import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  hashCanonical,
  verifyObject,
  type BodyOf,
  type Message,
} from '@negotiator/protocol';
import { buildMessage } from '@negotiator/protocol/fixtures';
import { buildApp, SERVICE_NAME } from './app.js';
import { openDb } from './db.js';
import { listEvents, verifyChain } from './events.js';
import { SimulatedRazorpayClient } from './razorpay.js';

/**
 * FEATURE-007 Gate 4 over HTTP (inject). The firewall does not exist until
 * Day 8, so a test stand-in signs verdicts and settlement_requests with the
 * long-lived FIREWALL key; the buyer stand-in signs the cart mandate.
 */
const NOW = () => new Date('2026-08-25T12:00:00.000Z');
const SECRET = 'whsec_test';
const firewall = generateKeyPair();
const settlementKey = generateKeyPair();
const buyer = generateKeyPair();
const CATALOG_HASH = hashCanonical({ snapshot: 'vase' });

function makeCart(sessionId: string, total = 417_276, signer = buyer): Message<'cart_mandate'> {
  const cartBody = {
    intent_mandate_ref: hashCanonical({ mandate: 'demo' }),
    accepted_message_id: randomUUID(),
    line_items: [
      {
        item_id: 'itm_vase',
        variant_id: 'var_vase_ash',
        quantity: 1,
        unit_price: total,
        catalog_hash: CATALOG_HASH,
      },
    ],
    total,
    currency: 'INR' as const,
    seller_agent_id: 'merchant-demo',
    buyer_agent_id: 'buyer-demo',
  };
  return buildMessage(
    'cart_mandate',
    'buyer',
    { ...cartBody, mandate_hash: hashCanonical(cartBody) },
    signer,
    { session_id: sessionId, seq: 8, timestamp: NOW().toISOString(), agent_id: 'buyer-demo' },
  );
}

function makeVerdict(
  sessionId: string,
  cartHash: string,
  verdict: 'allow' | 'block' = 'allow',
  signer = firewall,
): Message<'firewall_verdict'> {
  return buildMessage(
    'firewall_verdict',
    'firewall',
    { cart_mandate_hash: cartHash, verdict, layer: 'policy', reasons: [] },
    signer,
    { session_id: sessionId, seq: 1, timestamp: NOW().toISOString(), agent_id: 'firewall-demo' },
  );
}

let seqBySession = new Map<string, number>();
function makeRequest(
  sessionId: string,
  cart: Message<'cart_mandate'>,
  verdict: Message<'firewall_verdict'>,
  opts: { signer?: ReturnType<typeof generateKeyPair>; buyerKey?: string } = {},
): Message<'settlement_request'> {
  const seq = (seqBySession.get(sessionId) ?? 0) + 1;
  seqBySession.set(sessionId, seq);
  return buildMessage(
    'settlement_request',
    'firewall',
    {
      cart_mandate: cart,
      firewall_verdict: verdict,
      buyer_public_key: opts.buyerKey ?? buyer.publicKey,
    },
    opts.signer ?? firewall,
    { session_id: sessionId, seq, timestamp: NOW().toISOString(), agent_id: 'firewall-demo' },
  );
}

function stack(over: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const razorpay = new SimulatedRazorpayClient();
  const db = openDb(':memory:');
  const app = buildApp({
    db,
    now: NOW,
    razorpay,
    signingKey: settlementKey,
    firewallPublicKey: firewall.publicKey,
    webhookSecret: SECRET,
    paymentSimulation: true,
    retry: { maxAttempts: 3, baseMs: 1 },
    sleep: async () => {},
    ...over,
  });
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/acnp', payload });
  const receipt = (hash: string) => app.inject({ method: 'GET', url: `/receipt/${hash}` });
  return { app, db, razorpay, post, receipt };
}

