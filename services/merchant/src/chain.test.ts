import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  hashCanonical,
  type BodyOf,
  type CatalogItem,
  type KeyPair,
  type Message,
  type MessageType,
} from '@negotiator/protocol';
import { buildMessage } from '@negotiator/protocol/fixtures';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import type { ChainConfig, GetFn } from './handlers.js';
import { DEFAULT_POLICY } from './policy.js';
import { askPrice } from './strategy.js';

/**
 * FEATURE-008, seller side of F1 steps 6–8: after AGREED the merchant
 * verifies the buyer's cart copy against what it actually agreed and
 * served, accepts the firewall's verdict only from the configured firewall
 * key, and polls settlement for the signed receipt.
 */
const NOW = () => new Date('2026-08-26T10:00:00.000Z');
const firewall = generateKeyPair();
const settlementKey = generateKeyPair();

function makeStack(over: { chain?: ChainConfig; get?: GetFn; now?: () => Date } = {}) {
  const db = openDb(':memory:');
  const now = over.now ?? NOW;
  const get: GetFn = over.get ?? (async () => ({ status: 404, body: { error: 'unknown' } }));
  const app = buildApp({
    db,
    now,
    chain: over.chain ?? {
      firewallPublicKey: firewall.publicKey,
      settlement: {
        url: 'http://settlement.test',
        publicKey: settlementKey.publicKey,
        get,
        intervalMs: 1,
        timeoutMs: 1000,
        sleep: async () => {},
      },
    },
  });
  apps.push(app);
  const buyer = generateKeyPair();
  const session = randomUUID();
  const seqs = new Map<string, number>();
  const next = (who: string) => {
    const n = (seqs.get(who) ?? 0) + 1;
    seqs.set(who, n);
    return n;
  };
  const send = async <T extends MessageType>(
    type: T,
    role: 'buyer' | 'firewall',
    body: BodyOf<T>,
    key: KeyPair = role === 'buyer' ? buyer : firewall,
  ) => {
    const msg = buildMessage(type, role, body, key, {
      session_id: session,
      seq: next(role),
      timestamp: now().toISOString(),
      agent_id: role === 'buyer' ? 'buyer-demo' : 'firewall-demo',
    });
    const res = await app.inject({ method: 'POST', url: '/acnp', payload: msg });
    return {
      status: res.statusCode,
      reply: res.statusCode === 204 ? null : (res.json() as Message),
      sent: msg,
    };
  };
  const row = () =>
    db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session) as {
      state: string;
      cart_mandate_hash: string | null;
      verdict: string | null;
      settlement_status: string | null;
      razorpay_order_id: string | null;
    };
  /** §6: a message rejected at the boundary consumed nothing — the sender retries the same seq. */
  const rewind = (role: string) => seqs.set(role, (seqs.get(role) ?? 1) - 1);
  return { app, db, buyer, session, send, row, rewind };
}

type Stack = ReturnType<typeof makeStack>;

/** session_init → catalog → offer at ask(1) → seller accepts: AGREED. */
async function reachAgreed(s: Stack) {
  await s.send('session_init', 'buyer', {
    buyer_public_key: s.buyer.publicKey,
    supported_versions: ['0.1'],
    intent_mandate_ref: hashCanonical({ demo: true }),
  });
  const cat = await s.send('catalog_request', 'buyer', { category: 'gifts' });
  const vase = (cat.reply!.body as BodyOf<'catalog_offer'>).items.find(
    (i) => i.item_id === 'itm_vase',
  )!;
  const ask = askPrice(
    { list_price: 480_000, floor_price: 360_000, category: 'gifts' },
    1,
    DEFAULT_POLICY,
  );
  const offer = await s.send('offer', 'buyer', {
    line_items: [
      { item_id: 'itm_vase', variant_id: 'var_vase_ash', quantity: 1, proposed_unit_price: ask },
    ],
    total: ask,
    round: 1,
  });
  expect(offer.reply?.type).toBe('accept');
  expect(s.row().state).toBe('AGREED');
  return { vase, ask, acceptId: offer.reply!.message_id };
}

