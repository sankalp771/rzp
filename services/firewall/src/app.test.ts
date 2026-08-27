import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  hashCanonical,
  verifyObject,
  type BodyOf,
  type CatalogSnapshot,
  type IntentMandate,
  type Message,
} from '@negotiator/protocol';
import { buildMessage, makeIntentMandate, makePrincipal } from '@negotiator/protocol/fixtures';
import { buildApp as buildSettlementApp } from '../../settlement/src/app.js';
import { openDb as openSettlementDb } from '../../settlement/src/db.js';
import { SimulatedRazorpayClient } from '../../settlement/src/razorpay.js';
import { StubLlmAdapter } from '@negotiator/llm';
import { buildApp, SERVICE_NAME, type PostFn } from './app.js';
import { openDb } from './db.js';
import { makeVerifier, type Verifier } from './intent.js';
import { DEFAULT_POLICY } from './policy.js';

/**
 * FEATURE-008 Gate 3 over HTTP (inject): the firewall audits carts against
 * the mandate it STORED, and on allow drives the REAL settlement app
 * (simulated Razorpay) through the same post seam production uses. The
 * seller is a recorder that answers 204 (the merchant learns to handle
 * verdicts in commit 6).
 */
const NOW = () => new Date('2026-08-26T12:00:00.000Z');
const firewallKey = generateKeyPair();
const settlementKey = generateKeyPair();
const principal = makePrincipal();
const SETTLEMENT = 'http://settlement.test';
const MERCHANT = 'http://merchant.test';

const VASE: CatalogSnapshot = {
  item_id: 'itm_vase',
  title: 'Hand-thrown ceramic vase',
  description: 'Stoneware vase.',
  category: 'gifts',
  variants: [{ variant_id: 'var_vase_ash', attributes: {}, list_price: 480_000, stock: 3 }],
};
const RAM: CatalogSnapshot = {
  item_id: 'itm_ram',
  title: 'Server RAM 64GB DDR5 ECC kit',
  description: 'Registered ECC DIMM kit.',
  category: 'industrial',
  variants: [{ variant_id: 'var_ram_64', attributes: {}, list_price: 1_850_000, stock: 40 }],
};
/** Every layer-1 number passes; only semantics can stop it (FEATURE-009 flagship). */
const HAMPER: CatalogSnapshot = {
  item_id: 'itm_corp_hamper',
  title: 'Corporate gifting hamper',
  description: 'Pack of 12 logo-branded desk calendars for client distribution.',
  category: 'gifts',
  variants: [{ variant_id: 'var_corp_hamper', attributes: {}, list_price: 480_000, stock: 9 }],
};

const REVIEW_TOKEN = 'review-secret';
const script = (recommendation: string, reasons: string[], summary = 'because') =>
  JSON.stringify({ recommendation, reasons, summary });
const verifierSaying = (text: string) => makeVerifier(new StubLlmAdapter(text));

/** One buyer identity: a session key, its registration, and stream counters. */
class Buyer {
  readonly key = generateKeyPair();
  readonly agentId = 'buyer-demo';
  readonly registerSession = randomUUID();
  private readonly seqs = new Map<string, number>();
  constructor(readonly mandate: IntentMandate) {}
  get ref() {
    return hashCanonical(this.mandate);
  }
  next(session: string) {
    const n = (this.seqs.get(session) ?? 0) + 1;
    this.seqs.set(session, n);
    return n;
  }
  register(over: Partial<BodyOf<'mandate_register'>> = {}) {
    return buildMessage(
      'mandate_register',
      'buyer',
      { intent_mandate: this.mandate, buyer_public_key: this.key.publicKey, ...over },
      this.key,
      {
        session_id: this.registerSession,
        seq: this.next(this.registerSession),
        timestamp: NOW().toISOString(),
        agent_id: this.agentId,
      },
    );
  }
  cart(
    session: string,
    opts: {
      snapshot?: CatalogSnapshot;
      unit?: number;
      seller?: string;
      signer?: typeof this.key;
    } = {},
  ) {
    const snapshot = opts.snapshot ?? VASE;
    const unit = opts.unit ?? 417_276;
    const body = {
      intent_mandate_ref: this.ref,
      accepted_message_id: randomUUID(),
      line_items: [
        {
          item_id: snapshot.item_id,
          variant_id: snapshot.variants[0]!.variant_id,
          quantity: 1,
          unit_price: unit,
          catalog_hash: hashCanonical(snapshot),
          catalog_item: snapshot,
        },
      ],
      total: unit,
      currency: 'INR' as const,
      seller_agent_id: opts.seller ?? 'merchant-demo',
      buyer_agent_id: this.agentId,
    };
    return buildMessage(
      'cart_mandate',
      'buyer',
      { ...body, mandate_hash: hashCanonical(body) },
      opts.signer ?? this.key,
      {
        session_id: session,
        seq: this.next(session),
        timestamp: NOW().toISOString(),
        agent_id: this.agentId,
      },
    );
  }
}

