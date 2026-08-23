# BUILD_PLAN.md — Two Weeks to Submission

Deadline: applications close **5 September 2026**. Feature freeze **2 Sept**.
Days 3–4 Sept are for README, evals re-run, video, and rehearsal — protected;
no feature work there.

Each day's target maps to HANDOVER.md "Next up" items and gets its own
FEATURE file. If a day slips by more than one day cumulative, invoke the cut
order (CLAUDE.md §6) immediately — do not "catch up later".

## Week 1 — protocol + agents + settlement happy path

- **Day 1 (Aug 24):** Repo scaffold, Docker Compose skeleton, CI with one
  passing placeholder test, .env.example, LICENSE, seed-data plan.
- **Day 2 (Aug 25):** PROTOCOL.md v0.1 — all message types, field tables,
  state machine, error codes, versioning + signature scheme. Spec before code.
- **Day 3 (Aug 26):** Shared protocol library: schemas, canonical
  serialization, Ed25519 sign/verify, replay guard. Gate 1 green.
- **Day 4 (Aug 27):** Merchant Commerce Server: catalog, capabilities
  manifest, policy config storage, deterministic bounds engine (no LLM yet).
- **Day 5 (Aug 28):** Buyer Agent: intent mandate, discovery, deterministic
  strategy engine (reservation price, concession curve, walk-away). Stubbed
  negotiation runs end to end. Gate 2 green.
- **Day 6 (Aug 29):** LLM adapter layer + wire both agents to real free-tier
  models; record model-per-side in sessions.
- **Day 7 (Aug 30):** Settlement service: Razorpay test-mode orders,
  idempotency, webhook verification, receipt message. F1 happy path fully
  green including Gate 4. Tag `known-good` #1.

## Week 2 — firewall, ledger, dashboard, evals, polish

- **Day 8 (Aug 31):** Firewall layer 1 (deterministic rules) + verdict
  applier. Block path (F3) demoable.
- **Day 9 (Sep 1):** Firewall layer 2 (intent-verifier) + escalation queue +
  corrupted-goal flagship scenario. Gate 3 green. Tag `known-good` #2.
- **Day 10 (Sep 2):** Hash-chained ledger + chain verification + session
  replay data model. Dashboard: policy config + approval queue + replay view
  (function over polish). **Feature freeze at end of day.** Gate 5/6 green.
- **Day 11 (Sep 3):** Evals harness, 50-session run, metrics report artifact,
  dashboard evals page. THREAT_MODEL.md mitigations + tests reconciled.
  Gate 7 green.
- **Day 12 (Sep 4):** README (problem → diagram → one-command quickstart →
  protocol summary → metrics table → threat model), clean-machine test,
  history/secret scan, transcript+audit-trail money-shot screen final pass.
  Record the 5-minute video: 30s problem → 90s live happy-path demo → 60s
  firewall catching the rogue agent → 60s architecture → 30s metrics table.
  Rehearse the panel explanation of every component in plain words.
- **Day 13 (Sep 5):** Buffer + submit EARLY in the day. Gate 8 fully green
  before the form is touched.

## Cut order (mirror of CLAUDE.md §6 — first to go → last)
1. Tracing / replay UI polish
2. Dashboard visual polish
3. Refund path
4. Bundle-proposal message type
5. HARD FLOOR — never cut: protocol spec, signatures, both firewall layers,
   settlement happy path, integration tests, honest evals, PROTOCOL.md,
   README, threat model.

## Standing risks to watch
- Canonical-serialization/signature mismatch bugs (Day 3) — timebox one day,
  fallback per DECISIONS.md D004.
- Free-tier LLM rate limits during the 50-session eval run — add pacing and
  a resumable harness from the start.
- Demo legibility — the transcript/audit-trail screen is a deliverable, not
  polish; it survives every cut except the top two.
