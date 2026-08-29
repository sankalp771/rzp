import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pooled, scenarioMetrics } from './metrics.js';
import { failuresOf, renderMarkdown, summarize, type Report } from './report.js';
import { SCENARIOS, scenarioById, type Scenario } from './scenarios.js';
import { runSession, type Adapters } from './session.js';
import { RunStore } from './store.js';
import type { Mode, ScenarioId, SessionRecord } from './types.js';

/**
 * The run loop: scenarios × N, resumable from `sessions.jsonl`, paced when
 * asked, and always ending in a report that says how many sessions
 * actually ran. The CLI and the smoke test both call this.
 */

export interface RunOptions {
  mode: Mode;
  n: number;
  seed: number;
  runId: string;
  runsDir: string;
  scenarios?: ScenarioId[];
  adapters?: Adapters;
  clock?: 'frozen' | 'real';
  /** Sleep between executed sessions (live pacing). */
  paceMs?: number;
  /** Return true to stop the run cleanly after this session (e.g. repeated rate limits). */
  onSession?: (record: SessionRecord, done: number, total: number) => boolean | void;
  /** Wrote by the CLI to say why it stopped; carried into provenance. */
  stoppedEarly?: () => string | null;
}

export interface RunOutput {
  report: Report;
  records: SessionRecord[];
  executed: number;
  dir: string;
}

export async function runEvals(opts: RunOptions): Promise<RunOutput> {
  const startedAt = new Date();
  const scenarios: Scenario[] = opts.scenarios ? opts.scenarios.map(scenarioById) : [...SCENARIOS];
  const dir = join(opts.runsDir, opts.runId);
  const store = new RunStore(dir);
  const records = store.load();
  const done = new Set(records.map(RunStore.key));
  const total = scenarios.length * opts.n;
  const adapters = opts.adapters ?? {};
  const clock = opts.clock ?? (opts.mode === 'live' ? 'real' : 'frozen');
  let executed = 0;
  let stopped: string | null = null;

  outer: for (const scenario of scenarios) {
    for (let index = 0; index < opts.n; index++) {
      if (done.has(RunStore.key({ scenario: scenario.id, index }))) continue;
      const record = await runSession({
        runId: opts.runId,
        mode: opts.mode,
        scenario,
        index,
        seed: opts.seed,
        adapters,
        clock,
      });
      store.append(record);
      records.push(record);
      done.add(RunStore.key(record));
      executed += 1;
      if (opts.onSession?.(record, records.length, total)) {
        stopped = opts.stoppedEarly?.() ?? 'stopped by caller';
        break outer;
      }
      if (opts.paceMs && opts.paceMs > 0) await sleep(opts.paceMs);
    }
  }

  const report: Report = {
    provenance: {
      run_id: opts.runId,
      mode: opts.mode,
      seed: opts.seed,
      n_per_scenario: opts.n,
      requested: total,
      completed: records.length,
      executed_now: executed,
      git_commit: gitCommit(),
      models: {
        buyer: adapters.buyer?.modelId ?? 'stub/deterministic',
        seller: adapters.seller?.modelId ?? 'stub/deterministic',
        verifier: adapters.firewall?.modelId ?? 'not_configured (layer 1 only)',
      },
      clock,
      settlement:
        'simulated (in-process SimulatedRazorpayClient; the live Razorpay leg was proven by Gate 4 on Day 7)',
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      wall_ms: Date.now() - startedAt.getTime(),
      stopped_early: stopped,
      node: process.version,
    },
    scenarios: scenarios.map((s) =>
      scenarioMetrics(
        s,
        opts.n,
        records.filter((r) => r.scenario === s.id),
      ),
    ),
    pooled: pooled(records),
    failures: failuresOf(records),
    sessions: records
      .slice()
      .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.index - b.index)
      .map(summarize),
  };
  writeReport(dir, report);
  return { report, records, executed, dir };
}

export function writeReport(dir: string, report: Report): void {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(dir, 'REPORT.md'), renderMarkdown(report));
}

function gitCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