function cartBody(
  vase: CatalogItem,
  ask: number,
  acceptId: string,
  over: Record<string, unknown> = {},
) {
  const { catalog_hash, ...snapshot } = vase;
  const body = {
    intent_mandate_ref: hashCanonical({ demo: true }),
    accepted_message_id: acceptId,
    line_items: [
      {
        item_id: 'itm_vase',
        variant_id: 'var_vase_ash',
        quantity: 1,
        unit_price: ask,
        catalog_hash,
        catalog_item: snapshot,
      },
    ],
    total: ask,
    currency: 'INR' as const,
    seller_agent_id: 'merchant-demo',
    buyer_agent_id: 'buyer-demo',
    ...over,
  };
  return { ...body, mandate_hash: hashCanonical(body) } as BodyOf<'cart_mandate'>;
}

function receiptFor(hash: string, status: 'paid' | 'failed' = 'paid') {
  return buildMessage(
    'settlement_receipt',
    'settlement',
    {
      mandate_hash: hash,
      razorpay_order_id: 'order_sim_000001',
      status,
      amount: 1,
      currency: 'INR',
      ledger_entry_hash: 'b'.repeat(64),
    },
    settlementKey,
    {
      session_id: randomUUID(),
      seq: 1,
      timestamp: NOW().toISOString(),
      agent_id: 'settlement-demo',
    },
  );
}

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('merchant — cart copy (§7.8) and verdict (§7.9)', () => {
  it('a faithful cart copy → 204, COMPLIANCE_REVIEW; allow from the firewall key → SETTLING → receipt → SETTLED', async () => {
    let served: Message | null = null;
    const s = makeStack({
      get: async () => ({ status: 200, body: JSON.parse(JSON.stringify(served)) }),
    });
    const { vase, ask, acceptId } = await reachAgreed(s);
    const cart = cartBody(vase, ask, acceptId);
    served = receiptFor(cart.mandate_hash);
    const res = await s.send('cart_mandate', 'buyer', cart);
    expect(res.status).toBe(204);
    expect(s.row()).toMatchObject({
      state: 'COMPLIANCE_REVIEW',
      cart_mandate_hash: cart.mandate_hash,
    });

    const v = await s.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: cart.mandate_hash,
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    expect(v.status).toBe(204);
    await s.app.handlers.drain();
    expect(s.row()).toMatchObject({
      state: 'SETTLED',
      verdict: 'allow',
      settlement_status: 'paid',
      razorpay_order_id: 'order_sim_000001',
    });
  });

  it('escalate → held in COMPLIANCE_REVIEW; the human allow (seq 2) → SETTLING → SETTLED; who decided is on the row', async () => {
    let served: Message | null = null;
    const s = makeStack({
      get: async () => ({ status: 200, body: JSON.parse(JSON.stringify(served)) }),
    });
    const { vase, ask, acceptId } = await reachAgreed(s);
    const cart = cartBody(vase, ask, acceptId);
    served = receiptFor(cart.mandate_hash);
    await s.send('cart_mandate', 'buyer', cart);
    const hold = await s.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: cart.mandate_hash,
      verdict: 'escalate',
      layer: 'intent_verifier',
      reasons: ['INTENT_DRIFT_QUANTITY'],
      verifier_summary: 'looks like a bulk lot',
    });
    expect(hold.status).toBe(204);
    await s.app.handlers.drain();
    expect(s.row()).toMatchObject({
      state: 'COMPLIANCE_REVIEW',
      verdict: 'escalate',
      settlement_status: null,
    });
    const human = await s.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: cart.mandate_hash,
      verdict: 'allow',
      layer: 'human',
      reasons: ['HUMAN_APPROVED'],
    });
    expect(human.status).toBe(204);
    expect(human.sent.seq).toBe(2);
    await s.app.handlers.drain();
    expect(s.row()).toMatchObject({
      state: 'SETTLED',
      verdict: 'allow',
      settlement_status: 'paid',
    });
    const who = s.db
      .prepare('SELECT verdict_layer, verdict_reasons_json FROM sessions WHERE session_id = ?')
      .get(s.session);
    expect(who).toEqual({ verdict_layer: 'human', verdict_reasons_json: '["HUMAN_APPROVED"]' });
  });

  it('escalate → human reject / timeout → BLOCKED, nothing polled', async () => {
    for (const reason of ['HUMAN_REJECTED', 'ESCALATION_TIMEOUT']) {
      const s = makeStack();
      const { vase, ask, acceptId } = await reachAgreed(s);
      const cart = cartBody(vase, ask, acceptId);
      await s.send('cart_mandate', 'buyer', cart);
      await s.send('firewall_verdict', 'firewall', {
        cart_mandate_hash: cart.mandate_hash,
        verdict: 'escalate',
        layer: 'intent_verifier',
        reasons: [],
      });
      await s.send('firewall_verdict', 'firewall', {
        cart_mandate_hash: cart.mandate_hash,
        verdict: 'block',
        layer: 'human',
        reasons: [reason],
      });
      await s.app.handlers.drain();
      expect(s.row(), reason).toMatchObject({
        state: 'BLOCKED',
        verdict: 'block',
        settlement_status: null,
      });
    }
  });

  it('block → BLOCKED, nothing polled', async () => {
    const s = makeStack();
    const { vase, ask, acceptId } = await reachAgreed(s);
    const cart = cartBody(vase, ask, acceptId);
    await s.send('cart_mandate', 'buyer', cart);
    await s.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: cart.mandate_hash,
      verdict: 'block',
      layer: 'policy',
      reasons: ['CATEGORY_BLOCKED'],
    });
    await s.app.handlers.drain();
    expect(s.row()).toMatchObject({ state: 'BLOCKED', verdict: 'block', settlement_status: null });
  });

  it('a cart naming a different accept, different terms, or a relabelled snapshot → ACCEPT_MISMATCH (fatal)', async () => {
    for (const twist of ['accept', 'price', 'snapshot'] as const) {
      const s = makeStack();
      const { vase, ask, acceptId } = await reachAgreed(s);
      const cart =
        twist === 'accept'
          ? cartBody(vase, ask, randomUUID())
          : twist === 'price'
            ? cartBody(vase, ask - 1, acceptId)
            : cartBody({ ...vase, category: 'jewellery' }, ask, acceptId); // hash still the served one
      const res = await s.send('cart_mandate', 'buyer', cart);
      expect(res.reply?.type).toBe('error');
      expect((res.reply!.body as BodyOf<'error'>).code, twist).toBe('ACCEPT_MISMATCH');
      expect(s.row().state).toBe('FAILED');
    }
  });

  it('cart before AGREED → STATE_INVALID; verdict for another cart → STATE_INVALID', async () => {
    const s = makeStack();
    await s.send('session_init', 'buyer', {
      buyer_public_key: s.buyer.publicKey,
      supported_versions: ['0.1'],
      intent_mandate_ref: hashCanonical({ demo: true }),
    });
    const early = await s.send(
      'cart_mandate',
      'buyer',
      cartBody({ ...FAKE_VASE }, 1, randomUUID()),
    );
    expect((early.reply!.body as BodyOf<'error'>).code).toBe('STATE_INVALID');

    const s2 = makeStack();
    const { vase, ask, acceptId } = await reachAgreed(s2);
    await s2.send('cart_mandate', 'buyer', cartBody(vase, ask, acceptId));
    const wrong = await s2.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: 'c'.repeat(64),
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    expect((wrong.reply!.body as BodyOf<'error'>).code).toBe('STATE_INVALID');
    expect(s2.row().state).toBe('FAILED'); // fatal code closes the session
  });

  it('a verdict signed by anything but the configured firewall key → SIG_INVALID; unconfigured key → SESSION_UNKNOWN', async () => {
    let served: Message | null = null;
    const s = makeStack({
      get: async () => ({ status: 200, body: JSON.parse(JSON.stringify(served)) }),
    });
    const { vase, ask, acceptId } = await reachAgreed(s);
    const cart = cartBody(vase, ask, acceptId);
    served = receiptFor(cart.mandate_hash);
    await s.send('cart_mandate', 'buyer', cart);
    const forged = await s.send(
      'firewall_verdict',
      'firewall',
      { cart_mandate_hash: cart.mandate_hash, verdict: 'allow', layer: 'policy', reasons: [] },
      generateKeyPair(),
    );
    expect((forged.reply!.body as BodyOf<'error'>).code).toBe('SIG_INVALID');
    // BUG-004: an unauthenticated message neither advances state nor burns
    // the seller's stream — the real verdict still lands afterwards.
    expect(s.row().state).toBe('COMPLIANCE_REVIEW');
    expect(forged.reply!.seq).toBe(1);
    s.rewind('firewall'); // nothing was consumed (§6): the real firewall still sends seq 1
    const real = await s.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: cart.mandate_hash,
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    expect(real.status).toBe(204);
    await s.app.handlers.drain();
    expect(s.row().state).toBe('SETTLED');

    const bare = makeStack({ chain: {} });
    const agreed = await reachAgreed(bare);
    const c2 = cartBody(agreed.vase, agreed.ask, agreed.acceptId);
    await bare.send('cart_mandate', 'buyer', c2);
    const v = await bare.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: c2.mandate_hash,
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    expect((v.reply!.body as BodyOf<'error'>).code).toBe('SESSION_UNKNOWN');
    expect((await bare.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      firewall_key_configured: false,
      settlement_key_configured: false,
    });
  });

  it('receipt poll: a receipt with a bad signature is rejected; a timeout leaves SETTLING/pending', async () => {
    let t = NOW().getTime();
    const forgedReceipt = receiptFor('d'.repeat(64));
    const s = makeStack({
      now: () => new Date(t),
      get: async () => {
        t += 400; // each poll costs 400ms of fake time; timeout is 1000ms
        return { status: 200, body: JSON.parse(JSON.stringify(forgedReceipt)) };
      },
    });
    const { vase, ask, acceptId } = await reachAgreed(s);
    const cart = cartBody(vase, ask, acceptId);
    await s.send('cart_mandate', 'buyer', cart);
    await s.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: cart.mandate_hash,
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    await s.app.handlers.drain();
    // Signed by the right key but for a different mandate hash → rejected.
    expect(s.row()).toMatchObject({ state: 'SETTLING', settlement_status: 'receipt_invalid' });

    let t2 = NOW().getTime();
    const s2 = makeStack({
      now: () => new Date(t2),
      get: async () => {
        t2 += 400;
        return { status: 200, body: { status: 'pending' } };
      },
    });
    const a2 = await reachAgreed(s2);
    const c2 = cartBody(a2.vase, a2.ask, a2.acceptId);
    await s2.send('cart_mandate', 'buyer', c2);
    await s2.send('firewall_verdict', 'firewall', {
      cart_mandate_hash: c2.mandate_hash,
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
    });
    await s2.app.handlers.drain();
    expect(s2.row()).toMatchObject({ state: 'SETTLING', settlement_status: 'pending' });
  });
});

const FAKE_VASE: CatalogItem = {
  item_id: 'itm_vase',
  title: 'x',
  description: 'x',
  category: 'gifts',
  variants: [{ variant_id: 'var_vase_ash', attributes: {}, list_price: 1, stock: 1 }],
  catalog_hash: 'a'.repeat(64),
};
