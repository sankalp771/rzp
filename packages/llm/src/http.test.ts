import { describe, expect, it } from 'vitest';
import { LlmError } from './adapter.js';
import { fetchWithBudget, type FetchLike } from './http.js';

/** Fake clock + fake fetch so retry/budget behaviour is asserted exactly. */
function harness(responses: (number | 'network' | 'hang')[]) {
  let t = 0;
  const calls: number[] = [];
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(t);
    const next = responses.shift();
    if (next === 'network') throw new TypeError('fetch failed');
    if (next === 'hang') {
      // Simulate a request that only ends when the abort fires.
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return new Response('{}', { status: next ?? 200 });
  };
  return {
    fetchImpl,
    calls,
    sleeps,
    deps: {
      fetchImpl,
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
  };
}

const BUDGET = { attemptTimeoutMs: 8_000, totalBudgetMs: 12_000, maxAttempts: 3 };

describe('fetchWithBudget (retries INSIDE the budget — amendment #1)', () => {
  it('returns the first OK response without retrying', async () => {
    const h = harness([200]);
    const res = await fetchWithBudget('u', {}, BUDGET, h.deps);
    expect(res.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it('retries a 429 with backoff and succeeds', async () => {
    const h = harness([429, 200]);
    const res = await fetchWithBudget('u', {}, BUDGET, h.deps);
    expect(res.ok).toBe(true);
    expect(h.sleeps).toEqual([500]);
  });

  it('retries a network error, then a 503, then gives up at the attempt ceiling', async () => {
    const h = harness(['network', 503, 503]);
    await expect(fetchWithBudget('u', {}, BUDGET, h.deps)).rejects.toMatchObject({
      kind: 'http',
      status: 503,
    });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it('does not retry a non-retryable 4xx', async () => {
    const h = harness([400, 200]);
    await expect(fetchWithBudget('u', {}, BUDGET, h.deps)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
    });
    expect(h.calls).toHaveLength(1);
  });

  it('never sleeps past the total budget: backoff that would overrun ends the call', async () => {
    // Budget 1200ms: attempt 1 (429) → backoff 500 ok → attempt 2 (429) →
    // backoff 1000 would exceed remaining 700 → stop, 2 attempts only.
    const h = harness([429, 429, 200]);
    await expect(
      fetchWithBudget('u', {}, { ...BUDGET, totalBudgetMs: 1_200 }, h.deps),
    ).rejects.toBeInstanceOf(LlmError);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([500]);
  });

  it('honours a Retry-After that fits the budget', async () => {
    let first = true;
    const h = harness([]);
    const fetchImpl: FetchLike = async () => {
      if (first) {
        first = false;
        return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      }
      return new Response('{}', { status: 200 });
    };
    const res = await fetchWithBudget('u', {}, BUDGET, { ...h.deps, fetchImpl });
    expect(res.ok).toBe(true);
    expect(h.sleeps).toEqual([2000]);
  });

  it('classifies an aborted attempt as a timeout', async () => {
    const h = harness(['hang']);
    // Real timers drive the abort here; keep the attempt cap tiny.
    await expect(
      fetchWithBudget(
        'u',
        {},
        { attemptTimeoutMs: 20, totalBudgetMs: 25, maxAttempts: 1 },
        {
          fetchImpl: h.fetchImpl,
        },
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
