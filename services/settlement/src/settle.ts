import { randomUUID } from 'node:crypto';
import { signObject, type BodyOf, type Message } from '@negotiator/protocol';
import type { SettlementDb } from './db.js';
import { appendEvent, type SettlementEvent } from './events.js';
import { RazorpayError, type RazorpayClient, type RazorpayOrder } from './razorpay.js';
import { buildSimulatedWebhook, verifyWebhookSignature, type WebhookEvent } from './webhook.js';

/**
 * The settlement engine (FLOW F1 step 8, F4). Owns the money path
 * deterministically:
 *   accept → [find order by receipt | create order (bounded retry)] →
 *   order_created → webhook (real or simulated) through the HMAC verifier →
 *   paid | failed → signed settlement_receipt (polled via GET /receipt).
 * Every step is an append-only hash-chained event; the receipt's
 * ledger_entry_hash is the hash of the confirming event.
 */

export interface EngineLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface RetryPolicy {
  /** Attempt ceiling (CONSTRAINTS #10) — attempts, not retries. */
  maxAttempts: number;
  /** Backoff base: baseMs × 2^(attempt-1). */
  baseMs: number;
}

export interface EngineDeps {
  db: SettlementDb;
  razorpay: RazorpayClient;
  signingKey: { privateKey: string; publicKey: string };
  agentId: string;
  webhookSecret: string;
  /** Self-post a signed order.paid after order creation (amendment #1). */
  paymentSimulation: boolean;
  /** Second confirmation source: Orders API status on /receipt polls (amendment #2). */
  orderStatusPoll: boolean;
  retry: RetryPolicy;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: EngineLog;
}

export interface SettlementRow {
  mandate_hash: string;
  session_id: string;
  status: 'accepted' | 'order_created' | 'paid' | 'failed';
  amount: number;
  currency: string;
  receipt_ref: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  attempts: number;
  failure_code: string | null;
  cart_mandate_json: string;
  verdict_json: string;
  receipt_json: string | null;
  receipt_seq: number;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WebhookOutcome =
  | { ok: false; status: 401; reason: 'WEBHOOK_SIG_INVALID' }
  | { ok: true; status: 200; applied: boolean; detail: string };

export class SettlementEngine {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: EngineLog;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? { info() {}, warn() {} };
  }

  // --- accept ------------------------------------------------------------

  /**
   * Idempotent acceptance keyed by mandate hash: the first request creates
   * the row and starts settlement; any later request for the same cart is
   * acknowledged without touching Razorpay (PROTOCOL.md §6).
   */
  accept(
    request: Message<'settlement_request'>,
    cart: Message<'cart_mandate'>,
    verdict: Message<'firewall_verdict'>,
    mandateHash: string,
  ): 'accepted' | 'duplicate' {
    if (this.row(mandateHash)) return 'duplicate';
    const ts = this.now().toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO settlements (mandate_hash, session_id, status, amount, currency, receipt_ref,
           cart_mandate_json, verdict_json, created_at, updated_at)
         VALUES (?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mandateHash,
        request.session_id,
        cart.body.total,
        cart.body.currency,
        // Razorpay's receipt field is ≤ 40 chars; the full hash rides in notes.
        mandateHash.slice(0, 40),
        JSON.stringify(cart),
        JSON.stringify(verdict),
        ts,
        ts,
      );
    appendEvent(
      this.deps.db,
      mandateHash,
      'REQUEST_ACCEPTED',
      { request_message_id: request.message_id, verdict_message_id: verdict.message_id },
      this.now,
    );
    this.track(this.settle(mandateHash));
    return 'accepted';
  }

