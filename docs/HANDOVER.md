# HANDOVER.md — Where Things Stand Right Now

Read this FIRST every session. This is a living record of current state, not a
history dump — keep the "Current state" section ruthlessly current and let old
handoff entries scroll down.

---

## Current state (edit in place)

**Phase:** Week 2, Day 12 done — **feature freeze holds; the judged
surface is finished.** README rewritten in CLAUDE.md §7 order (problem →
mermaid diagram → quickstart incl. the key-less path → protocol summary
with all 17 types → metrics table untouched → threat table → demo ladder);
`docs/DEMO.md` (storyboard, pre-demo checklist, rehearsal record,
**submission checklist with the key-rotation slot**) and `docs/PITCH.md`
(every component in plain words + fifteen panel questions) exist; secret
scanning is a CI job (`secrets`, gitleaks over full history, D028) with
the one fake fixture allow-listed by fingerprint; `.env.example` now
documents every variable the code reads; PROTOCOL.md reconciled
editorially to the code (D030, its own commit) with the behavioural gaps
listed in BUG-006; THREAT_MODEL citations verified by grep; the T4
injection fixture `var_inject_hamper` is seeded and, against a **Gemini**
verifier, was blocked 3/3 (the demo's **Mistral** run is still owed);
floor leak recorded as v0.2 with its number (D029). Clean clone → green
in 41 s (warm pnpm store); key-less ladder + offline tamper demo
recorded (FEATURE-012). Day 13: the human's list below, then submit
early.
**Done:** Docs system; stack decided (D006–D009); repo scaffold
(FEATURE-001); ACNP spec + protocol library (FEATURE-002/003); merchant
server (FEATURE-004); buyer agent (FEATURE-005, D014); LLM adapter layer
(FEATURE-006, D015/D016); settlement (FEATURE-007, D017/D018); firewall
layer 1 + chain closes (FEATURE-008, D019/D020, BUG-004); firewall layer
2 (narrow-only intent-verifier, `intent.ts` the only LLM import) +
token-gated human queue decided exactly once + timeout sweep + buyer
hold → pending + merchant human-verdict handling + `review.mjs` +
`itm_corp_hamper` (FEATURE-009, D021/D022; spec: human-layer codes);
per-service audit ledgers + operator API + dashboard + verify script +
resume (FEATURE-010, D023/D024); evals harness, two committed 50-session
runs, report + dashboard tab, EVALS/THREAT_MODEL/README reconciled
(FEATURE-011, D025/D026); Day 12 polish (FEATURE-012, D028–D030, BUG-006).
**In progress:** — (feature freeze)
**Broken / unverified:** **Day 12 session ran in a container with no
Docker daemon and no Groq/Mistral egress** — so: (1) the Compose
quickstart was NOT re-run here (CI `compose` job on `main` `fba4567`,
run 33313929552, is the standing proof; the human repeats it on camera
day); (2) the **Mistral injection trial is owed**: `node scripts/negotiate.mjs
--target var_inject_hamper` on the demo line, transcript into
FEATURE-012 / THREAT_MODEL T4 either way; (3) **CI has not run on the
Day 12 commits** — `ci.yml` triggers on `push: main` and PRs only, and
the work is on `claude/fork-repo-plan-timeline-32edzz` — merge (or open a
PR), quote the run id, then cut `known-good-5` on the green sha (D027);
the new `secrets` job runs for the first time then; (4) the Gemini evals
re-run `live-42-gemini` is 6/50 (buyer + verifier on ONE Gemini key →
the verifier was absent under the buyer's rate limit → 4 holds counted as
false blocks) — kept, labelled, not cited, and it is not the demo line
(seller was stub); the README still cites `live-42-mistral`; (5) the
three LLM keys were pasted into a chat on Day 12 — **rotate all three
after the last live run and before submitting** (DEMO.md checklist). Older
items still true: The cited live evals run has a **Mistral buyer**,
not the demo's Gemini buyer — the Gemini key's free quota was exhausted
for the day on every model (run `live-42` stopped at 4/50; kept, D026);
re-run `pnpm evals -- --mode live --n 10 --seed 42 --run-id
live-42-gemini --baseline stub-42 --publish` on a fresh quota day and
cite both. The verifier and the buyer share a model in that run. The
dashboard was clicked for real on Day 12 (headless Chromium via
Playwright, stub stack): all five tabs render; a forced hold (retired
Gemini model id) appeared in Queue, **Approve was clicked in the page**,
the held run resumed to `allow/human` + a receipt, and Replay showed
4/4 ledgers verified with 21/21 envelopes matched; the only console
error is a missing `/favicon.ico` (cosmetic). Not clicked: Start run on
the Run tab (runs were started from the terminal) and Policy → Save. A failed settlement dispatch is
recorded (cart row + ledger `MESSAGE_OUT … delivery: failed`) but there is
no re-dispatch (drop candidate #2, not built); in-flight settlements are
not resumed after a settlement crash. The operator API is ONE token for
every party and the console has no login (THREAT_MODEL non-goal, D024).
A party can truncate its own ledger tail before anyone cited its head
(T6 honest limit; cross-party head anchoring is v0.2). Ledger entries
duplicate full envelopes (size, not correctness). Mistral never
escalated on its own today (allow vase / block hamper) — the queue was
exercised via a retired model id, i.e. a real provider failure, not a
model "escalate"; the Day 11 evals must measure false-allow / false-block
per provider on the drift fixtures. A prompt-injection trial against the
verifier has not been run live (Day 11/12 candidate). The firewall
cannot prove the seller produced a cart's snapshot (T1, v0.2). Razorpay
order status stays `created` (simulated tap). Gemini 429s → curve
fallbacks (2 today). The Groq seller quotes its floor in 13.3% (27/203)
of counter-offer rationales (evals number; hardening candidate: don't
show the seller model its floor, or filter the rationale). The corrupted Gemini buyer writes
"completely unsuitable" in its own rationale and buys anyway — the
buyer's shortlist/strategy have no semantics by design (evals finding).
`bundle_proposal` unhandled (cut candidate). Three LLM keys not rotated
(final-day checklist item).
**Do not touch / avoid:** `.env` holds real keys (gitignored): Razorpay
test keys + webhook secret, demo principal keypair, CONTROL_TOKEN,
long-lived FIREWALL/SETTLEMENT keys — `scripts/gen-keys.mjs` regenerates
the set for a fresh machine. Compose interpolates `$` inside `.env` —
write `$$` for a literal dollar. `tsconfig.tsbuildinfo` must stay out of
the Docker context. Provider model ids retire without notice — run
`LLM_CONTRACT=1 npx vitest run packages/llm/src/contract.test.ts` before
any demo. Velocity is 10 allows/hour per principal: a demo afternoon or
the evals run needs `FIREWALL_VELOCITY_MAX` raised (`.env.example` shows
the override). The merchant seed is additive (`INSERT OR IGNORE`) — new
demo items appear on the next boot without wiping the volume; never
change an existing seed row's price (persisted volumes keep the old one).
Sequence streams are per (session, sender, receiver): a boundary
rejection consumes nothing, the sender retries the same seq (tests use a
`rewind` helper). The buyer sends the seller's cart copy BEFORE the
firewall's — the firewall notifies the seller inside its own handler.
`.env` now also holds `FIREWALL_REVIEW_TOKEN`, `FIREWALL_LLM_PROVIDER=
mistral` and a demo `FIREWALL_ESCALATION_TIMEOUT_SEC=90` (< the buyer's
`VERDICT_POLL_TIMEOUT_MS` 120 s, so a timeout is visible to the buyer;
production default is 600 s). Latency: `30 s > 8 (verifier) + 8
(dispatch) + 5 (notify)`. The hamper is listed ₹100 under the vase on
purpose (shortlist tie-break) — do not "round it up". To demo the queue
without waiting for a model to escalate, point `MISTRAL_MODEL` at a
retired id and recreate the firewall (every cart then escalates);
restore it afterwards. In tests, a fake-clock jump must wait until the
buyer holds the escalate verdict (else `CLOCK_SKEW`), and the buyer's
test sleep must yield a macrotask so a concurrent "human" runs.
**Next up (ordered):**
1. ~~Repo scaffold + Docker Compose skeleton + CI pipeline~~ ✅ FEATURE-001
2. ~~PROTOCOL.md v0.1 review pass~~ ✅ FEATURE-002 (D010 mandate
   registration, D011 firewall-owned settlement path)
3. ~~Message signing + schema validation library (shared)~~ ✅ FEATURE-003
4. ~~Merchant Commerce Server~~ ✅ FEATURE-004 (catalog, policy, bounds
   engine, deterministic seller strategy, ACNP boundary)
5. ~~Buyer Agent~~ ✅ FEATURE-005 (mandate boot gate, shortlist + hash
   verification, buyer strategy + clamp, runner, control plane; first
   E2E negotiation green)
6. ~~LLM adapter layer + wire LLMs into both agents~~ ✅ FEATURE-006
   (three providers live, advisory-with-fallback, chaos E2E)
7. ~~End-to-end happy path: negotiate → accept → cart mandate → verdict →
   receipt~~ ✅ FEATURE-008 (live; tag `known-good-1`)
8. ~~Settlement: Razorpay test-mode orders + webhooks + receipt~~ ✅
   FEATURE-007 (live against Razorpay test mode)
9. ~~Firewall layer 1 (deterministic)~~ ✅ FEATURE-008 (D019/D020);
   ~~layer 2 (intent-verifier) + escalation queue~~ ✅ FEATURE-009
   (D021/D022; live approve/reject/timeout; tag `known-good-2`)
10. ~~Audit ledger (hash chain) + verification routine~~ ✅ FEATURE-010
    (D023; `verify-ledgers.mjs`; tag `known-good-3`)
11. ~~Dashboard: policy config, approval queue, session replay~~ ✅
    FEATURE-010 (D024; `:4005`, localhost only)
12. ~~Evals harness (50 synthetic negotiations) + metrics report~~ ✅
    FEATURE-011 (D025/D026; tag `known-good-4`)
13. ~~Threat model reconciled, README polish, demo kit~~ ✅ FEATURE-012
    (D028–D030, BUG-006)
14. **Day 13 (human):** Mistral injection trial → Compose rehearsal from
    the tag → video (DEMO.md) → merge/PR so CI runs → `known-good-5` →
    rotate keys → submit early (DEMO.md checklist). Only if slack: the
    Gemini re-run on the real demo line (`live-42-gemini` resumes by id
    on a fresh quota day, seller=groq, verifier=mistral).

**Key dates:** Submission closes 5 Sept 2026. Feature freeze target: 2 Sept.
Video + README polish: 3–4 Sept.

---

## Handoff log (append one entry per session, newest on top)

Format — exactly five lines plus header:

### YYYY-MM-DD HH:MM — [model name/version]
- Did: <what was completed this session>
- Left: <what remains on the active task>
- Watch out: <traps, fragile areas, assumptions made>
- Tests: <which checklist items ran; pass/fail>
- Decisions: <"none" or pointer to DECISIONS.md entries added>

<!-- entries begin below -->

### 2026-09-04 17:00 — [Claude Fable 5.1 (claude-fable-5-1)]
- Did: FEATURE-012 Day 12 polish — README rewrite (diagram, key-less
  quickstart, protocol summary, threat table, demo ladder); gitleaks CI
  job + `.gitleaksignore` + `.env.example` gaps (D028); clean-clone timed
  + key-less ladder + offline tamper; spec/threat-model/code audit →
  BUG-006, PROTOCOL.md editorial reconciliation alone (D030), THREAT_MODEL
  citations fixed; `var_inject_hamper` seeded (+ db.test 11) and blocked
  3/3 by a live Gemini verifier; D029 floor leak documented; DEMO.md +
  PITCH.md incl. the submission checklist with the key-rotation slot;
  `live-42-gemini` 6/50 kept, not cited.
- Left: the human's Day 13 list (Next up #14). No feature work.
- Watch out: this session had no Docker and no Groq/Mistral egress — read
  FEATURE-012 "Environment note" before trusting any live claim; CI has
  not run on this branch; the keys pasted on Day 12 must be rotated;
  `live-42-gemini` shows what a shared quota does to the verifier (keep
  three providers on three roles for the video).
- Tests: Gate 0 green on the final tree (lint clean, typecheck Done,
  348 passed / 6 skipped); Gate 8 items 1–4 recorded in FEATURE-012 with
  the container caveats; CI: pending merge/PR.
- Decisions: D028, D029, D030.

### 2026-08-29 23:00 — [Claude Fable 5 (claude-fable-5)]
- Did: BUG-005 — CI run `33258233847` on `5d3c686` was red at
  `pnpm build` (twelve `TS2307 @negotiator/ledger` from the evals
  typecheck of service source): evals never declared its
  `@negotiator/ledger` workspace dep, so on a clean clone pnpm built
  evals and ledger in the same tier and ledger's `dist/` did not exist
  yet; local machines passed on stale `dist/`. Reproduced by scrubbing
  every `dist/`; fixed by declaring the dep (one manifest line + lock);
  re-ran CI's exact sequence from a scrubbed tree. D027: `known-good-4`
  moved onto the fix commit. Gate 0 gained two checklist lines.
- Left: unchanged from 21:30 — Gemini-buyer live run on a fresh quota
  day; Day 12 README diagram + protocol summary, video, prompt-injection
  trial, floor-leak hardening decision.
- Watch out: a local green build proves nothing about build ORDER unless
  `dist/` was scrubbed first; any future package that typechecks another
  package's source must declare every dep that source imports. The
  Day 11 close was pushed without waiting for CI — that is now a Gate 0
  line.
- Tests: scrubbed-tree `pnpm install --frozen-lockfile`, `build`, `lint`,
  `typecheck` all exit 0; `pnpm test` 348 passed / 6 skipped (34 files
  + 1 skipped). CI on the fix commit `51fd5d2`: run `33260024384`,
  `test: success`, `compose: success`; `known-good-4` re-pointed there.
- Decisions: D027.

### 2026-08-29 21:30 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-011 — `evals/` harness (five scenarios on a seed, one
  fresh in-process stack per session, ground truth by scenario, layer
  attribution, per-session curve oracle from the services' own curve
  functions, JSONL resume, pacing + rate-limit/outage stop, floor-leak
  detector, provider stats, curve-vs-LLM comparison with baseline,
  provenance notes, `--report-only`); test-kit seams `buyerTuning` /
  `merchantPolicy` + buyer `AppOptions.tuning`; dashboard Evals tab +
  Compose mount; runs `stub-42` (50/50) and `live-42-mistral` (50/50)
  published to `evals/report.json`; README metrics table; EVALS.md
  rewritten; THREAT_MODEL T3/T4/T7/T8/T9 filled; FLOW F7; D025, D026.
- Left: Gemini-buyer live run on a fresh quota day (`--run-id
  live-42-gemini`); Day 12: README architecture diagram + protocol
  summary, video, prompt-injection trial, floor-leak hardening decision.
- Watch out: `TaskStop`/killing the `pnpm` wrapper does NOT kill the
  `tsx` child — two aborted runs kept executing in the background and
  appended sessions until found (truncated back; kill `node …cli.ts`
  explicitly). A bare re-run of a truncated run id RESUMES it (executes
  the missing sessions) — use `--report-only` to re-render. Gemini's
  free quota exhausts on the key, not the model. In PowerShell quote
  `--scenarios "a,b"`. Under Compose the dashboard reads
  `/app/evals/report.json` via a read-only bind mount.
- Tests: Gate 0 green (lint, typecheck, 347 + evals 20 + dashboard 4);
  Gate 7 all three items (artifacts committed; README copied from the
  artifact); stub run asserted against the closed-form curves.
- Decisions: D025, D026.

### 2026-08-29 17:30 — [Claude Fable 5 (claude-fable-5)]
- Did: Demo re-verification on a cold machine (Docker Desktop was down;
  images predated commits df0ddcd/9a8b264 → `pnpm build` +
  `docker compose up -d --build`, five healthy). Live: benign run SETTLED
  on real order `order_TVZU3KYZGkM1ZI` (14/14 sigs, 0 fallbacks);
  `var_relay_8ch` BLOCKED by layer 1 (CATEGORY_BLOCKED, 17/17 sigs);
  `var_corp_hamper` BLOCKED by layer 2 (INTENT_DRIFT_CATEGORY, Mistral,
  17/17 sigs); four chains verified (buyer 79 / merchant 62 / firewall 30
  / settlement 21 entries) with 14 + 16 + 16 envelopes matched
  cross-party; firewall DB copy verified offline (44 entries) then entry
  5 corrupted → `CHAIN BROKEN at entry 5 (entry_hash_mismatch)`;
  dashboard serves HTTP 200. No code changed.
- Left: Day 11 evals harness as listed in the 2026-08-28 entry.
- Watch out: containers auto-restart with Docker Desktop but images do
  NOT track HEAD — check `docker image inspect … --format '{{.Created}}'`
  against `git log -1 --format=%ci` before any demo. `verify-ledgers.mjs
  --db` exits 1 on a broken chain by design (a shell will show "error").
  Mistral again blocked the hamper outright — the human queue still has
  no organic escalation on record.
- Tests: LLM contract suite 6/6 live (gemini-2.5-flash, gpt-oss-120b,
  mistral-small-latest); Gate 5 tamper on a copy; Gate 6 compose five
  healthy; three live E2E transcripts read top to bottom.
- Decisions: none.

### 2026-08-28 20:00 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-010 — `packages/ledger` (chain, verify naming the first
  break, no update/delete anywhere by source search); every service
  records messages in/out, rejections, decisions and states on its own
  chain; settlement absorbs its money chain verbatim; operator API behind
  `DASHBOARD_TOKEN`; dashboard `:4005` (run / queue / replay & audit /
  policy / evals) with a token-injecting allowlisted proxy;
  `verify-ledgers.mjs` (live + `--db` offline); resume a pending run.
  Live: four chains verified, 19/19 and 22/22 envelopes matched across
  parties, tamper on a copy caught at entry 5, hold approved through the
  proxy and resumed to a real order. D023, D024. Tag `known-good-3`.
  **Feature freeze.**
