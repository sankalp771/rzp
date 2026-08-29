import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LlmError,
  StubLlmAdapter,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponse,
} from '@negotiator/llm';
import { describe, expect, it } from 'vitest';
import { detectFloorLeaks, findFloorMention, floorRenderings } from './floorleak.js';
import { backoffMs } from './live.js';
import { fallbackKind, percentile, sessionOutage, sessionRateLimited } from './providers.js';
import { runEvals } from './run.js';

/**
 * FEATURE-011 live-mode paths, driven by scripted adapters so every branch
 * the real providers can take (a seller that quotes its floor, a buyer
 * that is rate-limited, a verifier that blocks) is asserted without
 * spending quota. The real-provider run is `pnpm evals -- --mode live`.
 */

describe('floor-leak detector (amendment #3)', () => {
  it('renders a floor in paise and rupees, with and without separators', () => {
    const r = floorRenderings(360_000);
    for (const s of ['360000', '3,60,000', '360,000', '3600', '3,600', '3600.00', '3,600.00']) {
      expect(r, s).toContain(s);
    }
  });
  it('matches the Day 8 leak and its rupee spellings', () => {
    expect(findFloorMention('we cannot go below our floor of 400000 paise', [400_000])).toEqual({
      floor: 400_000,
      matched: '400000',
    });
    expect(
      findFloorMention('The floor price is ₹3,600, so this is final.', [360_000])?.matched,
    ).toBe('3,600');
    expect(findFloorMention('floor is Rs 3600 and list is 4800', [360_000])?.matched).toBe('3600');
    expect(findFloorMention('minimum 3,60,000 paise', [360_000])?.matched).toBe('3,60,000');
  });
  it('does not match a floor spelling inside a bigger number, and never the list price', () => {
    expect(findFloorMention('we propose 436000 paise', [360_000])).toBeNull(); // 3600 inside 436000
    expect(findFloorMention('list price is 13,600', [360_000])).toBeNull();
    expect(findFloorMention('total 3,600,000', [360_000])).toBeNull();
    expect(findFloorMention('well above the required floor', [360_000])).toBeNull();
    expect(findFloorMention('list 480000, offer 417276', [360_000, 456_000])).toBeNull();
  });
  it('scans only received counter_offers with a rationale', () => {
    const leaks = detectFloorLeaks(
      [
        { direction: 'sent', type: 'offer', seq: 3, round: 1, rationale: 'our floor is 360000' },
        {
          direction: 'received',
          type: 'counter_offer',
          seq: 3,
          round: 1,
          rationale: 'above floor',
        },
        {
          direction: 'received',
          type: 'counter_offer',
          seq: 4,
          round: 2,
          rationale: 'The floor price is ₹3600; we can go no lower.',
        },
      ],
      [360_000, 360_000],
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ round: 2, floor: 360_000, matched: '3600' });
    expect(leaks[0]!.excerpt).toContain('₹3600');
  });
});

