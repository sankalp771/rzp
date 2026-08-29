import type { MoveRow, SessionRecord, VerifierRow } from './types.js';

/**
 * Per-provider LLM statistics (FEATURE-011 design #3): every call the
 * agents and the verifier made, how many the model actually answered, and
 * how the rest failed — rate limits counted on their own because they are
 * the quota reality the live run has to live with (BUILD_PLAN risk).
 * Latencies are over answered calls only; a fallback's latency is the
 * time spent failing, which is a different number.
 */

export type Role = 'buyer' | 'seller' | 'verifier';

export interface ProviderStats {
  role: Role;
  model_id: string;
  calls: number;
  used: number;
  fallbacks: number;
  fallback_kinds: Record<string, number>;
  rate_limited: number;
  latency_ms: { median: number | null; p95: number | null };
  /** Verifier only: what it recommended when it answered. */
  recommendations?: Record<string, number>;
}

/** Classify a fallback/failure reason string into the adapter's error kinds. */
export function fallbackKind(reason: string | null | undefined): string {
  if (!reason) return 'none';
  const r = reason.toLowerCase();
  if (/rate_limited|\b429\b/.test(r)) return 'rate_limited';
  if (/timeout/.test(r)) return 'timeout';
  if (/network/.test(r)) return 'network';
  if (/http/.test(r)) return 'http';
  if (/malformed/.test(r)) return 'malformed';
  if (/unparseable|non-json|schema/.test(r)) return 'unparseable';
  return 'other';
}

export function sessionRateLimited(llm: SessionRecord['llm']): boolean {
  const moves = [...llm.buyer, ...llm.seller];
  return (
    moves.some((m) => !m.used_llm && fallbackKind(m.fallback_reason) === 'rate_limited') ||
    (llm.verifier !== null &&
      !llm.verifier.used_llm &&
      fallbackKind(llm.verifier.failure_reason) === 'rate_limited')
  );
}

/**
 * Every LLM call in the session failed on transport (network/timeout) —
 * the machine lost the providers, not the providers the machine. Pacing
 * treats it like a rate limit: back off, then stop rather than record
 * sessions that measure nothing.
 */
export function sessionOutage(llm: SessionRecord['llm']): boolean {
  const moves = [...llm.buyer, ...llm.seller];
  const verifierFailed = llm.verifier !== null && !llm.verifier.used_llm;
  const calls = moves.length + (llm.verifier ? 1 : 0);
  if (calls === 0) return false;
  const failedTransport = (reason: string | null | undefined) =>
    ['network', 'timeout'].includes(fallbackKind(reason));
  return (
    moves.every((m) => !m.used_llm && failedTransport(m.fallback_reason)) &&
    (llm.verifier === null || (verifierFailed && failedTransport(llm.verifier.failure_reason)))
  );
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function providerStats(records: SessionRecord[]): ProviderStats[] {
  const moveStats = (role: 'buyer' | 'seller'): ProviderStats[] => {
    const rows: MoveRow[] = records.flatMap((r) => r.llm[role]);
    const byModel = new Map<string, MoveRow[]>();
    for (const m of rows) byModel.set(m.model_id, [...(byModel.get(m.model_id) ?? []), m]);
    return [...byModel.entries()].map(([model_id, ms]) => {
      const used = ms.filter((m) => m.used_llm);
      const failed = ms.filter((m) => !m.used_llm);
      const kinds: Record<string, number> = {};
      for (const m of failed) {
        const k = fallbackKind(m.fallback_reason);
        kinds[k] = (kinds[k] ?? 0) + 1;
      }
      return {
        role,
        model_id,
        calls: ms.length,
        used: used.length,
        fallbacks: failed.length,
        fallback_kinds: kinds,
        rate_limited: kinds['rate_limited'] ?? 0,
        latency_ms: {
          median: percentile(
            used.map((m) => m.latency_ms),
            50,
          ),
          p95: percentile(
            used.map((m) => m.latency_ms),
            95,
          ),
        },
      };
    });
  };
  const verifierRows: VerifierRow[] = records.flatMap((r) =>
    r.llm.verifier ? [r.llm.verifier] : [],
  );
  const byModel = new Map<string, VerifierRow[]>();
  for (const v of verifierRows) byModel.set(v.model_id, [...(byModel.get(v.model_id) ?? []), v]);
  const verifier: ProviderStats[] = [...byModel.entries()].map(([model_id, vs]) => {
    const used = vs.filter((v) => v.used_llm);
    const absent = vs.filter((v) => !v.used_llm);
    const kinds: Record<string, number> = {};
    for (const v of absent) {
      const k = fallbackKind(v.failure_reason);
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const recommendations: Record<string, number> = {};
    for (const v of used) {
      const k = v.recommendation ?? 'unknown';
      recommendations[k] = (recommendations[k] ?? 0) + 1;
    }
    return {
      role: 'verifier',
      model_id,
      calls: vs.length,
      used: used.length,
      fallbacks: absent.length,
      fallback_kinds: kinds,
      rate_limited: kinds['rate_limited'] ?? 0,
      latency_ms: {
        median: percentile(
          used.map((v) => v.latency_ms),
          50,
        ),
        p95: percentile(
          used.map((v) => v.latency_ms),
          95,
        ),
      },
      recommendations,
    };
  });
  return [...moveStats('buyer'), ...moveStats('seller'), ...verifier];
}
