import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  generateKeyPair,
  makeBoundary,
  signObject,
  type ErrorCode,
  type JsonValue,
  type Message,
} from '@negotiator/protocol';
import { openDb, SqliteReplayStore, type SettlementDb } from './db.js';
import { ledgerFor } from './events.js';
import { ledgerRoutes } from './ledger-routes.js';
import {
  LiveRazorpayClient,
  SimulatedRazorpayClient,
  razorpayModeFromEnv,
  type RazorpayClient,
} from './razorpay.js';
import { SettlementEngine, type RetryPolicy } from './settle.js';
import { verifySettlementRequest } from './verify.js';

export const SERVICE_NAME = 'settlement';

declare module 'fastify' {
  interface FastifyInstance {
    engine: SettlementEngine;
  }
}

export interface AppOptions {
  db?: SettlementDb;
  now?: () => Date;
  razorpay?: RazorpayClient;
  signingKey?: { privateKey: string; publicKey: string };
  firewallPublicKey?: string;
  webhookSecret?: string;
  paymentSimulation?: boolean;
  orderStatusPoll?: boolean;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Operator read API secret (ledger, sessions); defaults to DASHBOARD_TOKEN. */
  dashboardToken?: string;
}

/**
 * Settlement service (S5). Sole caller is the firewall (D011): POST /acnp
 * accepts `settlement_request` from FIREWALL_PUBLIC_KEY only, runs the
 * §7.10 verification chain, and replies 204 (accepted; settle async under
 * the sync binding D013). Parties poll GET /receipt/{mandate_hash}.
 * POST /webhook/razorpay verifies the HMAC over the RAW body before any
 * state changes (CONSTRAINTS #4).
 */