- Left: nothing on FEATURE-010. Day 11: evals harness (50 sessions,
  stub + live subsets; raise `FIREWALL_VELOCITY_MAX`; measure deal-close
  rate, discount conceded, firewall catch rate, false-block AND
  false-allow per provider on the drift fixtures, 429 fallbacks,
  rationale floor leaks), `evals/report.json` (the dashboard tab reads
  it), THREAT_MODEL tests reconciled, Gate 7.
- Watch out: SQLite runs in WAL mode — an offline DB copy needs the
  `-wal` file; the `Ledger` constructor must never write (auditors open
  read-only); the buyer's `receiver` and the firewall's `delivery` ride
  inside recorded envelopes and must be stripped before hashing across
  parties; `mandate_register` is built outside `buildOutbound` (recorded
  explicitly, keyed by mandate ref); the dashboard is published on
  127.0.0.1 only — keep it that way; `.env` was restored after the demo
  (`FIREWALL_ESCALATION_TIMEOUT_SEC=90`, real Mistral model).
- Tests: Gate 0 green (329/329 + 6 skipped live-contract; lint + typecheck clean); Gate 5 all three items in the
  library and per service + live on a copy; Gate 6 compose five healthy;
  Gate 3/4 unchanged and green; the E2E cross-party proof.
