import { randomUUID } from 'node:crypto';
import {
  hashCanonical,
  generateKeyPair,
  isFatal,
  makeBoundary,
  messageSchema,
  signObject,
  verifyObject,
  type BodyOf,
  type CatalogItem,
  type ErrorCode,
  type IntentMandate,
  type JsonValue,
  type KeyPair,
  type LineItem,
  type Message,
  type MessageType,
} from '@negotiator/protocol';
import { StubLlmAdapter, proposeMove, type LlmAdapter, type MoveRecord } from '@negotiator/llm';
import type { Ledger } from '@negotiator/ledger';
import { SqliteReplayStore, type BuyerDb } from './db.js';
import { buildMandateRegister } from './mandate.js';
import { shortlist } from './shortlist.js';
import {
  DEFAULT_BUYER_TUNING,
  bidPrice,
  clampBuyerPrice,
  decideBuyer,
  type BuyerLineView,
  type BuyerParams,
} from './strategy.js';

/**
 * The buyer's whole run (FLOW F1 steps 1–8, F2, F3). Under the sync
 * binding (D013) the buyer drives: every send is an HTTP POST to the
 * receiver's /acnp and the reply rides back in the 200 body (204 =
 * accepted, nothing owed). EVERY reply passes the same boundary pipeline
 * the receivers run (F5) before any logic may look at it.
 *
 * Order of legs, and why:
 *   1. mandate_register → firewall. No ack, no negotiation (D010): an agent
 *      that has not deposited its authorization must not open a session.
 *   2. session_init … accept → seller (the Day 5 loop, unchanged).
 *   3. cart_mandate → seller copy FIRST, then → firewall. The firewall
 *      delivers its verdict to the seller inside its own handler, so the
 *      seller must already hold the cart (COMPLIANCE_REVIEW) or the verdict
 *      would arrive in AGREED and be refused.
 *   4. poll GET /receipt on settlement until paid | failed | timeout.
 *
 * Sequence bookkeeping (§6): streams are per (session, sender, receiver).
 * The buyer keeps one outbound counter toward the seller (`buyer_seq`) and
 * one toward the firewall (`firewall_seq`); inbound counters live in the
 * replay store per sender. A reply that passes the boundary consumes the
 * sender's seq immediately — even if the buyer then rejects it — mirroring
 * the receivers' rule, so nobody can wedge anybody with authenticated but
 * unwelcome messages.
 */

export interface PostResult {
  status: number;
  body: unknown;
}
/** Transport seams: tests inject fastify's inject(); production uses fetch. */
export type PostFn = (url: string, payload: unknown) => Promise<PostResult>;
export type GetFn = (url: string) => Promise<PostResult>;

