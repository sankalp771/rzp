import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  generateKeyPair,
  hashCanonical,
  makeBoundary,
  messageSchema,
  verifyObject,
  type BodyOf,
  type ErrorCode,
  type IntentMandate,
  type Message,
} from '@negotiator/protocol';
import { openDb, nextStreamSeq, SqliteReplayStore, type FirewallDb } from './db.js';
import { DEFAULT_POLICY, evaluateLayer1, policyFromEnv, type PolicyConfig } from './policy.js';
import { applyVerdict, buildOutbound, type Layer2Input, type OutboundKey } from './verdict.js';

export const SERVICE_NAME = 'firewall';

/**
 * Compliance Firewall (S4) — the only caller settlement accepts (D011) and
 * the holder of the only mandate copies ever audited (D010). One ACNP
 * endpoint under the sync binding (D013):
 *   mandate_register → mandate_ack (principal signature verified, buyer
 *                      session key pinned to the mandate ref)
 *   cart_mandate     → signed firewall_verdict in the 200 body; on allow the
 *                      settlement_request is dispatched to settlement and
 *                      the verdict delivered to the seller BEFORE replying,
 *                      so "allow with dispatch success ⇒ a receipt row
 *                      exists" (amendment #4). A failed dispatch does not
 *                      change the verdict — the purchase is compliant — it
 *                      is recorded on the cart row and logged.
 *   GET /verdict/:hash — latest signed verdict, idempotent (§7.9 polling).
 *
 * Latency inequality (amendment #4, mirrors FEATURE-006 #1): this handler
 * runs inside the buyer's HTTP call, so
 *   BUYER_HTTP_TIMEOUT_MS (30 000) > FIREWALL_DISPATCH_TIMEOUT_MS (8 000)
 *                                  + FIREWALL_NOTIFY_TIMEOUT_MS (5 000)
 *                                  + firewall processing
 * Settlement's /acnp answers 204 before it touches Razorpay, so Razorpay's
 * bounded retry is NOT inside this window. Change one, keep the inequality.
 */

export interface PostResult {
  status: number;
  body: unknown;
}
/** Transport seam: tests inject fastify's inject(); production uses fetch. */
export type PostFn = (url: string, payload: unknown, timeoutMs: number) => Promise<PostResult>;

export interface AppOptions {
  db?: FirewallDb;
  now?: () => Date;
  signingKey?: OutboundKey;
  /** Principal public keys whose mandates this firewall accepts (§5). */
  principalKeys?: string[];
  policy?: PolicyConfig;
  settlementUrl?: string;
  merchantUrl?: string;
  post?: PostFn;
  dispatchTimeoutMs?: number;
  notifyTimeoutMs?: number;
  /** Day 9 replaces the literal with a real recommender; see verdict.ts. */
  layer2?: Layer2Input;
}

interface MandateRow {
  intent_mandate_ref: string;
  mandate_json: string;
  principal_id: string;
  principal_public_key: string;
  buyer_agent_id: string;
  buyer_public_key: string;
  register_session_id: string;
  registered_at: string;
}

interface VerdictRow {
  cart_mandate_hash: string;
  seq: number;
  verdict: 'allow' | 'block' | 'escalate';
  layer: string;
  reasons_json: string;
  details_json: string;
  verdict_json: string;
  issued_at: string;
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const env = process.env;
  const db = opts.db ?? openDb();
  const now = opts.now ?? (() => new Date());
  const agentId = env['FIREWALL_AGENT_ID'] ?? 'firewall-demo';
  const policy = opts.policy ?? policyFromEnv(env);
  const layer2: Layer2Input = opts.layer2 ?? 'not_configured';
  const settlementUrl = (
    opts.settlementUrl ??
    env['SETTLEMENT_URL'] ??
    'http://settlement:4004'
  ).replace(/\/$/, '');
  const merchantUrl = (opts.merchantUrl ?? env['MERCHANT_URL'] ?? 'http://merchant:4001').replace(
    /\/$/,
    '',
  );
  const dispatchTimeoutMs =
    opts.dispatchTimeoutMs ?? Number(env['FIREWALL_DISPATCH_TIMEOUT_MS'] ?? 8000);
  const notifyTimeoutMs = opts.notifyTimeoutMs ?? Number(env['FIREWALL_NOTIFY_TIMEOUT_MS'] ?? 5000);
  const post = opts.post ?? fetchPost;