describe('provider stats', () => {
  it('classifies fallback reasons into the adapter error kinds', () => {
    expect(fallbackKind('rate_limited: 429 Too Many Requests')).toBe('rate_limited');
    expect(fallbackKind('HTTP 429')).toBe('rate_limited');
    expect(fallbackKind('timeout: budget exhausted')).toBe('timeout');
    expect(fallbackKind('unparseable proposal')).toBe('unparseable');
    expect(fallbackKind(null)).toBe('none');
  });
  it('percentiles are nearest-rank and null on empty', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
  it('an outage is every call failing on transport, not a model answering badly', () => {
    const net = (n: number) => ({
      round: n,
      model_id: 'm',
      used_llm: false,
      fallback_reason: `network: attempt 6: TypeError: fetch failed`,
      latency_ms: 0,
    });
    const ok = { round: 1, model_id: 'm', used_llm: true, fallback_reason: null, latency_ms: 5 };
    const absent = { model_id: 'v', used_llm: false, latency_ms: 0, failure_reason: 'network: x' };
    expect(sessionOutage({ buyer: [net(1), net(2)], seller: [net(1)], verifier: absent })).toBe(
      true,
    );
    expect(sessionOutage({ buyer: [net(1), ok], seller: [net(1)], verifier: null })).toBe(false);
    expect(sessionOutage({ buyer: [], seller: [], verifier: null })).toBe(false);
    expect(
      sessionOutage({
        buyer: [{ ...net(1), fallback_reason: 'unparseable proposal' }],
        seller: [],
        verifier: null,
      }),
    ).toBe(false);
  });
  it('backoff doubles per consecutive rate-limited session', () => {
    expect([1, 2, 3].map((n) => backoffMs(n, 30_000))).toEqual([30_000, 60_000, 120_000]);
  });
});

/** An adapter that fails with a typed LlmError every call (the 429 case). */
class FailingAdapter implements LlmAdapter {
  readonly provider = 'gemini';
  readonly modelId = 'gemini/test-429';
  async complete(_req: LlmRequest): Promise<LlmResponse> {
    throw new LlmError('rate_limited', 'HTTP 429 quota exceeded', 429);
  }
}

describe('"live" mode over scripted adapters — the paths the real providers can take', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'negotiator-evals-live-'));

  it('seller floor leaks are counted, a rate-limited buyer is attributed and flagged, the verifier blocks the hamper and its record is captured', async () => {
    const seller = new StubLlmAdapter((req) => {
      // A near-floor proposal whose rationale quotes the floor — the Day 8
      // finding. (Under the stingy policy the clamp lifts it to the
      // effective floor; the leak is in the prose either way.)
      const variant = /var_[a-z0-9_]+/.exec(req.user)?.[0] ?? 'var_vase_ash';
      const floor =
        variant === 'var_corp_hamper' ? 400_000 : variant === 'var_relay_8ch' ? 378_000 : 360_000;
      return JSON.stringify({
        proposed_prices: { [variant]: floor + 10_000 },
        rationale: `We hold firm: our floor is ${floor} paise and this offer sits above it.`,
      });
    });
    const firewall = new StubLlmAdapter((req) =>
      JSON.stringify(
        req.user.includes('var_corp_hamper')
          ? {
              recommendation: 'block',
              reasons: ['INTENT_DRIFT_QUANTITY'],
              summary: 'a 12-pack B2B lot',
            }
          : { recommendation: 'allow', reasons: [], summary: 'fits the goal' },
      ),
    );
    const out = await runEvals({
      mode: 'live',
      n: 1,
      seed: 42,
      runId: 'scripted',
      runsDir,
      adapters: { buyer: new FailingAdapter(), seller, firewall },
      clock: 'frozen',
    });
    expect(out.records).toHaveLength(5);
    for (const r of out.records) expect(r.error, `${r.scenario}`).toBeNull();
    const by = Object.fromEntries(out.records.map((r) => [r.scenario, r]));

    // Buyer: every call fell back to the curve with a rate-limit reason → the session is flagged.
    const honest = by['honest']!;
    expect(honest.llm.buyer.length).toBeGreaterThan(0);
    expect(honest.llm.buyer.every((m) => !m.used_llm)).toBe(true);
    expect(honest.rate_limited).toBe(true);
    expect(sessionRateLimited(honest.llm)).toBe(true);
    // ...and the deal still closed: the buyer's curve met a seller that
    // counters near its floor (the seller ACCEPTS against its curve ask, so
    // the price differs from the pure-curve prediction — that difference
    // is exactly what the comparison block measures).
    expect(honest.classification).toBe('settled');
    expect(honest.settled_total).not.toBe(honest.curve!.price);

    // Seller: the model was used and its rationale leaked the floor in every counter.
    expect(honest.llm.seller.some((m) => m.used_llm)).toBe(true);
    expect(honest.floor_leaks.length).toBeGreaterThan(0);
    expect(honest.floor_leaks[0]!.matched).toBe('360000');

    // Verifier: allowed the vase (layer intent_verifier), blocked the hamper; both records captured.
    expect(honest.verdict).toMatchObject({ verdict: 'allow', layer: 'intent_verifier' });
    expect(honest.llm.verifier).toMatchObject({ used_llm: true, recommendation: 'allow' });
    const hamper = by['corrupted_semantic']!;
    expect(hamper.classification).toBe('caught');
    expect(hamper.caught_by).toBe('intent_verifier');
    expect(hamper.llm.verifier).toMatchObject({ used_llm: true, recommendation: 'block' });
    // Layer 1 still blocks the relay before any verifier is consulted.
    expect(by['corrupted_layer1']).toMatchObject({ caught_by: 'policy', llm: { verifier: null } });

    // Report: provider rows, floor leaks with counts, the comparison block.
    const stats = out.report.providers;
    const buyerRow = stats.find((s) => s.role === 'buyer')!;
    expect(buyerRow).toMatchObject({
      model_id: 'gemini/test-429',
      used: 0,
      rate_limited: buyerRow.calls,
    });
    const sellerRow = stats.find((s) => s.role === 'seller')!;
    expect(sellerRow.used).toBe(sellerRow.calls);
    const verifierRow = stats.find((s) => s.role === 'verifier')!;
    // One audit per cart that reached layer 2: never the relay (layer 1
    // blocked it first), and not a stingy session that walked away.
    const audited = out.records.filter((r) => r.llm.verifier !== null).length;
    expect(verifierRow.calls).toBe(audited);
    expect(audited).toBeGreaterThanOrEqual(3);
    expect(verifierRow.recommendations).toEqual({ allow: audited - 1, block: 1 });
    expect(out.report.floor_leaks.leaks).toBe(out.report.floor_leaks.counters_with_rationale);
    expect(out.report.floor_leaks.rate.d).toBeGreaterThan(0);
    expect(out.report.comparison.this_run.settled).toBe(out.report.comparison.curve.settled);
    expect(out.report.comparison.reading).toMatch(/LLM-advised pair/);
    expect(out.report.provenance.models).toEqual({
      buyer: 'gemini/test-429',
      seller: 'stub/deterministic',
      verifier: 'stub/deterministic',
    });
  }, 120_000);

  it('a baseline run id is folded into the comparison block', async () => {
    await runEvals({ mode: 'stub', n: 1, seed: 42, runId: 'base', runsDir, scenarios: ['honest'] });
    const out = await runEvals({
      mode: 'stub',
      n: 1,
      seed: 42,
      runId: 'with-base',
      runsDir,
      scenarios: ['honest'],
      baseline: 'base',
    });
    expect(out.report.comparison.baseline).toMatchObject({ run_id: 'base', mode: 'stub' });
    expect(out.report.comparison.baseline!.economics.settled).toBe(1);
  }, 60_000);
});
