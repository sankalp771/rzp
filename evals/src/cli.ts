#!/usr/bin/env node
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvals } from './run.js';
import { SCENARIO_IDS } from './scenarios.js';
import type { Mode, ScenarioId, SessionRecord } from './types.js';

/**
 * The evals CLI (FEATURE-011):
 *
 *   pnpm evals                                # stub mode, 10 per scenario, seed 42 → evals/runs/stub-42/
 *   pnpm evals -- --mode live --n 50          # (next commit) the real adapters from .env
 *   pnpm evals -- --run-id stub-42            # re-running the same id resumes: finished sessions are skipped
 *   pnpm evals -- --publish                   # also copy report.json + REPORT.md to evals/ (what the README cites)
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
const scenarios = flag('--scenarios')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ScenarioId[] | undefined;
for (const s of scenarios ?? []) {
  if (!SCENARIO_IDS.includes(s)) throw new Error(`unknown scenario ${s}`);
}

if (mode === 'live') {
  throw new Error('live mode lands in the next commit (feat(evals): live mode)');
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
  console.log(
    `[${String(done).padStart(3)}/${total}] ${r.scenario.padEnd(19)} #${r.index} budget ${rupees(r.params.budget)}  ${judged} ${tail}  ${(r.wall_ms / 1000).toFixed(1)}s`,
  );
};

const out = await runEvals({
  mode,
  n,
  seed,
  runId,
  runsDir,
  ...(scenarios ? { scenarios } : {}),
  onSession: line,
});

if (has('--publish')) {
  copyFileSync(join(out.dir, 'report.json'), resolve(ROOT, 'evals/report.json'));
  copyFileSync(join(out.dir, 'REPORT.md'), resolve(ROOT, 'evals/REPORT.md'));
  console.log('published → evals/report.json, evals/REPORT.md');
}
const p = out.report.provenance;
console.log(
  `\n${p.completed}/${p.requested} sessions (${out.executed} executed now) → ${out.dir}\n` +
    `pooled benign: close ${fmt(out.report.pooled.benign?.deal_close)} · false block ${fmt(out.report.pooled.benign?.false_block)}\n` +
    `pooled corrupted: caught ${fmt(out.report.pooled.corrupted?.caught)} · false allow ${fmt(out.report.pooled.corrupted?.false_allow)}`,
);

function fmt(r: { n: number; d: number; pct: number | null } | undefined): string {
  if (!r) return '—';
  return r.pct === null ? `0/0` : `${r.pct}% (${r.n}/${r.d})`;
}