export interface RunnerLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/** The two long-lived counterparties (§5) and how to poll them. */
export interface BuyerChainConfig {
  firewallUrl: string;
  firewallPublicKey: string;
  settlementUrl: string;
  settlementPublicKey: string;
  get: GetFn;
  pollIntervalMs: number;
  /** Receipt poll window (settlement is seconds away). */
  pollTimeoutMs: number;
  /**
   * Verdict poll window after an `escalate` — a HUMAN is at the other end,
   * so this is minutes, not seconds; when it closes the run is `pending`,
   * never failed (§7.9). Defaults to pollTimeoutMs.
   */
  verdictPollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunnerDeps {
  db: BuyerDb;
  mandate: IntentMandate;
  /** hashCanonical(mandate) — the §7.1 intent_mandate_ref. */
  mandateRef: string;
  agentId: string;
  post: PostFn;
  chain: BuyerChainConfig;
  log: RunnerLog;
  /** The buyer's own append-only audit chain (PROTOCOL §11, D023). */
  ledger: Ledger;
  now?: () => Date;
  clockSkewSec?: number;
  tuning?: { opening_ratio: number; concession_exponent: number };
  /** Buyer-side model (D015: advisory). Default stub = pure curve. */
  llm?: LlmAdapter;
}

export interface RunOptions {
  merchantUrl: string;
  /**
   * Scenario override for tests/evals: negotiate this exact variant instead
   * of the shortlist's top pick. Strategy bounds (reservation ≤ budget)
   * still apply — this selects the target, it never loosens the math.
   */
  targetVariantId?: string;
}

export interface TranscriptEntry {
  direction: 'sent' | 'received';
  message: Message;
  /** Buyer offers only: which model proposed the number, or why not (amendment #3). */
  llm?: MoveRecord;
}

/** Per-run LLM usage, mutated by the loop and reported in the result. */
interface RunStats {
  calls: number;
  fallbacks: number;
}

export type RunOutcome = 'settled' | 'pending' | 'blocked' | 'walked_away' | 'failed';

interface CoreResult {
  session_id: string;
  state: string;
  outcome: RunOutcome;
  /** walk_away reason_code, verdict reasons, or error code, when not settled. */
  reason?: string;
  rounds: number;
  /** True once the firewall acked mandate_register for this run (D010). */
  mandate_registered: boolean;
  deal?: { line_items: LineItem[]; total: number };
  cart_mandate_hash?: string;
  verdict?: BodyOf<'firewall_verdict'>;
  receipt?: BodyOf<'settlement_receipt'>;
  transcript: TranscriptEntry[];
  /** Human-readable trace of buyer-internal decisions (demo legibility). */
  notes: string[];
}

export interface RunResult extends CoreResult {
  /** Demo header material: the story reads top-down from the goal. */
  mandate: { goal: string; budget_ceiling: number; intent_mandate_ref: string };
  models: { buyer: string };
  llm: RunStats;
  /** So a renderer can re-verify every signature without reading .env. */
  keys: { firewall: string; settlement: string };
}

/** Internal: aborts the run with a protocol-level failure. */
class RunFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

type Receiver = 'seller' | 'firewall';
type Key = KeyPair;

/** What negotiate() hands to the settlement leg. */
interface Agreement {
  line_items: LineItem[];
  total: number;
  accepted_message_id: string;
  seller_agent_id: string;
  catalog: CatalogItem[];
}

export class BuyerRunner {
  private readonly now: () => Date;
  private readonly receive: ReturnType<typeof makeBoundary>;
  private readonly llm: LlmAdapter;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.llm = deps.llm ?? new StubLlmAdapter('');
    this.receive = makeBoundary({
      resolveKey: (msg) => {
        // Long-lived, configured key for the firewall (§5).
        if (msg.sender.role === 'firewall') return deps.chain.firewallPublicKey;
        // TOFU (§5): session_ack carries the seller key we pin.
        if (msg.type === 'session_ack') {
          return (msg.body as BodyOf<'session_ack'>).seller_public_key;
        }
        const row = this.session(msg.session_id);
        return row?.seller_public_key ?? null;
      },
      replayStore: new SqliteReplayStore(deps.db),
      ...(deps.clockSkewSec !== undefined ? { clockSkewSec: deps.clockSkewSec } : {}),
      now: this.now,
    });
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const { db, mandate, mandateRef, agentId, log } = this.deps;
    const sessionId = randomUUID();
    const key = generateKeyPair();
    db.prepare(
      `INSERT INTO sessions (session_id, state, merchant_url, buyer_agent_id,
         buyer_public_key, buyer_private_key, mandate_ref, buyer_model, created_at)
       VALUES (?, 'INIT', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      opts.merchantUrl,
      agentId,
      key.publicKey,
      key.privateKey,
      mandateRef,
      this.llm.modelId, // model-per-side recorded in every session (D008)
      this.now().toISOString(),
    );
    this.deps.ledger.append(
      'SESSION_STATE',
      { state: 'INIT', buyer_model: this.llm.modelId, intent_mandate_ref: mandateRef },
      { session_id: sessionId },
    );

    const transcript: TranscriptEntry[] = [];
    const notes: string[] = [];
    const stats: RunStats = { calls: 0, fallbacks: 0 };
    const decorate = (core: CoreResult): RunResult => ({
      ...core,
      mandate: {
        goal: mandate.goal,
        budget_ceiling: mandate.budget_ceiling,
        intent_mandate_ref: mandateRef,
      },
      models: { buyer: this.llm.modelId },
      llm: stats,
      keys: {
        firewall: this.deps.chain.firewallPublicKey,
        settlement: this.deps.chain.settlementPublicKey,
      },
    });

    try {
      // F1 step 1: no registration, no session (D010).
      await this.register(sessionId, key, mandate, transcript, notes);
      const end = await this.negotiate(sessionId, key, mandate, opts, transcript, notes, stats);
      if (end.kind === 'walked_away') {
        return decorate(this.finish(sessionId, transcript, notes, 'walked_away', end.reason));
      }
      const outcome = await this.settle(sessionId, key, opts, end.agreement, transcript, notes);
      return decorate(outcome);
    } catch (err) {
      const failure = err instanceof RunFailure ? err : new RunFailure('INTERNAL', String(err));
      this.setState(sessionId, 'FAILED');
      log.warn({ session_id: sessionId, code: failure.code }, 'negotiation run failed');
      notes.push(`failed: ${failure.code} — ${failure.detail}`);
      return decorate(this.finish(sessionId, transcript, notes, 'failed', failure.code));
    }
  }

  // --- leg 1: registration (§7.0) --------------------------------------

  private async register(
    sessionId: string,
    key: Key,
    mandate: IntentMandate,
    transcript: TranscriptEntry[],
    notes: string[],
  ): Promise<void> {
    const { chain, agentId, db, log } = this.deps;
    const msg = buildMandateRegister(mandate, key, agentId, this.now);
    transcript.push({ direction: 'sent', message: msg as Message });
    let res: PostResult;
    try {
      res = await this.deps.post(`${chain.firewallUrl.replace(/\/$/, '')}/acnp`, msg);
    } catch (err) {
      throw new RunFailure('FIREWALL_UNREACHABLE', String(err));
    }
    const ack = this.acceptReply<'mandate_ack'>(res, 'mandate_ack', sessionId, transcript);
    if (ack.body.intent_mandate_ref !== this.deps.mandateRef) {
      throw new RunFailure('MANDATE_CONFLICT', 'firewall acked a different mandate ref');
    }
    // Amendment #3 (FEATURE-005) closes here: the row says 1 only after an ack.
    db.prepare('UPDATE sessions SET mandate_registered = 1 WHERE session_id = ?').run(sessionId);
    log.info({ session_id: sessionId, ref: this.deps.mandateRef }, 'mandate registered');
    notes.push(
      `mandate registered with firewall ${ack.sender.agent_id} (ref ${this.deps.mandateRef.slice(0, 12)}…)`,
    );
  }

  // --- leg 3–4: cart, verdict, receipt (§7.8–§7.11) ---------------------

  private async settle(
    sessionId: string,
    key: Key,
    opts: RunOptions,
    agreement: Agreement,
    transcript: TranscriptEntry[],
    notes: string[],
  ): Promise<CoreResult> {
    const { chain, agentId, db } = this.deps;
    const merchantUrl = `${opts.merchantUrl.replace(/\/$/, '')}/acnp`;
    const firewallUrl = `${chain.firewallUrl.replace(/\/$/, '')}/acnp`;

    // Build the Cart Mandate (§7.8) from the agreed lines and the seller's
    // exact catalog snapshots; mandate_hash commits to everything else.
    const line_items = agreement.line_items.map((li) => {
      const item = agreement.catalog.find((c) => c.item_id === li.item_id);
      if (!item) throw new RunFailure('INTERNAL', `agreed item ${li.item_id} not in catalog`);
      const { catalog_hash, ...catalog_item } = item;
      return {
        item_id: li.item_id,
        variant_id: li.variant_id,
        quantity: li.quantity,
        unit_price: li.proposed_unit_price,
        catalog_hash,
        catalog_item,
      };
    });
    const unhashed = {
      intent_mandate_ref: this.deps.mandateRef,
      accepted_message_id: agreement.accepted_message_id,
      line_items,
      total: agreement.total,
      currency: 'INR' as const,
      seller_agent_id: agreement.seller_agent_id,
      buyer_agent_id: agentId,
    };
    const cart: BodyOf<'cart_mandate'> = { ...unhashed, mandate_hash: hashCanonical(unhashed) };
    db.prepare('UPDATE sessions SET cart_mandate_hash = ? WHERE session_id = ?').run(
      cart.mandate_hash,
      sessionId,
    );
    notes.push(`cart mandate ${cart.mandate_hash.slice(0, 12)}… binds accept + snapshot + total`);

    // Seller copy first (see class comment), own envelope on the seller stream.
    await this.sendClosing(merchantUrl, sessionId, key, 'cart_mandate', cart, transcript, 'seller');
    // Then the firewall: its reply IS the verdict (allow/block) or an escalate hold.
    this.setState(sessionId, 'COMPLIANCE_REVIEW');
    let verdictMsg = await this.exchange<'firewall_verdict'>(
      firewallUrl,
      sessionId,
      key,
      'cart_mandate',
      cart,
      transcript,
      'firewall_verdict',
      undefined,
      'firewall',
    );
    if (verdictMsg.body.cart_mandate_hash !== cart.mandate_hash) {
      throw new RunFailure('VERDICT_MISMATCH', 'verdict is for a different cart');
    }
    if (verdictMsg.body.verdict === 'escalate') {
      const held = verdictMsg.body;
      notes.push(
        `verdict: ESCALATE (${held.layer}) — held for a human${held.reasons.length ? ` [${held.reasons.join(', ')}]` : ''}; polling /verdict`,
      );
      db.prepare('UPDATE sessions SET verdict = ? WHERE session_id = ?').run('escalate', sessionId);
      const decided = await this.pollVerdict(cart.mandate_hash, transcript);
      if (!decided) {
        // §7.9: a hold whose poller gives up is still a hold — pending, not
        // failed; the verdict, once a human issues it, stays retrievable.
        // Resuming a held run is Day 10; the hash below is what it needs.
        notes.push(
          `still held after ${chain.verdictPollTimeoutMs ?? chain.pollTimeoutMs}ms — outcome pending (approve/reject on the firewall: ${cart.mandate_hash})`,
        );
        return {
          ...this.finish(sessionId, transcript, notes, 'pending', 'HELD_IN_REVIEW'),
          deal: { line_items: agreement.line_items, total: agreement.total },
          cart_mandate_hash: cart.mandate_hash,
          verdict: held,
        };
      }
      verdictMsg = decided;
    }
    const verdict = verdictMsg.body;
    db.prepare('UPDATE sessions SET verdict = ? WHERE session_id = ?').run(
      verdict.verdict,
      sessionId,
    );
    if (verdict.verdict === 'block') {
      this.setState(sessionId, 'BLOCKED');
      notes.push(`verdict: BLOCK (${verdict.layer}) — ${verdict.reasons.join(', ')}`);
      return {
        ...this.finish(sessionId, transcript, notes, 'blocked', verdict.reasons.join(',')),
        deal: { line_items: agreement.line_items, total: agreement.total },
        cart_mandate_hash: cart.mandate_hash,
        verdict,
      };
    }
    notes.push(`verdict: ALLOW (${verdict.layer}) — settlement requested by the firewall`);
    this.setState(sessionId, 'SETTLING');

    // F1 step 8: poll for the signed receipt (D013).
    const receipt = await this.pollReceipt(sessionId, cart.mandate_hash, transcript, notes);
    const base = {
      deal: { line_items: agreement.line_items, total: agreement.total },
      cart_mandate_hash: cart.mandate_hash,
      verdict,
    };
    if (!receipt) {
      // Amendment #4: compliant but unconfirmed — pending, never "paid".
      db.prepare('UPDATE sessions SET settlement_status = ? WHERE session_id = ?').run(
        'pending',
        sessionId,
      );
      notes.push(
        'no receipt within the polling window — outcome pending (settlement may still complete)',
      );
      return {
        ...this.finish(sessionId, transcript, notes, 'pending', 'RECEIPT_TIMEOUT'),
        ...base,
      };
    }
    db.prepare(
      'UPDATE sessions SET settlement_status = ?, razorpay_order_id = ? WHERE session_id = ?',
    ).run(receipt.status, receipt.razorpay_order_id, sessionId);
    if (receipt.status === 'paid') {
      this.setState(sessionId, 'SETTLED');
      notes.push(`receipt: PAID — Razorpay order ${receipt.razorpay_order_id}`);
      return { ...this.finish(sessionId, transcript, notes, 'settled'), ...base, receipt };
    }
    this.setState(sessionId, 'FAILED');
    notes.push(`receipt: ${receipt.status.toUpperCase()}`);
    return {
      ...this.finish(sessionId, transcript, notes, 'failed', 'SETTLEMENT_FAILED'),
      ...base,
      receipt,
    };
  }

  /**
   * §7.9: after an escalate, poll the firewall until a terminal verdict
   * (a human decision or the queue timeout), or null when the verdict poll
   * window closes — the caller turns that into `pending`, never `failed`.
   */
  private async pollVerdict(
    hash: string,
    transcript: TranscriptEntry[],
  ): Promise<Message<'firewall_verdict'> | null> {
    const { chain } = this.deps;
    const url = `${chain.firewallUrl.replace(/\/$/, '')}/verdict/${hash}`;
    for await (const _tick of this.ticks(chain.verdictPollTimeoutMs ?? chain.pollTimeoutMs)) {
      const res = await chain.get(url).catch(() => null);
      const parsed = res && messageSchema('firewall_verdict').safeParse(res.body);
      if (parsed && parsed.success) {
        const v = parsed.data as unknown as Message<'firewall_verdict'>;
        if (!verifyObject(v, chain.firewallPublicKey).ok) {
          throw new RunFailure('SIG_INVALID', 'polled verdict does not verify');
        }
        if (v.body.cart_mandate_hash !== hash) {
          throw new RunFailure('VERDICT_MISMATCH', 'polled verdict is for a different cart');
        }
        if (v.body.verdict !== 'escalate') {
          transcript.push({ direction: 'received', message: v });
          // Polled, verified, acted on: evidence (§11).
          this.deps.ledger.append('MESSAGE_IN', asPayload(v), {
            session_id: v.session_id,
            ref: hash,
          });
          return v;
        }
      }
    }
    return null;
  }

  /** §7.11: the latest signed receipt, or null when the bounded window closes. */
  private async pollReceipt(
    sessionId: string,
    hash: string,
    transcript: TranscriptEntry[],
    notes: string[],
  ): Promise<BodyOf<'settlement_receipt'> | null> {
    const { chain, log } = this.deps;
    const url = `${chain.settlementUrl.replace(/\/$/, '')}/receipt/${hash}`;
    let polls = 0;
    for await (const _tick of this.ticks()) {
      polls += 1;
      const res = await chain.get(url).catch((err: unknown) => {
        log.warn({ session_id: sessionId, error: String(err) }, 'receipt poll failed');
        return null;
      });
      if (!res || res.status !== 200) continue;
      const parsed = messageSchema('settlement_receipt').safeParse(res.body);
      if (parsed.success) {
        const r = parsed.data as unknown as Message<'settlement_receipt'>;
        if (!verifyObject(r, chain.settlementPublicKey).ok || r.body.mandate_hash !== hash) {
          throw new RunFailure('SIG_INVALID', 'receipt does not verify against the settlement key');
        }
        transcript.push({ direction: 'received', message: r });
        this.deps.ledger.append('MESSAGE_IN', asPayload(r), { session_id: sessionId, ref: hash });
        notes.push(`receipt received after ${polls} poll(s)`);
        return r.body;
      }
      // A signed pending status (§7.11) — verify it too, then keep waiting.
      const pending = res.body as { status?: string; signature?: unknown };
      if (pending?.status === 'pending' && !verifyObject(pending, chain.settlementPublicKey).ok) {
        throw new RunFailure('SIG_INVALID', 'pending status does not verify');
      }
    }
    log.warn({ session_id: sessionId, polls }, 'receipt poll window closed; outcome pending');
    return null;
  }

  /** Bounded by wall clock AND poll count, so an injected clock can never spin it. */
  private async *ticks(timeoutMs = this.deps.chain.pollTimeoutMs): AsyncGenerator<number> {
    const { chain } = this.deps;
    const sleep = chain.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = this.now().getTime() + timeoutMs;
    const maxPolls = Math.ceil(timeoutMs / Math.max(chain.pollIntervalMs, 1)) + 1;
    for (let i = 0; i < maxPolls && this.now().getTime() <= deadline; i++) {
      yield i;
      await sleep(chain.pollIntervalMs);
    }
  }

  // --- leg 3 helper: the model proposes -----------------------------------

  /**
   * FLOW F1 step 3: ask the model for a price + rationale for the buyer's
   * NEXT offer. Shown its own ceiling (the reservation); the clamp in
   * strategy.ts enforces it regardless. Null proposal = deterministic curve
   * (D015). Every call is attributed per round (amendment #3).
   */
  private async propose(
    sessionId: string,
    nextRound: number,
    view: BuyerLineView,
    text: { title: string; description: string },
    params: BuyerParams,
    counterparty: number | undefined,
    mandate: IntentMandate,
    stats: RunStats,
    notes: string[],
  ): Promise<{ prices?: Map<string, number>; rationale?: string; record: MoveRecord }> {
    const { proposal, record } = await proposeMove(this.llm, {
      role: 'buyer',
      round: nextRound,
      max_rounds: params.max_rounds,
      currency: 'INR',
      goal: mandate.goal,
      preferences: mandate.preferences,
      lines: [
        {
          variant_id: view.variant_id,
          title: text.title,
          description: text.description,
          quantity: view.quantity,
          list_price: view.list_price,
          ...(counterparty !== undefined ? { counterparty_unit_price: counterparty } : {}),
          bound: { kind: 'ceiling', value: view.reservation },
        },
      ],
    });
    this.deps.db
      .prepare(
        `INSERT OR REPLACE INTO llm_moves
           (session_id, round, role, model_id, used_llm, fallback_reason, latency_ms)
         VALUES (?, ?, 'buyer', ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        nextRound,
        record.model_id,
        record.used_llm ? 1 : 0,
        record.fallback_reason ?? null,
        record.latency_ms,
      );
    this.deps.ledger.append(
      'LLM_MOVE',
      {
        round: nextRound,
        role: 'buyer',
        model_id: record.model_id,
        used_llm: record.used_llm,
        fallback_reason: record.fallback_reason ?? null,
        latency_ms: Math.round(record.latency_ms),
      },
      { session_id: sessionId },
    );
    stats.calls += 1;
    if (!record.used_llm) {
      stats.fallbacks += 1;
      if (this.llm.provider !== 'stub') {
        notes.push(`round ${nextRound}: LLM fallback to curve (${record.fallback_reason})`);
        this.deps.log.warn(
          { session_id: sessionId, round: nextRound, ...record },
          'LLM fallback to deterministic curve',
        );
      }
    }
    return {
      ...(proposal ? { prices: new Map(Object.entries(proposal.proposed_prices)) } : {}),
      ...(proposal ? { rationale: proposal.rationale } : {}),
      record,
    };
  }