  /** Tests await this so async settlement is observable without timers. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private track(p: Promise<void>): void {
    const wrapped = p
      .catch((err) => this.log.warn({ err: String(err) }, 'settlement task crashed'))
      .finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
  }

  // --- order creation with recovery + bounded retry (F4) ------------------

  async settle(mandateHash: string): Promise<void> {
    const row = this.row(mandateHash);
    if (!row || row.status === 'paid' || row.status === 'failed') return;

    let order: RazorpayOrder | null = row.razorpay_order_id
      ? ({ id: row.razorpay_order_id, amount: row.amount } as RazorpayOrder)
      : null;

    if (!order) {
      const { maxAttempts, baseMs } = this.deps.retry;
      for (let attempt = 1; attempt <= maxAttempts && !order; attempt++) {
        this.deps.db
          .prepare('UPDATE settlements SET attempts = ?, updated_at = ? WHERE mandate_hash = ?')
          .run(attempt, this.now().toISOString(), mandateHash);
        appendEvent(this.deps.db, mandateHash, 'SETTLEMENT_ATTEMPT', { attempt }, this.now);
        try {
          // Crash recovery (CONSTRAINTS #10): an order created on a previous
          // attempt/process but never persisted must be reused, not duplicated.
          const existing = await this.deps.razorpay.findOrderByReceipt(row.receipt_ref);
          if (existing) {
            order = existing;
            appendEvent(
              this.deps.db,
              mandateHash,
              'ORDER_RECOVERED',
              { order_id: existing.id },
              this.now,
            );
          } else {
            order = await this.deps.razorpay.createOrder({
              amount: row.amount,
              currency: 'INR',
              receipt: row.receipt_ref,
              notes: { mandate_hash: mandateHash, session_id: row.session_id },
            });
            appendEvent(
              this.deps.db,
              mandateHash,
              'ORDER_CREATED',
              { order_id: order.id, attempt },
              this.now,
            );
          }
        } catch (err) {
          const e = err instanceof RazorpayError ? err : new RazorpayError('network', String(err));
          this.log.warn(
            { mandate_hash: mandateHash, attempt, error: e.message },
            'SETTLEMENT_ATTEMPT failed',
          );
          if (!e.retryable || attempt === maxAttempts) {
            this.fail(mandateHash, 'SETTLEMENT_RETRY_EXHAUSTED', {
              attempts: attempt,
              last_error: e.message,
            });
            return;
          }
          await this.sleep(baseMs * 2 ** (attempt - 1));
        }
      }
      if (!order) {
        this.fail(mandateHash, 'SETTLEMENT_RETRY_EXHAUSTED', { attempts: maxAttempts });
        return;
      }
      this.deps.db
        .prepare(
          `UPDATE settlements SET status = 'order_created', razorpay_order_id = ?, updated_at = ?
           WHERE mandate_hash = ? AND status = 'accepted'`,
        )
        .run(order.id, this.now().toISOString(), mandateHash);
    }

    if (this.deps.paymentSimulation) {
      // Loud by design: the customer's card tap is simulated; the order is
      // real and the confirmation still passes the production HMAC verifier.
      this.log.warn(
        { mandate_hash: mandateHash, order_id: order.id },
        'PAYMENT_SIMULATION on: self-posting a signed order.paid webhook',
      );
      const { rawBody, signature } = buildSimulatedWebhook(order, this.deps.webhookSecret);
      await this.handleWebhook(rawBody, signature);
    }
  }

  private fail(mandateHash: string, code: string, payload: Record<string, unknown>): void {
    const ev = appendEvent(
      this.deps.db,
      mandateHash,
      'SETTLEMENT_RETRY_EXHAUSTED',
      payload,
      this.now,
    );
    this.deps.db
      .prepare(
        `UPDATE settlements SET status = 'failed', failure_code = ?, updated_at = ? WHERE mandate_hash = ?`,
      )
      .run(code, this.now().toISOString(), mandateHash);
    this.issueReceipt(this.row(mandateHash)!, 'failed', ev);
  }

  // --- webhook (CONSTRAINTS #4) ------------------------------------------

  /** Verifies the raw body first; nothing below may run on a bad signature. */
  async handleWebhook(
    rawBody: string | Buffer,
    signature: string | undefined,
  ): Promise<WebhookOutcome> {
    if (!verifyWebhookSignature(rawBody, signature, this.deps.webhookSecret)) {
      this.log.warn({}, 'WEBHOOK_SIG_INVALID: rejected, nothing mutated');
      return { ok: false, status: 401, reason: 'WEBHOOK_SIG_INVALID' };
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody.toString()) as WebhookEvent;
    } catch {
      return { ok: true, status: 200, applied: false, detail: 'unparseable body ignored' };
    }
    const payment = event.payload?.payment?.entity;
    const orderId = payment?.order_id ?? event.payload?.order?.entity?.id;
    if (!orderId) return { ok: true, status: 200, applied: false, detail: 'no order id' };
    const row = this.deps.db
      .prepare('SELECT * FROM settlements WHERE razorpay_order_id = ?')
      .get(orderId) as SettlementRow | undefined;
    if (!row) return { ok: true, status: 200, applied: false, detail: `unknown order ${orderId}` };

