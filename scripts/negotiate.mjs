#!/usr/bin/env node
/**
 * Demo transcript: trigger one run through the buyer's control plane and
 * print it top-down — mandate goal → registration → every signed message
 * with its rationale → verdict → receipt → the economics. Every Ed25519
 * signature is re-verified here: session keys from the messages that
 * exchanged them, the firewall's and settlement's long-lived keys from
 * .env when present (falling back to the keys the buyer reports).
 *
 *   pnpm build && node scripts/negotiate.mjs            # live run via :4002
 *   node scripts/negotiate.mjs --file run.json           # render a saved result
 *   node scripts/negotiate.mjs --target var_bookend      # the walk-away demo (strategy stops it)
 *   node scripts/negotiate.mjs --target var_relay_8ch    # layer 1 stops it (CATEGORY_BLOCKED)
 *   node scripts/negotiate.mjs --target var_corp_hamper  # layer 2 / a human stops it (semantic)
 *   node scripts/negotiate.mjs --resume <session_id>     # pick a pending (held) run back up
 *
 * While the run is in flight the script watches the firewall's review queue
 * (FIREWALL_REVIEW_TOKEN) and prints a HOLD banner with the exact approve /
 * reject command for the second terminal — the human in the loop.
 *
 * Reads CONTROL_TOKEN (and BUYER_URL_LOCAL, FIREWALL_URL_LOCAL,
 * FIREWALL_REVIEW_TOKEN, FIREWALL_PUBLIC_KEY, SETTLEMENT_PUBLIC_KEY) from
 * .env when not in the environment.
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
const env = loadEnv();

async function obtainRun() {
  const file = flag('--file');
  if (file) return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const token = env.CONTROL_TOKEN;
  if (!token) throw new Error('CONTROL_TOKEN not set (env or .env)');
  const base = (env.BUYER_URL_LOCAL ?? 'http://localhost:4002').replace(/\/$/, '');
  const target = flag('--target');
  const resume = flag('--resume');
  const stop = { done: false };
  watchQueue(stop);
  try {
    // --resume <session_id>: pick a pending run back up (held / awaiting receipt).
    const res = await fetch(resume ? `${base}/control/resume/${resume}` : `${base}/control/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': token },
      body: JSON.stringify(target && !resume ? { target_variant_id: target } : {}),
      // A held run waits VERDICT_POLL_TIMEOUT_MS (2 min) + receipt polling.
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok) throw new Error(`control/run → HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  } finally {
    stop.done = true;
  }
}

const firewallBase = (env.FIREWALL_URL_LOCAL ?? 'http://localhost:4003').replace(/\/$/, '');

/** Best-effort: which model (if any) is judging intent on this firewall. */
async function firewallInfo() {
  try {
    const h = await (await fetch(`${firewallBase}/health`)).json();
    const v = h.intent_verifier;
    return {
      // model ids already carry the provider prefix (D008 pinning: "mistral/…").
      verifier: v === 'not_configured' ? 'not configured (layer 1 only)' : v.model,
      review: h.review,
      timeoutSec: h.escalation_timeout_sec,
    };
  } catch {
    return null;
  }
}

/**
 * Watch the review queue while a run is in flight; print the hold banner
 * once, when the cart appears there. Stops when the run returns.
 */
