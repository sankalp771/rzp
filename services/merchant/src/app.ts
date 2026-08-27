import Fastify from 'fastify';
import { createAdapterFromEnv, type LlmAdapter } from '@negotiator/llm';
import { PROTOCOL_NAME, PROTOCOL_VERSION, makeBoundary } from '@negotiator/protocol';
import { openDb, SqliteReplayStore, type MerchantDb } from './db.js';
import { MerchantHandlers, type ChainConfig, type GetFn } from './handlers.js';
import { MerchantPolicy, savePolicy } from './policy.js';
import { seedIfEmpty } from './seed.js';
import { ledgerRoutes } from './ledger-routes.js';

export const SERVICE_NAME = 'merchant';

declare module 'fastify' {
  interface FastifyInstance {
    handlers: MerchantHandlers;
  }
}

export interface AppOptions {
  db?: MerchantDb;
  /** Injectable clock for tests (drives skew checks and reply timestamps). */
  now?: () => Date;
  /** Seller model override for tests; defaults to SELLER_LLM_PROVIDER (D015). */
  llm?: LlmAdapter;
  /** Firewall/settlement keys + receipt poll seam; defaults to env + fetch. */
  chain?: ChainConfig;
  /** Operator read/write API secret (ledger, policy, sessions); defaults to DASHBOARD_TOKEN. */
  dashboardToken?: string;
}

/**
 * Merchant Commerce Server (S1). One ACNP endpoint (§3): POST /acnp runs
 * boundary checks, then the handler; the signed reply rides in the 200
 * body, 204 when nothing is owed (D013). Boundary rejections return the
 * signed `error` message with HTTP 200 — the status code carries no
 * protocol meaning.
 */
export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const db = opts.db ?? openDb();
  if (seedIfEmpty(db)) app.log.info('seeded demo catalog and policy');
  // A named provider without its key throws here — boot refuses (D015).
  const llm = opts.llm ?? createAdapterFromEnv('SELLER');
  app.log.info({ llm: { provider: llm.provider, model: llm.modelId } }, 'seller model');
  const chain = opts.chain ?? chainFromEnv(process.env);
  if (!chain.firewallPublicKey) {
    app.log.warn({}, 'FIREWALL_PUBLIC_KEY not set: firewall verdicts will be rejected');
  }
  if (!chain.settlement) {
    app.log.warn({}, 'SETTLEMENT_PUBLIC_KEY not set: receipts will not be polled');
  }
  const handlers = new MerchantHandlers(
    db,
    process.env['MERCHANT_AGENT_ID'] ?? 'merchant-demo',
    opts.now,
    llm,
    app.log,
    chain,
  );
  app.decorate('handlers', handlers);
  const receive = makeBoundary({
    resolveKey: (msg) => handlers.resolveKey(msg),
    replayStore: new SqliteReplayStore(db),
    clockSkewSec: Number(process.env['CLOCK_SKEW_SEC'] ?? 120),
    ...(opts.now ? { now: opts.now } : {}),
  });

  const dashboardToken = opts.dashboardToken ?? process.env['DASHBOARD_TOKEN'];
  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    // Effective model, so a demo can never quietly run on the stub (D015).
    llm: handlers.llmInfo,
    ...handlers.chainInfo,
    ledger_entries: handlers.ledger.count(),
    operator_api: dashboardToken ? 'enabled' : 'disabled (DASHBOARD_TOKEN unset)',
  }));

  // Operator API (D024): the ledger, this merchant's sessions, and the policy.
  const gate = ledgerRoutes(app, handlers.ledger, dashboardToken);
  app.get('/sessions', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    return reply.code(200).send({
      sessions: db
        .prepare(
          `SELECT session_id, state, buyer_agent_id, round, cart_mandate_hash, verdict, verdict_layer,
                  settlement_status, razorpay_order_id, seller_model
             FROM sessions ORDER BY rowid DESC LIMIT 200`,
        )
        .all(),
    });
  });
  app.get('/policy', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    return reply.code(200).send(handlers.currentPolicy);
  });
  app.put('/policy', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    const parsed = MerchantPolicy.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid policy', issues: parsed.error.issues });
    }
    // Floors stay per variant in the catalog; the policy is the discount
    // ceiling, rounds and capabilities. Bounds enforcement reads the new
    // policy from the next message on (still deterministic, CONSTRAINTS #5).
    savePolicy(db, parsed.data);
    const applied = handlers.reloadPolicy();
    app.log.info({ policy: applied }, 'merchant policy updated by operator');
    return reply.code(200).send(applied);
  });

  app.post('/acnp', async (req, reply) => {
    const result = receive(req.body);
    if (!result.ok) {
      // Boundary rejection: never reaches a handler, never advances state
      // (F5). Reply is a signed error message built by the handlers' error
      // factory so unknown-session errors are still signed.
      app.log.warn({ code: result.code, detail: result.detail }, 'boundary rejection');
      const errOutcome = handlers.protocolError(
        // Minimal envelope facts for the error reply; the raw message may be
        // arbitrarily malformed, so only echo what we can trust.
        {
          message_id: stringField(req.body, 'message_id') ?? '00000000-0000-4000-8000-000000000000',
          session_id: stringField(req.body, 'session_id') ?? '00000000-0000-4000-8000-000000000000',
        } as never,
        result.code,
        result.detail,
        { authenticated: false }, // BUG-004: no state, no seq — nothing was verified
      );
      return reply.code(200).send(errOutcome.reply);
    }
    const outcome = await handlers.handle(result.message);
    if (outcome.commit) result.commit();
    if (outcome.reply === null) return reply.code(204).send();
    return reply.code(200).send(outcome.reply);
  });

  return app;
}

/** Long-lived keys and the receipt-poll knobs (see .env.example). */
function chainFromEnv(env: Record<string, string | undefined>): ChainConfig {
  const settlementKey = env['SETTLEMENT_PUBLIC_KEY'];
  return {
    ...(env['FIREWALL_PUBLIC_KEY'] ? { firewallPublicKey: env['FIREWALL_PUBLIC_KEY'] } : {}),
    ...(settlementKey
      ? {
          settlement: {
            url: (env['SETTLEMENT_URL'] ?? 'http://settlement:4004').replace(/\/$/, ''),
            publicKey: settlementKey,
            get: fetchGet,
            intervalMs: Number(env['RECEIPT_POLL_INTERVAL_MS'] ?? 500),
            timeoutMs: Number(env['RECEIPT_POLL_TIMEOUT_MS'] ?? 60_000),
          },
        }
      : {}),
  };
}

const fetchGet: GetFn = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.json() };
};

function stringField(raw: unknown, field: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const v = (raw as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length > 0 && v.length < 200 ? v : undefined;
}
