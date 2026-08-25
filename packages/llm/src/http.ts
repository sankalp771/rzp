import { LlmError } from './adapter.js';

/**
 * Bounded, budgeted HTTP for provider calls (CONSTRAINTS #10 spirit: every
 * retry loop has a ceiling). Retries on 429 / 5xx / network errors happen
 * INSIDE `totalBudgetMs`, never on top of it, so a caller that holds an
 * HTTP response open while we work (the merchant under the sync binding,
 * D013) can rely on one number:
 *
 *   worst-case proposal time ≤ totalBudgetMs            (default 12 000 ms)
 *   buyer client timeout      = BUYER_HTTP_TIMEOUT_MS   (default 30 000 ms)
 *   invariant: BUYER_HTTP_TIMEOUT_MS > LLM_TOTAL_BUDGET_MS + merchant processing
 *
 * FEATURE-006 amendment #1 — see FLOW.md F1 latency note.
 */

export interface FetchBudget {
  /** Per-attempt cap; an attempt never gets more than the remaining budget. */
  attemptTimeoutMs: number;
  /** Hard wall-clock ceiling for the whole call including retries and backoff. */
  totalBudgetMs: number;
  /** Retry ceiling (attempts, not retries). */
  maxAttempts: number;
}

export const DEFAULT_BUDGET: FetchBudget = {
  attemptTimeoutMs: 8_000,
  totalBudgetMs: 12_000,
  maxAttempts: 3,
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export async function fetchWithBudget(
  url: string,
  init: RequestInit,
  budget: FetchBudget = DEFAULT_BUDGET,
  deps: FetchDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + budget.totalBudgetMs;
  let lastError: LlmError | undefined;

  for (let attempt = 1; attempt <= budget.maxAttempts; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(budget.attemptTimeoutMs, remaining),
    );
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as { name?: string }).name === 'AbortError';
      lastError = new LlmError(
        aborted ? 'timeout' : 'network',
        aborted ? `attempt ${attempt} timed out` : `attempt ${attempt}: ${String(err)}`,
      );
      if (!(await backoff(attempt))) break;
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return res;
    // Provider error bodies name the real cause (bad model id, token
    // minimums); keep a bounded snippet — never the request, never the key.
    const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    lastError = new LlmError(
      res.status === 429 ? 'rate_limited' : 'http',
      `attempt ${attempt}: HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`,
      res.status,
    );
    if (!RETRYABLE(res.status)) break;
    // Honour Retry-After only if it fits in the budget; otherwise give up
    // early rather than sleep past the deadline.
    const retryAfter = Number(res.headers.get('retry-after') ?? '') * 1000;
    if (!(await backoff(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0))) {
      break;
    }
  }
  throw lastError ?? new LlmError('timeout', 'budget exhausted before first attempt');

  /** Exponential backoff clamped to the remaining budget; false = stop. */
  async function backoff(attempt: number, minMs = 0): Promise<boolean> {
    if (attempt >= budget.maxAttempts) return false;
    const wait = Math.max(minMs, 500 * 2 ** (attempt - 1));
    const remaining = deadline - now();
    if (wait >= remaining) return false;
    await sleep(wait);
    return true;
  }
}