function watchQueue(stop) {
  const token = env.FIREWALL_REVIEW_TOKEN;
  if (!token) return;
  const seen = new Set();
  const tick = async () => {
    if (stop.done) return;
    try {
      const res = await fetch(`${firewallBase}/review`, { headers: { 'x-review-token': token } });
      if (res.ok) {
        for (const p of (await res.json()).pending) {
          if (seen.has(p.cart_mandate_hash)) continue;
          seen.add(p.cart_mandate_hash);
          const items = p.line_items.map((li) => `${li.category}/${li.variant_id}`).join(', ');
          console.error(
            [
              '',
              '┌' + '─'.repeat(76) + '┐',
              `│ ⏳ HELD FOR A HUMAN — the firewall would not decide alone (times out ${p.expires_at})`,
              `│    cart ${p.cart_mandate_hash}`,
              `│    ${items} → ${rupees(p.total)} under goal "${p.goal}"`,
              `│    reasons: ${p.reasons.length ? p.reasons.join(', ') : '(verifier absent)'}`,
              ...p.details.map((d) => `│    ${d}`),
              '│  In another terminal:',
              `│    node scripts/review.mjs approve ${p.cart_mandate_hash}`,
              `│    node scripts/review.mjs reject  ${p.cart_mandate_hash}`,
              '└' + '─'.repeat(76) + '┘',
            ].join('\n'),
          );
        }
      }
    } catch {
      /* firewall unreachable from here: nothing to show */
    }
    if (!stop.done) setTimeout(tick, 2000).unref();
  };
  setTimeout(tick, 2000).unref();
}

const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const short = (h) => `${String(h).slice(0, 12)}…`;