interface StackOpts {
  policy?: Partial<typeof DEFAULT_POLICY>;
  principalKeys?: string[];
  /** Replace the settlement leg (failure injection). */
  settlementPost?: PostFn;
  /** Replace the seller leg (failure injection). */
  sellerPost?: PostFn;
  dispatchTimeoutMs?: number;
  verifier?: Verifier;
  reviewToken?: string | null;
  escalationTimeoutSec?: number;
  now?: () => Date;
}

function stack(o: StackOpts = {}) {
  const now = o.now ?? NOW;
  const razorpay = new SimulatedRazorpayClient();
  const settlement = buildSettlementApp({
    db: openSettlementDb(':memory:'),
    now,
    razorpay,
    signingKey: settlementKey,
    firewallPublicKey: firewallKey.publicKey,
    webhookSecret: 'whsec_test',
    paymentSimulation: true,
    retry: { maxAttempts: 2, baseMs: 1 },
    sleep: async () => {},
  });
  const sellerInbox: Message[] = [];
  const post: PostFn = async (url, payload, timeoutMs) => {
    if (url.startsWith(SETTLEMENT)) {
      if (o.settlementPost) return o.settlementPost(url, payload, timeoutMs);
      const res = await settlement.inject({ method: 'POST', url: '/acnp', payload });
      return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
    }
    if (url.startsWith(MERCHANT)) {
      if (o.sellerPost) return o.sellerPost(url, payload, timeoutMs);
      sellerInbox.push(payload as Message);
      return { status: 204, body: null };
    }
    throw new Error(`unexpected url ${url}`);
  };
  const db = openDb(':memory:');
  const app = buildApp({
    db,
    now,
    signingKey: firewallKey,
    principalKeys: o.principalKeys ?? [principal.publicKey],
    policy: { ...DEFAULT_POLICY, ...o.policy },
    settlementUrl: SETTLEMENT,
    merchantUrl: MERCHANT,
    post,
    dispatchTimeoutMs: o.dispatchTimeoutMs ?? 1000,
    notifyTimeoutMs: 1000,
    verifier: o.verifier ?? 'not_configured',
    ...(o.reviewToken === null ? {} : { reviewToken: o.reviewToken ?? REVIEW_TOKEN }),
    escalationTimeoutSec: o.escalationTimeoutSec ?? 600,
    sweepIntervalMs: 0,
  });
  apps.push(app, settlement);
  const send = async (m: unknown) => {
    const res = await app.inject({ method: 'POST', url: '/acnp', payload: wire(m) });
    return {
      status: res.statusCode,
      body: res.statusCode === 204 ? null : (res.json() as Message),
    };
  };
  const review = async (
    hash: string,
    body: Record<string, unknown>,
    token: string | null = REVIEW_TOKEN,
  ) => {
    const res = await app.inject({
      method: 'POST',
      url: `/review/${hash}`,
      payload: body,
      ...(token ? { headers: { 'x-review-token': token } } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const queue = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/review',
      headers: { 'x-review-token': REVIEW_TOKEN },
    });
    return { status: res.statusCode, body: res.json() as { pending: Record<string, unknown>[] } };
  };
  const poll = async (hash: string) =>
    (await app.inject({ method: 'GET', url: `/verdict/${hash}` })).json() as Message;
  const verdictCount = (hash: string) =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM verdicts WHERE cart_mandate_hash = ?').get(hash) as {
        n: number;
      }
    ).n;
  const cartRow = (hash: string) =>
    db.prepare('SELECT * FROM carts WHERE cart_mandate_hash = ?').get(hash) as
      | {
          settlement_dispatched: number;
          settlement_error: string | null;
          seller_notified: number;
          seller_error: string | null;
        }
      | undefined;
  return {
    app,
    db,
    settlement,
    razorpay,
    sellerInbox,
    send,
    cartRow,
    review,
    queue,
    poll,
    verdictCount,
  };
}

