import { randomUUID } from 'node:crypto';
import {
  generateKeyPair,
  hashCanonical,
  isFatal,
  messageSchema,
  signObject,
  verifyObject,
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
  served_hashes_json: string | null;
  accept_message_id: string | null;
  agreed_json: string | null;
  cart_mandate_hash: string | null;
}

export interface GetResult {
  status: number;
  body: unknown;
}
/** Transport seam for the receipt poll; production uses fetch. */
export type GetFn = (url: string, timeoutMs: number) => Promise<GetResult>;

/**
 * The seller's view of the compliance + settlement legs (F1 steps 6–8).
 * Both keys are long-lived and configured (§5); a missing firewall key
 * means verdicts are rejected as unknown senders, a missing settlement
 * key means the receipt poll is skipped — both visible in /health.
 */
export interface ChainConfig {
  firewallPublicKey?: string;
  settlement?: {
    url: string;
    publicKey: string;
    get: GetFn;
    intervalMs: number;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

export class MerchantHandlers {
  private readonly policy: MerchantPolicy;
  /** Boot-time fallback key: signs error replies for unknown sessions. */
  private readonly serviceKey = generateKeyPair();
  private readonly inflight = new Set<Promise<void>>();

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
    private readonly chain: ChainConfig = {},
  ) {
    this.policy = loadPolicy(db);
  }

  /** For /health: what is actually proposing prices on this side. */
  get llmInfo(): { provider: string; model: string } {
    return { provider: this.llm.provider, model: this.llm.modelId };
  }

  /** For /health: which legs of the chain this merchant can verify. */
  get chainInfo(): { firewall_key_configured: boolean; settlement_key_configured: boolean } {
    return {
      firewall_key_configured: Boolean(this.chain.firewallPublicKey),
      settlement_key_configured: Boolean(this.chain.settlement),
    };
  }

  /** Tests await this so the async receipt poll is observable without timers. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /**
   * Pinned buyer key for the boundary; embedded key for TOFU session_init;
   * the configured long-lived key for the firewall's verdicts (§5).
   */
  resolveKey(msg: Message): string | null {
    if (msg.type === 'session_init') {
      return (msg.body as BodyOf<'session_init'>).buyer_public_key;
    }
    if (msg.sender.role === 'firewall') return this.chain.firewallPublicKey ?? null;
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
      case 'cart_mandate':
        return this.inState(msg, ['AGREED'], (s) =>
          this.onCartMandate(msg as Message<'cart_mandate'>, s),
        );
      case 'firewall_verdict':
        return this.inState(msg, ['COMPLIANCE_REVIEW'], (s) =>
          this.onFirewallVerdict(msg as Message<'firewall_verdict'>, s),
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
    // Remember what we served in this session: the cart copy (§7.8) is
    // checked against these hashes, so a later stock change cannot cause a
    // false mismatch and a buyer's relabelled snapshot cannot pass.
    const served = { ...JSON.parse(s.served_hashes_json ?? '{}') } as Record<string, string>;
    for (const it of body.items) served[it.item_id] = it.catalog_hash;
    this.db
      .prepare('UPDATE sessions SET served_hashes_json = ? WHERE session_id = ?')
      .run(JSON.stringify(served), s.session_id);
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
      const accept = this.reply(s, msg, 'accept', {
        accepted_message_id: msg.message_id,
        line_items: body.line_items,
        total: body.total,
      });
      this.agree(s.session_id, accept.message_id, body.line_items, body.total);
      return { reply: accept, commit: true };
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
    this.agree(s.session_id, msg.message_id, last.line_items, last.total);
    return { reply: null, commit: true };
  }

  /**
   * §7.8 seller copy of the cart mandate. We verify it binds exactly the
   * deal we closed — the accept that closed it, the agreed items and
   * prices, and the catalog snapshots we served in this session — and park
   * the session in COMPLIANCE_REVIEW awaiting the firewall's verdict. A
   * cart that says anything else is an ACCEPT_MISMATCH (fatal): a buyer
   * cannot quietly settle different terms than it agreed.
   */
  private onCartMandate(msg: Message<'cart_mandate'>, s: SessionRow): HandlerOutcome {
    const body = msg.body;
    const agreed = JSON.parse(s.agreed_json ?? 'null') as {
      line_items: BodyOf<'accept'>['line_items'];
      total: number;
    } | null;
    const served = JSON.parse(s.served_hashes_json ?? '{}') as Record<string, string>;
    const mismatch = (why: string) => {
      this.setState(s.session_id, 'FAILED');
      return this.protocolError(msg, 'ACCEPT_MISMATCH', why);
    };
    if (!agreed || body.accepted_message_id !== s.accept_message_id) {
      return mismatch('accepted_message_id is not the accept that closed this deal');
    }
    if (body.seller_agent_id !== s.seller_agent_id || body.buyer_agent_id !== s.buyer_agent_id) {
      return mismatch('parties differ from the session');
    }
    const { mandate_hash, ...minus } = body;
    if (hashCanonical(minus) !== mandate_hash) {
      return mismatch('mandate_hash does not match the cart body');
    }
    // Same items, quantities and prices as agreed, as a set.
    const key = (li: { item_id: string; variant_id: string; quantity: number }, price: number) =>
      `${li.item_id}/${li.variant_id}×${li.quantity}@${price}`;
    const agreedKeys = agreed.line_items.map((li) => key(li, li.proposed_unit_price)).sort();
    const cartKeys = body.line_items.map((li) => key(li, li.unit_price)).sort();
    if (JSON.stringify(agreedKeys) !== JSON.stringify(cartKeys) || body.total !== agreed.total) {
      return mismatch('line items or total differ from the agreed deal');
    }
    for (const li of body.line_items) {
      // The snapshot must be the one we served, and the hash must commit to it.
      if (
        served[li.item_id] !== li.catalog_hash ||
        hashCanonical(li.catalog_item) !== li.catalog_hash
      ) {
        return mismatch(`${li.item_id}: catalog snapshot is not the one served in this session`);
      }
    }
    this.db
      .prepare(
        `UPDATE sessions SET state = 'COMPLIANCE_REVIEW', cart_mandate_hash = ? WHERE session_id = ?`,
      )
      .run(mandate_hash, s.session_id);
    this.log.info(
      { session_id: s.session_id, mandate_hash },
      'cart copy verified; awaiting verdict',
    );
    return { reply: null, commit: true };
  }

  /**
   * §7.9: the firewall's verdict for our session, verified against the
   * configured firewall key by the boundary. allow → SETTLING and poll the
   * receipt; block → BLOCKED; escalate → stay in review (Day 9).
   */
  private onFirewallVerdict(msg: Message<'firewall_verdict'>, s: SessionRow): HandlerOutcome {
    const body = msg.body;
    if (body.cart_mandate_hash !== s.cart_mandate_hash) {
      return this.protocolError(msg, 'STATE_INVALID', 'verdict is for a different cart');
    }
    this.db
      .prepare('UPDATE sessions SET verdict = ? WHERE session_id = ?')
      .run(body.verdict, s.session_id);
    this.log[body.verdict === 'allow' ? 'info' : 'warn'](
      { session_id: s.session_id, verdict: body.verdict, layer: body.layer, reasons: body.reasons },
      'firewall_verdict received',
    );
    if (body.verdict === 'block') {
      this.setState(s.session_id, 'BLOCKED');
    } else if (body.verdict === 'allow') {
      this.setState(s.session_id, 'SETTLING');
      this.track(this.pollReceipt(s.session_id, body.cart_mandate_hash));
    }
    return { reply: null, commit: true };
  }

  /**
   * F1 step 8, seller side: poll GET /receipt/{mandate_hash} on settlement
   * (D013) until a signed settlement_receipt says paid or failed, or the
   * bounded window closes. Without a configured settlement key the poll is
   * skipped and the session stays SETTLING — visible in the row and log.
   */
  private async pollReceipt(sessionId: string, mandateHash: string): Promise<void> {
    const cfg = this.chain.settlement;
    if (!cfg) {
      this.log.warn({ session_id: sessionId }, 'SETTLEMENT_* not configured: receipt not polled');
      this.setSettlement(sessionId, 'not_polled', null);
      return;
    }
    const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = this.now().getTime() + cfg.timeoutMs;
    // Bounded twice (CONSTRAINTS #10 spirit): by wall clock AND by a poll
    // count, so a frozen or injected clock can never make this loop spin.
    const maxPolls = Math.ceil(cfg.timeoutMs / Math.max(cfg.intervalMs, 1)) + 1;
    let polls = 0;
    while (this.now().getTime() <= deadline && polls < maxPolls) {
      polls += 1;
      try {
        const res = await cfg.get(`${cfg.url}/receipt/${mandateHash}`, cfg.intervalMs * 4);
        const parsed = messageSchema('settlement_receipt').safeParse(res.body);
        if (res.status === 200 && parsed.success) {
          const receipt = parsed.data as unknown as Message<'settlement_receipt'>;
          const sig = verifyObject(receipt, cfg.publicKey);
          if (!sig.ok || receipt.body.mandate_hash !== mandateHash) {
            this.log.warn({ session_id: sessionId }, 'receipt rejected: bad signature or hash');
            this.setSettlement(sessionId, 'receipt_invalid', null);
            return;
          }
          this.setSettlement(sessionId, receipt.body.status, receipt.body.razorpay_order_id);
          this.setState(sessionId, receipt.body.status === 'paid' ? 'SETTLED' : 'FAILED');
          this.log.info(
            { session_id: sessionId, status: receipt.body.status, polls },
            'settlement_receipt received',
          );
          return;
        }
      } catch (err) {
        this.log.warn({ session_id: sessionId, error: String(err) }, 'receipt poll failed');
      }
      await sleep(cfg.intervalMs);
    }
    this.log.warn(
      { session_id: sessionId, polls },
      'receipt poll timed out; session stays SETTLING',
    );
    this.setSettlement(sessionId, 'pending', null);
  }

  private track(p: Promise<void>): void {
    const wrapped = p
      .catch((err) => this.log.warn({ err: String(err) }, 'receipt poll crashed'))
      .finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
  }

  private setSettlement(sessionId: string, status: string, orderId: string | null): void {
    this.db
      .prepare(
        'UPDATE sessions SET settlement_status = ?, razorpay_order_id = ? WHERE session_id = ?',
      )
      .run(status, orderId, sessionId);
  }

  /** NEGOTIATING → AGREED, remembering exactly what was agreed (§7.7/§7.8). */
  private agree(
    sessionId: string,
    acceptMessageId: string,
    lineItems: BodyOf<'accept'>['line_items'],
    total: number,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET state = 'AGREED', accept_message_id = ?, agreed_json = ?
         WHERE session_id = ?`,
      )
      .run(acceptMessageId, JSON.stringify({ line_items: lineItems, total }), sessionId);
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
   * Signed `error` reply (§7.12). Handler-level errors (the message WAS
   * authenticated) consume the sender's seq (`commit: true`, §6), are
   * signed with the session key on the seller's stream, and — for fatal
   * codes (§10) — terminate the session: state -> FAILED.
   *
   * Boundary rejections (`authenticated: false`) come from a message nobody
   * has verified: they MUST NOT touch the session — not its state, not the
   * seller's outbound seq — or anyone who knows a session_id could kill a
   * live session with garbage (BUG-004). The reply is advisory: signed with
   * the boot-time service key at seq 1, outside every stream.
   */
  protocolError(
    inbound: Message,
    code: ErrorCode,
    detail: string,
    { authenticated = true }: { authenticated?: boolean } = {},
  ): HandlerOutcome {
    const s = authenticated ? this.session(inbound.session_id) : undefined;
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