- Decisions: D023, D024.

### 2026-08-27 13:30 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-009 — spec (§7.9 narrow-only rule, human-layer codes,
  decided-exactly-once, held ⇒ pending); `intent.ts` verifier (fenced,
  strict JSON, absent on any failure) + applier table; `escalations` +
  `/review` behind a token, `decide()` atomic first-decision-wins with a
  layer-1 re-check on approve, lazy + timer timeout sweep; merchant
  human-verdict leg; buyer hold → pending + `VERDICT_POLL_TIMEOUT_MS`;
  `itm_corp_hamper`; `review.mjs` + hold banner. Live: Mistral allowed
  the vase (real order) and blocked the hamper on semantics; approve /
  reject / timeout driven from a second terminal under a real provider
  failure. D021, D022. Tag `known-good-2`.
- Left: nothing on FEATURE-009. Day 10: hash-chained ledger absorbing
  verdicts / escalations / settlement events / clamps + verify routine;
  dashboard (policy, approval queue over `/review`, replay); resume a
  held or pending run; feature freeze.
- Watch out: `FIREWALL_ESCALATION_TIMEOUT_SEC=90` in `.env` is a demo
  value; the hamper's ₹4,700 list is deliberate (shortlist tie-break);
  Groq keeps quoting its floor; the corrupted buyer buys what it calls
  unsuitable — that is the demo, not a bug; a stack test that jumps the
  clock must wait until the buyer holds the escalate verdict.
