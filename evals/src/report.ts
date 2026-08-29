import type { Economics, Pooled, Rate, ScenarioMetrics } from './metrics.js';
import type { Mode, SessionRecord } from './types.js';

/**
 * The report artifact (FEATURE-011 design #3/#5): `report.json` is what the
 * dashboard's Evals tab renders and what the README's table is copied
 * from; `REPORT.md` is the same numbers for a human, with the failure
 * lines in the same tables as the wins. The first line states that the
 * settlement client is simulated (EVALS.md §6).
 */

export interface Provenance {
  run_id: string;
  mode: Mode;
  seed: number;
  n_per_scenario: number;
  requested: number;
  completed: number;
  /** Sessions executed by THIS invocation (the rest were resumed from disk). */
  executed_now: number;
  git_commit: string | null;
  models: { buyer: string; seller: string; verifier: string };
  clock: 'frozen' | 'real';
  settlement: 'simulated (in-process SimulatedRazorpayClient; the live Razorpay leg was proven by Gate 4 on Day 7)';
  started_at: string;
  finished_at: string;
  wall_ms: number;
  stopped_early: string | null;
  node: string;
}

export interface SessionSummary {
  scenario: string;
  index: number;
  session_id: string | null;
  budget: number;
  outcome: string;
  reason: string | null;
  classification: string;
  caught_by: string | null;
  rounds: number;
  list_total: number | null;
  settled_total: number | null;
  discount_pct: number | null;
  verdict: string | null;
  curve: { outcome: string; price: number | null; rounds: number } | null;
  wall_ms: number;
}

export interface Report {
  provenance: Provenance;
  scenarios: ScenarioMetrics[];
  pooled: Pooled;
  /** Every session that did not go the way ground truth says it should, plus every failure. */
  failures: {
    scenario: string;
    index: number;
    session_id: string | null;
    classification: string;
    reason: string | null;
    caught_by: string | null;
    error: string | null;
  }[];
  sessions: SessionSummary[];
}

export function summarize(r: SessionRecord): SessionSummary {
  return {
    scenario: r.scenario,
    index: r.index,
    session_id: r.session_id,
    budget: r.params.budget,
    outcome: r.outcome,
    reason: r.reason,
    classification: r.classification,
    caught_by: r.caught_by,
    rounds: r.rounds,
    list_total: r.list_total,
    settled_total: r.settled_total,
    discount_pct: r.discount_pct === null ? null : Math.round(r.discount_pct * 1000) / 10,
    verdict: r.verdict ? `${r.verdict.verdict}/${r.verdict.layer}` : null,
    curve: r.curve
      ? { outcome: r.curve.outcome, price: r.curve.price ?? null, rounds: r.curve.rounds }
      : null,
    wall_ms: r.wall_ms,
  };
}

export function failuresOf(records: SessionRecord[]): Report['failures'] {
  return records
    .filter((r) => ['false_block', 'false_allow', 'failed'].includes(r.classification))
    .map((r) => ({
      scenario: r.scenario,
      index: r.index,
      session_id: r.session_id,
      classification: r.classification,
      reason: r.reason,
      caught_by: r.caught_by,
      error: r.error,
    }));
}

// --- Markdown ---------------------------------------------------------------

