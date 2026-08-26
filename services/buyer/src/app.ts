import Fastify from 'fastify';
import { createAdapterFromEnv, type LlmAdapter } from '@negotiator/llm';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  hashCanonical,
  type IntentMandate,
} from '@negotiator/protocol';
import { openDb, type BuyerDb } from './db.js';
import { seedDemoMandate, verifyIntentMandate } from './mandate.js';
import { BuyerRunner, type BuyerChainConfig, type GetFn, type PostFn } from './runner.js';

export const SERVICE_NAME = 'buyer';

export interface AppOptions {
  db?: BuyerDb;
  /** Injectable clock for tests (drives skew checks and message timestamps). */
  now?: () => Date;
  /** Transport override for tests; defaults to fetch. */
  post?: PostFn;
  /** Mandate override for tests; defaults to env-driven loading. */
  mandate?: IntentMandate;
  controlToken?: string;
  /** Buyer model override for tests; defaults to BUYER_LLM_PROVIDER (D015). */
  llm?: LlmAdapter;
  /** Firewall + settlement addressing/keys/polling; defaults to env + fetch. */
  chain?: BuyerChainConfig;
}

/**
 * Buyer Agent (S2). Not an ACNP server — the buyer is the HTTP client under
 * the sync binding (D013). It exposes:
 *   GET  /health       — liveness
 *   POST /control/run  — trigger one run (returns the full signed transcript)
 *
 * /control/run is an internal control-plane endpoint that starts a spending
 * workflow, so it is gated by a shared-secret header (`x-control-token`
 * must equal CONTROL_TOKEN): without the token configured the endpoint
 * refuses to serve at all. This is deliberate demo-grade auth — see
 * THREAT_MODEL.md non-goals — and doubles as the seam the evals harness
 * (Day 11) calls. It also refuses without a firewall to register with
 * (D010): the buyer never negotiates unregistered.
 */
export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const db = opts.db ?? openDb();
  const controlToken = opts.controlToken ?? process.env['CONTROL_TOKEN'];

  // Boot gate (D010): a configured-but-invalid mandate refuses to serve —
  // an agent that cannot prove its authorization must not spend. A missing
  // mandate is tolerated at boot (health stays up; /control/run 503s) so
  // that key-less environments like CI can still run the stack.
  const source = mandateSource(opts, app.log);
  if (source) {
    const check = verifyIntentMandate(source.mandate(), opts.now);
    if (!check.ok) throw new Error(`refusing to start: Intent Mandate invalid — ${check.reason}`);
  }
  // A named provider without its key throws here — boot refuses (D015).
  const llm = opts.llm ?? createAdapterFromEnv('BUYER');
  app.log.info({ llm: { provider: llm.provider, model: llm.modelId } }, 'buyer model');
  const chain = opts.chain ?? chainFromEnv(process.env);
  if (!chain) {
    app.log.warn(
      {},
      'FIREWALL_URL/FIREWALL_PUBLIC_KEY/SETTLEMENT_URL/SETTLEMENT_PUBLIC_KEY incomplete: /control/run disabled',
    );
  }

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    // Effective model, so a demo can never quietly run on the stub (D015).
    llm: { provider: llm.provider, model: llm.modelId },
    mandate: source?.kind ?? 'none',
    chain_configured: Boolean(chain),
  }));

  app.post('/control/run', async (req, reply) => {
    if (!controlToken) {
      return reply
        .code(503)
        .send({ error: 'CONTROL_TOKEN not configured; control plane disabled' });
    }
    if (req.headers['x-control-token'] !== controlToken) {
      return reply.code(401).send({ error: 'invalid control token' });
    }
    if (!source) {
      return reply.code(503).send({
        error: 'no Intent Mandate configured (set PRINCIPAL_* keys or INTENT_MANDATE_JSON)',
      });
    }
    if (!chain) {
      return reply.code(503).send({
        error:
          'firewall/settlement not configured (FIREWALL_URL, FIREWALL_PUBLIC_KEY, SETTLEMENT_URL, SETTLEMENT_PUBLIC_KEY) — the buyer does not negotiate unregistered (D010)',
      });
    }
    const body = (req.body ?? {}) as { merchant_url?: string; target_variant_id?: string };
    const merchantUrl = body.merchant_url ?? process.env['MERCHANT_URL'] ?? 'http://merchant:4001';
    const mandate = source.mandate();
    const runner = new BuyerRunner({
      db,
      mandate,
      mandateRef: hashCanonical(mandate),
      agentId: process.env['BUYER_AGENT_ID'] ?? 'buyer-demo',
      post: opts.post ?? fetchPost,
      chain,
      log: app.log,
      ...(opts.now ? { now: opts.now } : {}),
      clockSkewSec: Number(process.env['CLOCK_SKEW_SEC'] ?? 120),
      llm,
    });
    const result = await runner.run({
      merchantUrl,
      ...(body.target_variant_id ? { targetVariantId: body.target_variant_id } : {}),
    });
    if (source.kind === 'demo-seed') {
      result.notes.unshift(
        'demo seed: a fresh Intent Mandate was signed for this run (one mandate, one purchase — §7.9)',
      );
    }
    return reply.code(200).send(result);
  });

  return app;
}

