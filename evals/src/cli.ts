#!/usr/bin/env node
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CONSECUTIVE_RATE_LIMITED, backoffMs, liveAdapters, loadEnv } from './live.js';
import { runEvals } from './run.js';
import { SCENARIO_IDS } from './scenarios.js';
import { sessionOutage } from './providers.js';
import type { Adapters } from './session.js';
import type { Mode, ScenarioId, SessionRecord } from './types.js';

/**
 * The evals CLI (FEATURE-011):
 *
 *   pnpm evals                                # stub mode, 10 per scenario, seed 42 → evals/runs/stub-42/
 *   pnpm evals -- --mode live --n 10          # the real adapters from .env (paced, resumable, honest count)
 *   pnpm evals -- --run-id stub-42            # re-running the same id resumes: finished sessions are skipped
 *   pnpm evals -- --mode live --baseline stub-42 --publish
 *                                             # fold the stub run in as the comparison baseline and copy
 *                                             # report.json + REPORT.md to evals/ (what the README cites)
 *   pnpm evals -- --scenarios honest,corrupted_semantic --n 3
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');

// The four services build their Fastify loggers unless NODE_ENV=test; the
// harness IS the test kit and prints one line per session itself.
process.env['NODE_ENV'] ??= 'test';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);

const mode = (flag('--mode') ?? 'stub') as Mode;
if (mode !== 'stub' && mode !== 'live') throw new Error(`--mode must be stub or live, got ${mode}`);
const n = Number(flag('--n') ?? 10);
const seed = Number(flag('--seed') ?? 42);
const runId = flag('--run-id') ?? `${mode}-${seed}`;
const runsDir = resolve(ROOT, flag('--runs-dir') ?? 'evals/runs');
const baseline = flag('--baseline');
const scenarios = flag('--scenarios')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ScenarioId[] | undefined;
for (const s of scenarios ?? []) {
  if (!SCENARIO_IDS.includes(s)) throw new Error(`unknown scenario ${s}`);
}

const env = loadEnv(ROOT);
let adapters: Adapters = {};
if (mode === 'live') {
  adapters = liveAdapters(env);
  const name = (a?: { modelId: string }) => a?.modelId ?? 'stub/deterministic (curve only)';
  console.log(
    `live mode — buyer ${name(adapters.buyer)} · seller ${name(adapters.seller)} · verifier ${adapters.firewall?.modelId ?? 'NOT CONFIGURED (layer 1 only — set FIREWALL_LLM_PROVIDER)'}`,
  );
}
const paceMs = Number(flag('--pace-ms') ?? env['EVALS_PACE_MS'] ?? (mode === 'live' ? 2000 : 0));
// Provenance notes: an explicit --note, plus the adapter retry budget whenever
// it is overridden (the in-process harness has no 30 s HTTP window, so a
// wider budget lets a rate-limited call retry instead of falling back).
const notes: string[] = [];
if (flag('--note')) notes.push(flag('--note')!);
const budgetKeys = ['LLM_TOTAL_BUDGET_MS', 'LLM_MAX_ATTEMPTS', 'LLM_CALL_TIMEOUT_MS'] as const;
if (mode === 'live' && budgetKeys.some((k) => process.env[k])) {
  notes.push(
    `sessions executed in this invocation ran with ${budgetKeys
      .filter((k) => process.env[k])
      .map((k) => `${k}=${process.env[k]}`)
      .join(' ')} (adapter retry budget override; default 12000 ms / 3 attempts)`,
  );
}

const rupees = (p: number | null) => (p === null ? '—' : `₹${(p / 100).toLocaleString('en-IN')}`);
const line = (r: SessionRecord, done: number, total: number) => {
  const tail =
    r.classification === 'failed'
      ? `FAILED ${r.error?.split('\n')[0] ?? r.reason}`
      : r.outcome === 'settled'
        ? `settled ${rupees(r.settled_total)} in ${r.rounds} rounds (${r.verdict?.verdict}/${r.verdict?.layer})`
        : r.outcome === 'walked_away'
          ? `walked away (${r.reason}) after ${r.rounds} rounds`
          : `${r.outcome} ${r.verdict?.verdict}/${r.verdict?.layer} ${r.reason ?? ''}`;
  const judged = r.classification.toUpperCase().padEnd(11);
  const llm =
    mode === 'live'
      ? `  llm ${r.llm.buyer.filter((m) => m.used_llm).length + r.llm.seller.filter((m) => m.used_llm).length}/${r.llm.buyer.length + r.llm.seller.length}${r.rate_limited ? ' RATE-LIMITED' : ''}${r.floor_leaks.length ? ` floor-leaks ${r.floor_leaks.length}` : ''}`
      : '';
  console.log(
    `[${String(done).padStart(3)}/${total}] ${r.scenario.padEnd(19)} #${r.index} budget ${rupees(r.params.budget)}  ${judged} ${tail}${llm}  ${(r.wall_ms / 1000).toFixed(1)}s`,
  );
};

// Quota reality (BUILD_PLAN standing risk): back off after a rate-limited
// session, stop cleanly after MAX_CONSECUTIVE_RATE_LIMITED in a row.
let consecutiveRateLimited = 0;
let stopReason: string | null = null;
const onSession = async (r: SessionRecord, done: number, total: number) => {
  line(r, done, total);
  if (mode !== 'live') return false;
  const outage = sessionOutage(r.llm);
  if (outage) console.log('every LLM call in that session failed on transport — network outage?');
  if (!r.rate_limited && !outage) {
    consecutiveRateLimited = 0;
    return false;
  }
  consecutiveRateLimited += 1;
  if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED) {
    stopReason = `${consecutiveRateLimited} consecutive ${outage ? 'transport-failed' : 'rate-limited'} sessions — re-run the same --run-id later to resume`;
    console.log(`stopping: ${stopReason}`);
    return true;
  }
  if (done >= total) return false; // nothing left to pace
  const wait = backoffMs(consecutiveRateLimited);
  console.log(`rate-limited; backing off ${wait / 1000}s before the next session`);
  await new Promise((res) => setTimeout(res, wait));
  return false;
};

const out = await runEvals({
  mode,
  n,
  seed,
  runId,
  runsDir,
  adapters,
  paceMs,
  ...(scenarios ? { scenarios } : {}),
  ...(baseline ? { baseline } : {}),
  onSession,
  stoppedEarly: () => stopReason,
  notes,
});

if (has('--publish')) {
  copyFileSync(join(out.dir, 'report.json'), resolve(ROOT, 'evals/report.json'));
  copyFileSync(join(out.dir, 'REPORT.md'), resolve(ROOT, 'evals/REPORT.md'));
  console.log('published → evals/report.json, evals/REPORT.md');
}
const p = out.report.provenance;
console.log(
  `\n${p.completed}/${p.requested} sessions (${out.executed} executed now${p.stopped_early ? `; stopped early: ${p.stopped_early}` : ''}) → ${out.dir}\n` +
    `pooled benign: close ${fmt(out.report.pooled.benign?.deal_close)} · false block ${fmt(out.report.pooled.benign?.false_block)}\n` +
    `pooled corrupted: caught ${fmt(out.report.pooled.corrupted?.caught)} · false allow ${fmt(out.report.pooled.corrupted?.false_allow)}\n` +
    `floor leaks: ${fmt(out.report.floor_leaks.rate)}`,
);

function fmt(r: { n: number; d: number; pct: number | null } | undefined): string {
  if (!r) return '—';
  return r.pct === null ? `0/0` : `${r.pct}% (${r.n}/${r.d})`;
}