- Tests: Gate 0 green (307/307 + 6 skipped live-contract; lint + typecheck clean); Gate 1 spec ↔ code; Gate 3 all
  five items (semantic form); Gate 6 escalate scenarios in the E2E;
  Compose live: six runs, two real Razorpay orders, every signature ✔.
- Decisions: D021, D022.

### 2026-08-26 19:30 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-008 — spec (cart `catalog_item`, per-receiver seq streams,
  one-mandate-one-purchase incl. pending escalate); boundary resolver
  codes; firewall storage + layer-1 policy + applier with explicit
  `not_configured` layer-2 slot; `/acnp` register/audit with settlement
  dispatch and seller notification inside the verdict (dispatch failure
  → allow stands, `pending`); merchant cart-copy/verdict/receipt legs;
  buyer register→cart→verdict→receipt; four-service E2E; demo transcript;
  BUG-004 fixed; `itm_relay` + additive seeding. Live: SETTLED with a real
  order, and BLOCKED/CATEGORY_BLOCKED, both read top to bottom.
- Left: nothing on FEATURE-008. Day 9: layer 2 into the applier slot
  (absence → escalate), escalation queue + `/verdict` poll live, semantic
  flagship; Gate 3 items 2 (semantic) and 4.
- Watch out: velocity 10/hour per principal (raise for demos/evals); the
  seller model repeats its floor in rationale (hardening candidate);
  Gemini 429s → curve fallbacks; the RAM kit walks away, the relay blocks
  — pick the right target for the demo; commits 5/6 were reordered
  (merchant before buyer) so the E2E has a merchant that accepts carts.
