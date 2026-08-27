#!/usr/bin/env node
/**
 * Audit from the terminal (FEATURE-010 amendment #1 — the money shot must
 * never depend on the dashboard):
 *
 *   node scripts/verify-ledgers.mjs                 # verify all four live ledgers; cross-check the latest session
 *   node scripts/verify-ledgers.mjs --session <id>  # cross-check that session
 *   node scripts/verify-ledgers.mjs --db path.db    # verify a COPY of a service database offline
 *
 * Whole-ledger verification per party (a session slice is never a chain of
 * its own) + cross-party check: every signed envelope one party sent that
 * another party recorded receiving must hash to the same canonical form.
 * Reads DASHBOARD_TOKEN and *_URL_LOCAL from .env when not in the environment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { hashCanonical } = await import(
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
const short = (h) => `${String(h).slice(0, 12)}…`;
const OK = '✓';
const BAD = '✘';

// --- offline: a copied database file ---------------------------------------
const dbPath = flag('--db');
if (dbPath) {
  // better-sqlite3 is a dependency of the ledger package, not of the repo root
  // (pnpm does not hoist): resolve it from there.
  const Database = createRequire(new URL('../packages/ledger/package.json', import.meta.url))(
    'better-sqlite3',
  );
  const { Ledger } = await import(
    new URL('../packages/ledger/dist/index.js', import.meta.url).href
  );
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const ledger = new Ledger(db);
  const v = ledger.verify();
  console.log(
    v.ok
      ? `${OK} ${dbPath}: whole ledger verified — ${v.length} entries, head ${short(v.head)}`
      : `${BAD} ${dbPath}: CHAIN BROKEN at entry ${v.break_at_seq} (${v.reason}) — ${v.length} entries verified before it`,
  );
  if (!v.ok) {
    const bad = ledger.list({ after: v.break_at_seq - 1, limit: 1 })[0];
    if (bad)
      console.log(
        `   entry ${bad.entry_seq}: ${bad.entry_type} ${bad.payload.type ?? ''} at ${bad.at}`,
      );
  }
  process.exit(v.ok ? 0 : 1);
}

// --- live: the four parties --------------------------------------------------
const token = env.DASHBOARD_TOKEN;
if (!token) {
  console.error('DASHBOARD_TOKEN not set (env or .env) — the operator API is disabled without it');
  process.exit(2);
}
const urls = {
  buyer: env.BUYER_URL_LOCAL ?? 'http://localhost:4002',
  merchant: env.MERCHANT_URL_LOCAL ?? 'http://localhost:4001',
  firewall: env.FIREWALL_URL_LOCAL ?? 'http://localhost:4003',
  settlement: env.SETTLEMENT_URL_LOCAL ?? 'http://localhost:4004',
};
const headers = { 'x-dashboard-token': token };
async function get(party, path) {
  const res = await fetch(`${urls[party].replace(/\/$/, '')}${path}`, { headers });
  if (!res.ok) throw new Error(`${party} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

let allOk = true;
console.log(
  '── whole-ledger verification (per party; sessions interleave, so this is the only chain claim) ──',
);
for (const party of Object.keys(urls)) {
  try {
    const v = await get(party, '/ledger/verify');
    if (v.ok)
      console.log(
        `${OK} ${party.padEnd(10)} verified — ${v.length} entries, head ${short(v.head)}`,
      );
    else {
      allOk = false;
      console.log(
        `${BAD} ${party.padEnd(10)} CHAIN BROKEN at entry ${v.break_at_seq} (${v.reason}) — ${v.length} entries verified before it`,
      );
    }
  } catch (err) {
    allOk = false;
    console.log(`${BAD} ${party.padEnd(10)} ${err.message}`);
  }
}

let session = flag('--session');
if (!session) {
  const { sessions } = await get('buyer', '/sessions');
  session = sessions[0]?.session_id;
}
if (!session) {
  console.log('no session to cross-check yet');
  process.exit(allOk ? 0 : 1);
}
console.log(`\n── cross-party check for session ${session} ──`);
const ledgers = {};
for (const party of Object.keys(urls)) {
  ledgers[party] = (await get(party, `/ledger?session_id=${session}&limit=5000`)).entries;
}
const strip = (p) => {
  const { receiver: _r, delivery: _d, ...m } = p;
  return m;
};
const ins = new Map();
for (const [party, entries] of Object.entries(ledgers)) {
  for (const e of entries)
    if (e.entry_type === 'MESSAGE_IN')
      ins.set(e.payload.message_id, { party, hash: hashCanonical(strip(e.payload)) });
}
let matched = 0;
let mismatched = 0;
let unpaired = 0;
for (const [party, entries] of Object.entries(ledgers)) {
  for (const e of entries) {
    if (e.entry_type !== 'MESSAGE_OUT') continue;
    const sent = hashCanonical(strip(e.payload));
    const got = ins.get(e.payload.message_id);
    if (!got) {
      unpaired += 1;
      continue;
    }
    if (got.hash === sent) matched += 1;
    else {
      mismatched += 1;
      allOk = false;
      console.log(
        `${BAD} ${e.payload.type} ${short(e.payload.message_id)}: ${party} sent ${short(sent)} but ${got.party} recorded ${short(got.hash)}`,
      );
    }
  }
}
console.log(
  mismatched === 0
    ? `${OK} this session's envelopes match across parties — ${matched} matched, ${unpaired} recorded by one side only (e.g. a receipt nobody polled)`
    : `${BAD} DIVERGENCE: ${mismatched} envelope(s) differ between parties (${matched} matched)`,
);
for (const party of Object.keys(urls)) {
  const states = ledgers[party]
    .filter((e) => e.entry_type === 'SESSION_STATE')
    .map((e) => e.payload.state);
  if (states.length) console.log(`   ${party.padEnd(10)} states: ${states.join(' → ')}`);
}
process.exit(allOk ? 0 : 1);