  // --- leg 2: the negotiation loop (F1 steps 2–6, F2) --------------------

  /** Ends in an agreement (→ settle) or a walk-away (state already set, note pushed). */
  private async negotiate(
    sessionId: string,
    key: Key,
    mandate: IntentMandate,
    opts: RunOptions,
    transcript: TranscriptEntry[],
    notes: string[],
    stats: RunStats,
  ): Promise<{ kind: 'agreed'; agreement: Agreement } | { kind: 'walked_away'; reason: string }> {
    const url = `${opts.merchantUrl.replace(/\/$/, '')}/acnp`;

    // 1. session_init → session_ack (TOFU pin).
    const ack = await this.exchange<'session_ack'>(
      url,
      sessionId,
      key,
      'session_init',
      {
        buyer_public_key: key.publicKey,
        supported_versions: ['0.1'],
        intent_mandate_ref: this.deps.mandateRef,
      },
      transcript,
      'session_ack',
    );
    if (ack.body.chosen_version !== '0.1') {
      throw new RunFailure('VERSION_UNSUPPORTED', `seller chose ${ack.body.chosen_version}`);
    }
    this.deps.db
      .prepare(
        `UPDATE sessions SET state = 'NEGOTIATING', seller_agent_id = ?,
           seller_public_key = ?, chosen_version = ? WHERE session_id = ?`,
      )
      .run(ack.sender.agent_id, ack.body.seller_public_key, ack.body.chosen_version, sessionId);
    notes.push(`pinned seller key from session_ack (agent ${ack.sender.agent_id})`);

    // 2. catalog_request → catalog_offer → shortlist.
    const catalog = await this.exchange<'catalog_offer'>(
      url,
      sessionId,
      key,
      'catalog_request',
      { max_items: 50 },
      transcript,
      'catalog_offer',
    );
    const listed = shortlist(catalog.body.items, mandate);
    for (const bad of listed.hash_mismatches) {
      notes.push(`catalog_hash mismatch on ${bad} — item excluded`);
    }
    const target = opts.targetVariantId
      ? this.findVariant(catalog.body.items, opts.targetVariantId, mandate)
      : listed.candidates[0];
    const walkAway = async (reason: BodyOf<'walk_away'>['reason_code'], note: string) => {
      await this.sendClosing(
        url,
        sessionId,
        key,
        'walk_away',
        { reason_code: reason },
        transcript,
        'seller',
      );
      this.setState(sessionId, 'WALKED_AWAY');
      notes.push(note);
      return { kind: 'walked_away' as const, reason };
    };
    if (!target) {
      return walkAway(
        'no_acceptable_terms',
        'no candidate satisfied the mandate — walked away before offering',
      );
    }
    notes.push(
      `target: ${target.item.item_id}/${target.variant.variant_id} ` +
        `(list ${target.variant.list_price}, reservation ${target.reservation})`,
    );

    const view: BuyerLineView = {
      item_id: target.item.item_id,
      variant_id: target.variant.variant_id,
      quantity: 1,
      list_price: target.variant.list_price,
      reservation: target.reservation,
    };
    const params: BuyerParams = {
      ...(this.deps.tuning ?? DEFAULT_BUYER_TUNING),
      max_rounds: Math.min(mandate.max_rounds, ack.body.capabilities.max_rounds),
      budget_ceiling: mandate.budget_ceiling,
      deadline: mandate.constraints.deadline,
    };
    const agreementOf = (line_items: LineItem[], total: number, acceptId: string): Agreement => ({
      line_items,
      total,
      accepted_message_id: acceptId,
      seller_agent_id: ack.sender.agent_id,
      catalog: catalog.body.items,
    });

    // 3. Offer rounds. The opening bid may come from the model too — clamped
    // by clampBuyerPrice exactly like every later round.
    const text = { title: target.item.title, description: target.item.description };
    let round = 1;
    const opening = await this.propose(
      sessionId,
      1,
      view,
      text,
      params,
      undefined,
      mandate,
      stats,
      notes,
    );
    const openingProposal = opening.prices?.get(view.variant_id);
    const openingPrice =
      openingProposal !== undefined
        ? clampBuyerPrice(openingProposal, view, 1, params)
        : { price: bidPrice(view, 1, params), clamped: false as const };
    if (openingPrice.clamped) {
      notes.push(
        `clamped: ${view.variant_id}: ${openingPrice.reason} (proposed ${openingProposal})`,
      );
    }
    let lineItems: LineItem[] = [
      {
        item_id: view.item_id,
        variant_id: view.variant_id,
        quantity: 1,
        proposed_unit_price: openingPrice.price,
      },
    ];
    let rationale = opening.rationale;
    let moveRecord = opening.record;
    for (;;) {
      const total = lineItems.reduce((s, li) => s + li.quantity * li.proposed_unit_price, 0);
      this.deps.db
        .prepare('UPDATE sessions SET round = ? WHERE session_id = ?')
        .run(round, sessionId);
      const reply = await this.exchange<'counter_offer' | 'accept' | 'walk_away'>(
        url,
        sessionId,
        key,
        'offer',
        { line_items: lineItems, total, round, ...(rationale ? { rationale } : {}) },
        transcript,
        ['counter_offer', 'accept', 'walk_away'],
        moveRecord,
      );

      // `Message<union>` is not a discriminated union (type and body are
      // independent type params), so each branch casts body to its type.
      if (reply.type === 'accept') {
        // Seller accepted our numbers — echo rule §7.7 verified our side.
        const acc = reply.body as BodyOf<'accept'>;
        const echoOk =
          hashCanonical({ line_items: acc.line_items, total: acc.total }) ===
          hashCanonical({ line_items: lineItems, total });
        if (!echoOk)
          throw new RunFailure('ACCEPT_MISMATCH', 'seller accept does not echo our offer');
        this.setState(sessionId, 'AGREED');
        notes.push(`seller accepted our round-${round} offer at ${total}`);
        return { kind: 'agreed', agreement: agreementOf(lineItems, total, reply.message_id) };
      }
      if (reply.type === 'walk_away') {
        const wa = reply.body as BodyOf<'walk_away'>;
        this.setState(sessionId, 'WALKED_AWAY');
        notes.push(`seller walked away: ${wa.reason_code}`);
        return { kind: 'walked_away', reason: wa.reason_code };
      }

      // counter_offer: recompute the total before any strategy runs (§7.5).
      const counter = reply.body as BodyOf<'counter_offer'>;
      const computed = counter.line_items.reduce(
        (s, li) => s + li.quantity * li.proposed_unit_price,
        0,
      );
      if (computed !== counter.total) {
        throw new RunFailure(
          'TOTAL_MISMATCH',
          `seller claimed ${counter.total}, computed ${computed}`,
        );
      }
      // Accept / walk-away never depend on the model (pure curve rules), so
      // decide first and only spend an LLM call when we are going to counter.
      const counters = counter.line_items.map((line) => ({ line, view }));
      let decision = decideBuyer(counters, round, params, this.now);
      if (decision.kind === 'counter') {
        const next = await this.propose(
          sessionId,
          round + 1,
          view,
          text,
          params,
          counter.line_items[0]!.proposed_unit_price,
          mandate,
          stats,
          notes,
        );
        decision = decideBuyer(counters, round, params, this.now, next.prices);
        rationale = next.rationale;
        moveRecord = next.record;
      }

      if (decision.kind === 'accept') {
        const accept = await this.sendClosing(
          url,
          sessionId,
          key,
          'accept',
          {
            accepted_message_id: reply.message_id,
            line_items: counter.line_items,
            total: counter.total,
          },
          transcript,
          'seller',
        );
        this.setState(sessionId, 'AGREED');
        notes.push(`accepted seller counter at ${counter.total} in round ${round}`);
        return {
          kind: 'agreed',
          agreement: agreementOf(counter.line_items, counter.total, accept.message_id),
        };
      }
      if (decision.kind === 'walk_away') {
        return walkAway(
          decision.reason_code,
          `walked away in round ${round}: ${decision.reason_code}`,
        );
      }
      for (const reason of decision.clamp_reasons) notes.push(`clamped: ${reason}`);
      round += 1;
      lineItems = decision.line_items;
    }
  }

