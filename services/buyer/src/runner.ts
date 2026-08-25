import { randomUUID } from 'node:crypto';
import {
  hashCanonical,
  generateKeyPair,
  isFatal,
  makeBoundary,
  signObject,
  type BodyOf,
  type ErrorCode,
  type IntentMandate,
  type LineItem,
  type Message,
  type MessageType,
} from '@negotiator/protocol';
import { StubLlmAdapter, proposeMove, type LlmAdapter, type MoveRecord } from '@negotiator/llm';
import { SqliteReplayStore, type BuyerDb } from './db.js';
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
 * The buyer's negotiation loop (FLOW F1 steps 2–6, F2). Under the sync
 * binding (D013) the buyer drives: every send is an HTTP POST to the
 * merchant's /acnp and the counterparty's reply rides back in the 200 body
 * (204 = accepted, nothing owed). EVERY reply passes the same boundary
 * pipeline the merchant runs (F5) before the strategy may look at it.
 *
 * Sequence bookkeeping (§6): the buyer's outbound counter (buyer_seq) and
 * the seller's inbound counter (replay store) are independent. A reply that
 * passes the boundary consumes the seller's seq immediately — even if the
 * buyer then rejects it semantically — mirroring the merchant's rule, so
 * neither side can wedge the other by sending something authenticated but
 * unwelcome.
 */

export interface PostResult {
  status: number;
  body: unknown;
}
/** Transport seam: tests inject fastify's inject(); production uses fetch. */
export type PostFn = (url: string, payload: unknown) => Promise<PostResult>;

