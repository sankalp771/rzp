#!/usr/bin/env node
/**
 * Demo transcript: trigger one negotiation through the buyer's control
 * plane and print it top-down — mandate goal → every signed message with
 * its rationale → the economics. Every Ed25519 signature is re-verified
 * here from the keys exchanged in-band (nothing trusted from labels).
 *
 *   pnpm build && node scripts/negotiate.mjs            # live run via :4002
 *   node scripts/negotiate.mjs --file run.json           # render a saved result
 *   node scripts/negotiate.mjs --target var_bookend      # force the walk-away demo
 *
 * Reads CONTROL_TOKEN (and BUYER_URL) from .env when not in the environment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { verifyObject } = await import(
  new URL('../packages/protocol/dist/index.js', import.meta.url).href
);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

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

async function obtainRun() {
  const file = flag('--file');
  if (file) return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const env = loadEnv();
  const token = env.CONTROL_TOKEN;
  if (!token) throw new Error('CONTROL_TOKEN not set (env or .env)');
  const base = (env.BUYER_URL_LOCAL ?? 'http://localhost:4002').replace(/\/$/, '');
  const target = flag('--target');
  const res = await fetch(`${base}/control/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': token },
    body: JSON.stringify(target ? { target_variant_id: target } : {}),
  });
  if (!res.ok) throw new Error(`control/run → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function render(run) {
  let buyerKey, sellerKey, listPrice, variantId;
  for (const t of run.transcript) {
    const b = t.message.body;
    if (t.message.type === 'session_init') buyerKey = b.buyer_public_key;
    if (t.message.type === 'session_ack') sellerKey = b.seller_public_key;
  }
  const firstOffer = run.transcript.find((t) => t.message.type === 'offer');
  if (firstOffer) variantId = firstOffer.message.body.line_items[0].variant_id;
  const catalog = run.transcript.find((t) => t.message.type === 'catalog_offer');
  if (catalog && variantId) {
    for (const item of catalog.message.body.items) {
      const v = item.variants.find((v) => v.variant_id === variantId);
      if (v) listPrice = v.list_price;
    }
  }

  const lines = [];
  lines.push('═'.repeat(78));
  lines.push(`THE NEGOTIATOR — session ${run.session_id}`);
  lines.push(`Mandate: "${run.mandate.goal}"`);
  lines.push(
    `Budget ceiling ${rupees(run.mandate.budget_ceiling)}  ·  buyer model ${run.models.buyer}`,
  );
  lines.push('═'.repeat(78));

  let ok = 0;
  let bad = 0;
  for (const { direction, message: m, llm } of run.transcript) {
    const arrow = direction === 'sent' ? 'BUYER  →' : '←  SELLER';
    const key = m.sender.role === 'buyer' ? buyerKey : sellerKey;
    const verified = verifyObject(m, key).ok;
    if (verified) ok += 1;
    else bad += 1;
    const sig = verified ? 'sig ✔' : 'sig ✘ INVALID';
    const b = m.body;
    let detail = '';
    switch (m.type) {
      case 'session_init':
        detail = `versions [${b.supported_versions}], mandate ref ${b.intent_mandate_ref.slice(0, 12)}…`;
        break;
      case 'session_ack':
        detail = `v${b.chosen_version}, max_rounds ${b.capabilities.max_rounds}, ${b.capabilities.currency}`;
        break;
      case 'catalog_request':
        detail = `max_items ${b.max_items}`;
        break;
      case 'catalog_offer':
        detail = `${b.items.length} items, each with catalog_hash`;
        break;
      case 'offer':
      case 'counter_offer': {
        const li = b.line_items[0];
        detail = `round ${b.round} — ${li.variant_id} × ${li.quantity} @ ${rupees(li.proposed_unit_price)}`;
        break;
      }
      case 'accept':
        detail = `accepts msg ${b.accepted_message_id.slice(0, 8)}… at ${rupees(b.total)}`;
        break;
      case 'walk_away':
        detail = `reason: ${b.reason_code}`;
        break;
      case 'error':
        detail = `${b.code}: ${b.detail}`;
        break;
      default:
        detail = JSON.stringify(b).slice(0, 60);
    }
    lines.push(
      `${arrow}  seq ${String(m.seq).padStart(2)}  ${m.type.padEnd(15)} ${detail}  [${sig}]`,
    );
    if (b.rationale) lines.push(`             "${b.rationale}"`);
    if (llm && !llm.used_llm) lines.push(`             (curve — ${llm.fallback_reason})`);
  }

  lines.push('─'.repeat(78));
  if (run.outcome === 'agreed' && listPrice) {
    const settled = run.deal.total;
    lines.push(
      `DEAL: list ${rupees(listPrice)} → settled ${rupees(settled)}  —  ${pct(1 - settled / listPrice)} below list, in ${run.rounds} rounds`,
    );
  } else {
    lines.push(
      `OUTCOME: ${run.outcome.toUpperCase()} (${run.reason ?? run.state}) after ${run.rounds} rounds`,
    );
  }
  lines.push(
    `Signatures: ${ok} verified, ${bad} invalid  ·  LLM calls ${run.llm.calls}, fallbacks ${run.llm.fallbacks}  ·  mandate_registered=${run.mandate_registered}`,
  );
  lines.push('═'.repeat(78));
  return lines.join('\n');
}

const run = await obtainRun();
console.log(render(run));
if (flag('--json')) console.log(JSON.stringify(run));
