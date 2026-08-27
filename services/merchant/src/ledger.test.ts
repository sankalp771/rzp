import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, hashCanonical, type BodyOf, type Message } from '@negotiator/protocol';
import { buildMessage } from '@negotiator/protocol/fixtures';
import type { LedgerEntry } from '@negotiator/ledger';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { DEFAULT_POLICY } from './policy.js';
import { askPrice } from './strategy.js';

/**
 * FEATURE-010 Gate 5 over HTTP: the merchant's own chain records every
 * message in/out, rejections, clamps and state changes; /ledger/verify
 * walks it; an out-of-band edit is reported at exactly that entry; the
 * operator API is token-gated; PUT /policy takes effect on the next message.
 */
const NOW = () => new Date('2026-08-28T10:00:00.000Z');
const TOKEN = 'dash-secret';
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function stack() {
  const db = openDb(':memory:');
  const app = buildApp({ db, now: NOW, chain: {}, dashboardToken: TOKEN });
  apps.push(app);
  const buyer = generateKeyPair();
  const session = randomUUID();
  let seq = 0;
  const send = async <T extends 'session_init' | 'catalog_request' | 'offer'>(
    type: T,
    body: BodyOf<T>,
    key = buyer,
  ) => {
    const msg = buildMessage(type, 'buyer', body, key, {
      session_id: session,
      seq: ++seq,
      timestamp: NOW().toISOString(),
      agent_id: 'buyer-demo',
    });
    const res = await app.inject({ method: 'POST', url: '/acnp', payload: msg });
    return {
      status: res.statusCode,
      reply: res.statusCode === 204 ? null : (res.json() as Message),
    };
  };
  const api = async (method: 'GET' | 'PUT', url: string, payload?: unknown, token = TOKEN) => {
    const res = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      ...(token ? { headers: { 'x-dashboard-token': token } } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  /** §6: a message rejected at the boundary consumed nothing — retry the same seq. */
  const rewind = () => {
    seq -= 1;
  };
  return { app, db, buyer, session, send, api, rewind };
}

async function negotiate(s: ReturnType<typeof stack>) {
  await s.send('session_init', {
    buyer_public_key: s.buyer.publicKey,
    supported_versions: ['0.1'],
    intent_mandate_ref: hashCanonical({ demo: true }),
  });
  await s.send('catalog_request', { category: 'gifts' });
  const ask = askPrice(
    { list_price: 480_000, floor_price: 360_000, category: 'gifts' },
    1,
    DEFAULT_POLICY,
  );
  // Below the seller's round-1 ask → a counter (and a clamp-free reply); then accept at the ask.
  await s.send('offer', {
    line_items: [
      { item_id: 'itm_vase', variant_id: 'var_vase_ash', quantity: 1, proposed_unit_price: 100 },
    ],
    total: 100,
    round: 1,
  });
  const accept = await s.send('offer', {
    line_items: [
      { item_id: 'itm_vase', variant_id: 'var_vase_ash', quantity: 1, proposed_unit_price: ask },
    ],
    total: ask,
    round: 2,
  });
  expect(accept.reply?.type).toBe('accept');
}

describe('merchant ledger (F6) + operator API (D024)', () => {
  it('records every message in and out and the state changes; the whole chain verifies', async () => {
    const s = stack();
    await negotiate(s);
    const { body } = await s.api('GET', `/ledger?session_id=${s.session}`);
    const entries = body['entries'] as LedgerEntry[];
    const shape = entries.map(
      (e) =>
        `${e.entry_type}:${(e.payload as { type?: string; state?: string }).type ?? (e.payload as { state?: string }).state ?? ''}`,
    );
    expect(shape).toEqual([
      'MESSAGE_IN:session_init',
      'MESSAGE_OUT:session_ack',
      'MESSAGE_IN:catalog_request',
      'MESSAGE_OUT:catalog_offer',
      'MESSAGE_IN:offer',
      'LLM_MOVE:',
      'MESSAGE_OUT:counter_offer',
      'MESSAGE_IN:offer',
      'LLM_MOVE:',
      'MESSAGE_OUT:accept',
    ]);
    // Every recorded envelope is the signed envelope itself.
    const out = entries.filter((e) => e.entry_type === 'MESSAGE_OUT');
    expect((out[0]!.payload as unknown as Message).signature).toBeDefined();
    const verify = await s.api('GET', '/ledger/verify');
    expect(verify.body).toMatchObject({ ok: true, length: entries.length });
    expect((await s.api('GET', '/health', undefined, '')).body).toMatchObject({
      ledger_entries: entries.length,
      operator_api: 'enabled',
    });
  });

  it('a boundary rejection is on record without trusting its session id; a handler rejection is on the session', async () => {
    const s = stack();
    await negotiate(s);
    const forged = await s.send('catalog_request', { category: 'gifts' }, generateKeyPair());
    expect((forged.reply!.body as BodyOf<'error'>).code).toBe('SIG_INVALID');
    const all = (await s.api('GET', '/ledger')).body['entries'] as LedgerEntry[];
    const rejected = all.find((e) => e.entry_type === 'BOUNDARY_REJECTED')!;
    expect(rejected.session_id).toBeNull();
    expect(rejected.payload).toMatchObject({ code: 'SIG_INVALID', claimed_session_id: s.session });
    // Authenticated but wrong state (AGREED): HANDLER_REJECTED on the session.
    s.rewind(); // the forged message consumed nothing (§6)
    const late = await s.send('catalog_request', { category: 'gifts' });
    expect((late.reply!.body as BodyOf<'error'>).code).toBe('STATE_INVALID');
    const mine = (await s.api('GET', `/ledger?session_id=${s.session}&entry_type=HANDLER_REJECTED`))
      .body['entries'] as LedgerEntry[];
    expect(mine).toHaveLength(1);
    expect((await s.api('GET', '/ledger/verify')).body).toMatchObject({ ok: true });
  });

  it('TAMPER over HTTP: an out-of-band edit of entry k → /ledger/verify reports k', async () => {
    const s = stack();
    await negotiate(s);
    const before = (await s.api('GET', '/ledger/verify')).body;
    expect(before['ok']).toBe(true);
    // Attacker with DB access rewrites the accepted price in the stored accept.
    s.db
      .prepare(
        'UPDATE ledger_entries SET payload_json = replace(payload_json, \'"accept"\', \'"reject"\') WHERE entry_seq = 10',
      )
      .run();
    expect((await s.api('GET', '/ledger/verify')).body).toEqual({
      ok: false,
      break_at_seq: 10,
      reason: 'entry_hash_mismatch',
      length: 9,
    });
  });

  it('operator API gate: no token → 401; unset → 503; PUT /policy validates and takes effect next message', async () => {
    const s = stack();
    expect((await s.api('GET', '/ledger', undefined, '')).status).toBe(401);
    expect((await s.api('GET', '/policy', undefined, 'nope')).status).toBe(401);
    const bad = await s.api('PUT', '/policy', { ...DEFAULT_POLICY, max_discount_pct: 5 });
    expect(bad.status).toBe(400);
    const ok = await s.api('PUT', '/policy', { ...DEFAULT_POLICY, max_rounds: 3 });
    expect(ok.status).toBe(200);
    expect((await s.api('GET', '/policy')).body).toMatchObject({ max_rounds: 3 });
    const ack = await s.send('session_init', {
      buyer_public_key: s.buyer.publicKey,
      supported_versions: ['0.1'],
      intent_mandate_ref: hashCanonical({ demo: true }),
    });
    expect((ack.reply!.body as BodyOf<'session_ack'>).capabilities.max_rounds).toBe(3);
    expect((await s.api('GET', '/sessions')).body['sessions']).toHaveLength(1);

    const closed = buildApp({ db: openDb(':memory:'), now: NOW, chain: {} });
    apps.push(closed);
    expect((await closed.inject({ method: 'GET', url: '/ledger/verify' })).statusCode).toBe(503);
    expect((await closed.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      operator_api: 'disabled (DASHBOARD_TOKEN unset)',
    });
  });
});