  // --- transport & plumbing --------------------------------------------

  /** Send one message and boundary-check the reply; expect one of `expected`. */
  private async exchange<T extends MessageType>(
    url: string,
    sessionId: string,
    key: Key,
    type: MessageType,
    body: unknown,
    transcript: TranscriptEntry[],
    expected: T | T[],
    llm?: MoveRecord,
    receiver: Receiver = 'seller',
  ): Promise<Message<T>> {
    const sent = this.buildOutbound(sessionId, key, type, body, receiver);
    transcript.push({ direction: 'sent', message: sent, ...(llm ? { llm } : {}) });
    const res = await this.deps.post(url, sent);
    return this.acceptReply<T>(res, expected, sessionId, transcript);
  }

  /** Boundary-check a reply body and require one of the expected types. */
  private acceptReply<T extends MessageType>(
    res: PostResult,
    expected: T | T[],
    sessionId: string,
    transcript: TranscriptEntry[],
  ): Message<T> {
    if (res.status === 204 || res.body === null || res.body === undefined) {
      throw new RunFailure(
        'STATE_INVALID',
        `expected a ${String(expected)} reply, got nothing (204)`,
      );
    }
    const checked = this.receive(res.body);
    if (!checked.ok) {
      // The reply failed signature/schema/replay checks — it never reaches
      // the strategy, and it does NOT consume the sender's seq (§6).
      this.rejected(sessionId, checked.code, checked.detail);
      throw new RunFailure(checked.code, checked.detail);
    }
    // Authenticated: consume the sender's seq now, before semantic checks
    // (§6 — authenticated-but-rejected still consumes).
    checked.commit();
    transcript.push({ direction: 'received', message: checked.message });
    this.deps.ledger.append('MESSAGE_IN', asPayload(checked.message), { session_id: sessionId });
    const msg = checked.message;
    if (msg.type === 'error') {
      const err = msg.body as BodyOf<'error'>;
      if (isFatal(err.code as ErrorCode)) this.setState(sessionId, 'FAILED');
      throw new RunFailure(err.code, err.detail);
    }
    const expectedList = Array.isArray(expected) ? expected : [expected];
    if (!expectedList.includes(msg.type as T)) {
      throw new RunFailure('STATE_INVALID', `expected ${expectedList.join('|')}, got ${msg.type}`);
    }
    return msg as Message<T>;
  }

