import { randomUUID } from 'node:crypto';
import {
  generateKeyPair,
  hashCanonical,
  isFatal,
  signObject,
  type BodyOf,
  type ErrorCode,
  type Message,
  type MessageType,
} from '@negotiator/protocol';
import { StubLlmAdapter, proposeMove, type LlmAdapter, type MoveRecord } from '@negotiator/llm';
import type { MerchantDb } from './db.js';
import { effectiveFloor, loadPolicy, type MerchantPolicy } from './policy.js';
import { decideSeller, type BuyerOfferView } from './strategy.js';

/** Minimal logger shape so handlers stay free of fastify/pino types. */
export interface HandlerLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}
const NO_LOG: HandlerLog = { info() {}, warn() {} };

/**
 * Merchant-side ACNP handlers: session lifecycle (§7.1–7.4) and the
 * deterministic negotiation loop (§7.5, §7.7). Called only with messages
 * the boundary already accepted (schema, skew, signature, replay).
 *
 * Under the sync binding (D013) each handler returns the signed reply
 * message, or `null` when nothing is owed (HTTP 204). State transitions
 * follow PROTOCOL.md §9 and are persisted per session before the reply is
 * returned, so a crash between the two can only lose a reply, never accept
 * a message twice (the replay commit is the caller's last step).
 */

export type HandlerOutcome = { reply: Message; commit: boolean } | { reply: null; commit: true };

interface SessionRow {
  session_id: string;
  state: string;
  buyer_agent_id: string;
  buyer_public_key: string;
  seller_agent_id: string;
  seller_public_key: string;
  seller_private_key: string;
  chosen_version: string;
  seller_seq: number;
  round: number;
  last_offer_json: string | null;
}

export class MerchantHandlers {
  private readonly policy: MerchantPolicy;
  /** Boot-time fallback key: signs error replies for unknown sessions. */
  private readonly serviceKey = generateKeyPair();

  constructor(
    private readonly db: MerchantDb,
    private readonly agentId: string = 'merchant-demo',
    private readonly now: () => Date = () => new Date(),
    /**
     * Seller-side model (D015: advisory). The default stub proposes nothing,
     * so tests and the key-less quickstart run the pure deterministic curve.
     */
    private readonly llm: LlmAdapter = new StubLlmAdapter(''),
    private readonly log: HandlerLog = NO_LOG,
  ) {
    this.policy = loadPolicy(db);
  }

  /** For /health: what is actually proposing prices on this side. */
  get llmInfo(): { provider: string; model: string } {
    return { provider: this.llm.provider, model: this.llm.modelId };
  }

  /** Pinned buyer key for the boundary; embedded key for TOFU session_init. */
  resolveKey(msg: Message): string | null {
    if (msg.type === 'session_init') {
      return (msg.body as BodyOf<'session_init'>).buyer_public_key;
    }
    const row = this.session(msg.session_id);
    if (!row) return null;
    return msg.sender.agent_id === row.buyer_agent_id ? row.buyer_public_key : null;
  }

  /** Async since Day 6: the offer path awaits the (bounded) LLM proposal. */
  async handle(msg: Message): Promise<HandlerOutcome> {
    switch (msg.type) {
      case 'session_init':
        return this.onSessionInit(msg as Message<'session_init'>);
      case 'catalog_request':
        return this.inState(msg, ['NEGOTIATING'], (s) =>
          this.onCatalogRequest(msg as Message<'catalog_request'>, s),
        );
      case 'offer':
      case 'counter_offer':
        return this.inState(msg, ['NEGOTIATING'], (s) =>
          this.onBuyerOffer(msg as Message<'offer'>, s),
        );
      case 'accept':
        return this.inState(msg, ['NEGOTIATING'], (s) =>
          this.onAccept(msg as Message<'accept'>, s),
        );
      case 'reject':
        // Buyer declined our counter; session stays NEGOTIATING, nothing owed.
        return this.inState(msg, ['NEGOTIATING'], () => ({ reply: null, commit: true }));
      case 'walk_away':
        return this.inState(msg, ['NEGOTIATING'], (s) => {
          this.setState(s.session_id, 'WALKED_AWAY');
          return { reply: null, commit: true };
        });
      default:
        return this.protocolError(msg, 'STATE_INVALID', `merchant does not accept ${msg.type}`);
    }
  }

