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
import { BuyerRunner, type PostFn } from './runner.js';

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
}

/**
 * Buyer Agent (S2). Not an ACNP server — the buyer is the HTTP client under
 * the sync binding (D013). It exposes:
 *   GET  /health       — liveness
 *   POST /control/run  — trigger one negotiation run (returns the transcript)
 *
 * /control/run is an internal control-plane endpoint that starts a spending
 * workflow, so it is gated by a shared-secret header (`x-control-token`
 * must equal CONTROL_TOKEN): without the token configured the endpoint
 * refuses to serve at all. This is deliberate demo-grade auth — see
 * THREAT_MODEL.md non-goals — and doubles as the seam the evals harness
 * (Day 11) calls.
 */
export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const db = opts.db ?? openDb();
  const controlToken = opts.controlToken ?? process.env['CONTROL_TOKEN'];

  // Boot gate (D010): a configured-but-invalid mandate refuses to serve —
  // an agent that cannot prove its authorization must not spend. A missing
  // mandate is tolerated at boot (health stays up; /control/run 503s) so
  // that key-less environments like CI can still run the stack.
  const loaded = loadMandate(opts, app.log);
  if (loaded && !loaded.check.ok) {
    throw new Error(`refusing to start: Intent Mandate invalid — ${loaded.check.reason}`);
  }
  const mandate = loaded?.check.ok ? loaded.check.mandate : undefined;
  // A named provider without its key throws here — boot refuses (D015).
  const llm = opts.llm ?? createAdapterFromEnv('BUYER');
  app.log.info({ llm: { provider: llm.provider, model: llm.modelId } }, 'buyer model');

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    // Effective model, so a demo can never quietly run on the stub (D015).
    llm: { provider: llm.provider, model: llm.modelId },
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
    if (!mandate) {
      return reply.code(503).send({
        error: 'no Intent Mandate configured (set PRINCIPAL_* keys or INTENT_MANDATE_JSON)',
      });
    }
    const body = (req.body ?? {}) as { merchant_url?: string; target_variant_id?: string };
    const merchantUrl = body.merchant_url ?? process.env['MERCHANT_URL'] ?? 'http://merchant:4001';
    const runner = new BuyerRunner({
      db,
      mandate,
      mandateRef: hashCanonical(mandate),
      agentId: process.env['BUYER_AGENT_ID'] ?? 'buyer-demo',
      post: opts.post ?? fetchPost,
      log: app.log,
      ...(opts.now ? { now: opts.now } : {}),
      clockSkewSec: Number(process.env['CLOCK_SKEW_SEC'] ?? 120),
      llm,
    });
    const result = await runner.run({
      merchantUrl,
      ...(body.target_variant_id ? { targetVariantId: body.target_variant_id } : {}),
    });
    return reply.code(200).send(result);
  });

  return app;
}

/**
 * Mandate sources, in priority order: explicit option (tests) →
 * INTENT_MANDATE_JSON (a principal-signed artifact provided from outside —
 * the real-design shape) → demo seed signed with PRINCIPAL_* env keys
 * (DEMO ONLY: the principal key does not belong next to the agent; see
 * mandate.ts and THREAT_MODEL.md non-goals).
 */
function loadMandate(
  opts: AppOptions,
  log: { warn: (o: object, m?: string) => void },
): { check: ReturnType<typeof verifyIntentMandate> } | undefined {
  if (opts.mandate) return { check: verifyIntentMandate(opts.mandate, opts.now) };
  const json = process.env['INTENT_MANDATE_JSON'];
  if (json) {
    try {
      return { check: verifyIntentMandate(JSON.parse(json), opts.now) };
    } catch {
      return { check: { ok: false, reason: 'INTENT_MANDATE_JSON is not valid JSON' } };
    }
  }
  const priv = process.env['PRINCIPAL_PRIVATE_KEY'];
  const pub = process.env['PRINCIPAL_PUBLIC_KEY'];
  if (priv && pub) {
    const mandate = seedDemoMandate({ privateKey: priv, publicKey: pub }, opts.now);
    return { check: verifyIntentMandate(mandate, opts.now) };
  }
  log.warn({}, 'no Intent Mandate configured — /control/run will refuse until one is provided');
  return undefined;
}

/**
 * Sync-binding latency inequality (FEATURE-006 amendment #1): the seller's
 * LLM proposal runs INSIDE the merchant's HTTP reply, bounded by
 * LLM_TOTAL_BUDGET_MS (12s incl. retries). This client timeout must exceed
 * that plus merchant processing:
 *   BUYER_HTTP_TIMEOUT_MS (30 000) > LLM_TOTAL_BUDGET_MS (12 000) + processing
 * If either env value is changed, keep the inequality — see FLOW.md F1.
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