  /** Send a message whose only acceptable reply is 204 (accept, walk_away, cart copy). */
  private async sendClosing(
    url: string,
    sessionId: string,
    key: Key,
    type: MessageType,
    body: unknown,
    transcript: TranscriptEntry[],
    receiver: Receiver,
  ): Promise<Message> {
    const sent = this.buildOutbound(sessionId, key, type, body, receiver);
    transcript.push({ direction: 'sent', message: sent });
    const res = await this.deps.post(url, sent);
    if (res.status === 204) return sent;
    // A signed error here is authenticated feedback; surface it.
    const checked = this.receive(res.body);
    if (checked.ok) {
      checked.commit();
      transcript.push({ direction: 'received', message: checked.message });
      this.deps.ledger.append('MESSAGE_IN', asPayload(checked.message), { session_id: sessionId });
      if (checked.message.type === 'error') {
        const err = checked.message.body as BodyOf<'error'>;
        throw new RunFailure(err.code, err.detail);
      }
      return sent; // unexpected but authenticated non-error reply: tolerated on close
    }
    this.rejected(sessionId, checked.code, checked.detail);
    throw new RunFailure(checked.code, checked.detail);
  }

  /** F5 on the buyer side: a reply that failed the boundary is on record, never acted on. */
  private rejected(sessionId: string, code: string, detail: string): void {
    this.deps.ledger.append(
      'BOUNDARY_REJECTED',
      { code, detail, claimed_session_id: sessionId },
      { session_id: sessionId },
    );
  }