/**
 * Mandate sources, in priority order: explicit option (tests) →
 * INTENT_MANDATE_JSON (a principal-signed artifact provided from outside —
 * the real-design shape, single-use like any real authorization) → demo
 * seed signed with PRINCIPAL_* env keys, re-signed FRESH PER RUN because a
 * mandate is consumed by its first allow (§7.9) and the demo runs many
 * times (DEMO ONLY: the principal key does not belong next to the agent;
 * see mandate.ts and THREAT_MODEL.md non-goals).
 */
function mandateSource(
  opts: AppOptions,
  log: { warn: (o: object, m?: string) => void },
): { kind: 'option' | 'json' | 'demo-seed'; mandate: () => IntentMandate } | undefined {
  if (opts.mandate) {
    const m = opts.mandate;
    return { kind: 'option', mandate: () => m };
  }
  const json = process.env['INTENT_MANDATE_JSON'];
  if (json) {
    let parsed: IntentMandate;
    try {
      parsed = JSON.parse(json) as IntentMandate;
    } catch {
      throw new Error('refusing to start: INTENT_MANDATE_JSON is not valid JSON');
    }
    return { kind: 'json', mandate: () => parsed };
  }
  const priv = process.env['PRINCIPAL_PRIVATE_KEY'];
  const pub = process.env['PRINCIPAL_PUBLIC_KEY'];
  if (priv && pub) {
    return {
      kind: 'demo-seed',
      mandate: () => seedDemoMandate({ privateKey: priv, publicKey: pub }, opts.now),
    };
  }
  log.warn({}, 'no Intent Mandate configured — /control/run will refuse until one is provided');
  return undefined;
}

/** All four values or nothing: a half-configured chain is a misconfiguration, not a mode. */
function chainFromEnv(env: Record<string, string | undefined>): BuyerChainConfig | undefined {
  const firewallUrl = env['FIREWALL_URL'];
  const firewallPublicKey = env['FIREWALL_PUBLIC_KEY'];
  const settlementUrl = env['SETTLEMENT_URL'];
  const settlementPublicKey = env['SETTLEMENT_PUBLIC_KEY'];
  if (!firewallUrl || !firewallPublicKey || !settlementUrl || !settlementPublicKey)
    return undefined;
  return {
    firewallUrl,
    firewallPublicKey,
    settlementUrl,
    settlementPublicKey,
    get: fetchGet,
    pollIntervalMs: Number(env['RECEIPT_POLL_INTERVAL_MS'] ?? 500),
    pollTimeoutMs: Number(env['RECEIPT_POLL_TIMEOUT_MS'] ?? 60_000),
  };
}

/**
 * Sync-binding latency inequality (FEATURE-006 #1, FEATURE-008 #4): the
 * seller's LLM proposal runs INSIDE the merchant's HTTP reply
 * (LLM_TOTAL_BUDGET_MS, 12s incl. retries), and the firewall's settlement
 * dispatch + seller notification run INSIDE its verdict reply
 * (FIREWALL_DISPATCH_TIMEOUT_MS 8s + FIREWALL_NOTIFY_TIMEOUT_MS 5s). This
 * client timeout must exceed each of those plus processing:
 *   BUYER_HTTP_TIMEOUT_MS (30 000) > 12 000 + processing
 *   BUYER_HTTP_TIMEOUT_MS (30 000) > 8 000 + 5 000 + processing
 * If any of these env values changes, keep both inequalities — FLOW.md F1.
 */
const BUYER_HTTP_TIMEOUT_MS = Number(process.env['BUYER_HTTP_TIMEOUT_MS'] ?? 30_000);

const fetchPost: PostFn = async (url, payload) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(BUYER_HTTP_TIMEOUT_MS),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const fetchGet: GetFn = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(BUYER_HTTP_TIMEOUT_MS) });
  return { status: res.status, body: await res.json() };
};
