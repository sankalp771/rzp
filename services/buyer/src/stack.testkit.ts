import { generateKeyPair, type Message } from '@negotiator/protocol';
import type { LlmAdapter } from '@negotiator/llm';
import { buildApp as buildFirewallApp } from '../../firewall/src/app.js';
import { openDb as openFirewallDb, type FirewallDb } from '../../firewall/src/db.js';
import { makeVerifier } from '../../firewall/src/intent.js';
import { DEFAULT_POLICY } from '../../firewall/src/policy.js';
import { buildApp as buildMerchantApp } from '../../merchant/src/app.js';
import { openDb as openMerchantDb, type MerchantDb } from '../../merchant/src/db.js';
import { buildApp as buildSettlementApp } from '../../settlement/src/app.js';
import { openDb as openSettlementDb, type SettlementDb } from '../../settlement/src/db.js';
import { SimulatedRazorpayClient } from '../../settlement/src/razorpay.js';
import { buildApp } from './app.js';
import { openDb, type BuyerDb } from './db.js';
import { seedDemoMandate } from './mandate.js';
import type { PostFn, RunResult } from './runner.js';

/**
 * The whole system in one process (Gate 6 shape): merchant, firewall,
 * settlement (simulated Razorpay, self-signed webhook) and buyer, wired
 * through the same transport seams production uses, routed by URL. Every
 * expected number in the E2E suites derives from published curve formulas.
 * Not a test file (no describe) — excluded from the build by tsconfig.
 */

export const NOW = () => new Date('2026-08-25T10:00:00.000Z');
export const TOKEN = 'test-control-token';
export const REVIEW_TOKEN = 'test-review-token';
export const DASHBOARD_TOKEN = 'test-dashboard-token';
export const principal = generateKeyPair();
const firewallKey = generateKeyPair();
const settlementKey = generateKeyPair();

export const MERCHANT_URL = 'http://merchant.test';
export const FIREWALL_URL = 'http://firewall.test';
export const SETTLEMENT_URL = 'http://settlement.test';

export interface StackOptions {
  budget?: number;
  /** Tamper/replay the merchant's replies (call index counts merchant posts only). */
  tamper?: (reply: Message, callIndex: number) => Message;
  replayCall?: number;
  /** Tamper what the firewall receives (the cart between buyer and firewall). */
  tamperToFirewall?: (payload: Message) => Message;
  firewallDown?: boolean;
  buyerLlm?: LlmAdapter;
  sellerLlm?: LlmAdapter;
  /** The firewall's layer 2 (FEATURE-009); absent = not_configured, layer 1 only. */
  firewallLlm?: LlmAdapter;
  velocityMax?: number;
  /** A fixed mandate for every run on this stack (proves single-use). */
  mandateOverrides?: Record<string, unknown>;
  /** Mutable clock for every service (default: frozen at NOW). */
  now?: () => Date;
  escalationTimeoutSec?: number;
  /** How long the buyer waits on a hold before reporting `pending`. */
  verdictPollTimeoutMs?: number;
}