export interface RunnerLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface RunnerDeps {
  db: BuyerDb;
  mandate: IntentMandate;
  /** hashCanonical(mandate) — the §7.1 intent_mandate_ref. */
  mandateRef: string;
  agentId: string;
  post: PostFn;
  log: RunnerLog;
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

interface CoreResult {
  session_id: string;
  state: string;
  outcome: 'agreed' | 'walked_away' | 'failed';
  /** walk_away reason_code or error code, when not agreed. */
  reason?: string;
  rounds: number;
  /** Always false on Day 5: the firewall (Day 8) is not there to register with. */
  mandate_registered: boolean;
  deal?: { line_items: LineItem[]; total: number };
  transcript: TranscriptEntry[];
  /** Human-readable trace of buyer-internal decisions (demo legibility). */
  notes: string[];
}

export interface RunResult extends CoreResult {
  /** Demo header material: the story reads top-down from the goal. */
  mandate: { goal: string; budget_ceiling: number };
  models: { buyer: string };
  llm: RunStats;
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

export class BuyerRunner {
  private readonly now: () => Date;
  private readonly receive: ReturnType<typeof makeBoundary>;
  private readonly llm: LlmAdapter;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.llm = deps.llm ?? new StubLlmAdapter('');
    this.receive = makeBoundary({
      resolveKey: (msg) => {
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

    const transcript: TranscriptEntry[] = [];
    const notes: string[] = [];
    const stats: RunStats = { calls: 0, fallbacks: 0 };
    const decorate = (core: CoreResult): RunResult => ({
      ...core,
      mandate: { goal: mandate.goal, budget_ceiling: mandate.budget_ceiling },
      models: { buyer: this.llm.modelId },
      llm: stats,
    });
    // Amendment #3 / D010: the firewall does not exist yet, so the mandate
    // cannot be registered. This is deliberately loud — in the row, in the
    // log, and in the result — so Day 8 finds a TODO in the data.
    log.warn(
      { session_id: sessionId, mandate_registered: false },
      'mandate_register NOT delivered — firewall lands Day 8; session recorded as unregistered',
    );
    notes.push('mandate_registered=false: firewall (Day 8) not yet available to register with');

    try {
      const result = await this.negotiate(sessionId, key, mandate, opts, transcript, notes, stats);
      return decorate(result);
    } catch (err) {
      const failure = err instanceof RunFailure ? err : new RunFailure('INTERNAL', String(err));
      this.setState(sessionId, 'FAILED');
      log.warn({ session_id: sessionId, code: failure.code }, 'negotiation run failed');
      return decorate({
        session_id: sessionId,
        state: 'FAILED',
        outcome: 'failed',
        reason: failure.code,
        rounds: this.session(sessionId)?.round ?? 0,
        mandate_registered: false,
        transcript,
        notes: [...notes, `failed: ${failure.code} — ${failure.detail}`],
      });
    }
  }

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

  // --- the loop ---------------------------------------------------------

  private async negotiate(
    sessionId: string,
    key: { publicKey: string; privateKey: string },
    mandate: IntentMandate,
    opts: RunOptions,
    transcript: TranscriptEntry[],
    notes: string[],
    stats: RunStats,
  ): Promise<CoreResult> {
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
    if (!target) {
      await this.sendClosing(
        url,
        sessionId,
        key,
        'walk_away',
        { reason_code: 'no_acceptable_terms' },
        transcript,
      );
      this.setState(sessionId, 'WALKED_AWAY');
      notes.push('no candidate satisfied the mandate — walked away before offering');
      return this.finish(
        sessionId,
        'WALKED_AWAY',
        'walked_away',
        transcript,
        notes,
        'no_acceptable_terms',
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
        return this.finish(sessionId, 'AGREED', 'agreed', transcript, notes, undefined, {
          line_items: lineItems,
          total,
        });
      }
      if (reply.type === 'walk_away') {
        const wa = reply.body as BodyOf<'walk_away'>;
        this.setState(sessionId, 'WALKED_AWAY');
        notes.push(`seller walked away: ${wa.reason_code}`);
        return this.finish(
          sessionId,
          'WALKED_AWAY',
          'walked_away',
          transcript,
          notes,
          wa.reason_code,
        );
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
        await this.sendClosing(
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
        );
        this.setState(sessionId, 'AGREED');
        notes.push(`accepted seller counter at ${counter.total} in round ${round}`);
        return this.finish(sessionId, 'AGREED', 'agreed', transcript, notes, undefined, {
          line_items: counter.line_items,
          total: counter.total,
        });
      }
      if (decision.kind === 'walk_away') {
        await this.sendClosing(
          url,
          sessionId,
          key,
          'walk_away',
          { reason_code: decision.reason_code },
          transcript,
        );
        this.setState(sessionId, 'WALKED_AWAY');
        notes.push(`walked away in round ${round}: ${decision.reason_code}`);
        return this.finish(
          sessionId,
          'WALKED_AWAY',
          'walked_away',
          transcript,
          notes,
          decision.reason_code,
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
    key: { publicKey: string; privateKey: string },
    type: MessageType,
    body: unknown,
    transcript: TranscriptEntry[],
    expected: T | T[],
    llm?: MoveRecord,
  ): Promise<Message<T>> {
    const sent = this.buildOutbound(sessionId, key, type, body);
    transcript.push({ direction: 'sent', message: sent, ...(llm ? { llm } : {}) });
    const res = await this.deps.post(url, sent);
    if (res.status === 204 || res.body === null || res.body === undefined) {
      throw new RunFailure(
        'STATE_INVALID',
        `expected a ${String(expected)} reply, got nothing (204)`,
      );
    }
    const checked = this.receive(res.body);
    if (!checked.ok) {
      // The reply failed signature/schema/replay checks — it never reaches
      // the strategy, and it does NOT consume a seller seq (§6).
      throw new RunFailure(checked.code, checked.detail);
    }
    // Authenticated: consume the seller's seq now, before semantic checks
    // (§6 — authenticated-but-rejected still consumes).
    checked.commit();
    transcript.push({ direction: 'received', message: checked.message });
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

  /** Send a message whose only acceptable reply is 204 (accept, walk_away). */
  private async sendClosing(
    url: string,
    sessionId: string,
    key: { publicKey: string; privateKey: string },
    type: MessageType,
    body: unknown,
    transcript: TranscriptEntry[],
  ): Promise<void> {
    const sent = this.buildOutbound(sessionId, key, type, body);
    transcript.push({ direction: 'sent', message: sent });
    const res = await this.deps.post(url, sent);
    if (res.status === 204) return;
    // A signed error here is authenticated feedback; surface it.
    const checked = this.receive(res.body);
    if (checked.ok) {
      checked.commit();
      transcript.push({ direction: 'received', message: checked.message });
      if (checked.message.type === 'error') {
        const err = checked.message.body as BodyOf<'error'>;
        throw new RunFailure(err.code, err.detail);
      }
      return; // unexpected but authenticated non-error reply: tolerated on close
    }
    throw new RunFailure(checked.code, checked.detail);
  }

  private buildOutbound(
    sessionId: string,
    key: { publicKey: string; privateKey: string },
    type: MessageType,
    body: unknown,
  ): Message {
    const unsigned = {
      protocol: 'ACNP' as const,
      version: '0.1',
      type,
      message_id: randomUUID(),
      session_id: sessionId,
      seq: this.nextSeq(sessionId),
      sender: { agent_id: this.deps.agentId, role: 'buyer' as const },
      timestamp: this.now().toISOString(),
      body,
    };
    return signObject(unsigned, key.privateKey, key.publicKey) as unknown as Message;
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
    state: string,
    outcome: RunResult['outcome'],
    transcript: TranscriptEntry[],
    notes: string[],
    reason?: string,
    deal?: CoreResult['deal'],
  ): CoreResult {
    return {
      session_id: sessionId,
      state,
      outcome,
      ...(reason !== undefined ? { reason } : {}),
      rounds: this.session(sessionId)?.round ?? 0,
      mandate_registered: false,
      ...(deal !== undefined ? { deal } : {}),
      transcript,
      notes,
    };
  }

  private session(id: string) {
    return this.deps.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as
      | { session_id: string; state: string; seller_public_key: string | null; round: number }
      | undefined;
  }

  private setState(sessionId: string, state: string): void {
    this.deps.db
      .prepare('UPDATE sessions SET state = ? WHERE session_id = ?')
      .run(state, sessionId);
  }

  private nextSeq(sessionId: string): number {
    this.deps.db
      .prepare('UPDATE sessions SET buyer_seq = buyer_seq + 1 WHERE session_id = ?')
      .run(sessionId);
    return (
      this.deps.db
        .prepare('SELECT buyer_seq FROM sessions WHERE session_id = ?')
        .get(sessionId) as {
        buyer_seq: number;
      }
    ).buyer_seq;
  }
}