- Tests: Gate 0 green (267/267 + 6 skipped); Gate 1 spec drift; Gate 3
  items 1, 3, 5 + item 2 in layer-1 form; Gate 6 four-service E2E;
  Compose live in live-test mode (settled + blocked transcripts).
- Decisions: D019, D020.

### 2026-08-26 15:30 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-007 settlement — spec fix §7.10 (buyer_public_key attested
  by the firewall, shipped alone); storage + append-only hash chain;
  Razorpay client live-test/simulated with the CONSTRAINTS #2 boot rule;
  firewall-only /acnp with the full §7.10 chain; lookup-by-receipt before
  create; bounded retry; webhook HMAC over the raw body; signed receipts +
  pending; payment simulation + Orders-API poll flags. Live Gate 4: real
  order order_TULvJMWlrc12qi, receipt sig ✔, idempotent repeat.
- Left: nothing on FEATURE-007. Day 8: firewall layer 1 + verdict
  applier; buyer builds/sends cart_mandate + mandate_register; firewall
  sends settlement_request (with buyer_public_key); agents poll /receipt;
  tag known-good #1. LLM keys: user still to rotate.
- Watch out: Compose interpolates `$` in .env (`$$` for literal); the
  settlement replay guard starts each session at seq 1 for the firewall
  (the verdict message is not addressed to settlement); Razorpay's order
  status stays `created` under simulation — say so on video; Day 11 evals
  must compare LLM-advised vs pure-curve economics per model before any
  buyer strategy guard is considered.