export interface Stack {
  merchantDb: MerchantDb;
  buyerDb: BuyerDb;
  firewallDb: FirewallDb;
  settlementDb: SettlementDb;
  razorpay: SimulatedRazorpayClient;
  run: (
    payload?: object,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; result: RunResult }>;
  /** The human queue, as the dashboard / review.mjs would drive it. */
  pending: () => Promise<{ cart_mandate_hash: string; reasons: string[] }[]>;
  review: (
    hash: string,
    decision: 'approve' | 'reject',
    reviewer?: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Poll the queue until one hold appears, then decide it (runs beside a run()). */
  decideWhenHeld: (decision: 'approve' | 'reject') => Promise<string>;
  /** Operator API GET on a party (`/ledger?…`, `/ledger/verify`, `/sessions`), token injected. */
  api: (
    party: 'merchant' | 'buyer' | 'firewall' | 'settlement',
    path: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Await the merchant's background receipt poll. */
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

export async function makeStack(opts: StackOptions = {}): Promise<Stack> {
  const NOW_ = opts.now ?? NOW;
  const settlementDb = openSettlementDb(':memory:');
  const razorpay = new SimulatedRazorpayClient();
  const settlement = buildSettlementApp({
    db: settlementDb,
    now: NOW_,
    razorpay,
    signingKey: settlementKey,
    firewallPublicKey: firewallKey.publicKey,
    webhookSecret: 'whsec_test',
    paymentSimulation: true,
    retry: { maxAttempts: 2, baseMs: 1 },
    sleep: async () => {},
    dashboardToken: DASHBOARD_TOKEN,
  });
  const settlementGet = async (url: string) => {
    const path = url.replace(SETTLEMENT_URL, '');
    const res = await settlement.inject({ method: 'GET', url: path });
    return { status: res.statusCode, body: res.json() as unknown };
  };

  const merchantDb = openMerchantDb(':memory:');
  const merchant = buildMerchantApp({
    db: merchantDb,
    now: NOW_,
    dashboardToken: DASHBOARD_TOKEN,
    ...(opts.sellerLlm ? { llm: opts.sellerLlm } : {}),
    chain: {
      firewallPublicKey: firewallKey.publicKey,
      settlement: {
        url: SETTLEMENT_URL,
        publicKey: settlementKey.publicKey,
        get: settlementGet,
        intervalMs: 1,
        timeoutMs: 1000,
        sleep: async () => {},
      },
    },
  });

  const firewallDb = openFirewallDb(':memory:');
  const firewall = buildFirewallApp({
    db: firewallDb,
    now: NOW_,
    signingKey: firewallKey,
    principalKeys: [principal.publicKey],
    policy: { ...DEFAULT_POLICY, ...(opts.velocityMax ? { velocityMax: opts.velocityMax } : {}) },
    settlementUrl: SETTLEMENT_URL,
    merchantUrl: MERCHANT_URL,
    post: async (url, payload) => {
      const app = url.startsWith(SETTLEMENT_URL) ? settlement : merchant;
      const res = await app.inject({ method: 'POST', url: '/acnp', payload });
      return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
    },
    dispatchTimeoutMs: 1000,
    notifyTimeoutMs: 1000,
    verifier: opts.firewallLlm
      ? makeVerifier(opts.firewallLlm, () => NOW_().getTime())
      : 'not_configured',
    reviewToken: REVIEW_TOKEN,
    escalationTimeoutSec: opts.escalationTimeoutSec ?? 600,
    sweepIntervalMs: 0,
    dashboardToken: DASHBOARD_TOKEN,
  });
  const reviewHeaders = { 'x-review-token': REVIEW_TOKEN };
  const pending = async () => {
    const res = await firewall.inject({ method: 'GET', url: '/review', headers: reviewHeaders });
    return (res.json() as { pending: { cart_mandate_hash: string; reasons: string[] }[] }).pending;
  };
  const review = async (hash: string, decision: 'approve' | 'reject', reviewer = 'sankalp') => {
    const res = await firewall.inject({
      method: 'POST',
      url: `/review/${hash}`,
      headers: reviewHeaders,
      payload: { decision, reviewer },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  const buyerDb = openDb(':memory:');
  const mandate = seedDemoMandate(principal, NOW_, {
    ...(opts.budget !== undefined ? { budget_ceiling: opts.budget } : {}),
    ...(opts.mandateOverrides ?? {}),
  });

  let merchantCalls = 0;
  let lastBody: unknown = null;
  const post: PostFn = async (url, payload) => {
    if (url.startsWith(FIREWALL_URL)) {
      if (opts.firewallDown) throw new Error('ECONNREFUSED firewall');
      const sent = opts.tamperToFirewall ? opts.tamperToFirewall(payload as Message) : payload;
      const res = await firewall.inject({ method: 'POST', url: '/acnp', payload: sent });
      return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
    }
    merchantCalls += 1;
    if (opts.replayCall === merchantCalls && lastBody !== null) {
      return { status: 200, body: lastBody }; // adversary replays the previous reply
    }
    const res = await merchant.inject({ method: 'POST', url: '/acnp', payload });
    let body: unknown = res.statusCode === 204 ? null : res.json();
    if (body !== null && opts.tamper) body = opts.tamper(body as Message, merchantCalls);
    if (body !== null) lastBody = body;
    return { status: res.statusCode, body };
  };

  const buyer = buildApp({
    db: buyerDb,
    now: NOW_,
    post,
    mandate,
    controlToken: TOKEN,
    dashboardToken: DASHBOARD_TOKEN,
    ...(opts.buyerLlm ? { llm: opts.buyerLlm } : {}),
    chain: {
      firewallUrl: FIREWALL_URL,
      firewallPublicKey: firewallKey.publicKey,
      settlementUrl: SETTLEMENT_URL,
      settlementPublicKey: settlementKey.publicKey,
      get: async (url) => {
        if (url.startsWith(FIREWALL_URL)) {
          const res = await firewall.inject({ method: 'GET', url: url.replace(FIREWALL_URL, '') });
          return { status: res.statusCode, body: res.json() as unknown };
        }
        return settlementGet(url);
      },
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      verdictPollTimeoutMs: opts.verdictPollTimeoutMs ?? 1000,
      // A macrotask yield, not a no-op: the buyer's poll loop must let a
      // concurrently "deciding human" (decideWhenHeld) get the event loop.
      sleep: () => new Promise((r) => setImmediate(r)),
    },
  });
  return {
    merchantDb,
    buyerDb,
    firewallDb,
    settlementDb,
    razorpay,
    pending,
    review,
    api: async (party, path) => {
      const app = { merchant, buyer, firewall, settlement }[party];
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: { 'x-dashboard-token': DASHBOARD_TOKEN },
      });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    },
    decideWhenHeld: async (decision) => {
      // The buyer polls /verdict with a no-op sleep, so every await here
      // interleaves with its loop — a human deciding mid-run, in one process.
      for (let i = 0; i < 10_000; i++) {
        const held = await pending();
        if (held.length > 0) {
          const hash = held[0]!.cart_mandate_hash;
          const res = await review(hash, decision);
          if (res.status !== 200) throw new Error(`review failed: ${JSON.stringify(res.body)}`);
          return hash;
        }
        await new Promise((r) => setImmediate(r));
      }
      throw new Error('nothing was ever held');
    },
    run: async (payload = {}, headers = { 'x-control-token': TOKEN }) => {
      const res = await buyer.inject({
        method: 'POST',
        url: '/control/run',
        headers,
        payload: { merchant_url: MERCHANT_URL, ...payload },
      });
      // Settlement's async settle → receipt must be observable before the buyer polls;
      // under inject the self-signed webhook runs on the next tick, which the poll
      // loop's awaits already yield to.
      return { status: res.statusCode, result: res.json() as RunResult };
    },
    drain: async () => {
      await settlement.engine.drain();
      await merchant.handlers.drain();
    },
    close: async () => {
      await merchant.close();
      await firewall.close();
      await settlement.close();
      await buyer.close();
    },
  };
}