  private buildOutbound(
    sessionId: string,
    key: Key,
    type: MessageType,
    body: unknown,
    receiver: Receiver,
  ): Message {
    const unsigned = {
      protocol: 'ACNP' as const,
      version: '0.1',
      type,
      message_id: randomUUID(),
      session_id: sessionId,
      seq: this.nextSeq(sessionId, receiver),
      sender: { agent_id: this.deps.agentId, role: 'buyer' as const },
      timestamp: this.now().toISOString(),
      body,
    };
    const signed = signObject(unsigned, key.privateKey, key.publicKey) as unknown as Message;
    // The receiver is not in the envelope (streams are per receiver, §6):
    // record it, so a replay can pair this entry with the right party's chain.
    this.deps.ledger.append(
      'MESSAGE_OUT',
      { ...asPayload(signed), receiver },
      { session_id: sessionId },
    );
    return signed;
  }

  private findVariant(
    items: BodyOf<'catalog_offer'>['items'],
    variantId: string,
    mandate: IntentMandate,
  ) {
    for (const item of items) {
      const variant = item.variants.find((v) => v.variant_id === variantId);
      if (variant) {
        return {
          item,
          variant,
          reservation: Math.min(variant.list_price, mandate.budget_ceiling),
        };
      }
    }
    return undefined;
  }

