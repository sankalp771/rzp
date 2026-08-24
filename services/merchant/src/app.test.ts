import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  hashCanonical,
  verifyObject,
  type BodyOf,
  type Message,
  type MessageType,
} from '@negotiator/protocol';
import { buildMessage, type BuildOpts } from '@negotiator/protocol/fixtures';
import { buildApp, SERVICE_NAME } from './app.js';
import { openDb } from './db.js';
import { DEFAULT_POLICY } from './policy.js';
import { askPrice } from './strategy.js';

/**
 * Merchant service end-to-end over real HTTP (inject): a scripted buyer
 * negotiates against the deterministic seller. This is F1 steps 2–5 with
 * the buyer played by the test.
 */

const db = openDb(':memory:');
const NOW = () => new Date('2026-08-24T10:00:00.000Z');
const app = buildApp({ db, now: NOW });
afterAll(() => app.close());

const buyer = generateKeyPair();
const session_id = randomUUID();
let buyerSeq = 0;
let sellerPk = ''; // pinned from session_ack (TOFU)
let lastSellerSeq = 0;

async function send<T extends MessageType>(
  type: T,
  body: BodyOf<T>,
  opts: Partial<BuildOpts> = {},
): Promise<{ status: number; reply?: Message }> {
  const msg = buildMessage(type, 'buyer', body, buyer, {
    session_id,
    seq: ++buyerSeq,
    timestamp: NOW().toISOString(),
    agent_id: 'buyer-e2e',
    ...opts,
  });
  const res = await app.inject({ method: 'POST', url: '/acnp', payload: msg });
  if (res.statusCode === 204) return { status: 204 };
  const reply = res.json() as Message;
  // Every in-session seller message (replies AND error replies) must carry a
  // strictly increasing seller seq — asserted centrally here.
  if (reply?.session_id === session_id && reply.seq !== undefined) {
    expect(reply.seq).toBe(lastSellerSeq + 1);
    lastSellerSeq = reply.seq;
  }
  return { status: res.statusCode, reply };
}

function expectSignedSellerReply(reply: Message | undefined, type: string): Message {
  expect(reply?.type).toBe(type);
  expect(reply!.session_id).toBe(session_id);
  // Every seller reply verifies against the pinned session key (seq
  // monotonicity is asserted in send()).
  expect(verifyObject(reply as never, sellerPk)).toEqual({ ok: true });
  return reply!;
}

