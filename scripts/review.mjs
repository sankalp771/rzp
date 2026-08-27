#!/usr/bin/env node
/**
 * The human in the loop (FEATURE-009, PROTOCOL.md §7.9): list the firewall's
 * held carts and decide one. This is what the Day 10 dashboard's approval
 * queue calls; until then it is the demo's second terminal.
 *
 *   node scripts/review.mjs list
 *   node scripts/review.mjs approve <cart_mandate_hash> [note]
 *   node scripts/review.mjs reject  <cart_mandate_hash> [note]
 *
 * Reads FIREWALL_REVIEW_TOKEN (and FIREWALL_URL_LOCAL, default
 * http://localhost:4003) from .env when not in the environment. The
 * reviewer name comes from --reviewer, else REVIEWER, else the OS user.
 */
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--reviewer');

function loadEnv() {
  const p = resolve(here, '../.env');
  const out = {};
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  }
  return { ...out, ...process.env };
}
const env = loadEnv();
const base = (env.FIREWALL_URL_LOCAL ?? 'http://localhost:4003').replace(/\/$/, '');
const token = env.FIREWALL_REVIEW_TOKEN;
if (!token) {
  console.error('FIREWALL_REVIEW_TOKEN not set (env or .env) — the queue is disabled without it');
  process.exit(2);
}
const headers = { 'content-type': 'application/json', 'x-review-token': token };
const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const short = (h) => `${String(h).slice(0, 12)}…`;

async function list() {
  const res = await fetch(`${base}/review`, { headers });
  if (!res.ok) throw new Error(`GET /review → HTTP ${res.status}: ${await res.text()}`);
  const { pending } = await res.json();
  if (pending.length === 0) {
    console.log('No carts held for review.');
    return;
  }
  for (const p of pending) {
    const items = p.line_items
      .map((li) => `${li.category}/${li.variant_id} × ${li.quantity} @ ${rupees(li.unit_price)}`)
      .join('; ');
    console.log('─'.repeat(78));
    console.log(`HELD  ${p.cart_mandate_hash}`);
    console.log(`  goal:     "${p.goal}"  (principal ${p.principal_id})`);
    console.log(`  cart:     ${items} → total ${rupees(p.total)} from ${p.seller_agent_id}`);
    console.log(
      `  reasons:  ${p.reasons.length ? p.reasons.join(', ') : '(none — verifier absent)'}`,
    );
    for (const d of p.details) console.log(`            ${d}`);
    if (p.verifier?.record) {
      const r = p.verifier.record;
      console.log(
        `  verifier: ${r.model_id} ${r.used_llm ? `in ${r.latency_ms}ms` : `— ${r.failure_reason ?? 'absent'}`}`,
      );
    }
    console.log(`  held since ${p.held_since}, times out at ${p.expires_at}`);
    console.log(`  → node scripts/review.mjs approve ${p.cart_mandate_hash}`);
    console.log(`  → node scripts/review.mjs reject  ${p.cart_mandate_hash}`);
  }
  console.log('─'.repeat(78));
}

async function decide(decision, hash, note) {
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) {
    throw new Error(`usage: review.mjs ${decision} <cart_mandate_hash> [note]`);
  }
  const reviewer = flag('--reviewer') ?? env.REVIEWER ?? userInfo().username ?? 'operator';
  const res = await fetch(`${base}/review/${hash}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ decision, reviewer, ...(note ? { note } : {}) }),
  });
  const body = await res.json();
  if (res.status === 409) {
    const v = body.verdict?.body;
    console.log(
      `ALREADY DECIDED — standing verdict: ${v?.verdict?.toUpperCase()} (layer ${v?.layer}) ${v?.reasons?.join(', ') ?? ''}`,
    );
    process.exit(1);
  }
  if (!res.ok)
    throw new Error(`POST /review/${short(hash)} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  const v = body.verdict.body;
  console.log(
    `${decision.toUpperCase()} by ${reviewer} → verdict ${v.verdict.toUpperCase()} (layer ${v.layer}) ${v.reasons.join(', ')} for cart ${short(hash)}`,
  );
  if (decision === 'approve' && v.verdict !== 'allow') {
    console.log(
      '  the policy layer refused the approval (re-check at decision time) — see reasons',
    );
  }
}

const [cmd, hash, ...rest] = positional;
if (cmd === 'list' || cmd === undefined) await list();
else if (cmd === 'approve' || cmd === 'reject')
  await decide(cmd, hash, rest.join(' ') || undefined);
else {
  console.error('usage: review.mjs list | approve <hash> [note] | reject <hash> [note]');
  process.exit(2);
}