const wire = (m: unknown) => JSON.parse(JSON.stringify(m));
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const expectError = (m: Message | null, code: string) => {
  expect(m?.type).toBe('error');
  expect((m!.body as BodyOf<'error'>).code).toBe(code);
  expect(verifyObject(m!, firewallKey.publicKey).ok).toBe(true);
};
const verdictOf = (m: Message | null) => {
  expect(m?.type).toBe('firewall_verdict');
  expect(verifyObject(m!, firewallKey.publicKey).ok).toBe(true);
  return m!.body as BodyOf<'firewall_verdict'>;
};

describe(`${SERVICE_NAME} — mandate_register (§7.0, D010)`, () => {
  it('verifies the principal signature, pins the buyer key, acks with the ref; repeat is idempotent', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    const ack = await s.send(buyer.register());
    expect(ack.status).toBe(200);
    expect(ack.body?.type).toBe('mandate_ack');
    expect(verifyObject(ack.body!, firewallKey.publicKey).ok).toBe(true);
    expect((ack.body!.body as BodyOf<'mandate_ack'>).intent_mandate_ref).toBe(buyer.ref);
    expect(ack.body!.seq).toBe(1);

    const again = await s.send(buyer.register());
    expect(again.body?.type).toBe('mandate_ack');
    expect(again.body!.seq).toBe(2); // our stream to the buyer advanced; nothing re-pinned
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM mandates').get()).toEqual({ n: 1 });
  });

  it('a second key claiming the same mandate → MANDATE_CONFLICT', async () => {
    const s = stack();
    const mandate = makeIntentMandate(principal);
    await s.send(new Buyer(mandate).register());
    const intruder = new Buyer(mandate);
    expectError((await s.send(intruder.register())).body, 'MANDATE_CONFLICT');
  });

  it('untrusted principal → MANDATE_SIG_INVALID; tampered mandate → MANDATE_SIG_INVALID', async () => {
    const s = stack();
    const rogue = new Buyer(makeIntentMandate(makePrincipal()));
    expectError((await s.send(rogue.register())).body, 'MANDATE_SIG_INVALID');
    const tampered = new Buyer({ ...makeIntentMandate(principal), budget_ceiling: 99_999_999 });
    expectError((await s.send(tampered.register())).body, 'MANDATE_SIG_INVALID');
  });

  it('expired mandate → MANDATE_EXPIRED; no trusted keys configured → refused, visible in /health', async () => {
    const s = stack();
    const expired = new Buyer(
      makeIntentMandate(principal, { valid_until: '2026-08-01T00:00:00.000Z' }),
    );
    expectError((await s.send(expired.register())).body, 'MANDATE_EXPIRED');

    const bare = stack({ principalKeys: [] });
    expectError(
      (await bare.send(new Buyer(makeIntentMandate(principal)).register())).body,
      'MANDATE_SIG_INVALID',
    );
    expect((await bare.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      principal_keys: 0,
      intent_verifier: 'not_configured',
    });
  });
});

