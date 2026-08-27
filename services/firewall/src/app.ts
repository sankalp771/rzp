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
import { verifierFromEnv, type Verifier } from './intent.js';
import { DEFAULT_POLICY, evaluateLayer1, policyFromEnv, type PolicyConfig } from './policy.js';
import {
  applyVerdict,
  buildOutbound,
  type AppliedVerdict,
  type Layer2Input,
  type OutboundKey,
} from './verdict.js';

export const SERVICE_NAME = 'firewall';

declare module 'fastify' {
  interface FastifyInstance {
    firewall: {
      decide: (
        hash: string,
        decision: Decision,
        reviewer: string | null,
        note: string | null,
      ) => Promise<unknown>;
      sweepExpired: () => Promise<void>;
    };
  }
}

/**
 * Compliance Firewall (S4) — the only caller settlement accepts (D011) and
 * the holder of the only mandate copies ever audited (D010). One ACNP
 * endpoint under the sync binding (D013):
 *   mandate_register → mandate_ack (principal signature verified, buyer
 *                      session key pinned to the mandate ref)
 *   cart_mandate     → signed firewall_verdict in the 200 body: layer 1
 *                      (policy.ts) then, if configured, layer 2 (intent.ts)
 *                      → applyVerdict (verdict.ts, the only decider). On
 *                      allow the settlement_request is dispatched and the
 *                      verdict delivered to the seller BEFORE replying, so
 *                      "allow with dispatch success ⇒ a receipt row exists"
 *                      (D020). On escalate the cart enters the human queue.
 *   GET /verdict/:hash — latest signed verdict, idempotent (§7.9 polling);
 *                      expired holds are timed out lazily here first.
 *   GET /review, POST /review/:hash — the human approval queue, gated by
 *                      FIREWALL_REVIEW_TOKEN (D022). A decision is claimed
 *                      exactly once; approve re-runs layer 1 first.
 *
 * Latency inequality (FEATURE-009): this handler runs inside the buyer's
 * HTTP call, so
 *   BUYER_HTTP_TIMEOUT_MS (30 000) > FIREWALL_LLM_BUDGET_MS      (8 000)
 *                                  + FIREWALL_DISPATCH_TIMEOUT_MS (8 000)
 *                                  + FIREWALL_NOTIFY_TIMEOUT_MS   (5 000)
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
  /** Layer 2. Defaults to FIREWALL_LLM_PROVIDER; 'not_configured' = layer 1 only. */
  verifier?: Verifier | 'not_configured';
  /** Shared secret for /review; unset → the queue is read/decide-disabled (503). */
  reviewToken?: string;
  escalationTimeoutSec?: number;
  /** Timer period for the timeout sweep; 0 disables the timer (tests sweep lazily). */
  sweepIntervalMs?: number;
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
  verifier_json: string | null;
}

interface CartRow {
  cart_mandate_hash: string;
  session_id: string;
  intent_mandate_ref: string;
  principal_id: string;
  seller_agent_id: string;
  total: number;
  cart_json: string;
  received_at: string;
}

interface EscalationRow {
  cart_mandate_hash: string;
  session_id: string;
  held_since: string;
  expires_at: string;
  status: 'pending' | 'decided';
  decision: 'approve' | 'reject' | 'timeout' | null;
  reviewer: string | null;
  note: string | null;
  decided_at: string | null;
}