- Tests: Gate 0 green (221/221 + 6 skipped live-LLM); Gate 4 all five
  items over HTTP + live against Razorpay test mode; Gate 5-style chain
  tamper test + no-update/delete grep; Compose all healthy in live-test.
- Decisions: D017, D018.

### 2026-08-25 04:30 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-006 — @negotiator/llm (Gemini + OpenAI-compat adapters via
  raw fetch, budgeted retries, strict-JSON proposals, env factory with
  refuse-to-boot rule); both agents wired through the existing clamp
  seams; per-round llm_moves; chaos E2E; scripts/negotiate.mjs. Live
  Gemini-vs-Groq run over Compose: 460000 in 4 rounds, 12/12 sigs.
- Left: nothing on FEATURE-006. Day 7 next: settlement (Razorpay test
  mode). Keys still NOT rotated — user must do it in the consoles.
- Watch out: provider model ids retire silently (run the contract suite
  before demos); Gemini 2.5 needs thinkingBudget 0 for short JSON tasks;
  Groq gpt-oss 400s in json mode under tiny max_tokens; the LLM buyer
  concedes faster than the curve — an evals finding, not a bug; the
  firewall (Day 9) must not inherit D015's fallback-to-proceed policy.
- Tests: Gate 0 green (185/185 + 6 live contract); Gate 2 chaos E2E +
  clamp adversarial both sides; Compose healthy with real providers.
- Decisions: D015, D016.