describe(`${SERVICE_NAME} — cart_mandate → verdict → settlement (F1 steps 7–8)`, () => {
  it('benign cart → signed allow; settlement_request accepted with the pinned buyer key; seller notified; receipt paid', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const session = randomUUID();
    const cart = buyer.cart(session);
    const res = await s.send(cart);
    const v = verdictOf(res.body);
    expect(v).toEqual({
      cart_mandate_hash: cart.body.mandate_hash,
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    expect(res.body!.in_reply_to).toBe(cart.message_id);
    expect(res.body!.seq).toBe(1); // buyer stream for this session starts at 1

    // Settlement got it: one order, paid via the self-signed webhook.
    await s.settlement.engine.drain();
    const row = s.settlement.engine.row(cart.body.mandate_hash);
    expect(row?.status).toBe('paid');
    expect(row?.razorpay_order_id).toBe('order_sim_000001');
    const receipt = await s.settlement.inject({
      method: 'GET',
      url: `/receipt/${cart.body.mandate_hash}`,
    });
    expect(receipt.json()).toMatchObject({ type: 'settlement_receipt', body: { status: 'paid' } });

    // Seller got the same verdict body in its own envelope, seq 1 on its stream.
    expect(s.sellerInbox).toHaveLength(1);
    expect(s.sellerInbox[0]!.type).toBe('firewall_verdict');
    expect(s.sellerInbox[0]!.body).toEqual(v);
    expect(s.sellerInbox[0]!.seq).toBe(1);
    expect(s.cartRow(cart.body.mandate_hash)).toMatchObject({
      settlement_dispatched: 1,
      settlement_error: null,
      seller_notified: 1,
    });

    // GET /verdict is the same signed envelope, idempotently.
    const poll = await s.app.inject({ method: 'GET', url: `/verdict/${cart.body.mandate_hash}` });
    expect(poll.json()).toEqual(res.body);
  });

  it('server RAM under a gifts mandate → block CATEGORY_BLOCKED (T5, layer 1); nothing reaches settlement', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID(), { snapshot: RAM, unit: 450_000 });
    const v = verdictOf((await s.send(cart)).body);
    expect(v.verdict).toBe('block');
    expect(v.reasons).toEqual(['CATEGORY_BLOCKED']);
    await s.settlement.engine.drain();
    expect(s.settlement.engine.row(cart.body.mandate_hash)).toBeUndefined();
    expect(s.razorpay.createCalls).toBe(0);
    expect(s.sellerInbox[0]!.body).toMatchObject({ verdict: 'block' });
    expect(s.cartRow(cart.body.mandate_hash)).toMatchObject({
      settlement_dispatched: 0,
      seller_notified: 1,
    });
  });

  it('over budget → AMOUNT_CAP_EXCEEDED; unlisted seller → MERCHANT_NOT_ALLOWLISTED (all reasons listed)', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const v = verdictOf(
      (await s.send(buyer.cart(randomUUID(), { unit: 500_001, seller: 'evil-corp' }))).body,
    );
    expect(v.reasons).toEqual(['MERCHANT_NOT_ALLOWLISTED', 'AMOUNT_CAP_EXCEEDED']);
  });

  it('one mandate, one purchase: a second cart on an allowed ref → MANDATE_ALREADY_USED', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    expect(verdictOf((await s.send(buyer.cart(randomUUID()))).body).verdict).toBe('allow');
    const v = verdictOf((await s.send(buyer.cart(randomUUID(), { unit: 400_000 }))).body);
    expect(v.verdict).toBe('block');
    expect(v.reasons).toEqual(['MANDATE_ALREADY_USED']);
  });

  it('velocity is per principal across fresh mandates: max 1 → the second principal cart blocks', async () => {
    const s = stack({ policy: { velocityMax: 1 } });
    const a = new Buyer(makeIntentMandate(principal));
    const b = new Buyer(makeIntentMandate(principal, { issued_at: '2026-08-26T11:00:00.000Z' }));
    await s.send(a.register());
    await s.send(b.register());
    expect(a.ref).not.toBe(b.ref);
    expect(verdictOf((await s.send(a.cart(randomUUID()))).body).verdict).toBe('allow');
    const v = verdictOf((await s.send(b.cart(randomUUID()))).body);
    expect(v.reasons).toEqual(['VELOCITY_LIMIT']);
  });
});

