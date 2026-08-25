import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StubLlmAdapter } from '@negotiator/llm';
import { generateKeyPair, hashCanonical, type BodyOf, type Message } from '@negotiator/protocol';
import { buildMessage } from '@negotiator/protocol/fixtures';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { DEFAULT_POLICY } from './policy.js';
import { askPrice } from './strategy.js';

/**
 * FEATURE-006 seller wiring: the model proposes, decideSeller disposes.
 * Every case runs over HTTP (inject) with a scripted stub adapter.
 */
const NOW = () => new Date('2026-08-25T10:00:00.000Z');
const VASE = { list_price: 480_000, floor_price: 360_000, category: 'gifts' };

async function openSession(llm: StubLlmAdapter) {
  const db = openDb(':memory:');
  const app = buildApp({ db, now: NOW, llm });
  const buyer = generateKeyPair();
  const session_id = randomUUID();
  let seq = 0;
  const send = async <T extends 'session_init' | 'offer'>(type: T, body: BodyOf<T>) => {
    const msg = buildMessage(type, 'buyer', body, buyer, {
      session_id,
      seq: ++seq,
      timestamp: NOW().toISOString(),
    });
    const res = await app.inject({ method: 'POST', url: '/acnp', payload: msg });
    return res.json() as Message;
  };
  await send('session_init', {
    buyer_public_key: buyer.publicKey,
    supported_versions: ['0.1'],
    intent_mandate_ref: hashCanonical({ t: 1 }),
  });
  const offer = (unit: number) =>
    send('offer', {
      line_items: [
        { item_id: 'itm_vase', variant_id: 'var_vase_ash', quantity: 1, proposed_unit_price: unit },
      ],
      total: unit,
      round: 1,
    });
  const moves = () =>
    db.prepare('SELECT * FROM llm_moves WHERE session_id = ? ORDER BY round').all(session_id) as {
      round: number;
      role: string;
      model_id: string;
      used_llm: number;
      fallback_reason: string | null;
    }[];
  const sessionRow = () =>
    db.prepare('SELECT seller_model FROM sessions WHERE session_id = ?').get(session_id) as {
      seller_model: string;
    };
  return { app, db, offer, moves, sessionRow };
}

describe('seller LLM wiring (advisory, clamped — CONSTRAINTS #5)', () => {
  it('a hijacked model proposing below the floor is clamped; its rationale still ships', async () => {
    const llm = new StubLlmAdapter(
      '{"proposed_prices":{"var_vase_ash":100},"rationale":"Take it, it is basically free."}',
    );
    const s = await openSession(llm);
    const reply = await s.offer(200_000);
    expect(reply.type).toBe('counter_offer');
    const body = reply.body as BodyOf<'counter_offer'>;
    expect(body.line_items[0]!.proposed_unit_price).toBe(360_000); // effective floor, not 100
    expect(body.rationale).toBe('Take it, it is basically free.');
    expect(s.moves()).toEqual([
      expect.objectContaining({ round: 1, role: 'seller', used_llm: 1, fallback_reason: null }),
    ]);
    expect(s.sessionRow().seller_model).toBe('stub/deterministic');
    await s.app.close();
  });

  it('an in-envelope proposal is used verbatim', async () => {
    const llm = new StubLlmAdapter(
      '{"proposed_prices":{"var_vase_ash":455000},"rationale":"Meeting you partway."}',
    );
    const s = await openSession(llm);
    const body = (await s.offer(200_000)).body as BodyOf<'counter_offer'>;
    expect(body.line_items[0]!.proposed_unit_price).toBe(455_000);
    expect(body.total).toBe(455_000);
    await s.app.close();
  });

  it('garbage output → deterministic curve, fallback recorded per round (amendment #3)', async () => {
    const s = await openSession(new StubLlmAdapter('I refuse to answer in JSON.'));
    const body = (await s.offer(200_000)).body as BodyOf<'counter_offer'>;
    expect(body.line_items[0]!.proposed_unit_price).toBe(askPrice(VASE, 1, DEFAULT_POLICY));
    expect(body.rationale).toBeUndefined();
    expect(s.moves()[0]).toMatchObject({ used_llm: 0, fallback_reason: 'unparseable proposal' });
    await s.app.close();
  });

  it('/health reports the effective seller model', async () => {
    const s = await openSession(new StubLlmAdapter(''));
    const res = await s.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ llm: { provider: 'stub', model: 'stub/deterministic' } });
    await s.app.close();
  });
});