describe(`${SERVICE_NAME} negotiation end-to-end`, () => {
  const li = (unit: number, quantity = 1) => [
    { item_id: 'itm_vase', variant_id: 'var_vase_ash', quantity, proposed_unit_price: unit },
  ];
  let catalogHash = '';

  it('session_init → signed session_ack with capabilities from policy', async () => {
    const { status, reply } = await send('session_init', {
      buyer_public_key: buyer.publicKey,
      supported_versions: ['0.1'],
      intent_mandate_ref: hashCanonical({ demo: true }),
    });
    expect(status).toBe(200);
    sellerPk = (reply!.body as BodyOf<'session_ack'>).seller_public_key;
    const ack = expectSignedSellerReply(reply, 'session_ack');
    expect((ack.body as BodyOf<'session_ack'>).capabilities).toMatchObject({
      max_rounds: DEFAULT_POLICY.max_rounds,
      currency: 'INR',
    });
  });

  it('catalog_request → catalog_offer with verifiable per-item hashes', async () => {
    const { reply } = await send('catalog_request', { category: 'gifts' });
    const offer = expectSignedSellerReply(reply, 'catalog_offer');
    const items = (offer.body as BodyOf<'catalog_offer'>).items;
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.every((i) => i.category === 'gifts')).toBe(true);
    // catalog_hash must equal the hash of the snapshot minus the hash field.
    const vase = items.find((i) => i.item_id === 'itm_vase')!;
    const { catalog_hash, ...snapshot } = vase;
    expect(catalog_hash).toBe(hashCanonical(snapshot));
    catalogHash = catalog_hash;
    expect(catalogHash).toMatch(/^[0-9a-f]{64}$/);
    // Floors must never appear anywhere in the payload (merchant-private).
    expect(JSON.stringify(offer.body)).not.toContain('floor');
  });

  it('lowball offer → deterministic counter_offer at the round-1 ask', async () => {
    const { reply } = await send('offer', { line_items: li(200_000), total: 200_000, round: 1 });
    const counter = expectSignedSellerReply(reply, 'counter_offer');
    const body = counter.body as BodyOf<'counter_offer'>;
    const expectedAsk = askPrice(
      { list_price: 480_000, floor_price: 360_000, category: 'gifts' },
      1,
      DEFAULT_POLICY,
    );
    expect(body.line_items[0]!.proposed_unit_price).toBe(expectedAsk);
    expect(body.total).toBe(expectedAsk);
  });

  it('offer with a wrong total → TOTAL_MISMATCH error, session survives', async () => {
    const { reply } = await send('counter_offer', {
      line_items: li(300_000),
      total: 999,
      round: 2,
    });
    expect(reply?.type).toBe('error');
    expect((reply!.body as BodyOf<'error'>).code).toBe('TOTAL_MISMATCH');
  });

  it('offer meeting the ask → seller accept echoing our numbers', async () => {
    const ask = askPrice(
      { list_price: 480_000, floor_price: 360_000, category: 'gifts' },
      2, // TOTAL_MISMATCH consumed a seq but not a round: this is round 2
      DEFAULT_POLICY,
    );
    const { reply } = await send('counter_offer', {
      line_items: li(ask),
      total: ask,
      round: 2,
    });
    const accept = expectSignedSellerReply(reply, 'accept');
    const body = accept.body as BodyOf<'accept'>;
    expect(body.total).toBe(ask);
    expect(body.line_items).toEqual(li(ask));
    // State is AGREED: further offers must be rejected as STATE_INVALID.
    const after = await send('offer', { line_items: li(ask), total: ask, round: 3 });
    expect((after.reply!.body as BodyOf<'error'>).code).toBe('STATE_INVALID');
  });
});

describe(`${SERVICE_NAME} boundary rejections over HTTP (F5)`, () => {
  it('unsigned garbage → signed SCHEMA_INVALID error message', async () => {
    const res = await app.inject({ method: 'POST', url: '/acnp', payload: { hello: 1 } });
    expect(res.statusCode).toBe(200);
    const err = res.json() as Message<'error'>;
    expect(err.type).toBe('error');
    expect(err.body.code).toBe('SCHEMA_INVALID');
  });

  it('replayed message → REPLAY_DETECTED error', async () => {
    const other = generateKeyPair();
    const sid = randomUUID();
    const init = buildMessage(
      'session_init',
      'buyer',
      {
        buyer_public_key: other.publicKey,
        supported_versions: ['0.1'],
        intent_mandate_ref: hashCanonical({ x: 1 }),
      },
      other,
      { session_id: sid, seq: 1, timestamp: NOW().toISOString() },
    );
    const first = await app.inject({ method: 'POST', url: '/acnp', payload: init });
    expect((first.json() as Message).type).toBe('session_ack');
    const replayed = await app.inject({ method: 'POST', url: '/acnp', payload: init });
    expect((replayed.json() as Message<'error'>).body.code).toBe('REPLAY_DETECTED');
  });

  it('unknown session → SESSION_UNKNOWN error', async () => {
    const other = generateKeyPair();
    const msg = buildMessage(
      'offer',
      'buyer',
      {
        line_items: [{ item_id: 'i', variant_id: 'v', quantity: 1, proposed_unit_price: 1 }],
        total: 1,
        round: 1,
      },
      other,
      { timestamp: NOW().toISOString() },
    );
    const res = await app.inject({ method: 'POST', url: '/acnp', payload: msg });
    expect((res.json() as Message<'error'>).body.code).toBe('SESSION_UNKNOWN');
  });

  it('health still reports protocol name and version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok', protocol: 'ACNP', version: '0.1' });
  });
});