### 2026-08-25 02:00 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-005 buyer agent — boundary moved to @negotiator/protocol;
  mandate boot gate + demo seed (loudly labeled); deterministic strategy
  with reservation clamp; shortlist verifying catalog hashes; runner over
  the sync binding; token-gated /control/run; first E2E (deal closes at
  ask(4)=417276 round 4; bookend walk-away; tamper/replay rejected).
- Left: nothing on FEATURE-005. Day 6 next: LLM adapters feeding the
  proposedPrices seams in decideBuyer/decideSeller.
- Watch out: every buyer session has mandate_registered=0 until Day 8
  delivers mandate_register; Message<union> is not a discriminated union
  (cast body per branch); e2e.test.ts asserts from curve formulas — retune
  either default curve and the guard test tells you before the E2E lies.
- Tests: Gate 0 green (151/151); Gate 1 buyer-side incl. tamper+replay
  over E2E; Gate 2 clamp adversarial + determinism + walk-away; Compose
  all healthy with a live 13-message signed run (transcript in
  FEATURE-005).
- Decisions: D014.

### 2026-08-24 13:00 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-004 merchant server — SQLite storage+seed, reusable ACNP
  boundary, session lifecycle, deterministic strategy with bounds clamp.
  Spec: D013 sync transport binding, 204 rule, seq-consumption rule.
- Left: boundary.ts moves to a shared package on Day 5; cart_mandate copy
  handling waits for the firewall.
- Watch out: catalog attributes must be JCS-safe (integers only — the float
  ban bit our own seed); Docker runtime needs data/ chowned before USER
  node; authenticated-but-rejected messages MUST consume seq (§6).
- Tests: Gate 0 green (115/115); Gate 1 boundary items over HTTP; Gate 2
  clamp adversarial + determinism; Compose all healthy.
- Decisions: D013.

### 2026-08-23 16:00 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-003 `packages/protocol` — JCS canonicalizer, SHA-256, Ed25519
  via node:crypto (D012), zod schemas for all 17 types + Intent Mandate,
  parseMessage with §10 codes, ReplayGuard, 19 committed JSON Schemas,
  shared fixtures export. Fixed BUG-002. Spec tables aligned (526fe18).
- Left: nothing on FEATURE-003.
- Watch out: `canonicalize` must stay a hand-written emitter — do not
  "simplify" back to sort+JSON.stringify (BUG-002). Run `pnpm --filter
  @negotiator/protocol schemas` after any zod change or the drift test fails.
- Tests: Gate 0 green; Gate 1 items 1, 2, 4 pass; item 3 pass except
  ledger-logging (no ledger yet). 84/84 tests.
- Decisions: D012.

### 2026-08-23 14:30 — [Claude Fable 5 (claude-fable-5)]
- Did: FEATURE-002 PROTOCOL.md review — added `mandate_register`/`mandate_ack`,
  principal-signed mandate, firewall→settlement path, TOFU bootstrap rule,
  hash/encoding conventions, full state table, error catalogue; aligned
  FLOW/ARCHITECTURE/THREAT_MODEL to spec names.
- Left: nothing on FEATURE-002.
- Watch out: the firewall now holds per-session state BEFORE `session_init`
  (keyed by `intent_mandate_ref`); settlement must reject any caller but the
  firewall key — both are Day 3/8 implementation obligations.
- Tests: Gate 0 lint pass; docs cross-check table in FEATURE-002.
- Decisions: D010, D011.

### 2026-08-23 13:45 — [Claude Fable 5 (claude-fable-5)]
- Did: Flattened docs bundle to root; recorded D006–D009; built FEATURE-001
  scaffold (workspace, 2 libs, 4 services, Dockerfile+Compose, CI, env
  example, LICENSE, README); fixed BUG-001.
- Left: Nothing on FEATURE-001 except seeing CI go green on first push.
- Watch out: Docker context must exclude `*.tsbuildinfo` or images ship
  without `dist/`; Compose healthchecks must use `CMD-SHELL` for `$PORT`.
- Tests: Gate 0 lint/typecheck/test pass (8/8 ×3); Gate 6 compose-healthy
  pass; CI run 32627953190 green (test + compose).
- Decisions: D006 (TS monorepo), D007 (SQLite), D008 (Gemini/Groq/Mistral),
  D009 (docs layout).
