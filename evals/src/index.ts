/** Evals harness (FEATURE-011): scenarios × N over the in-process stack, honest metrics. */
export { predictCurve, policyFor, effectiveFloorFor } from './curves.js';
export { rate, scenarioMetrics, pooled, benign, corrupted } from './metrics.js';
export { renderMarkdown, summarize, failuresOf } from './report.js';
export type { Report, Provenance, SessionSummary } from './report.js';
export { runEvals, writeReport } from './run.js';
export type { RunOptions, RunOutput } from './run.js';
export { SCENARIOS, SCENARIO_IDS, drawParams, sessionSeed, scenarioById } from './scenarios.js';
export { runSession, classify } from './session.js';
export { RunStore } from './store.js';
export type * from './types.js';