const pct = (r: Rate) => (r.pct === null ? `— (0/0)` : `${r.pct}% (${r.n}/${r.d})`);
const num = (x: number | null, digits = 1) => (x === null ? '—' : x.toFixed(digits));
const rupees = (p: number | null) =>
  p === null ? '—' : `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const econ = (e: Economics) =>
  `${e.settled} settled · avg ${num(e.avg_discount_pct)}% below list · avg ${num(e.avg_rounds)} rounds · avg ${rupees(e.avg_settled_total)}`;

export function renderMarkdown(report: Report): string {
  const p = report.provenance;
  const out: string[] = [];
  out.push(`# Evals report — run \`${p.run_id}\` (${p.mode} mode)`, '');
  out.push(
    `> Settlement: ${p.settlement}. ${p.completed} of ${p.requested} sessions completed` +
      (p.stopped_early ? ` — **stopped early: ${p.stopped_early}**` : '') +
      '. Every rate is printed with its numerator/denominator; failure numbers sit in the same tables as the wins.',
    '',
  );
  out.push('## Provenance', '');
  out.push(`- git commit: \`${p.git_commit ?? 'unknown'}\``);
  out.push(
    `- models: buyer \`${p.models.buyer}\` · seller \`${p.models.seller}\` · intent-verifier \`${p.models.verifier}\``,
  );
  out.push(
    `- seed ${p.seed} · ${p.n_per_scenario} sessions per scenario · clock ${p.clock} · node ${p.node}`,
  );
  out.push(
    `- started ${p.started_at} · finished ${p.finished_at} · wall ${(p.wall_ms / 1000).toFixed(1)} s (${p.executed_now} executed in this invocation, ${p.completed - p.executed_now} resumed from disk)`,
  );
  out.push('');

  out.push('## Benign scenarios — negotiation quality and the false-block rate', '');
  out.push(
    '| Scenario | Sessions | Deal-close | Walk-away | False block | Avg discount | Avg rounds | Avg settled |',
  );
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of report.scenarios.filter((s) => s.benign)) {
    const b = s.benign!;
    const held = b.false_block_held ? ` (${b.false_block_held} held)` : '';
    out.push(
      `| \`${s.scenario}\` | ${s.completed}${s.failed ? ` (${s.failed} failed)` : ''} | ${pct(b.deal_close)} | ${pct(b.walk_away)} | ${pct(b.false_block)}${held} | ${num(b.llm.avg_discount_pct)}% | ${num(b.llm.avg_rounds)} | ${rupees(b.llm.avg_settled_total)} |`,
    );
  }
  if (report.pooled.benign) {
    const b = report.pooled.benign;
    out.push(
      `| **pooled** | ${b.sessions}${b.failed ? ` (${b.failed} failed)` : ''} | ${pct(b.deal_close)} | ${pct(b.walk_away)} | ${pct(b.false_block)} | ${num(b.llm.avg_discount_pct)}% | ${num(b.llm.avg_rounds)} | ${rupees(b.llm.avg_settled_total)} |`,
    );
  }
  out.push('');
  const reasons = report.scenarios
    .filter((s) => s.benign && Object.keys(s.benign.walk_away_reasons).length)
    .map(
      (s) =>
        `\`${s.scenario}\`: ${Object.entries(s.benign!.walk_away_reasons)
          .map(([k, v]) => `${k} ×${v}`)
          .join(', ')}`,
    );
  if (reasons.length) out.push(`Walk-away reasons — ${reasons.join('; ')}.`, '');

  out.push('## Corrupted scenarios — catch rate, false allows, and who caught it', '');
  out.push(
    '| Scenario | Reached firewall | Caught | of which held | False allow | Walked away first | Caught by |',
  );
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of report.scenarios.filter((s) => s.corrupted)) {
    const c = s.corrupted!;
    out.push(
      `| \`${s.scenario}\` | ${c.reached_firewall}${s.failed ? ` (${s.failed} failed)` : ''} | ${pct(c.caught)} | ${c.escalation_share.n} | **${pct(c.false_allow)}** | ${c.walked_before_firewall} | ${layers(c.caught_by)} |`,
    );
  }
  if (report.pooled.corrupted) {
    const c = report.pooled.corrupted;
    out.push(
      `| **pooled** | ${c.reached_firewall} | ${pct(c.caught)} | ${c.escalation_share.n} | **${pct(c.false_allow)}** | ${c.walked_before_firewall} | ${layers(c.caught_by)} |`,
    );
  }
  out.push('');
  const misses = report.scenarios.flatMap((s) => s.corrupted?.false_allow_sessions ?? []);
  out.push(
    misses.length
      ? `**Critical misses (money moved on a corrupted cart): ${misses.length}** — sessions ${misses.map((m) => `\`${m.slice(0, 8)}\``).join(', ')}.`
      : '**Critical misses (money moved on a corrupted cart): 0.**',
    '',
  );

  out.push('## Curve vs LLM — benign economics on identical parameters (amendment #1)', '');
  out.push('| Scenario | Curves alone (prediction) | This run |');
  out.push('| --- | --- | --- |');
  for (const s of report.scenarios.filter((s) => s.benign)) {
    out.push(`| \`${s.scenario}\` | ${econ(s.benign!.curve)} | ${econ(s.benign!.llm)} |`);
  }
  if (report.pooled.benign)
    out.push(
      `| **pooled** | ${econ(report.pooled.benign.curve)} | ${econ(report.pooled.benign.llm)} |`,
    );
  out.push('', reading(report), '');

  out.push('## Failures and surprises', '');
  if (report.failures.length === 0)
    out.push('- none: every session went the way its ground truth says it should.');
  for (const f of report.failures) {
    out.push(
      `- \`${f.scenario}\` #${f.index} (${f.session_id?.slice(0, 8) ?? 'no session'}): **${f.classification}** — ${f.reason ?? ''}${f.caught_by ? ` by ${f.caught_by}` : ''}${f.error ? ` — ${f.error.split('\n')[0]}` : ''}`,
    );
  }
  out.push('');
  out.push('## Artifacts', '');
  out.push(
    `- \`evals/runs/${p.run_id}/sessions.jsonl\` — every session: parameters, outcome, verdict, LLM attribution, compact transcript`,
  );
  out.push(
    `- \`evals/runs/${p.run_id}/report.json\` — this report as data (the dashboard's Evals tab reads the published copy)`,
  );
  out.push('');
  return out.join('\n');
}

function layers(by: Partial<Record<string, number>>): string {
  const entries = Object.entries(by).filter(([, v]) => v);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(', ') : '—';
}

/** One honest sentence, generated from the numbers rather than written once and left to rot. */
export function reading(report: Report): string {
  const b = report.pooled.benign;
  if (!b || b.llm.avg_discount_pct === null || b.curve.avg_discount_pct === null) {
    return report.provenance.mode === 'stub'
      ? '_Stub mode: this run IS the curves — the two columns must agree exactly (the smoke test asserts it)._'
      : '_Not enough settled benign sessions to compare._';
  }
  if (report.provenance.mode === 'stub') {
    return '_Stub mode: this run IS the curves — the two columns must agree exactly (the smoke test asserts it)._';
  }
  const dd = b.llm.avg_discount_pct - b.curve.avg_discount_pct;
  const dr = (b.llm.avg_rounds ?? 0) - (b.curve.avg_rounds ?? 0);
  const who =
    dd < 0 ? 'wins LESS discount' : dd > 0 ? 'wins MORE discount' : 'wins the same discount';
  return `_Reading: on identical budgets and curves, the LLM-advised pair closed ${b.deal_close.n}/${b.deal_close.d} deals vs the curves' ${b.curve.settled}/${b.deal_close.d}, and ${who} (${num(b.llm.avg_discount_pct)}% vs ${num(b.curve.avg_discount_pct)}% below list, ${dd >= 0 ? '+' : ''}${dd.toFixed(1)} points) in ${dr >= 0 ? '+' : ''}${dr.toFixed(1)} rounds. Both agents were model-advised, so this measures the pair, not one side._`;
}