  // --- handlers ---------------------------------------------------------

  private onSessionInit(msg: Message<'session_init'>): HandlerOutcome {
    if (this.session(msg.session_id)) {
      // Same session_id again: the replay guard caught true duplicates, so
      // this is a re-init attempt — refuse to re-pin (key-swap attack).
      return this.protocolError(msg, 'STATE_INVALID', 'session already initialized');
    }
    const mutual = msg.body.supported_versions.includes('0.1');
    if (!mutual) {
      return this.protocolError(msg, 'VERSION_UNSUPPORTED', 'no mutual version; supported: 0.1');
    }
    const seller = generateKeyPair();
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, state, buyer_agent_id, buyer_public_key,
           seller_agent_id, seller_public_key, seller_private_key, chosen_version,
           seller_model, created_at)
         VALUES (?, 'NEGOTIATING', ?, ?, ?, ?, ?, '0.1', ?, ?)`,
      )
      .run(
        msg.session_id,
        msg.sender.agent_id,
        msg.body.buyer_public_key,
        this.agentId,
        seller.publicKey,
        seller.privateKey,
        this.llm.modelId, // model-per-side recorded in every session (D008)
        this.now().toISOString(),
      );
    const row = this.session(msg.session_id)!;
    return {
      reply: this.reply(row, msg, 'session_ack', {
        seller_public_key: seller.publicKey,
        chosen_version: '0.1',
        capabilities: {
          ...this.policy.capabilities,
          max_rounds: this.policy.max_rounds,
          currency: 'INR',
        },
      }),
      commit: true,
    };
  }

  private onCatalogRequest(msg: Message<'catalog_request'>, s: SessionRow): HandlerOutcome {
    const { category, max_items } = msg.body;
    const items = this.db
      .prepare(
        `SELECT item_id, title, description, category FROM catalog_items
         ${category ? 'WHERE category = ?' : ''} ORDER BY item_id LIMIT ?`,
      )
      .all(...(category ? [category] : []), max_items ?? 50) as {
      item_id: string;
      title: string;
      description: string;
      category: string;
    }[];
    const body: BodyOf<'catalog_offer'> = {
      items: items.map((item) => {
        const variants = (
          this.db
            .prepare(
              'SELECT variant_id, attributes, list_price, stock FROM variants WHERE item_id = ? ORDER BY variant_id',
            )
            .all(item.item_id) as {
            variant_id: string;
            attributes: string;
            list_price: number;
            stock: number;
          }[]
        ).map((v) => ({
          variant_id: v.variant_id,
          attributes: JSON.parse(v.attributes) as Record<string, string | number | boolean>,
          list_price: v.list_price,
          stock: v.stock,
        }));
        const snapshot = { ...item, variants };
        // catalog_hash binds this exact public snapshot (floors excluded —
        // they are merchant-private) into the later cart mandate (T1).
        return { ...snapshot, catalog_hash: hashCanonical(snapshot) };
      }),
    };
    return { reply: this.reply(s, msg, 'catalog_offer', body), commit: true };
  }

  private async onBuyerOffer(
    msg: Message<'offer' | 'counter_offer'>,
    s: SessionRow,
  ): Promise<HandlerOutcome> {
    const body = msg.body;
    // Receiver recomputes the total (§7.5) before any strategy runs.
    const computed = body.line_items.reduce(
      (sum, li) => sum + li.quantity * li.proposed_unit_price,
      0,
    );
    if (computed !== body.total) {
      return this.protocolError(
        msg,
        'TOTAL_MISMATCH',
        `computed ${computed}, claimed ${body.total}`,
      );
    }
    const round = s.round + 1;
    if (round > this.policy.max_rounds || body.round > this.policy.max_rounds) {
      this.setState(s.session_id, 'WALKED_AWAY');
      return {
        reply: this.reply(s, msg, 'walk_away', { reason_code: 'rounds_exhausted' }),
        commit: true,
      };
    }

    // Resolve every line item against the live catalog.
    const views: BuyerOfferView[] = [];
    const texts = new Map<string, { title: string; description: string }>();
    let quantityTotal = 0;
    for (const li of body.line_items) {
      const v = this.db
        .prepare(
          `SELECT v.list_price, v.floor_price, v.stock, i.category, i.title, i.description
           FROM variants v JOIN catalog_items i ON i.item_id = v.item_id
           WHERE v.variant_id = ? AND v.item_id = ?`,
        )
        .get(li.variant_id, li.item_id) as
        | {
            list_price: number;
            floor_price: number;
            stock: number;
            category: string;
            title: string;
            description: string;
          }
        | undefined;
      if (!v || v.stock < li.quantity) {
        return this.protocolError(msg, 'ITEM_UNAVAILABLE', `${li.item_id}/${li.variant_id}`);
      }
      quantityTotal += li.quantity;
      views.push({ line: li, pricing: v });
      texts.set(li.variant_id, { title: v.title, description: v.description });
    }
    if (quantityTotal > this.policy.max_quantity_per_order) {
      return this.protocolError(
        msg,
        'ITEM_UNAVAILABLE',
        `quantity ${quantityTotal} exceeds per-order cap`,
      );
    }

    // FLOW F1 step 4: the model drafts a counter WITHIN the envelope (it is
    // shown the effective floor), then decideSeller clamps whatever came
    // back. A null proposal means the deterministic curve (D015).
    const { proposal, record } = await proposeMove(this.llm, {
      role: 'seller',
      round,
      max_rounds: this.policy.max_rounds,
      currency: 'INR',
      lines: views.map((v) => ({
        variant_id: v.line.variant_id,
        title: texts.get(v.line.variant_id)?.title ?? '',
        description: texts.get(v.line.variant_id)?.description ?? '',
        quantity: v.line.quantity,
        list_price: v.pricing.list_price,
        counterparty_unit_price: v.line.proposed_unit_price,
        bound: { kind: 'floor', value: effectiveFloor(v.pricing, this.policy) },
      })),
    });
    this.recordMove(s.session_id, round, record);
    const proposedPrices = proposal ? new Map(Object.entries(proposal.proposed_prices)) : undefined;

    const decision = decideSeller(views, round, this.policy, proposedPrices);
    this.db.prepare('UPDATE sessions SET round = ? WHERE session_id = ?').run(round, s.session_id);

    if (decision.kind === 'accept') {
      // We accept the buyer's numbers verbatim (echo rule §7.7).
      this.setState(s.session_id, 'AGREED');
      return {
        reply: this.reply(s, msg, 'accept', {
          accepted_message_id: msg.message_id,
          line_items: body.line_items,
          total: body.total,
        }),
        commit: true,
      };
    }
    // Counter within bounds. Clamp events are pino-logged here (ledger from
    // Day 10, BOUNDS_CLAMPED); the body is persisted for the accept-echo check.
    for (const reason of decision.clamp_reasons) {
      this.log.warn({ session_id: s.session_id, round, reason }, 'BOUNDS_CLAMPED');
    }
    const counterBody: BodyOf<'counter_offer'> = {
      line_items: decision.line_items,
      total: decision.total,
      round: body.round,
      ...(proposal ? { rationale: proposal.rationale } : {}),
    };
    this.db
      .prepare('UPDATE sessions SET last_offer_json = ? WHERE session_id = ?')
      .run(JSON.stringify(counterBody), s.session_id);
    return { reply: this.reply(s, msg, 'counter_offer', counterBody), commit: true };
  }

  private onAccept(msg: Message<'accept'>, s: SessionRow): HandlerOutcome {
    // Echo rule (§7.7): the accept must byte-match our last outbound offer.
    if (!s.last_offer_json) {
      return this.protocolError(msg, 'ACCEPT_MISMATCH', 'no outstanding seller offer');
    }
    const last = JSON.parse(s.last_offer_json) as BodyOf<'counter_offer'>;
    const echoOk =
      hashCanonical({ line_items: msg.body.line_items, total: msg.body.total }) ===
      hashCanonical({ line_items: last.line_items, total: last.total });
    if (!echoOk) {
      this.setState(s.session_id, 'FAILED');
      return this.protocolError(msg, 'ACCEPT_MISMATCH', 'echo does not match our offer');
    }
    this.setState(s.session_id, 'AGREED');
    return { reply: null, commit: true };
  }

  // --- plumbing ---------------------------------------------------------

  private async inState(
    msg: Message,
    allowed: string[],
    fn: (s: SessionRow) => HandlerOutcome | Promise<HandlerOutcome>,
  ): Promise<HandlerOutcome> {
    const s = this.session(msg.session_id);
    if (!s) return this.protocolError(msg, 'SESSION_UNKNOWN', msg.session_id);
    if (!allowed.includes(s.state)) {
      return this.protocolError(msg, 'STATE_INVALID', `${msg.type} not valid in ${s.state}`);
    }
    return fn(s);
  }

  /** Per-round attribution (amendment #3); fallbacks are also warned. */
  private recordMove(sessionId: string, round: number, r: MoveRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO llm_moves
           (session_id, round, role, model_id, used_llm, fallback_reason, latency_ms)
         VALUES (?, ?, 'seller', ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        round,
        r.model_id,
        r.used_llm ? 1 : 0,
        r.fallback_reason ?? null,
        r.latency_ms,
      );
    if (!r.used_llm && this.llm.provider !== 'stub') {
      this.log.warn({ session_id: sessionId, round, ...r }, 'LLM fallback to deterministic curve');
    }
  }

  private session(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as
      SessionRow | undefined;
  }

  private setState(sessionId: string, state: string): void {
    this.db.prepare('UPDATE sessions SET state = ? WHERE session_id = ?').run(state, sessionId);
  }

  private nextSeq(sessionId: string): number {
    this.db
      .prepare('UPDATE sessions SET seller_seq = seller_seq + 1 WHERE session_id = ?')
      .run(sessionId);
    return (
      this.db.prepare('SELECT seller_seq FROM sessions WHERE session_id = ?').get(sessionId) as {
        seller_seq: number;
      }
    ).seller_seq;
  }

  /** Build, sequence and sign an outbound message for a live session. */
  private reply<T extends MessageType>(
    s: SessionRow,
    inReplyTo: Message,
    type: T,
    body: BodyOf<T>,
  ): Message<T> {
    const unsigned = {
      protocol: 'ACNP' as const,
      version: '0.1',
      type,
      message_id: randomUUID(),
      session_id: s.session_id,
      seq: this.nextSeq(s.session_id),
      in_reply_to: inReplyTo.message_id,
      sender: { agent_id: s.seller_agent_id, role: 'seller' as const },
      timestamp: this.now().toISOString(),
      body,
    };
    return signObject(unsigned, s.seller_private_key, s.seller_public_key) as unknown as Message<T>;
  }

  /**
   * Signed `error` reply (§7.12). Signed with the session key when the
   * session exists, else the boot-time service key — advisory either way.
   * Handler-level errors consume the sender's seq (`commit: true`) because
   * the message was authenticated (PROTOCOL.md §6 sequence consumption);
   * app.ts ignores the flag for boundary rejections, which never commit.
   * Fatal codes (§10) terminate the session: state -> FAILED.
   */
  protocolError(inbound: Message, code: ErrorCode, detail: string): HandlerOutcome {
    const s = this.session(inbound.session_id);
    if (
      s &&
      isFatal(code) &&
      !['SETTLED', 'WALKED_AWAY', 'BLOCKED', 'FAILED', 'EXPIRED'].includes(s.state)
    ) {
      this.setState(s.session_id, 'FAILED');
    }
    const key = s
      ? { privateKey: s.seller_private_key, publicKey: s.seller_public_key }
      : this.serviceKey;
    const unsigned = {
      protocol: 'ACNP' as const,
      version: '0.1',
      type: 'error' as const,
      message_id: randomUUID(),
      session_id: inbound.session_id,
      seq: s ? this.nextSeq(s.session_id) : 1,
      in_reply_to: inbound.message_id,
      sender: { agent_id: s?.seller_agent_id ?? this.agentId, role: 'seller' as const },
      timestamp: this.now().toISOString(),
      body: { code, detail, offending_message_id: inbound.message_id },
    };
    return {
      reply: signObject(unsigned, key.privateKey, key.publicKey) as unknown as Message<'error'>,
      commit: true,
    };
  }
}
