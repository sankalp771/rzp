/**
 * Razorpay Orders API client — TEST MODE ONLY (CONSTRAINTS #2). Raw fetch,
 * no SDK, one base URL. Two modes, both named explicitly at boot and
 * reported in /health (no silent downgrade, same rule as the LLM stub):
 *   live-test  — real https://api.razorpay.com with rzp_test_* credentials
 *   simulated  — in-process fake with the same response shapes (CI, tests,
 *                key-less quickstart)
 */

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: 'created' | 'attempted' | 'paid';
  notes: Record<string, string>;
}

export interface CreateOrderParams {
  amount: number;
  currency: 'INR';
  /** ≤ 40 chars; we use the first 40 hex chars of the mandate hash. */
  receipt: string;
  notes: Record<string, string>;
}

export class RazorpayError extends Error {
  constructor(
    public readonly kind: 'network' | 'http',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
  /** Auth/validation failures never succeed on retry; 429/5xx/network may. */
  get retryable(): boolean {
    return this.kind === 'network' || this.status === 429 || (this.status ?? 0) >= 500;
  }
}

export interface RazorpayClient {
  readonly mode: 'live-test' | 'simulated';
  createOrder(params: CreateOrderParams): Promise<RazorpayOrder>;
  /** Crash-recovery lookup (CONSTRAINTS #10): an order we created but never persisted. */
  findOrderByReceipt(receipt: string): Promise<RazorpayOrder | null>;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
}

export type RazorpayMode = RazorpayClient['mode'];

/** Boot rule (CONSTRAINTS #2): refuse anything that is not clearly test mode. */
export function razorpayModeFromEnv(env: Record<string, string | undefined>): RazorpayMode {
  const mode = (env['RAZORPAY_MODE'] ?? 'live-test').toLowerCase();
  if (mode === 'simulated') return 'simulated';
  if (mode !== 'live-test') {
    throw new Error(`refusing to start: RAZORPAY_MODE="${mode}" is not live-test|simulated`);
  }
  const keyId = env['RAZORPAY_KEY_ID'] ?? '';
  if (!keyId.startsWith('rzp_test_')) {
    throw new Error(
      'refusing to start: RAZORPAY_KEY_ID is not a test-mode key (must start with rzp_test_) — live keys are prohibited (CONSTRAINTS #2)',
    );
  }
  if (/^rzp_test_x+$/i.test(keyId) || !env['RAZORPAY_KEY_SECRET']) {
    throw new Error(
      'refusing to start: RAZORPAY_MODE=live-test needs real rzp_test_* credentials (KEY_ID placeholder or empty KEY_SECRET) — set them or choose RAZORPAY_MODE=simulated explicitly',
    );
  }
  return 'live-test';
}

export interface LiveOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class LiveRazorpayClient implements RazorpayClient {
  readonly mode = 'live-test' as const;
  private readonly auth: string;
  private readonly base: string;
  constructor(private readonly opts: LiveOptions) {
    if (!opts.keyId.startsWith('rzp_test_')) {
      throw new Error('LiveRazorpayClient: test-mode keys only (CONSTRAINTS #2)');
    }
    this.auth = 'Basic ' + Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64');
    this.base = (opts.baseUrl ?? 'https://api.razorpay.com/v1').replace(/\/$/, '');
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: this.auth, ...init.headers },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new RazorpayError('network', `razorpay ${path}: ${String(err)}`);
    }
    if (!res.ok) {
      // Razorpay error bodies are {error:{code,description}} — no secrets.
      const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new RazorpayError(
        'http',
        `razorpay ${path}: HTTP ${res.status} ${snippet}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  createOrder(params: CreateOrderParams): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('/orders', { method: 'POST', body: JSON.stringify(params) });
  }

  async findOrderByReceipt(receipt: string): Promise<RazorpayOrder | null> {
    const list = await this.call<{ items: RazorpayOrder[] }>(
      `/orders?receipt=${encodeURIComponent(receipt)}&count=1`,
    );
    return list.items[0] ?? null;
  }

  fetchOrder(orderId: string): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`);
  }
}

/**
 * In-process stand-in with the same shapes. Tests script failures with
 * `failNext` (retry ceiling) and pre-seed orders (crash recovery).
 */
export class SimulatedRazorpayClient implements RazorpayClient {
  readonly mode = 'simulated' as const;
  readonly orders = new Map<string, RazorpayOrder>();
  createCalls = 0;
  private failures: RazorpayError[] = [];
  private counter = 0;

  /** Queue failures for the next N createOrder calls. */
  failNext(n: number, status = 503): void {
    for (let i = 0; i < n; i++) {
      this.failures.push(new RazorpayError('http', `simulated HTTP ${status}`, status));
    }
  }

  async createOrder(params: CreateOrderParams): Promise<RazorpayOrder> {
    this.createCalls += 1;
    const fail = this.failures.shift();
    if (fail) throw fail;
    this.counter += 1;
    const order: RazorpayOrder = {
      id: `order_sim_${String(this.counter).padStart(6, '0')}`,
      amount: params.amount,
      currency: params.currency,
      receipt: params.receipt,
      status: 'created',
      notes: params.notes,
    };
    this.orders.set(order.id, order);
    return order;
  }

  async findOrderByReceipt(receipt: string): Promise<RazorpayOrder | null> {
    for (const o of this.orders.values()) if (o.receipt === receipt) return o;
    return null;
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    const o = this.orders.get(orderId);
    if (!o) throw new RazorpayError('http', `simulated: no order ${orderId}`, 400);
    return o;
  }

  /** Test hook for the optional status poll: mark an order paid out-of-band. */
  markPaid(orderId: string): void {
    const o = this.orders.get(orderId);
    if (o) o.status = 'paid';
  }
}