  private finish(
    sessionId: string,
    transcript: TranscriptEntry[],
    notes: string[],
    outcome: RunOutcome,
    reason?: string,
  ): CoreResult {
    const row = this.session(sessionId);
    return {
      session_id: sessionId,
      state: row?.state ?? 'FAILED',
      outcome,
      ...(reason !== undefined ? { reason } : {}),
      rounds: row?.round ?? 0,
      mandate_registered: (row?.mandate_registered ?? 0) === 1,
      transcript,
      notes,
    };
  }

  private session(id: string) {
    return this.deps.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as
      | {
          session_id: string;
          state: string;
          seller_public_key: string | null;
          round: number;
          mandate_registered: number;
        }
      | undefined;
  }

  private setState(sessionId: string, state: string): void {
    this.deps.db
      .prepare('UPDATE sessions SET state = ? WHERE session_id = ?')
      .run(state, sessionId);
    this.deps.ledger.append('SESSION_STATE', { state }, { session_id: sessionId });
  }

  /** Outbound seq on the (session, receiver) stream — §6. */
  private nextSeq(sessionId: string, receiver: Receiver): number {
    const col = receiver === 'seller' ? 'buyer_seq' : 'firewall_seq';
    this.deps.db
      .prepare(`UPDATE sessions SET ${col} = ${col} + 1 WHERE session_id = ?`)
      .run(sessionId);
    return (
      this.deps.db
        .prepare(`SELECT ${col} AS n FROM sessions WHERE session_id = ?`)
        .get(sessionId) as {
        n: number;
      }
    ).n;
  }
}

/** A signed envelope as a ledger payload (JSON-safe by construction: JCS-signed). */
function asPayload(m: Message): Record<string, JsonValue> {
  return m as unknown as Record<string, JsonValue>;
}