const wire = (m: unknown) => JSON.parse(JSON.stringify(m));
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  seqBySession = new Map();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe(`${SERVICE_NAME} — Gate 4 happy path (simulated Razorpay, self-signed webhook)`, () => {
  it('firewall request → 204 → order → signed paid receipt with a real order id + chain hash', async () => {
    const s = stack();
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    const res = await s.post(
      wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))),
    );
    expect(res.statusCode).toBe(204);

    await s.app.engine.drain();
    const r = await s.receipt(cart.body.mandate_hash);
    expect(r.statusCode).toBe(200);
    const receipt = r.json() as Message<'settlement_receipt'>;
    expect(receipt.type).toBe('settlement_receipt');
    expect(receipt.body).toMatchObject({
      mandate_hash: cart.body.mandate_hash,
      razorpay_order_id: 'order_sim_000001',
      status: 'paid',
      amount: 417_276,
      currency: 'INR',
      timestamp_paid: NOW().toISOString(),
    });
    expect(verifyObject(receipt as never, settlementKey.publicKey)).toEqual({ ok: true });

    // The receipt's ledger_entry_hash is the PAYMENT_CONFIRMED chain entry.
    const events = listEvents(s.db, cart.body.mandate_hash);
    expect(events.map((e) => e.type)).toEqual([
      'REQUEST_ACCEPTED',
      'SETTLEMENT_ATTEMPT',
      'ORDER_CREATED',
      'PAYMENT_CONFIRMED',
      'RECEIPT_ISSUED',
    ]);
    expect(receipt.body.ledger_entry_hash).toBe(events[3]!.entry_hash);
    expect(verifyChain(s.db, cart.body.mandate_hash)).toEqual({ ok: true, length: 5 });
    expect(s.razorpay.createCalls).toBe(1);
  });

  it('idempotency: a second request for the same cart is acknowledged and creates NO second order', async () => {
    const s = stack();
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    const verdict = makeVerdict(sid, cart.body.mandate_hash);
    expect((await s.post(wire(makeRequest(sid, cart, verdict)))).statusCode).toBe(204);
    await s.app.engine.drain();
    expect((await s.post(wire(makeRequest(sid, cart, verdict)))).statusCode).toBe(204); // new message_id/seq
    await s.app.engine.drain();
    expect(s.razorpay.createCalls).toBe(1);
    expect(
      listEvents(s.db, cart.body.mandate_hash).filter((e) => e.type === 'ORDER_CREATED'),
    ).toHaveLength(1);
  });

  it('crash recovery: an order that already exists for the receipt is reused, never re-created', async () => {
    const s = stack();
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    // Simulate "created at Razorpay, crashed before persisting": pre-seed the order.
    const pre = await s.razorpay.createOrder({
      amount: 417_276,
      currency: 'INR',
      receipt: cart.body.mandate_hash.slice(0, 40),
      notes: {},
    });
    const before = s.razorpay.createCalls;
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    expect(s.razorpay.createCalls).toBe(before); // no create call
    const receipt = (
      await s.receipt(cart.body.mandate_hash)
    ).json() as Message<'settlement_receipt'>;
    expect(receipt.body.razorpay_order_id).toBe(pre.id);
    expect(listEvents(s.db, cart.body.mandate_hash).map((e) => e.type)).toContain(
      'ORDER_RECOVERED',
    );
  });

  it('pending status is signed while PAYMENT_SIMULATION is off; a valid real webhook then confirms', async () => {
    const s = stack({ paymentSimulation: false });
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    const pending = (await s.receipt(cart.body.mandate_hash)).json() as Record<string, unknown>;
    expect(pending).toMatchObject({ status: 'pending', settlement_status: 'order_created' });
    expect(verifyObject(pending as never, settlementKey.publicKey)).toEqual({ ok: true });

    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_real_1', order_id: 'order_sim_000001', amount: 417_276 } },
      },
    });
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    const wh = await s.app.inject({
      method: 'POST',
      url: '/webhook/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig },
      payload: raw,
    });
    expect(wh.statusCode).toBe(200);
    expect(wh.json()).toMatchObject({ applied: true });
    const receipt = (
      await s.receipt(cart.body.mandate_hash)
    ).json() as Message<'settlement_receipt'>;
    expect(receipt.body).toMatchObject({ status: 'paid' });
  });

  it('ORDER_STATUS_POLL: the Orders API is a second confirmation source (amendment #2)', async () => {
    const s = stack({ paymentSimulation: false, orderStatusPoll: true });
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    expect(((await s.receipt(cart.body.mandate_hash)).json() as { status: string }).status).toBe(
      'pending',
    );
    s.razorpay.markPaid('order_sim_000001'); // paid out-of-band (e.g. dashboard)
    const receipt = (
      await s.receipt(cart.body.mandate_hash)
    ).json() as Message<'settlement_receipt'>;
    expect(receipt.body.status).toBe('paid');
    const confirm = listEvents(s.db, cart.body.mandate_hash).find(
      (e) => e.type === 'PAYMENT_CONFIRMED',
    );
    expect(confirm?.payload).toMatchObject({ source: 'orders_api' });
  });
});