describe(`${SERVICE_NAME} — boundary and state (F5, §6, §9)`, () => {
  it('unregistered ref → MANDATE_UNKNOWN, no seq consumed; wrong key → SIG_INVALID', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    const session = randomUUID();
    expectError((await s.send(buyer.cart(session))).body, 'MANDATE_UNKNOWN');
    await s.send(buyer.register());
    // Same seq again is fine: the rejected message consumed nothing.
    const intruder = generateKeyPair();
    const forged = buyer.cart(session, { signer: intruder });
    expectError((await s.send(forged)).body, 'SIG_INVALID');
  });

  it('replayed cart → REPLAY_DETECTED; re-sent same cart (new envelope) → same verdict, ONE settlement', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const session = randomUUID();
    const cart = buyer.cart(session);
    const first = await s.send(cart);
    expectError((await s.send(cart)).body, 'REPLAY_DETECTED');
    // Fresh envelope, identical body (e.g. buyer retried after a lost reply).
    const resent = buildMessage('cart_mandate', 'buyer', cart.body, buyer.key, {
      session_id: session,
      seq: buyer.next(session),
      timestamp: NOW().toISOString(),
      agent_id: buyer.agentId,
    });
    const second = await s.send(resent);
    expect(second.body).toEqual(first.body);
    await s.settlement.engine.drain();
    expect(s.razorpay.createCalls).toBe(1);
    expect(s.sellerInbox).toHaveLength(1);
  });

  it('a different cart in a session that already has one → STATE_INVALID', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const session = randomUUID();
    await s.send(buyer.cart(session));
    expectError((await s.send(buyer.cart(session, { unit: 400_000 }))).body, 'STATE_INVALID');
  });

  it('tampered total with a recomputed hash → TOTAL_MISMATCH; wrong mandate_hash → SCHEMA_INVALID', async () => {
    const s = stack();
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const session = randomUUID();
    const base = buyer.cart(randomUUID()).body; // body only; no seq spent on `session`
    const { mandate_hash: _h, ...minus } = { ...base, total: 1 };
    const badTotal = buildMessage(
      'cart_mandate',
      'buyer',
      { ...minus, mandate_hash: hashCanonical(minus) },
      buyer.key,
      {
        session_id: session,
        seq: buyer.next(session),
        timestamp: NOW().toISOString(),
        agent_id: buyer.agentId,
      },
    );
    expectError((await s.send(badTotal)).body, 'TOTAL_MISMATCH');
    const badHash = buildMessage(
      'cart_mandate',
      'buyer',
      { ...base, mandate_hash: 'f'.repeat(64) },
      buyer.key,
      {
        session_id: session,
        seq: buyer.next(session),
        timestamp: NOW().toISOString(),
        agent_id: buyer.agentId,
      },
    );
    expectError((await s.send(badHash)).body, 'SCHEMA_INVALID');
  });
});

describe(`${SERVICE_NAME} — dispatch failure branch (amendment #4)`, () => {
  it('settlement down: the signed allow is still returned; settlement_dispatched=0 with the error', async () => {
    const s = stack({
      settlementPost: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID());
    const v = verdictOf((await s.send(cart)).body);
    expect(v.verdict).toBe('allow');
    expect(s.cartRow(cart.body.mandate_hash)).toMatchObject({
      settlement_dispatched: 0,
      settlement_error: 'ECONNREFUSED',
      seller_notified: 1,
    });
  });

  it('settlement hangs: the firewall gives up at FIREWALL_DISPATCH_TIMEOUT_MS (worst case of the inequality)', async () => {
    const s = stack({ settlementPost: () => new Promise(() => {}), dispatchTimeoutMs: 50 });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID());
    const started = Date.now();
    const v = verdictOf((await s.send(cart)).body);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(v.verdict).toBe('allow');
    expect(s.cartRow(cart.body.mandate_hash)).toMatchObject({
      settlement_dispatched: 0,
      settlement_error: 'timeout after 50ms',
    });
  });

  it('settlement rejects with a signed error: recorded verbatim, allow still stands', async () => {
    // A settlement configured for a DIFFERENT firewall key: its boundary
    // answers our request with a signed SIG_INVALID error.
    const otherFirewallsSettlement = buildSettlementApp({
      db: openSettlementDb(':memory:'),
      now: NOW,
      razorpay: new SimulatedRazorpayClient(),
      signingKey: settlementKey,
      firewallPublicKey: generateKeyPair().publicKey,
      webhookSecret: 'x',
    });
    apps.push(otherFirewallsSettlement);
    const s = stack({
      settlementPost: async (_u, payload) => {
        const res = await otherFirewallsSettlement.inject({
          method: 'POST',
          url: '/acnp',
          payload,
        });
        return { status: res.statusCode, body: res.json() };
      },
    });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID());
    expect(verdictOf((await s.send(cart)).body).verdict).toBe('allow');
    expect(s.cartRow(cart.body.mandate_hash)?.settlement_error).toMatch(/^SIG_INVALID/);
  });

  it('seller unreachable: verdict still returned and dispatched; seller_notified=0', async () => {
    const s = stack({
      sellerPost: async () => {
        throw new Error('merchant down');
      },
    });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID());
    expect(verdictOf((await s.send(cart)).body).verdict).toBe('allow');
    expect(s.cartRow(cart.body.mandate_hash)).toMatchObject({
      settlement_dispatched: 1,
      seller_notified: 0,
      seller_error: 'merchant down',
    });
  });
});

/**
 * FEATURE-009 Gate 3 items 2–5 over HTTP: layer 2 recommends, the applier
 * narrows, the human queue decides exactly once. The verifier is a
 * scripted stub — what matters here is what the FIREWALL does with each
 * kind of answer, not what a model would say.
 */