export type Decision = 'approve' | 'reject' | 'timeout';

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const env = process.env;
  const db = opts.db ?? openDb();
  const now = opts.now ?? (() => new Date());
  const agentId = env['FIREWALL_AGENT_ID'] ?? 'firewall-demo';
  const policy = opts.policy ?? policyFromEnv(env);
  const verifier: Verifier | 'not_configured' =
    opts.verifier ?? verifierFromEnv(env, () => now().getTime());
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
  const reviewToken = opts.reviewToken ?? env['FIREWALL_REVIEW_TOKEN'];
  const escalationTimeoutSec =
    opts.escalationTimeoutSec ?? Number(env['FIREWALL_ESCALATION_TIMEOUT_SEC'] ?? 600);
  const sweepIntervalMs =
    opts.sweepIntervalMs ?? Number(env['FIREWALL_ESCALATION_SWEEP_MS'] ?? 15_000);

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
  const verifierInfo =
    verifier === 'not_configured'
      ? 'not_configured'
      : { provider: verifier.provider, model: verifier.modelId };
  if (verifier === 'not_configured') {
    // Visible deferral / operator choice: no LLM auditor at all, layer 1 only.
    app.log.warn(
      {},
      'intent_verifier NOT CONFIGURED (FIREWALL_LLM_PROVIDER unset/stub): layer 1 only, every allow is layer: policy',
    );
  }
  if (!reviewToken) {
    app.log.warn(
      {},
      'FIREWALL_REVIEW_TOKEN not set: /review is disabled (holds can only time out)',
    );
  }
  app.log.info(
    {
      policy,
      intent_verifier: verifierInfo,
      settlementUrl,
      merchantUrl,
      dispatchTimeoutMs,
      notifyTimeoutMs,
      escalationTimeoutSec,
      sweepIntervalMs,
    },
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
  const cartRow = (hash: string) =>
    db.prepare('SELECT * FROM carts WHERE cart_mandate_hash = ?').get(hash) as CartRow | undefined;
  const escalationRow = (hash: string) =>
    db.prepare('SELECT * FROM escalations WHERE cart_mandate_hash = ?').get(hash) as
      EscalationRow | undefined;

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

  const layer1For = (cart: BodyOf<'cart_mandate'>, row: MandateRow, hash: string) =>
    evaluateLayer1(cart, JSON.parse(row.mandate_json) as IntentMandate, policy, {
      now: now(),
      recentAllowsForPrincipal: recentAllows(row.principal_id, hash),
      mandateStatus: mandateStatus(cart.intent_mandate_ref, hash),
    });

  const stateFor = (v: AppliedVerdict['verdict']) =>
    v === 'allow' ? 'SETTLING' : v === 'block' ? 'BLOCKED' : 'COMPLIANCE_REVIEW';

  /** Sign the verdict for the buyer stream and append it (call inside a transaction). */
  function appendVerdict(
    sessionId: string,
    hash: string,
    applied: AppliedVerdict,
    verifierJson: string | null,
    inReplyTo?: string,
  ): Message<'firewall_verdict'> {
    const body: BodyOf<'firewall_verdict'> = {
      cart_mandate_hash: hash,
      verdict: applied.verdict,
      layer: applied.layer,
      reasons: applied.reasons,
      ...(applied.summary ? { verifier_summary: applied.summary.slice(0, 4000) } : {}),
    };
    const verdict = buildOutbound('firewall_verdict', body, {
      sessionId,
      seq: nextStreamSeq(db, sessionId, 'buyer'),
      agentId,
      key,
      now,
      ...(inReplyTo ? { inReplyTo } : {}),
    });
    const prev = latestVerdict(hash);
    db.prepare(
      `INSERT INTO verdicts (cart_mandate_hash, seq, verdict, layer, reasons_json, details_json,
         verdict_json, issued_at, verifier_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash,
      (prev?.seq ?? 0) + 1,
      applied.verdict,
      applied.layer,
      JSON.stringify(applied.reasons),
      JSON.stringify(applied.details),
      JSON.stringify(verdict),
      now().toISOString(),
      verifierJson,
    );
    return verdict;
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
    intent_verifier: verifierInfo,
    review: reviewToken ? 'enabled' : 'disabled (FIREWALL_REVIEW_TOKEN unset)',
    escalation_timeout_sec: escalationTimeoutSec,
    pending_escalations: (
      db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n,
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
    await sweepExpired(); // lazy timeout: a poller never sees a stale hold
    const v = latestVerdict(hash);
    if (!v) return reply.code(404).send({ error: 'unknown cart_mandate_hash' });
    return reply.code(200).send(JSON.parse(v.verdict_json));
  });

  // --- the human queue (D022) -----------------------------------------------

  const gate = (req: { headers: Record<string, unknown> }) => {
    if (!reviewToken) return { status: 503, error: 'FIREWALL_REVIEW_TOKEN not configured' };
    if (req.headers['x-review-token'] !== reviewToken)
      return { status: 401, error: 'invalid review token' };
    return null;
  };

  app.get('/review', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    await sweepExpired();
    const rows = db
      .prepare("SELECT * FROM escalations WHERE status = 'pending' ORDER BY held_since")
      .all() as EscalationRow[];
    return reply.code(200).send({ pending: rows.map(reviewItem) });
  });

  app.post('/review/:hash', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    const { hash } = req.params as { hash: string };
    const body = (req.body ?? {}) as { decision?: string; reviewer?: string; note?: string };
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return reply.code(400).send({ error: 'decision must be "approve" or "reject"' });
    }
    if (typeof body.reviewer !== 'string' || body.reviewer.length === 0) {
      return reply.code(400).send({ error: 'reviewer is required' });
    }
    await sweepExpired(); // a hold past its deadline is already the timeout's, not the human's
    const out = await decide(hash, body.decision, body.reviewer, body.note ?? null);
    if (!out.ok) {
      return reply.code(out.status).send({
        error: out.code,
        ...(out.verdict ? { verdict: out.verdict } : {}),
      });
    }
    return reply.code(200).send({ decision: body.decision, verdict: out.verdict });
  });

  /** What a reviewer needs to decide: goal vs. what is actually in the cart. */
  function reviewItem(e: EscalationRow) {
    const cart = cartRow(e.cart_mandate_hash)!;
    const cartMsg = JSON.parse(cart.cart_json) as Message<'cart_mandate'>;
    const mandate = JSON.parse(
      mandateByRef(cart.intent_mandate_ref)!.mandate_json,
    ) as IntentMandate;
    const v = latestVerdict(e.cart_mandate_hash)!;
    return {
      cart_mandate_hash: e.cart_mandate_hash,
      session_id: e.session_id,
      held_since: e.held_since,
      expires_at: e.expires_at,
      principal_id: cart.principal_id,
      goal: mandate.goal,
      preferences: mandate.preferences,
      seller_agent_id: cart.seller_agent_id,
      total: cart.total,
      line_items: cartMsg.body.line_items.map((li) => ({
        item_id: li.item_id,
        variant_id: li.variant_id,
        quantity: li.quantity,
        unit_price: li.unit_price,
        category: li.catalog_item.category,
        title: li.catalog_item.title,
      })),
      reasons: JSON.parse(v.reasons_json) as string[],
      details: JSON.parse(v.details_json) as string[],
      verifier: v.verifier_json ? (JSON.parse(v.verifier_json) as unknown) : null,
    };
  }

  /**
   * Decide a pending escalation EXACTLY ONCE (amendment #1). The claim
   * (`UPDATE … WHERE status = 'pending'`), the layer-1 re-check and the
   * appended human verdict are one synchronous transaction; whoever commits
   * first — a human or the timeout sweep — wins, the other sees
   * ALREADY_DECIDED and no further verdict is ever produced. Dispatch and
   * seller notification happen after the commit, exactly as for an
   * immediate allow.
   */
  async function decide(
    hash: string,
    decision: Decision,
    reviewer: string | null,
    note: string | null,
  ): Promise<
    | { ok: true; verdict: Message<'firewall_verdict'> }
    | { ok: false; status: number; code: string; verdict?: unknown }
  > {
    const committed = db.transaction(() => {
      const claim = db
        .prepare(
          `UPDATE escalations SET status = 'decided', decision = ?, reviewer = ?, note = ?, decided_at = ?
            WHERE cart_mandate_hash = ? AND status = 'pending'`,
        )
        .run(decision, reviewer, note, now().toISOString(), hash);
      if (claim.changes === 0) return null;
      const cart = cartRow(hash)!;
      const cartMsg = JSON.parse(cart.cart_json) as Message<'cart_mandate'>;
      const row = mandateByRef(cart.intent_mandate_ref)!;
      let applied: AppliedVerdict;
      if (decision === 'approve') {
        // The human sits below the policy (§7.9): re-run layer 1 by the
        // firewall's clock — expiry, deadline, velocity, mandate status.
        const recheck = layer1For(cartMsg.body, row, hash);
        applied =
          recheck.verdict === 'block'
            ? {
                verdict: 'block',
                layer: 'policy',
                reasons: recheck.reasons,
                details: recheck.details.map((d) => `human approval refused by policy: ${d}`),
              }
            : {
                verdict: 'allow',
                layer: 'human',
                reasons: ['HUMAN_APPROVED'],
                details: [`approved by ${reviewer}${note ? `: ${note}` : ''}`],
              };
      } else if (decision === 'reject') {
        applied = {
          verdict: 'block',
          layer: 'human',
          reasons: ['HUMAN_REJECTED'],
          details: [`rejected by ${reviewer}${note ? `: ${note}` : ''}`],
        };
      } else {
        applied = {
          verdict: 'block',
          layer: 'human',
          reasons: ['ESCALATION_TIMEOUT'],
          details: [`no human decision within ${escalationTimeoutSec}s — auto-blocked (T10)`],
        };
      }
      const verdict = appendVerdict(cart.session_id, hash, applied, null);
      db.prepare('UPDATE sessions SET state = ? WHERE session_id = ?').run(
        stateFor(applied.verdict),
        cart.session_id,
      );
      return { verdict, applied, cartMsg, row };
    })();

    if (!committed) {
      const existing = escalationRow(hash);
      if (!existing) return { ok: false, status: 404, code: 'NOT_FOUND' };
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_DECIDED',
        verdict: JSON.parse(latestVerdict(hash)!.verdict_json) as unknown,
      };
    }
    const { verdict, applied, cartMsg, row } = committed;
    app.log[applied.verdict === 'allow' ? 'info' : 'warn'](
      {
        mandate_hash: hash,
        decision,
        reviewer,
        verdict: applied.verdict,
        layer: applied.layer,
        reasons: applied.reasons,
        details: applied.details,
        ...(decision === 'timeout' ? { event: 'ESCALATION_TIMEOUT' } : {}),
      },
      `escalation decided: ${decision} → ${applied.verdict}`,
    );
    if (applied.verdict === 'allow') await dispatchSettlement(cartMsg, verdict, row, hash);
    await notifySeller(cartMsg.session_id, verdict.body, hash);
    return { ok: true, verdict };
  }

  /** T10: every pending hold past its deadline becomes a timeout decision. */
  async function sweepExpired(): Promise<void> {
    const due = db
      .prepare(
        "SELECT cart_mandate_hash FROM escalations WHERE status = 'pending' AND expires_at <= ?",
      )
      .all(now().toISOString()) as { cart_mandate_hash: string }[];
    for (const { cart_mandate_hash } of due) {
      await decide(cart_mandate_hash, 'timeout', null, null);
    }
  }
  if (sweepIntervalMs > 0) {
    const timer = setInterval(() => {
      sweepExpired().catch((err) => app.log.error({ err }, 'escalation sweep failed'));
    }, sweepIntervalMs);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

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
    const layer1 = layer1For(body, row, mandate_hash);
    // Layer 2 runs only on a layer-1 allow (§7.9) and only recommends; its
    // answer — or its absence — is data for the applier, nothing else.
    let layer2: Layer2Input = 'not_configured';
    if (layer1.verdict === 'allow' && verifier !== 'not_configured') {
      layer2 = await verifier.verify(mandate, body);
      if (layer2.kind === 'absent') {
        app.log.warn(
          { mandate_hash, event: 'VERIFIER_ABSENT', reason: layer2.reason, record: layer2.record },
          'intent-verifier absent — escalating, never allowing',
        );
      }
    }
    const applied = applyVerdict(layer1, layer2);
    const verifierJson = layer2 === 'not_configured' ? null : JSON.stringify(layer2);
    const ts = now().toISOString();
    const verdict = db.transaction(() => {
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
      ).run(msg.session_id, body.intent_mandate_ref, mandate_hash, stateFor(applied.verdict), ts);
      const v = appendVerdict(msg.session_id, mandate_hash, applied, verifierJson, msg.message_id);
      if (applied.verdict === 'escalate') {
        db.prepare(
          `INSERT INTO escalations (cart_mandate_hash, session_id, held_since, expires_at)
           VALUES (?, ?, ?, ?)`,
        ).run(
          mandate_hash,
          msg.session_id,
          ts,
          new Date(now().getTime() + escalationTimeoutSec * 1000).toISOString(),
        );
      }
      return v;
    })();
    app.log[applied.verdict === 'allow' ? 'info' : 'warn'](
      {
        session_id: msg.session_id,
        mandate_hash,
        verdict: applied.verdict,
        layer: applied.layer,
        reasons: applied.reasons,
        details: applied.details,
        verifier: layer2 === 'not_configured' ? 'not_configured' : layer2.record,
        total: body.total,
        seller: body.seller_agent_id,
      },
      `firewall_verdict ${applied.verdict}`,
    );

    // F1 step 8: dispatch to settlement BEFORE replying (amendment #4).
    if (applied.verdict === 'allow') await dispatchSettlement(msg, verdict, row, mandate_hash);
    // §7.9: the seller gets every verdict, in its own envelope on its own stream.
    await notifySeller(msg.session_id, verdict.body, mandate_hash);
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

  // In-process seam (tests, and the Day 10 dashboard if it co-hosts).
  app.decorate('firewall', { decide, sweepExpired });
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