  // Long-lived signing key (§5): ephemeral with a loud warning if unset —
  // nobody can verify our verdicts then, which /health makes visible.
  let signingKey = opts.signingKey;
  let signingKeySource: 'configured' | 'ephemeral' = 'configured';
  if (!signingKey) {
    if (env['FIREWALL_PRIVATE_KEY'] && env['FIREWALL_PUBLIC_KEY']) {
      signingKey = {
        privateKey: env['FIREWALL_PRIVATE_KEY'],
        publicKey: env['FIREWALL_PUBLIC_KEY'],
      };
    } else {
      signingKey = generateKeyPair();
      signingKeySource = 'ephemeral';
      app.log.warn({}, 'FIREWALL_*_KEY not set: using an EPHEMERAL signing key (demo only)');
    }
  }
  const key = signingKey;

  // Trusted principal keys (§5). FIREWALL_PRINCIPAL_KEYS is the real-design
  // shape; falling back to PRINCIPAL_PUBLIC_KEY is the demo's one-keypair
  // convenience (THREAT_MODEL non-goals) — only the PUBLIC half is read here.
  const principalKeys =
    opts.principalKeys ??
    (env['FIREWALL_PRINCIPAL_KEYS'] ?? env['PRINCIPAL_PUBLIC_KEY'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (principalKeys.length === 0) {
    app.log.warn(
      {},
      'no trusted principal keys configured: every mandate_register will be refused',
    );
  }
  app.log.info(
    { policy, layer2, settlementUrl, merchantUrl, dispatchTimeoutMs, notifyTimeoutMs },
    'firewall config',
  );

  // --- storage helpers -----------------------------------------------------

  const mandateByRef = (ref: string) =>
    db.prepare('SELECT * FROM mandates WHERE intent_mandate_ref = ?').get(ref) as
      MandateRow | undefined;
  const latestVerdict = (hash: string) =>
    db
      .prepare('SELECT * FROM verdicts WHERE cart_mandate_hash = ? ORDER BY seq DESC LIMIT 1')
      .get(hash) as VerdictRow | undefined;
  const sessionRow = (id: string) =>
    db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as
      { session_id: string; cart_mandate_hash: string; state: string } | undefined;

  /** §7.9 one-mandate-one-purchase: the latest verdict on any OTHER cart for this ref. */
  function mandateStatus(ref: string, exceptHash: string) {
    const rows = db
      .prepare(
        `SELECT v.verdict FROM carts c
           JOIN verdicts v ON v.cart_mandate_hash = c.cart_mandate_hash
          WHERE c.intent_mandate_ref = ? AND c.cart_mandate_hash != ?
            AND v.seq = (SELECT MAX(seq) FROM verdicts WHERE cart_mandate_hash = c.cart_mandate_hash)`,
      )
      .all(ref, exceptHash) as { verdict: VerdictRow['verdict'] }[];
    if (rows.some((r) => r.verdict === 'allow')) return 'allowed' as const;
    if (rows.some((r) => r.verdict === 'escalate')) return 'in_review' as const;
    return rows.length > 0 ? ('blocked' as const) : ('unused' as const);
  }

  /** Velocity is keyed by principal (amendment #5), across mandates. */
  function recentAllows(principalId: string, exceptHash: string): number {
    const since = new Date(now().getTime() - policy.velocityWindowSec * 1000).toISOString();
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM carts c
            WHERE c.principal_id = ? AND c.received_at > ? AND c.cart_mandate_hash != ?
              AND (SELECT verdict FROM verdicts WHERE cart_mandate_hash = c.cart_mandate_hash
                    ORDER BY seq DESC LIMIT 1) = 'allow'`,
        )
        .get(principalId, since, exceptHash) as { n: number }
    ).n;
  }

  // --- boundary --------------------------------------------------------------

  const receive = makeBoundary({
    resolveKey: (msg) => {
      // TOFU (§5/§7.0): the registration is self-signed by the key it pins.
      if (msg.type === 'mandate_register') {
        return (msg.body as BodyOf<'mandate_register'>).buyer_public_key;
      }
      if (msg.type === 'cart_mandate') {
        const ref = (msg.body as BodyOf<'cart_mandate'>).intent_mandate_ref;
        const row = mandateByRef(ref);
        // §7.8: an unregistered ref is MANDATE_UNKNOWN (fatal), not a generic
        // unknown session; a registered ref verifies ONLY against the pinned key.
        return row
          ? row.buyer_public_key
          : { code: 'MANDATE_UNKNOWN', detail: `no mandate registered under ${ref.slice(0, 12)}…` };
      }
      return null;
    },
    replayStore: new SqliteReplayStore(db),
    clockSkewSec: Number(env['CLOCK_SKEW_SEC'] ?? 120),
    now,
  });

  // --- routes ----------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    signing_key: signingKeySource,
    principal_keys: principalKeys.length,
    // Visible deferral: Day 9 wires the intent-verifier into this slot.
    intent_verifier: layer2 === 'not_configured' ? 'not_configured (Day 9)' : layer2,
    policy,
    settlement_url: settlementUrl,
    merchant_url: merchantUrl,
    dispatch_timeout_ms: dispatchTimeoutMs,
    notify_timeout_ms: notifyTimeoutMs,
  }));

  app.post('/acnp', async (req, reply) => {
    const result = receive(req.body);
    if (!result.ok) {
      app.log.warn({ code: result.code, detail: result.detail }, 'boundary rejection');
      return reply.code(200).send(errorMessage(req.body, result.code, result.detail));
    }
    const msg = result.message;
    const done = (out: Message | null) => {
      result.commit(); // authenticated: consumes seq even when rejected (§6)
      return out === null ? reply.code(204).send() : reply.code(200).send(out);
    };
    switch (msg.type) {
      case 'mandate_register':
        return done(onRegister(msg as Message<'mandate_register'>));
      case 'cart_mandate':
        return done(await onCart(msg as Message<'cart_mandate'>));
      default:
        return done(errorMessage(msg, 'STATE_INVALID', `firewall does not accept ${msg.type}`));
    }
  });

  app.get('/verdict/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!/^[0-9a-f]{64}$/.test(hash))
      return reply.code(400).send({ error: 'hash must be sha-256 hex' });
    const v = latestVerdict(hash);
    if (!v) return reply.code(404).send({ error: 'unknown cart_mandate_hash' });
    return reply.code(200).send(JSON.parse(v.verdict_json));
  });

  // --- handlers ----------------------------------------------------------------

  /** §7.0: verify the PRINCIPAL's signature, pin the buyer key to the ref, ack. */
  function onRegister(msg: Message<'mandate_register'>): Message {
    const mandate = msg.body.intent_mandate;
    if (!principalKeys.includes(mandate.principal_public_key)) {
      return errorMessage(
        msg,
        'MANDATE_SIG_INVALID',
        'principal key is not trusted by this firewall',
      );
    }
    const sig = verifyObject(mandate, mandate.principal_public_key);
    if (!sig.ok)
      return errorMessage(msg, 'MANDATE_SIG_INVALID', `principal signature: ${sig.reason}`);
    if (now().getTime() > Date.parse(mandate.valid_until)) {
      return errorMessage(msg, 'MANDATE_EXPIRED', `valid_until ${mandate.valid_until} has passed`);
    }
    const ref = hashCanonical(mandate);
    const existing = mandateByRef(ref);
    if (existing) {
      if (
        existing.buyer_public_key !== msg.body.buyer_public_key ||
        existing.buyer_agent_id !== msg.sender.agent_id
      ) {
        // A second agent (or key) claiming an already-bound mandate.
        return errorMessage(msg, 'MANDATE_CONFLICT', 'mandate already registered to another key');
      }
      // Idempotent re-registration: same mandate, same key.
      app.log.info({ ref }, 'mandate_register repeated (idempotent)');
    } else {
      const bySession = db
        .prepare('SELECT intent_mandate_ref FROM mandates WHERE register_session_id = ?')
        .get(msg.session_id) as { intent_mandate_ref: string } | undefined;
      if (bySession) {
        return errorMessage(
          msg,
          'MANDATE_CONFLICT',
          'session already bound to a different mandate',
        );
      }
      db.prepare(
        `INSERT INTO mandates (intent_mandate_ref, mandate_json, principal_id, principal_public_key,
           buyer_agent_id, buyer_public_key, register_session_id, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ref,
        JSON.stringify(mandate),
        mandate.principal_id,
        mandate.principal_public_key,
        msg.sender.agent_id,
        msg.body.buyer_public_key,
        msg.session_id,
        now().toISOString(),
      );
      app.log.info(
        { ref, principal_id: mandate.principal_id, buyer: msg.sender.agent_id },
        'mandate registered',
      );
    }
    return buildOutbound(
      'mandate_ack',
      { intent_mandate_ref: ref },
      {
        sessionId: msg.session_id,
        seq: nextStreamSeq(db, msg.session_id, 'buyer'),
        agentId,
        key,
        now,
        inReplyTo: msg.message_id,
      },
    );
  }

  /** §7.8/§7.9: audit the cart against the STORED mandate, decide, dispatch, reply. */
  async function onCart(msg: Message<'cart_mandate'>): Promise<Message> {
    const body = msg.body;
    const row = mandateByRef(body.intent_mandate_ref)!; // resolveKey guaranteed it
    if (msg.sender.agent_id !== row.buyer_agent_id || body.buyer_agent_id !== row.buyer_agent_id) {
      return errorMessage(msg, 'STATE_INVALID', 'buyer_agent_id does not match the registration');
    }
    // Recompute everything we are asked to trust (§13).
    const { mandate_hash, ...minusHash } = body;
    const recomputed = hashCanonical(minusHash);
    if (recomputed !== mandate_hash) {
      return errorMessage(msg, 'SCHEMA_INVALID', 'mandate_hash does not match the cart body');
    }
    const sum = body.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
    if (sum !== body.total) {
      return errorMessage(msg, 'TOTAL_MISMATCH', `computed ${sum}, claimed ${body.total}`);
    }

    // Idempotency: the same cart again gets the same signed verdict, no
    // re-evaluation, no second dispatch (§6). A different cart in a session
    // that already has one is a state violation (§9).
    const prior = latestVerdict(mandate_hash);
    if (prior) {
      const s = sessionRow(msg.session_id);
      if (!s || s.cart_mandate_hash !== mandate_hash) {
        return errorMessage(msg, 'STATE_INVALID', 'cart already audited under another session');
      }
      app.log.info({ mandate_hash }, 'cart_mandate repeated: returning the stored verdict');
      return JSON.parse(prior.verdict_json) as Message;
    }
    if (sessionRow(msg.session_id)) {
      return errorMessage(msg, 'STATE_INVALID', 'session already submitted a cart_mandate');
    }

    const mandate = JSON.parse(row.mandate_json) as IntentMandate;
    const layer1 = evaluateLayer1(body, mandate, policy, {
      now: now(),
      recentAllowsForPrincipal: recentAllows(row.principal_id, mandate_hash),
      mandateStatus: mandateStatus(body.intent_mandate_ref, mandate_hash),
    });
    const applied = applyVerdict(layer1, layer2);
    const verdictBody: BodyOf<'firewall_verdict'> = {
      cart_mandate_hash: mandate_hash,
      verdict: applied.verdict,
      layer: applied.layer,
      reasons: applied.reasons,
    };
    const verdict = buildOutbound('firewall_verdict', verdictBody, {
      sessionId: msg.session_id,
      seq: nextStreamSeq(db, msg.session_id, 'buyer'),
      agentId,
      key,
      now,
      inReplyTo: msg.message_id,
    });
    const ts = now().toISOString();
    const state =
      applied.verdict === 'allow'
        ? 'SETTLING'
        : applied.verdict === 'block'
          ? 'BLOCKED'
          : 'COMPLIANCE_REVIEW';
    db.transaction(() => {
      db.prepare(
        `INSERT INTO carts (cart_mandate_hash, session_id, intent_mandate_ref, principal_id,
           seller_agent_id, total, cart_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mandate_hash,
        msg.session_id,
        body.intent_mandate_ref,
        row.principal_id,
        body.seller_agent_id,
        body.total,
        JSON.stringify(msg),
        ts,
      );
      db.prepare(
        `INSERT INTO sessions (session_id, intent_mandate_ref, cart_mandate_hash, state, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(msg.session_id, body.intent_mandate_ref, mandate_hash, state, ts);
      db.prepare(
        `INSERT INTO verdicts (cart_mandate_hash, seq, verdict, layer, reasons_json, details_json,
           verdict_json, issued_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mandate_hash,
        applied.verdict,
        applied.layer,
        JSON.stringify(applied.reasons),
        JSON.stringify(applied.details),
        JSON.stringify(verdict),
        ts,
      );
    })();
    app.log[applied.verdict === 'allow' ? 'info' : 'warn'](
      {
        session_id: msg.session_id,
        mandate_hash,
        verdict: applied.verdict,
        layer: applied.layer,
        reasons: applied.reasons,
        details: applied.details,
        total: body.total,
        seller: body.seller_agent_id,
      },
      `firewall_verdict ${applied.verdict}`,
    );

    // F1 step 8: dispatch to settlement BEFORE replying (amendment #4).
    if (applied.verdict === 'allow') await dispatchSettlement(msg, verdict, row, mandate_hash);
    // §7.9: the seller gets every verdict, in its own envelope on its own stream.
    await notifySeller(msg.session_id, verdictBody, mandate_hash);
    return verdict;
  }

  async function dispatchSettlement(
    cart: Message<'cart_mandate'>,
    verdict: Message<'firewall_verdict'>,
    row: MandateRow,
    mandateHash: string,
  ): Promise<void> {
    // The embedded verdict is the very envelope the buyer received (and
    // the ledger holds) — an attached artifact, not a message on the
    // settlement stream; only the settlement_request itself is sequenced
    // there (settlement sees this firewall from seq 1, §6).
    const request = buildOutbound(
      'settlement_request',
      {
        cart_mandate: cart,
        firewall_verdict: verdict,
        // §7.10: attested here; settlement verifies the cart against it.
        buyer_public_key: row.buyer_public_key,
      },
      {
        sessionId: cart.session_id,
        seq: nextStreamSeq(db, cart.session_id, 'settlement'),
        agentId,
        key,
        now,
      },
    );
    const outcome = await deliver(`${settlementUrl}/acnp`, request, dispatchTimeoutMs);
    db.prepare(
      'UPDATE carts SET settlement_dispatched = ?, settlement_error = ? WHERE cart_mandate_hash = ?',
    ).run(outcome.ok ? 1 : 0, outcome.ok ? null : outcome.error, mandateHash);
    if (outcome.ok) {
      app.log.info({ mandate_hash: mandateHash }, 'settlement_request accepted by settlement');
    } else {
      // Loud: the allow stands, the money did not move. Visible in the row.
      app.log.error(
        { mandate_hash: mandateHash, error: outcome.error },
        'settlement dispatch FAILED — verdict is allow, settlement_dispatched=0',
      );
    }
  }

  async function notifySeller(
    sessionId: string,
    verdictBody: BodyOf<'firewall_verdict'>,
    mandateHash: string,
  ): Promise<void> {
    const forSeller = buildOutbound('firewall_verdict', verdictBody, {
      sessionId,
      seq: nextStreamSeq(db, sessionId, 'seller'),
      agentId,
      key,
      now,
    });
    const outcome = await deliver(`${merchantUrl}/acnp`, forSeller, notifyTimeoutMs);
    db.prepare(
      'UPDATE carts SET seller_notified = ?, seller_error = ? WHERE cart_mandate_hash = ?',
    ).run(outcome.ok ? 1 : 0, outcome.ok ? null : outcome.error, mandateHash);
    if (!outcome.ok) {
      app.log.warn({ mandate_hash: mandateHash, error: outcome.error }, 'seller not notified');
    }
  }

  /** POST one message; 204 = accepted; a 200 body is a (signed) error reply. */
  async function deliver(
    url: string,
    payload: Message,
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await withTimeout(post(url, payload, timeoutMs), timeoutMs);
      if (res.status === 204) return { ok: true };
      if (res.status === 200 && res.body) {
        const parsed = messageSchema('error').safeParse(res.body);
        const code = parsed.success ? (parsed.data.body as BodyOf<'error'>).code : 'unparseable';
        const detail = parsed.success ? (parsed.data.body as BodyOf<'error'>).detail : '';
        return { ok: false, error: `${code}: ${detail}`.trim() };
      }
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Signed `error` reply (§7.12) with the firewall key; advisory before acceptance. */
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
      sender: { agent_id: agentId, role: 'firewall' as const },
      timestamp: now().toISOString(),
      body: {
        code,
        detail,
        ...(field('message_id') ? { offending_message_id: field('message_id') } : {}),
      },
    };
    return buildOutbound('error', unsigned.body, {
      sessionId: unsigned.session_id,
      seq: 1,
      agentId,
      key,
      now,
      ...(unsigned.in_reply_to ? { inReplyTo: unsigned.in_reply_to } : {}),
    });
  }

  return app;
}

/** The firewall's own ceiling on any outbound wait, independent of the transport seam. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const fetchPost: PostFn = async (url, payload, timeoutMs) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

export { DEFAULT_POLICY };