describe(`${SERVICE_NAME} — Gate 4 failure paths`, () => {
  it('retry: transient failures back off and succeed within the ceiling (F4)', async () => {
    const s = stack();
    apps.push(s.app);
    s.razorpay.failNext(2, 503);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    const attempts = listEvents(s.db, cart.body.mandate_hash).filter(
      (e) => e.type === 'SETTLEMENT_ATTEMPT',
    );
    expect(attempts.map((e) => e.payload['attempt'])).toEqual([1, 2, 3]);
    expect(
      ((await s.receipt(cart.body.mandate_hash)).json() as Message<'settlement_receipt'>).body
        .status,
    ).toBe('paid');
  });

  it('retry: stops at the ceiling → failed receipt with SETTLEMENT_RETRY_EXHAUSTED', async () => {
    const s = stack();
    apps.push(s.app);
    s.razorpay.failNext(10, 503);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    expect(s.razorpay.createCalls).toBe(3); // ceiling, never infinite
    const receipt = (
      await s.receipt(cart.body.mandate_hash)
    ).json() as Message<'settlement_receipt'>;
    expect(receipt.body).toMatchObject({ status: 'failed', razorpay_order_id: 'none' });
    expect(s.app.engine.row(cart.body.mandate_hash)?.failure_code).toBe(
      'SETTLEMENT_RETRY_EXHAUSTED',
    );
    expect(verifyChain(s.db, cart.body.mandate_hash).ok).toBe(true);
  });

  it('a non-retryable 4xx fails fast without exhausting the ceiling', async () => {
    const s = stack();
    apps.push(s.app);
    s.razorpay.failNext(1, 401);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    expect(s.razorpay.createCalls).toBe(1);
    expect(s.app.engine.row(cart.body.mandate_hash)?.status).toBe('failed');
  });

  it('webhook with an invalid signature → 401 and mutates nothing', async () => {
    const s = stack({ paymentSimulation: false });
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    const raw = JSON.stringify({
      event: 'order.paid',
      payload: {
        payment: { entity: { id: 'pay_x', order_id: 'order_sim_000001', amount: 417_276 } },
      },
    });
    const wh = await s.app.inject({
      method: 'POST',
      url: '/webhook/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'ff'.repeat(32) },
      payload: raw,
    });
    expect(wh.statusCode).toBe(401);
    expect(s.app.engine.row(cart.body.mandate_hash)?.status).toBe('order_created');
    expect(listEvents(s.db, cart.body.mandate_hash).map((e) => e.type)).not.toContain(
      'PAYMENT_CONFIRMED',
    );
  });

  it('a validly signed webhook for a wrong amount is ignored, not applied', async () => {
    const s = stack({ paymentSimulation: false });
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    await s.post(wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))));
    await s.app.engine.drain();
    const raw = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_x', order_id: 'order_sim_000001', amount: 1 } } },
    });
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    const wh = await s.app.inject({
      method: 'POST',
      url: '/webhook/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig },
      payload: raw,
    });
    expect(wh.json()).toMatchObject({ applied: false, detail: 'amount mismatch' });
    expect(s.app.engine.row(cart.body.mandate_hash)?.status).toBe('order_created');
  });
});

