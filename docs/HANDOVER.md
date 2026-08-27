# HANDOVER.md — Where Things Stand Right Now

Read this FIRST every session. This is a living record of current state, not a
history dump — keep the "Current state" section ruthlessly current and let old
handoff entries scroll down.

---

## Current state (edit in place)

**Phase:** Week 2, Day 9 done. **Both firewall layers and the human in
the loop, live:** the vase run allowed at `layer intent_verifier`
(Mistral) → real order `order_TUiS4AeOYaEB10`; the corporate hamper
(every layer-1 number passes) blocked by layer 2 with
`INTENT_DRIFT_CATEGORY`; under a real provider failure every cart
escalated and the queue was driven from a second terminal: approve →
`allow/human` seq 2 → real order `order_TUiVCzCWcfN4Fc`; reject →
`HUMAN_REJECTED`; nobody → `ESCALATION_TIMEOUT` at 90 s inside the
buyer's 120 s window. Tag `known-good-2`.
**Done:** Docs system; stack decided (D006–D009); repo scaffold
(FEATURE-001); ACNP spec + protocol library (FEATURE-002/003); merchant
server (FEATURE-004); buyer agent (FEATURE-005, D014); LLM adapter layer
(FEATURE-006, D015/D016); settlement (FEATURE-007, D017/D018); firewall
layer 1 + chain closes (FEATURE-008, D019/D020, BUG-004); firewall layer
2 (narrow-only intent-verifier, `intent.ts` the only LLM import) +
token-gated human queue decided exactly once + timeout sweep + buyer
hold → pending + merchant human-verdict handling + `review.mjs` +
`itm_corp_hamper` (FEATURE-009, D021/D022; spec: human-layer codes).
**In progress:** —
**Broken / unverified:** Verdicts, `escalations`, `verifier_json`,
`settlement_events`, `llm_moves`/clamps are still per-service tables +
pino — the Day 10 ledger absorbs them. A held buyer run whose 120 s
window closes ends `pending` with the hash printed and is NOT resumed
(Day 10 carry-forward, together with failed-dispatch retry and
in-flight settlement resume). `/review` is a bearer token, not operator
identity (stated in `.env.example`; Day 10 dashboard). Mistral never
escalated on its own today (allow vase / block hamper) — the queue was
exercised via a retired model id, i.e. a real provider failure, not a
model "escalate"; the Day 11 evals must measure false-allow / false-block
per provider on the drift fixtures. A prompt-injection trial against the
verifier has not been run live (Day 11/12 candidate). The firewall
cannot prove the seller produced a cart's snapshot (T1, v0.2). Razorpay
order status stays `created` (simulated tap). Gemini 429s → curve
fallbacks (2 today). The Groq seller quoted its floor in rationale twice
more (hardening candidate). The corrupted Gemini buyer writes
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
10. Audit ledger (hash chain) + verification routine
11. Dashboard: policy config, approval queue, session replay
12. Evals harness (50 synthetic negotiations) + metrics report
13. Threat model doc, README polish, demo seed data, pitch video assets

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