function render(run, fw) {
  let buyerKey, sellerKey, listPrice, variantId;
  for (const t of run.transcript) {
    const b = t.message.body;
    if (t.message.type === 'session_init') buyerKey = b.buyer_public_key;
    if (t.message.type === 'mandate_register') buyerKey = b.buyer_public_key;
    if (t.message.type === 'session_ack') sellerKey = b.seller_public_key;
  }
  const firewallKey = env.FIREWALL_PUBLIC_KEY || run.keys?.firewall;
  const settlementKey = env.SETTLEMENT_PUBLIC_KEY || run.keys?.settlement;
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
  lines.push(`Mandate: "${run.mandate.goal}"  (ref ${short(run.mandate.intent_mandate_ref)})`);
  lines.push(
    `Budget ceiling ${rupees(run.mandate.budget_ceiling)}  ·  buyer model ${run.models.buyer}${fw ? `  ·  intent-verifier ${fw.verifier}` : ''}`,
  );
  lines.push('═'.repeat(78));

  let ok = 0;
  let bad = 0;
  // Who a buyer message went to: the firewall for the registration and the
  // second cart envelope (the seller copy goes first), the seller otherwise.
  const carts = run.transcript.filter((t) => t.message.type === 'cart_mandate');
  const toFirewall = (m) =>
    m.type === 'mandate_register' ||
    (carts.length === 2 && carts[1].message.message_id === m.message_id);
  const label = {
    seller: '←  SELLER    ',
    firewall: '←  FIREWALL  ',
    settlement: '←  SETTLEMENT',
  };
  for (const { message: m, llm } of run.transcript) {
    const role = m.sender.role;
    const arrow =
      role === 'buyer' ? `BUYER → ${toFirewall(m) ? 'FIREWALL' : 'SELLER  '}` : label[role];
    const key = {
      buyer: buyerKey,
      seller: sellerKey,
      firewall: firewallKey,
      settlement: settlementKey,
    }[role];
    const verified = key ? verifyObject(m, key).ok : false;
    if (verified) ok += 1;
    else bad += 1;
    const sig = verified ? 'sig ✔' : key ? 'sig ✘ INVALID' : 'sig ? (no key)';
    const b = m.body;
    let detail = '';
    switch (m.type) {
      case 'mandate_register':
        detail = `principal-signed mandate, budget ${rupees(b.intent_mandate.budget_ceiling)}, categories [${b.intent_mandate.constraints.categories_allowed}]`;
        break;
      case 'mandate_ack':
        detail = `registered ref ${short(b.intent_mandate_ref)} — firewall pinned the buyer key`;
        break;
      case 'session_init':
        detail = `versions [${b.supported_versions}], mandate ref ${short(b.intent_mandate_ref)}`;
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
      case 'cart_mandate': {
        const li = b.line_items[0];
        detail = `${li.catalog_item.category}/${li.variant_id} @ ${rupees(li.unit_price)} → total ${rupees(b.total)}, hash ${short(b.mandate_hash)}`;
        break;
      }
      case 'firewall_verdict':
        detail = `${b.verdict.toUpperCase()} (layer ${b.layer})${b.reasons.length ? ` — ${b.reasons.join(', ')}` : ''} for cart ${short(b.cart_mandate_hash)}`;
        break;
      case 'settlement_receipt':
        detail = `${b.status.toUpperCase()} — Razorpay order ${b.razorpay_order_id}, ${rupees(b.amount)}, ledger ${short(b.ledger_entry_hash)}`;
        break;
      case 'error':
        detail = `${b.code}: ${b.detail}`;
        break;
      default:
        detail = JSON.stringify(b).slice(0, 60);
    }
    lines.push(
      `${arrow}  seq ${String(m.seq).padStart(2)}  ${m.type.padEnd(18)} ${detail}  [${sig}]`,
    );
    if (b.rationale) lines.push(`             "${b.rationale}"`);
    if (b.verifier_summary) lines.push(`             verifier: "${b.verifier_summary}"`);
    if (llm && !llm.used_llm) lines.push(`             (curve — ${llm.fallback_reason})`);
  }

  lines.push('─'.repeat(78));
  const settled = run.deal?.total;
  const v = run.verdict;
  const who =
    v?.layer === 'human'
      ? v.reasons.includes('ESCALATION_TIMEOUT')
        ? 'nobody answered the review queue in time (auto-block, T10)'
        : v.verdict === 'allow'
          ? 'a HUMAN approved it after the verifier escalated'
          : 'a HUMAN rejected it after the verifier escalated'
      : v?.layer === 'intent_verifier'
        ? 'the intent-verifier (layer 2, semantics)'
        : 'the policy engine (layer 1, numbers)';
  if (run.outcome === 'settled' && listPrice) {
    lines.push(
      `DEAL: list ${rupees(listPrice)} → settled ${rupees(settled)}  —  ${pct(1 - settled / listPrice)} below list, in ${run.rounds} rounds`,
    );
    lines.push(
      `SETTLED: Razorpay order ${run.receipt.razorpay_order_id} (${run.receipt.status}) · verdict ${v.verdict}/${v.layer} — ${who}`,
    );
  } else if (run.outcome === 'settled') {
    // A resumed run has no catalog in its transcript, so no list price to compare.
    lines.push(
      `SETTLED (resumed): Razorpay order ${run.receipt.razorpay_order_id} (${run.receipt.status}) for ${rupees(settled)} · verdict ${v.verdict}/${v.layer} — ${who}`,
    );
  } else if (run.outcome === 'blocked') {
    lines.push(
      `BLOCKED (layer ${v.layer}): ${v.reasons.join(', ')} — ${who}; agreed ${rupees(settled)} never reached settlement`,
    );
    if (v.reasons.includes('VELOCITY_LIMIT')) {
      lines.push(
        '  demo hint: raise FIREWALL_VELOCITY_MAX (or wait for FIREWALL_VELOCITY_WINDOW_SEC) — velocity is per principal',
      );
    }
  } else if (run.outcome === 'pending' && run.reason === 'HELD_IN_REVIEW') {
    lines.push(
      `HELD: the firewall escalated and no human decided within the buyer's window — the cart is still in the queue${fw?.timeoutSec ? ` (auto-blocks ${fw.timeoutSec}s after the hold)` : ''}`,
    );
    lines.push(`  node scripts/review.mjs approve ${run.cart_mandate_hash}   (or reject)`);
  } else if (run.outcome === 'pending') {
    lines.push(
      `PENDING: verdict allow, but no receipt within the polling window (${run.reason}) — check settlement /receipt/${run.cart_mandate_hash}`,
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

const fw = flag('--file') ? null : await firewallInfo();
const run = await obtainRun();
console.log(render(run, fw));
if (flag('--json')) console.log(JSON.stringify(run));