    switch (event.event) {
      case 'order.paid':
      case 'payment.captured': {
        if (row.status === 'paid')
          return { ok: true, status: 200, applied: false, detail: 'already paid' };
        const amount = payment?.amount ?? event.payload?.order?.entity?.amount;
        if (amount !== row.amount) {
          this.log.warn(
            { order_id: orderId, amount, expected: row.amount },
            'webhook amount mismatch ignored',
          );
          return { ok: true, status: 200, applied: false, detail: 'amount mismatch' };
        }
        this.markPaid(row, payment?.id ?? 'unknown', 'webhook');
        return { ok: true, status: 200, applied: true, detail: 'paid' };
      }
      case 'payment.failed': {
        if (row.status === 'paid' || row.status === 'failed') {
          return { ok: true, status: 200, applied: false, detail: `already ${row.status}` };
        }
        const ev = appendEvent(
          this.deps.db,
          row.mandate_hash,
          'PAYMENT_FAILED',
          {
            order_id: orderId,
            payment_id: payment?.id ?? null,
            error_code: payment?.error_code ?? null,
          },
          this.now,
        );
        this.deps.db
          .prepare(
            `UPDATE settlements SET status = 'failed', failure_code = 'PAYMENT_FAILED', updated_at = ? WHERE mandate_hash = ?`,
          )
          .run(this.now().toISOString(), row.mandate_hash);
        this.issueReceipt(this.row(row.mandate_hash)!, 'failed', ev);
        return { ok: true, status: 200, applied: true, detail: 'failed' };
      }
      default:
        return { ok: true, status: 200, applied: false, detail: `event ${event.event} ignored` };
    }
  }

  private markPaid(row: SettlementRow, paymentId: string, source: 'webhook' | 'orders_api'): void {
    const paidAt = this.now().toISOString();
    const ev = appendEvent(
      this.deps.db,
      row.mandate_hash,
      'PAYMENT_CONFIRMED',
      { order_id: row.razorpay_order_id, payment_id: paymentId, source },
      this.now,
    );
    this.deps.db
      .prepare(
        `UPDATE settlements SET status = 'paid', razorpay_payment_id = ?, paid_at = ?, updated_at = ?
         WHERE mandate_hash = ?`,
      )
      .run(paymentId, paidAt, paidAt, row.mandate_hash);
    this.issueReceipt(this.row(row.mandate_hash)!, 'paid', ev);
  }

  // --- receipts (§7.11) ---------------------------------------------------

  private issueReceipt(
    row: SettlementRow,
    status: 'paid' | 'failed',
    confirming: SettlementEvent,
  ): void {
    const seq = row.receipt_seq + 1;
    const body: BodyOf<'settlement_receipt'> = {
      mandate_hash: row.mandate_hash,
      razorpay_order_id: row.razorpay_order_id ?? 'none',
      status,
      amount: row.amount,
      currency: 'INR',
      ...(status === 'paid' && row.paid_at ? { timestamp_paid: row.paid_at } : {}),
      // The chain entry that confirms this outcome (Day 10 ledger absorbs it).
      ledger_entry_hash: confirming.entry_hash,
    };
    const unsigned = {
      protocol: 'ACNP' as const,
      version: '0.1',
      type: 'settlement_receipt' as const,
      message_id: randomUUID(),
      session_id: row.session_id,
      seq,
      sender: { agent_id: this.deps.agentId, role: 'settlement' as const },
      timestamp: this.now().toISOString(),
      body,
    };
    const receipt = signObject(
      unsigned,
      this.deps.signingKey.privateKey,
      this.deps.signingKey.publicKey,
    );
    this.deps.db
      .prepare(
        'UPDATE settlements SET receipt_json = ?, receipt_seq = ?, updated_at = ? WHERE mandate_hash = ?',
      )
      .run(JSON.stringify(receipt), seq, this.now().toISOString(), row.mandate_hash);
    appendEvent(
      this.deps.db,
      row.mandate_hash,
      'RECEIPT_ISSUED',
      { receipt_message_id: unsigned.message_id, status },
      this.now,
    );
  }

  /**
   * GET /receipt/{mandate_hash}: the latest signed receipt, or a signed
   * pending status. With ORDER_STATUS_POLL on, an order_created row is
   * cross-checked against the Orders API as a second confirmation source.
   */
  async receiptFor(mandateHash: string): Promise<Record<string, unknown> | null> {
    let row = this.row(mandateHash);
    if (!row) return null;
    if (
      !row.receipt_json &&
      row.status === 'order_created' &&
      this.deps.orderStatusPoll &&
      row.razorpay_order_id
    ) {
      try {
        const order = await this.deps.razorpay.fetchOrder(row.razorpay_order_id);
        if (order.status === 'paid') {
          this.log.info({ order_id: order.id }, 'ORDER_STATUS_POLL: Orders API reports paid');
          this.markPaid(row, 'via_orders_api', 'orders_api');
          row = this.row(mandateHash)!;
        }
      } catch (err) {
        this.log.warn({ error: String(err) }, 'ORDER_STATUS_POLL failed; staying pending');
      }
    }
    if (row.receipt_json) return JSON.parse(row.receipt_json) as Record<string, unknown>;
    const pending = {
      status: 'pending' as const,
      mandate_hash: row.mandate_hash,
      settlement_status: row.status,
      razorpay_order_id: row.razorpay_order_id,
      attempts: row.attempts,
      updated_at: row.updated_at,
      signer: this.deps.agentId,
    };
    return signObject(
      pending,
      this.deps.signingKey.privateKey,
      this.deps.signingKey.publicKey,
    ) as Record<string, unknown>;
  }

  row(mandateHash: string): SettlementRow | undefined {
    return this.deps.db
      .prepare('SELECT * FROM settlements WHERE mandate_hash = ?')
      .get(mandateHash) as SettlementRow | undefined;
  }
}
