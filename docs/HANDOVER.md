# HANDOVER.md — Where Things Stand Right Now

Read this FIRST every session. This is a living record of current state, not a
history dump — keep the "Current state" section ruthlessly current and let old
handoff entries scroll down.

---

## Current state (edit in place)

**Phase:** Week 1, Day 3 done (a day early).
**Done:** Docs system; stack decided (D006–D009); repo scaffold — pnpm/TS
monorepo, 4 fastify service stubs with `/health`, Compose all-healthy, CI
workflow, `.env.example`, LICENSE, README skeleton (FEATURE-001).
**In progress:** —
**Broken / unverified:** Replay rejections are not ledger-logged yet (no
ledger until Day 10). `ReplayGuard` is in-memory only until services back
it with SQLite.
**Do not touch / avoid:** `.env` holds real free-tier keys (gitignored) — the
keys were pasted in chat and should be rotated before submission.
`tsconfig.tsbuildinfo` must stay out of the Docker context (see FEATURE-001).
**Next up (ordered):**
1. ~~Repo scaffold + Docker Compose skeleton + CI pipeline~~ ✅ FEATURE-001
2. ~~PROTOCOL.md v0.1 review pass~~ ✅ FEATURE-002 (D010 mandate
   registration, D011 firewall-owned settlement path)
3. ~~Message signing + schema validation library (shared)~~ ✅ FEATURE-003
4. Merchant Commerce Server: catalog + capabilities manifest + policy config
5. Buyer Agent: intent mandate + discovery + strategy engine (no LLM yet)
6. LLM adapter layer + wire LLMs into both agents
7. End-to-end happy path: negotiate → accept → cart mandate
8. Settlement: Razorpay test-mode orders + webhooks + receipt
9. Firewall layer 1 (deterministic), then layer 2 (intent-verifier), then
   escalation queue
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