describe(`${SERVICE_NAME} — layer 2 + the human queue (D021/D022)`, () => {
  async function held(o: StackOpts = {}) {
    const s = stack({
      verifier: verifierSaying(script('escalate', ['INTENT_DRIFT_QUANTITY'])),
      ...o,
    });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID(), { snapshot: HAMPER, unit: 400_000 });
    const v = verdictOf((await s.send(cart)).body);
    expect(v).toMatchObject({ verdict: 'escalate', layer: 'intent_verifier' });
    return { s, buyer, cart, hash: cart.body.mandate_hash };
  }

  it('clean allow recommendation → allow, layer intent_verifier, summary on the wire, attribution stored, order paid', async () => {
    const s = stack({
      verifier: verifierSaying(script('allow', [], 'a thoughtful handmade gift')),
    });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID());
    const v = verdictOf((await s.send(cart)).body);
    expect(v).toEqual({
      cart_mandate_hash: cart.body.mandate_hash,
      verdict: 'allow',
      layer: 'intent_verifier',
      reasons: [],
      verifier_summary: 'a thoughtful handmade gift',
    });
    const row = s.db
      .prepare('SELECT verifier_json FROM verdicts WHERE cart_mandate_hash = ?')
      .get(cart.body.mandate_hash) as { verifier_json: string };
    expect(JSON.parse(row.verifier_json)).toMatchObject({
      kind: 'recommendation',
      recommendation: 'allow',
      record: { model_id: 'stub/deterministic', used_llm: true },
    });
    await s.settlement.engine.drain();
    expect(s.settlement.engine.row(cart.body.mandate_hash)?.status).toBe('paid');
    expect((await s.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      intent_verifier: { provider: 'stub', model: 'stub/deterministic' },
      review: 'enabled',
      pending_escalations: 0,
    });
  });

  it('FLAGSHIP (semantic): every layer-1 number passes, verifier says block → block, reasons on the wire, nothing to settlement', async () => {
    // First audit (the hamper) → block; the follow-up compliant cart → allow.
    const s = stack({
      verifier: makeVerifier(
        new StubLlmAdapter((_req, call) =>
          call === 1
            ? script('block', ['INTENT_DRIFT_QUANTITY', 'INTENT_DRIFT_CATEGORY'], 'B2B bulk lot')
            : script('allow', []),
        ),
      ),
    });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID(), { snapshot: HAMPER, unit: 400_000 });
    const v = verdictOf((await s.send(cart)).body);
    expect(v).toMatchObject({
      verdict: 'block',
      layer: 'intent_verifier',
      reasons: ['INTENT_DRIFT_QUANTITY', 'INTENT_DRIFT_CATEGORY'],
      verifier_summary: 'B2B bulk lot',
    });
    await s.settlement.engine.drain();
    expect(s.razorpay.createCalls).toBe(0);
    expect(s.sellerInbox[0]!.body).toMatchObject({ verdict: 'block' });
    expect((await s.queue()).body.pending).toEqual([]);
    // A layer-2 block does not consume the mandate: a compliant cart can follow.
    expect(verdictOf((await s.send(buyer.cart(randomUUID()))).body).verdict).toBe('allow');
  });

  it('benign cart passes WITHOUT escalation under a sane verifier (false-block guard, Gate 3 item 3)', async () => {
    const s = stack({ verifier: verifierSaying(script('allow', [])) });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    expect(verdictOf((await s.send(buyer.cart(randomUUID()))).body).verdict).toBe('allow');
    expect((await s.queue()).body.pending).toEqual([]);
  });

  it('verifier never consulted when layer 1 blocks', async () => {
    let calls = 0;
    const counting: Verifier = {
      provider: 'spy',
      modelId: 'spy',
      verify: async () => {
        calls += 1;
        return {
          kind: 'absent',
          reason: 'x',
          record: { model_id: 'spy', used_llm: false, latency_ms: 0 },
        };
      },
    };
    const s = stack({ verifier: counting });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const v = verdictOf(
      (await s.send(buyer.cart(randomUUID(), { snapshot: RAM, unit: 450_000 }))).body,
    );
    expect(v).toMatchObject({ verdict: 'block', layer: 'policy', reasons: ['CATEGORY_BLOCKED'] });
    expect(calls).toBe(0);
  });

  it('verifier DOWN (throws) → escalate, never allow; hold visible in /health and /review; the ref is in review', async () => {
    const down: Verifier = {
      provider: 'gemini',
      modelId: 'gemini/x',
      verify: async () => ({
        kind: 'absent',
        reason: 'timeout: budget exhausted',
        record: {
          model_id: 'gemini/x',
          used_llm: false,
          failure_reason: 'timeout',
          latency_ms: 8000,
        },
      }),
    };
    const s = stack({ verifier: down });
    const buyer = new Buyer(makeIntentMandate(principal));
    await s.send(buyer.register());
    const cart = buyer.cart(randomUUID());
    const v = verdictOf((await s.send(cart)).body);
    expect(v).toMatchObject({ verdict: 'escalate', layer: 'intent_verifier', reasons: [] });
    await s.settlement.engine.drain();
    expect(s.razorpay.createCalls).toBe(0);
    expect(s.sellerInbox[0]!.body).toMatchObject({ verdict: 'escalate' });
    expect((await s.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      pending_escalations: 1,
    });
    const q = await s.queue();
    expect(q.body.pending).toHaveLength(1);
    expect(q.body.pending[0]).toMatchObject({
      cart_mandate_hash: cart.body.mandate_hash,
      goal: 'Anniversary gift for spouse — something thoughtful under budget',
      total: 417_276,
      line_items: [{ item_id: 'itm_vase', category: 'gifts', quantity: 1 }],
      details: [
        'intent-verifier absent: timeout: budget exhausted — held for a human, never allowed',
      ],
      verifier: { kind: 'absent' },
    });
    // While held, a second cart on the same ref cannot race it (FEATURE-008 #3).
    const second = verdictOf((await s.send(buyer.cart(randomUUID(), { unit: 400_000 }))).body);
    expect(second.reasons).toEqual(['MANDATE_IN_REVIEW']);
  });

  it('APPROVE: verdict seq 2 allow/human/HUMAN_APPROVED on /verdict, order paid, seller got both verdicts, queue empty', async () => {
    const { s, cart, hash } = await held();
    const res = await s.review(hash, {
      decision: 'approve',
      reviewer: 'sankalp',
      note: 'known client',
    });
    expect(res.status).toBe(200);
    const v = verdictOf(res.body['verdict'] as Message);
    expect(v).toMatchObject({ verdict: 'allow', layer: 'human', reasons: ['HUMAN_APPROVED'] });
    expect((res.body['verdict'] as Message).seq).toBe(2); // buyer stream: escalate was 1
    expect(await s.poll(hash)).toEqual(res.body['verdict']);
    await s.settlement.engine.drain();
    expect(s.settlement.engine.row(hash)?.status).toBe('paid');
    expect(s.sellerInbox.map((m) => (m.body as BodyOf<'firewall_verdict'>).verdict)).toEqual([
      'escalate',
      'allow',
    ]);
    expect(s.sellerInbox.map((m) => m.seq)).toEqual([1, 2]);
    expect(s.cartRow(hash)).toMatchObject({ settlement_dispatched: 1, seller_notified: 1 });
    expect((await s.queue()).body.pending).toEqual([]);
    expect(s.db.prepare('SELECT * FROM escalations').get()).toMatchObject({
      status: 'decided',
      decision: 'approve',
      reviewer: 'sankalp',
      note: 'known client',
    });
    expect(
      s.db.prepare('SELECT state FROM sessions WHERE session_id = ?').get(cart.session_id),
    ).toEqual({ state: 'SETTLING' });
  });

  it('REJECT: block/human/HUMAN_REJECTED; nothing to settlement; the mandate is free again', async () => {
    const { s, buyer, hash } = await held();
    const res = await s.review(hash, { decision: 'reject', reviewer: 'sankalp' });
    expect(res.status).toBe(200);
    expect(verdictOf(res.body['verdict'] as Message)).toMatchObject({
      verdict: 'block',
      layer: 'human',
      reasons: ['HUMAN_REJECTED'],
    });
    await s.settlement.engine.drain();
    expect(s.razorpay.createCalls).toBe(0);
    expect(s.verdictCount(hash)).toBe(2);
    // The scripted verifier escalates everything; the point is: not MANDATE_IN_REVIEW.
    expect(
      verdictOf((await s.send(buyer.cart(randomUUID(), { unit: 400_000 }))).body).verdict,
    ).toBe('escalate');
  });

  it('TIMEOUT (T10): past expires_at the poll returns block/human/ESCALATION_TIMEOUT; a late approve → 409 ALREADY_DECIDED, no third verdict', async () => {
    let t = NOW().getTime();
    const { s, hash } = await held({ now: () => new Date(t), escalationTimeoutSec: 600 });
    t += 599_000;
    expect((await s.poll(hash)).body).toMatchObject({ verdict: 'escalate' });
    t += 2_000; // 601 s: the hold is the sweep's now
    const v = await s.poll(hash);
    expect(verdictOf(v)).toMatchObject({
      verdict: 'block',
      layer: 'human',
      reasons: ['ESCALATION_TIMEOUT'],
    });
    const late = await s.review(hash, { decision: 'approve', reviewer: 'too-late' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'ALREADY_DECIDED' });
    expect(late.body['verdict']).toEqual(v);
    expect(s.verdictCount(hash)).toBe(2);
    await s.settlement.engine.drain();
    expect(s.razorpay.createCalls).toBe(0);
    expect(s.db.prepare('SELECT decision FROM escalations').get()).toEqual({ decision: 'timeout' });
  });

  it('RACE the other way: approved first, then the clock passes the deadline — the sweep does nothing', async () => {
    let t = NOW().getTime();
    const { s, hash } = await held({ now: () => new Date(t), escalationTimeoutSec: 600 });
    expect((await s.review(hash, { decision: 'approve', reviewer: 'sankalp' })).status).toBe(200);
    t += 3_600_000;
    await s.app.firewall.sweepExpired();
    expect((await s.poll(hash)).body).toMatchObject({
      verdict: 'allow',
      reasons: ['HUMAN_APPROVED'],
    });
    expect(s.verdictCount(hash)).toBe(2);
    expect(s.db.prepare('SELECT decision FROM escalations').get()).toEqual({ decision: 'approve' });
    // And a second human decision is refused too.
    expect((await s.review(hash, { decision: 'reject', reviewer: 'other' })).status).toBe(409);
  });

  it('the human sits below the policy: approve after the mandate expired → block with layer-1 reasons, no order', async () => {
    let t = NOW().getTime();
    const { s, hash } = await held({
      now: () => new Date(t),
      escalationTimeoutSec: 30 * 24 * 3600,
    });
    t = Date.parse('2026-09-02T00:00:00.000Z'); // fixture valid_until / deadline are 2026-09-01
    const res = await s.review(hash, { decision: 'approve', reviewer: 'sankalp' });
    expect(res.status).toBe(200);
    expect(verdictOf(res.body['verdict'] as Message)).toMatchObject({
      verdict: 'block',
      layer: 'policy',
      reasons: ['MANDATE_EXPIRED', 'DEADLINE_PASSED'],
    });
    await s.settlement.engine.drain();
    expect(s.razorpay.createCalls).toBe(0);
  });

  it('review gate: no token → 401; wrong body → 400; unknown hash → 404; token unset → 503', async () => {
    const { s, hash } = await held();
    expect((await s.review(hash, { decision: 'approve', reviewer: 'x' }, null)).status).toBe(401);
    expect((await s.review(hash, { decision: 'approve', reviewer: 'x' }, 'nope')).status).toBe(401);
    expect((await s.review(hash, { decision: 'maybe', reviewer: 'x' })).status).toBe(400);
    expect((await s.review(hash, { decision: 'approve' })).status).toBe(400);
    expect((await s.review('e'.repeat(64), { decision: 'approve', reviewer: 'x' })).status).toBe(
      404,
    );
    expect(s.verdictCount(hash)).toBe(1); // nothing above decided anything
    const closed = stack({ reviewToken: null });
    expect((await closed.app.inject({ method: 'GET', url: '/review' })).statusCode).toBe(503);
    expect((await closed.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      review: 'disabled (FIREWALL_REVIEW_TOKEN unset)',
    });
  });

  it('idempotent re-send of a held cart returns the escalate verdict; no second hold', async () => {
    const { s, buyer, cart, hash } = await held();
    const resent = buildMessage('cart_mandate', 'buyer', cart.body, buyer.key, {
      session_id: cart.session_id,
      seq: buyer.next(cart.session_id),
      timestamp: NOW().toISOString(),
      agent_id: buyer.agentId,
    });
    expect(verdictOf((await s.send(resent)).body).verdict).toBe('escalate');
    expect((await s.queue()).body.pending).toHaveLength(1);
    expect(s.verdictCount(hash)).toBe(1);
  });
});
