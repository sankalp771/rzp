# FEATURE-010 — The audit ledger (per-service hash chains) + the thin dashboard — feature freeze

## Scope
- **Goal:** Every service keeps a tamper-evident, append-only, hash-chained
  ledger of every message in, every message out, every boundary
  rejection and every decision it made (PROTOCOL.md §11), with a `verify`
  routine that reports the first broken entry; the four chains are
  readable and verifiable from a terminal script and from a thin
  dashboard that also drives the demo (run, approve/reject, policy,
  replay). End of day = **feature freeze**.
- **In scope:** `packages/ledger` (chain, verify, SQLite store, list);
  wiring at the boundary of merchant, buyer, firewall, settlement
  (settlement alone, CONSTRAINTS #16) + domain events; `GET /ledger`,
  `GET /ledger/verify` per service and merchant `GET/PUT /policy`, buyer
  `GET /sessions`, all behind `DASHBOARD_TOKEN`; `dashboard/` Fastify
  server + static page + token-injecting proxy (Run / Queue / Policy /
  Replay / Evals tabs); `scripts/verify-ledgers.mjs`; Compose `:4005`;
  CI health.
- **Explicitly out of scope:** a central ledger service (D023 — per-party
  chains by design); operator identity on the dashboard (one fully
  trusted operator console, THREAT_MODEL non-goal); the evals report
  itself (Day 11 — the tab reads it if present); `bundle_proposal` (cut).
- **Flow sections touched (FLOW.md):** F6 rewritten (real), F5 (rejections
  as entries), F3 (queue/verdict entries), dashboard entry to F1.
- **Architecture sections touched (ARCHITECTURE.md):** S5 ledger, §3
  dashboard.
- **Risk class:** MEDIUM-HIGH — touches every service's boundary and the
  settlement service (own commit); ~1,900 lines on freeze day.
- **Amendments from approval:**
  1. **`scripts/verify-ledgers.mjs` ships in the demo commit** — both
     money shots (cross-party replay, tamper detection) must run from a
     terminal, never only behind the dashboard.
  2. **Honest sentence — one token reads and writes everything:** the
     dashboard is a fully trusted operator console (`DASHBOARD_TOKEN`
     reads all four chains and, via the proxy, approves holds, edits
     policy, starts runs). Real deployment = per-party read tokens.
     Stated in THREAT_MODEL.
  3. **Honest wording — a session view is not a session chain-verify:**
     chains are per service with sessions interleaved, so a filtered
     slice cannot be hash-verified on its own. UI and docs say "whole
     ledger verified ✓ + this session's envelopes match across parties
     ✓", never "this session's chain verified".
  4. **Tamper-demo hygiene:** the out-of-band `UPDATE` runs on a
     throwaway copy of a service DB, never the live volume; `known-good-3`
     is tagged on clean data.
  5. Drop order today: (1) resume a held/pending run, (2) re-dispatch a
     failed settlement request, (3) evals tab stub, (4) the Policy tab.

## Design (approved)
- **Entry:** `{entry_seq, at, entry_type, session_id|null, ref|null,
  payload}`; `entry_hash = sha256(prev_entry_hash ‖ JCS(entry))`,
  genesis prev = 64 zero nibbles (D018 generalised). One chain per
  service (`ledger_entries`), sessions interleaved. `verify()` walks the
  whole chain and reports the first break by `entry_seq` (bad prev, bad
  hash, or sequence gap). The library exports no update/delete; a
  source-search test greps every workspace for `UPDATE|DELETE …
  ledger_entries`.
- **Entry types:** `MESSAGE_IN`, `MESSAGE_OUT`, `BOUNDARY_REJECTED`,
  `HANDLER_REJECTED`, `BOUNDS_CLAMPED`, `LLM_MOVE`, `VERDICT`,
  `ESCALATION_DECIDED`, `VERIFIER_ABSENT`, `ESCALATION_TIMEOUT`,
  `SETTLEMENT_EVENT` (settlement: D018's event verbatim incl. its
  `entry_hash` — absorbed, not re-derived).
- **Cross-party consistency:** the same signed envelope appears in both
  parties' chains; compared by `message_id` → `hashCanonical(envelope)`.
- **Reads:** `DASHBOARD_TOKEN` (header `x-dashboard-token`; unset → 503).
- **Dashboard:** vanilla page + Fastify proxy `/api/:service/*` injecting
  the tokens server-side; no new dependencies.

## Plan (approved before implementation)
1. feat(ledger): `packages/ledger` + Gate 5 tests (verify, tamper at k
   breaks at k, gap detection, no update/delete anywhere).
2. feat(merchant): boundary + events + `/ledger`, `/ledger/verify`,
   `/policy` GET/PUT; HTTP tamper test.
3. feat(buyer): boundary + events + `/ledger`, `/sessions`.
4. feat(firewall): boundary + verdict/escalation/verifier events.
5. feat(settlement): boundary + `SETTLEMENT_EVENT` import entries. Alone.
6. feat(dashboard): server, page, proxy; Compose; CI health;
   `scripts/verify-ledgers.mjs`.
7. feat(buyer): resume (drop candidate #1).
8. docs close, D023/D024, FLOW F6, THREAT_MODEL T6 + non-goal, README;
   tag `known-good-3`; feature freeze in HANDOVER.
- New dependencies: none.
- Verified by: Gate 0; Gate 5 in the library and per service; Gate 6
  compose-healthy incl. dashboard + CI; live: run from the dashboard,
  approve from the Queue tab, replay with four chains verified +
  cross-party match, tamper a DB copy and see the break reported at that
  entry — from `verify-ledgers.mjs` AND the Replay tab.

## Implementation log
1. `5368da3` feat(ledger) — `packages/ledger`: chain, `verify()` naming
   the first break and why, list/head/count; Gate 5 in the library incl.
   re-hash → break at k+1, deletion → gap, "a session slice is not a
   sub-chain", non-JCS payload refused, and the workspace-wide
   no-update/delete source search.
2. `f279504` feat(merchant) — chain at the boundary + clamps, moves,
   states; `/ledger`, `/ledger/verify`, `/sessions`, `GET/PUT /policy`
   behind `DASHBOARD_TOKEN`; HTTP tamper test.
3. `9ef9e87` feat(buyer) — chain on every leg (with `receiver` on each
   outbound envelope); `/ledger`, `/sessions`; E2E: both chains verify and
   every envelope matches across parties by canonical hash (8 out, 6 in).
4. `242f544` feat(firewall) — messages, `VERDICT` (details + verifier
   attribution), `VERIFIER_ABSENT`, decisions/timeouts, states, dispatch
   and notify WITH delivery outcome; the escalate → approve story read
   back from the chain in order.
5. `a42d711` feat(settlement) — `SETTLEMENT_EVENT` absorbs D018's chain
   verbatim inside the same transaction; request in, receipt out;
   operator API. Alone (CONSTRAINTS #16).
6. `577dd6c` feat(dashboard) — console + allowlisted proxy injecting
   tokens server-side; `scripts/verify-ledgers.mjs` (live + `--db`
   offline); Dockerfile `SERVICE_DIR`; Compose `127.0.0.1:4005`; tokens.
7. `99f3c2a` feat(buyer) — resume a pending run (drop candidate #1, built):
   `POST /control/resume/:session_id`, `negotiate.mjs --resume`; deal and
   mandate text reconstructed from the buyer's own ledger. Building it
   surfaced a wiring gap: `mandate_register` bypassed `buildOutbound` and
   was not on the buyer's chain — now recorded, keyed by the mandate ref.
   `df0ddcd` fix(ledger) — opening an existing ledger never writes (an
   auditor opens a read-only copy); `9a8b264` fix(demo) — resumed closing line.
8. docs close (this commit) + live verification below; tag `known-good-3`.

Design notes that surfaced while building:
- The buyer's private `receiver` note and the firewall's `delivery`
  outcome ride inside the recorded envelope payload; cross-party
  comparison strips them before hashing (`verify-ledgers.mjs`) or compares
  signatures (the page).
- A boundary rejection's `session_id` is recorded as `claimed_session_id`
  in the payload with the entry's own `session_id` null — nothing in a
  rejected message was verified.
- The firewall records inbound carts by session only; everything it DID
  about a cart is keyed by the cart hash (`ref`), so a cart's story is
  `GET /ledger?ref=<hash>`.
- pnpm does not hoist: `verify-ledgers.mjs --db` resolves `better-sqlite3`
  through `packages/ledger`'s own `createRequire`.

## Verification record

### Gate 0 (final run at close)
```
$ pnpm lint && pnpm typecheck && npx vitest run
Checking formatting...
All matched files use Prettier code style!
(eslint: clean; tsc --noEmit ×8 workspaces: clean)
 Test Files  33 passed | 1 skipped (34)
      Tests  329 passed | 6 skipped (335)      # skipped = live LLM contract suite without LLM_CONTRACT=1
```

### Gate 5 — ledger changes (all three items, in the library and per service)
1. Chain verification on a fresh multi-event session: `ledger.test.ts`
   "links every entry … verifies end to end"; per service over HTTP
   (merchant `ledger.test.ts`, firewall `app.test.ts` "escalate → approve
   is fully on record", settlement `app.test.ts` "request in → every
   settlement event verbatim → receipt out"); `buyer/e2e.test.ts` "buyer
   and merchant chains verify, and every envelope … same hash (and back)".
2. Tamper at exactly that entry: library (edit k → k; re-hash k → k+1;
   delete k → gap at k+1), merchant HTTP (entry 10), firewall HTTP
   (the `VERIFIER_ABSENT` entry), settlement HTTP (entry 2), and LIVE on a
   copy of the firewall's database (below).
3. No update/delete path anywhere: `ledger.test.ts` "greps every non-test
   source file" (packages, services, dashboard, evals).

### Gate 6 — Compose + CI
`docker compose up -d --build` → five services healthy (merchant, buyer,
firewall, settlement, **dashboard**). CI: see the tag's run.

### Live, 2026-08-28 (Gemini buyer, Groq seller, Mistral firewall, live-test Razorpay)
**Dashboard + proxy.** `GET :4005/health` → `tokens: {dashboard: set,
review: set, control: set}` (values never shown); `GET :4005/` → 200,
23,788 bytes; `GET /api/firewall/health` through the proxy →
`intent_verifier mistral/mistral-small-latest`, `operator_api: enabled`;
`GET /api/merchant/acnp` → **403** (not allowlisted); all four
`/api/<party>/ledger/verify` → `ok` (fresh tables, length 0, genesis head).

**Run 1 — benign, started THROUGH the proxy** (`POST /api/buyer/control/run`,
HTTP 200 in 18.4 s): session `1cb632db…`, `settled` / `SETTLED`,
`layer intent_verifier`, real order `order_TUnHe99ozVTq8h`, 19 messages.
```
$ node scripts/verify-ledgers.mjs
── whole-ledger verification (per party; sessions interleave, so this is the only chain claim) ──
✓ buyer      verified — 27 entries, head 83c7d05b07fd…
✓ merchant   verified — 22 entries, head 20b8d95d810e…
✓ firewall   verified — 8 entries, head f157ac224c87…
✓ settlement verified — 7 entries, head f94bfd0948d4…
── cross-party check for session 1cb632db-cbc7-4846-a971-b82b229efdad ──
✓ this session's envelopes match across parties — 19 matched, 0 recorded by one side only
   buyer      states: INIT → AGREED → COMPLIANCE_REVIEW → SETTLING → SETTLED
   merchant   states: SETTLING → SETTLED
   firewall   states: SETTLING
```

**Tamper demo — on a COPY, never the live volume (amendment #4):**
```
$ docker compose cp firewall:/app/data/firewall.db …/firewall-copy.db   (+ .db-wal, .db-shm: WAL mode)
$ node scripts/verify-ledgers.mjs --db firewall-copy.db
✓ firewall-copy.db: whole ledger verified — 8 entries, head f157ac224c87…
$ node -e "… UPDATE ledger_entries SET payload_json = replace(payload_json, '\"allow\"', '\"block\"') WHERE entry_seq = 5"
entry 5 before: VERDICT {"cart_mandate_hash":"775b38ba…","d…      rows changed: 1
$ node scripts/verify-ledgers.mjs --db firewall-copy.db
✘ firewall-copy.db: CHAIN BROKEN at entry 5 (entry_hash_mismatch) — 4 entries verified before it
   entry 5: VERDICT  at 2026-08-27T12:27:52.612Z
$ curl -H "x-dashboard-token: …" :4003/ledger/verify     → {"ok":true,"length":8,"head":"f157ac224c87…"}   (live untouched)
```
Two findings from the first attempt, both fixed before the record above:
the `Ledger` constructor migrated unconditionally (fails on a read-only
copy → `df0ddcd`), and a WAL-mode copy without its `-wal` file has no
table at all (documented in the script's usage).

**Run 2 — held → human approves in the dashboard → resume** (firewall
temporarily on a retired Mistral model id = verifier absent; buyer
`VERDICT_POLL_TIMEOUT_MS=15000`; `.env` restored afterwards, `/health`
back to `mistral-small-latest`, `escalation_timeout_sec 90`,
`pending_escalations 0`):
```
$ node scripts/negotiate.mjs --target var_corp_hamper
←  FIREWALL    seq  1  firewall_verdict   ESCALATE (layer intent_verifier) for cart 87761494b20b…  [sig ✔]
HELD: the firewall escalated and no human decided within the buyer's window — the cart is still in the queue (auto-blocks 600s after the hold)
  node scripts/review.mjs approve 87761494b20b…   (or reject)
Signatures: 19 verified, 0 invalid  ·  LLM calls 5, fallbacks 4
$ curl -X POST :4005/api/firewall/review/87761494… -d '{"decision":"approve","reviewer":"console","note":"approved from the dashboard queue"}'
proxy approve → approve {"verdict":"allow","layer":"human","reasons":["HUMAN_APPROVED"]}
$ curl :4005/api/buyer/sessions → ec851285-4dc1-4249-91ae-09832183b019 COMPLIANCE_REVIEW escalate
$ node scripts/negotiate.mjs --resume ec851285-4dc1-4249-91ae-09832183b019
THE NEGOTIATOR — session ec851285-4dc1-4249-91ae-09832183b019
Mandate: "Anniversary gift for spouse — something thoughtful under budget"  (ref 6f23cd46fb7e…)   ← from the buyer's ledger
←  FIREWALL    seq  2  firewall_verdict   ALLOW (layer human) — HUMAN_APPROVED for cart 87761494b20b…  [sig ✔]
←  SETTLEMENT  seq  1  settlement_receipt PAID — Razorpay order order_TUnPTn0mEsJkdl, ₹4,344.96, ledger fccef4949d9b…  [sig ✔]
OUTCOME: SETTLED
$ node scripts/verify-ledgers.mjs --session ec851285-4dc1-4249-91ae-09832183b019
✓ buyer 58 · merchant 47 · firewall 22 · settlement 14 entries — all verified
✓ this session's envelopes match across parties — 22 matched, 0 one-sided
   buyer      states: INIT → AGREED → COMPLIANCE_REVIEW → SETTLING → SETTLED
   merchant   states: SETTLING → SETTLED
   firewall   states: COMPLIANCE_REVIEW → SETTLING
```
Gemini 429s again (4 curve fallbacks in run 2).

**Not exercised by me:** clicking the page. The Run / Queue / Replay
calls the page makes were driven through the proxy with curl (run 1 was
started through it, the approval in run 2 went through it, the four
verify calls and the session listing too). The user should open
`http://localhost:4005`, pick session `ec851285…` in Replay & audit, and
read "whole ledger verified ✓" ×4 and "this session's envelopes match
across parties ✓ (22 matched)".

## Outcome
Closed 2026-08-28 by Claude Fable 5. Tag `known-good-3`. **Feature freeze.**
Drop candidates: #1 resume — built; #2 re-dispatch a failed settlement
request — not built (a failed dispatch stays visible on the cart row and
in the ledger; carried into HANDOVER's honest list); #3 evals tab — a
stub that reads `evals/report.json` (Day 11 fills it); #4 Policy tab —
built.

**Plain-language explanation (for the pitch):** Every service in the
system now keeps its own tamper-evident diary. Each entry — a message
received, a message sent, a rejection, a verdict, a human decision, a
state change — is hashed together with the hash of the entry before it,
so changing or removing any old entry breaks every hash after it: rip out
page 40 and page 41 exposes you. There is deliberately no central diary:
a central one would be a party everyone has to trust, and the money path
must never wait on someone else to write things down. Because the same
signed message is recorded by both parties that exchanged it, either
side can prove what was said and neither can quietly rewrite its copy.
One script verifies all four diaries and cross-checks a session; the
dashboard shows the same thing, and is careful to claim only what is
true: the whole diary verifies, and this session's messages match across
parties. Live today: every chain verified, one out-of-band edit of a copy
was caught at exactly that entry, and a held purchase was approved from
the console and resumed to a real order.