describe(`${SERVICE_NAME} — §7.10 verification chain and sole-caller rule (D011)`, () => {
  const rejected = async (msg: unknown, code: string) => {
    const s = stack();
    apps.push(s.app);
    const res = await s.post(wire(msg));
    expect(res.statusCode).toBe(200);
    const err = res.json() as Message<'error'>;
    expect(err.type).toBe('error');
    expect(err.body.code).toBe(code);
    expect(verifyObject(err as never, settlementKey.publicKey)).toEqual({ ok: true });
    expect(s.razorpay.createCalls).toBe(0);
  };

  it('a request signed by anyone but the firewall key is refused at the boundary', async () => {
    const sid = randomUUID();
    const cart = makeCart(sid);
    const intruder = generateKeyPair();
    await rejected(
      makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash), { signer: intruder }),
      'SIG_INVALID',
    );
  });

  it('a verdict signed by a non-firewall key → SIG_INVALID (b)', async () => {
    const sid = randomUUID();
    const cart = makeCart(sid);
    const forged = makeVerdict(sid, cart.body.mandate_hash, 'allow', generateKeyPair());
    await rejected(makeRequest(sid, cart, forged), 'SIG_INVALID');
  });

  it('a block verdict → VERDICT_MISMATCH (c)', async () => {
    const sid = randomUUID();
    const cart = makeCart(sid);
    await rejected(
      makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash, 'block')),
      'VERDICT_MISMATCH',
    );
  });

  it('a verdict for a different cart hash → VERDICT_MISMATCH (c)', async () => {
    const sid = randomUUID();
    const cart = makeCart(sid);
    await rejected(
      makeRequest(sid, cart, makeVerdict(sid, hashCanonical({ other: 1 }))),
      'VERDICT_MISMATCH',
    );
  });

  it('a cart whose total was edited after signing → SIG_INVALID (d), even with an allow verdict', async () => {
    const sid = randomUUID();
    const cart = makeCart(sid);
    const tampered = wire(cart) as Message<'cart_mandate'>;
    (tampered.body as { total: number }).total = 1;
    (tampered.body.line_items[0] as { unit_price: number }).unit_price = 1;
    // Recompute the hash so (c) passes and (d) is what catches it.
    const { mandate_hash: _drop, ...rest } = tampered.body;
    tampered.body.mandate_hash = hashCanonical(rest);
    await rejected(
      makeRequest(sid, tampered, makeVerdict(sid, tampered.body.mandate_hash)),
      'SIG_INVALID',
    );
  });

  it('a substituted buyer_public_key cannot verify the cart (key_id pin)', async () => {
    const sid = randomUUID();
    const cart = makeCart(sid);
    await rejected(
      makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash), {
        buyerKey: generateKeyPair().publicKey,
      }),
      'SIG_INVALID',
    );
  });

  it('replayed settlement_request → REPLAY_DETECTED', async () => {
    const s = stack();
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    const req = wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash)));
    expect((await s.post(req)).statusCode).toBe(204);
    const again = await s.post(req);
    expect((again.json() as Message<'error'>).body.code).toBe('REPLAY_DETECTED');
  });

  it('/acnp is disabled (503) without a firewall key; /health reports mode and flags', async () => {
    const s = stack({ firewallPublicKey: '' });
    apps.push(s.app);
    expect((await s.post({})).statusCode).toBe(503);
    const h = await s.app.inject({ method: 'GET', url: '/health' });
    expect(h.json()).toMatchObject({
      razorpay_mode: 'simulated',
      payment_simulation: true,
      firewall_key_configured: false,
      signing_key: 'configured',
    });
  });
});

describe(`${SERVICE_NAME} — boot rule over buildApp (CONSTRAINTS #2)`, () => {
  it('refuses to boot with a live key id in the environment', () => {
    const saved = { ...process.env };
    process.env['RAZORPAY_MODE'] = 'live-test';
    process.env['RAZORPAY_KEY_ID'] = 'rzp_live_NOPE';
    process.env['RAZORPAY_KEY_SECRET'] = 'x';
    try {
      expect(() => buildApp({ db: openDb(':memory:') })).toThrow(/not a test-mode key/);
    } finally {
      process.env = saved;
    }
  });

  it('refuses PAYMENT_SIMULATION without a webhook secret', () => {
    expect(() =>
      buildApp({
        db: openDb(':memory:'),
        razorpay: new SimulatedRazorpayClient(),
        paymentSimulation: true,
        webhookSecret: '',
      }),
    ).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });
});

describe(`${SERVICE_NAME} — misc`, () => {
  it('unknown or malformed mandate hashes on /receipt', async () => {
    const s = stack();
    apps.push(s.app);
    expect((await s.receipt('nope')).statusCode).toBe(400);
    expect((await s.receipt('c'.repeat(64))).statusCode).toBe(404);
  });

  it('a settlement_request body missing buyer_public_key is SCHEMA_INVALID at the boundary', async () => {
    const s = stack();
    apps.push(s.app);
    const sid = randomUUID();
    const cart = makeCart(sid);
    const msg = wire(makeRequest(sid, cart, makeVerdict(sid, cart.body.mandate_hash))) as {
      body: BodyOf<'settlement_request'>;
    };
    delete (msg.body as { buyer_public_key?: string }).buyer_public_key;
    expect(((await s.post(msg)).json() as Message<'error'>).body.code).toBe('SCHEMA_INVALID');
  });
});