export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const env = process.env;
  const db = opts.db ?? openDb();
  const now = opts.now ?? (() => new Date());

  // Razorpay: explicit mode, test keys only (CONSTRAINTS #2) — throws on
  // anything else, so a misconfigured service never boots.
  const razorpay =
    opts.razorpay ??
    (razorpayModeFromEnv(env) === 'simulated'
      ? new SimulatedRazorpayClient()
      : new LiveRazorpayClient({
          keyId: env['RAZORPAY_KEY_ID']!,
          keySecret: env['RAZORPAY_KEY_SECRET']!,
        }));
  if (razorpay.mode === 'simulated') {
    app.log.warn({}, 'RAZORPAY_MODE=simulated: no real orders will be created');
  }

  // Long-lived keys (§5). A missing signing key gets an ephemeral one with a
  // loud warning (receipts still verify within one process lifetime); a
  // missing firewall key disables /acnp rather than accepting anyone.
  let signingKey = opts.signingKey;
  let signingKeySource: 'configured' | 'ephemeral' = 'configured';
  if (!signingKey) {
    if (env['SETTLEMENT_PRIVATE_KEY'] && env['SETTLEMENT_PUBLIC_KEY']) {
      signingKey = {
        privateKey: env['SETTLEMENT_PRIVATE_KEY'],
        publicKey: env['SETTLEMENT_PUBLIC_KEY'],
      };
    } else {
      signingKey = generateKeyPair();
      signingKeySource = 'ephemeral';
      app.log.warn({}, 'SETTLEMENT_*_KEY not set: using an EPHEMERAL signing key (demo only)');
    }
  }
  const firewallPublicKey = opts.firewallPublicKey ?? env['FIREWALL_PUBLIC_KEY'] ?? '';
  if (!firewallPublicKey) app.log.warn({}, 'FIREWALL_PUBLIC_KEY not set: /acnp disabled (503)');

  const paymentSimulation =
    opts.paymentSimulation ??
    ['on', 'true', '1'].includes((env['PAYMENT_SIMULATION'] ?? '').toLowerCase());
  const orderStatusPoll =
    opts.orderStatusPoll ??
    ['on', 'true', '1'].includes((env['ORDER_STATUS_POLL'] ?? '').toLowerCase());
  const webhookSecret = opts.webhookSecret ?? env['RAZORPAY_WEBHOOK_SECRET'] ?? '';
  if (paymentSimulation && !webhookSecret) {
    throw new Error(
      'refusing to start: PAYMENT_SIMULATION=on needs RAZORPAY_WEBHOOK_SECRET to sign its webhook',
    );
  }
  if (paymentSimulation) {
    app.log.warn(
      {},
      'PAYMENT_SIMULATION=on: the customer card tap is simulated by a self-signed webhook',
    );
  }
  if (!webhookSecret)
    app.log.warn({}, 'RAZORPAY_WEBHOOK_SECRET not set: all webhooks will be rejected');

  const engine = new SettlementEngine({
    db,
    razorpay,
    signingKey,
    agentId: env['SETTLEMENT_AGENT_ID'] ?? 'settlement-demo',
    webhookSecret,
    paymentSimulation,
    orderStatusPoll,
    retry: opts.retry ?? {
      maxAttempts: Number(env['SETTLEMENT_MAX_ATTEMPTS'] ?? 5),
      baseMs: Number(env['SETTLEMENT_BACKOFF_MS'] ?? 500),
    },
    now,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    log: app.log,
  });
  app.decorate('engine', engine);
  const ledger = ledgerFor(db, now);
  const dashboardToken = opts.dashboardToken ?? env['DASHBOARD_TOKEN'];
  const asPayload = (m: Message): Record<string, JsonValue> =>
    m as unknown as Record<string, JsonValue>;

  const receive = makeBoundary({
    // Sole caller (D011): only the firewall key ever resolves.
    resolveKey: (msg) =>
      msg.type === 'settlement_request' && firewallPublicKey ? firewallPublicKey : null,
    replayStore: new SqliteReplayStore(db),
    clockSkewSec: Number(env['CLOCK_SKEW_SEC'] ?? 120),
    now,
  });

  // Keep the raw body for webhook HMAC verification while still parsing JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    razorpay_mode: razorpay.mode,
    payment_simulation: paymentSimulation,
    order_status_poll: orderStatusPoll,
    firewall_key_configured: Boolean(firewallPublicKey),
    signing_key: signingKeySource,
    ledger_entries: ledger.count(),
    operator_api: dashboardToken ? 'enabled' : 'disabled (DASHBOARD_TOKEN unset)',
  }));

  // Operator API (D024): this service's ledger and its settlements, read-only.
  const dashGate = ledgerRoutes(app, ledger, dashboardToken);
  app.get('/sessions', async (req, reply) => {
    const denied = dashGate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    return reply.code(200).send({
      sessions: db
        .prepare(
          `SELECT session_id, mandate_hash, status, amount, currency, razorpay_order_id,
                  razorpay_payment_id, attempts, failure_code, paid_at, created_at, updated_at
             FROM settlements ORDER BY rowid DESC LIMIT 200`,
        )
        .all(),
    });
  });

  /** A handler-level refusal: authenticated, seq consumed, on the session's record. */
  const refuse = (msg: Message, code: ErrorCode, detail: string) => {
    const err = errorMessage(msg, code, detail);
    ledger.append(
      'HANDLER_REJECTED',
      { code, detail, reply: asPayload(err) },
      { session_id: msg.session_id },
    );
    return err;
  };

  app.post('/acnp', async (req, reply) => {
    if (!firewallPublicKey)
      return reply.code(503).send({ error: 'FIREWALL_PUBLIC_KEY not configured' });
    const result = receive(req.body);
    if (!result.ok) {
      app.log.warn({ code: result.code, detail: result.detail }, 'boundary rejection');
      const err = errorMessage(req.body, result.code, result.detail);
      ledger.append('BOUNDARY_REJECTED', {
        code: result.code,
        detail: result.detail,
        claimed_session_id: err.session_id,
        reply: asPayload(err),
      });
      return reply.code(200).send(err);
    }
    const msg = result.message;
    ledger.append('MESSAGE_IN', asPayload(msg), { session_id: msg.session_id });
    if (msg.type !== 'settlement_request') {
      result.commit(); // authenticated but unwelcome: consumes seq (§6)
      return reply
        .code(200)
        .send(refuse(msg, 'STATE_INVALID', `settlement does not accept ${msg.type}`));
    }
    const verified = verifySettlementRequest(
      msg as Message<'settlement_request'>,
      firewallPublicKey,
    );
    if (!verified.ok) {
      result.commit();
      app.log.warn({ code: verified.code, detail: verified.detail }, 'settlement_request rejected');
      return reply.code(200).send(refuse(msg, verified.code, verified.detail));
    }
    const outcome = engine.accept(
      msg as Message<'settlement_request'>,
      verified.cart,
      verified.verdict,
      verified.mandateHash,
    );
    result.commit();
    app.log.info({ mandate_hash: verified.mandateHash, outcome }, 'settlement_request accepted');
    return reply.code(204).send();
  });

  app.post('/webhook/razorpay', async (req, reply) => {
    const raw = (req as { rawBody?: string }).rawBody ?? '';
    const sig = req.headers['x-razorpay-signature'];
    const out = await engine.handleWebhook(raw, Array.isArray(sig) ? sig[0] : sig);
    return reply
      .code(out.status)
      .send(out.ok ? { applied: out.applied, detail: out.detail } : { error: out.reason });
  });

  app.get('/receipt/:mandate_hash', async (req, reply) => {
    const { mandate_hash } = req.params as { mandate_hash: string };
    if (!/^[0-9a-f]{64}$/.test(mandate_hash))
      return reply.code(400).send({ error: 'mandate_hash must be sha-256 hex' });
    const body = await engine.receiptFor(mandate_hash);
    if (!body) return reply.code(404).send({ error: 'unknown mandate_hash' });
    return reply.code(200).send(body);
  });

  /** Signed `error` reply (§7.12) with the settlement key; advisory before acceptance. */
  function errorMessage(inbound: unknown, code: ErrorCode, detail: string): Message<'error'> {
    const field = (name: string) => {
      const v = (inbound as Record<string, unknown> | null)?.[name];
      return typeof v === 'string' && v.length > 0 && v.length < 200 ? v : undefined;
    };
    const unsigned = {
      protocol: 'ACNP' as const,
      version: '0.1',
      type: 'error' as const,
      message_id: randomUUID(),
      session_id: field('session_id') ?? '00000000-0000-4000-8000-000000000000',
      seq: 1,
      ...(field('message_id') ? { in_reply_to: field('message_id') } : {}),
      sender: {
        agent_id: env['SETTLEMENT_AGENT_ID'] ?? 'settlement-demo',
        role: 'settlement' as const,
      },
      timestamp: now().toISOString(),
      body: {
        code,
        detail,
        ...(field('message_id') ? { offending_message_id: field('message_id') } : {}),
      },
    };
    return signObject(
      unsigned,
      signingKey!.privateKey,
      signingKey!.publicKey,
    ) as unknown as Message<'error'>;
  }

  return app;
}
