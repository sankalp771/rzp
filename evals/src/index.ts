/** Evals harness (FEATURE-011): scenarios × N over the in-process stack, honest metrics. */
export { predictCurve, policyFor, effectiveFloorFor } from './curves.js';
export {
  detectFloorLeaks,
  findFloorMention,
  floorRenderings,
  floorLeakSummary,
} from './floorleak.js';
export type { FloorLeakSummary } from './floorleak.js';
export { loadEnv, liveAdapters, backoffMs, MAX_CONSECUTIVE_RATE_LIMITED } from './live.js';
export { rate, scenarioMetrics, pooled, benign, corrupted, economics } from './metrics.js';
export { providerStats, fallbackKind, sessionRateLimited, percentile } from './providers.js';
export type { ProviderStats } from './providers.js';
export { renderMarkdown, summarize, failuresOf, reading } from './report.js';
export type { Report, Provenance, SessionSummary, Comparison } from './report.js';
export { runEvals, writeReport } from './run.js';
export type { RunOptions, RunOutput } from './run.js';
export { SCENARIOS, SCENARIO_IDS, drawParams, sessionSeed, scenarioById } from './scenarios.js';
export { runSession, classify } from './session.js';
export type { Adapters } from './session.js';
export { RunStore } from './store.js';
export type * from './types.js';
