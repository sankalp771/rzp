import Fastify from 'fastify';
import { createAdapterFromEnv, type LlmAdapter } from '@negotiator/llm';
import { PROTOCOL_NAME, PROTOCOL_VERSION, makeBoundary } from '@negotiator/protocol';
import { openDb, SqliteReplayStore, type MerchantDb } from './db.js';
import { MerchantHandlers } from './handlers.js';
import { seedIfEmpty } from './seed.js';

export const SERVICE_NAME = 'merchant';

export interface AppOptions {
  db?: MerchantDb;
  /** Injectable clock for tests (drives skew checks and reply timestamps). */
  now?: () => Date;
  /** Seller model override for tests; defaults to SELLER_LLM_PROVIDER (D015). */
  llm?: LlmAdapter;
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
  const handlers = new MerchantHandlers(
    db,
    process.env['MERCHANT_AGENT_ID'] ?? 'merchant-demo',
    opts.now,
    llm,
    app.log,
  );
  const receive = makeBoundary({
    resolveKey: (msg) => handlers.resolveKey(msg),
    replayStore: new SqliteReplayStore(db),
    clockSkewSec: Number(process.env['CLOCK_SKEW_SEC'] ?? 120),
    ...(opts.now ? { now: opts.now } : {}),
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    // Effective model, so a demo can never quietly run on the stub (D015).
    llm: handlers.llmInfo,
  }));

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

function stringField(raw: unknown, field: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const v = (raw as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length > 0 && v.length < 200 ? v : undefined;
}
