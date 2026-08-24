# FEATURE-004 — Merchant Commerce Server (S1, no LLM)

## Scope
- **Goal:** The merchant is a live ACNP counterparty: sessions, catalog with
  real hashes, policy-bounded deterministic negotiation — so Day 5's stubbed
  buyer can negotiate end to end and Day 6's LLM only adds phrasing.
- **In scope:** SQLite storage + demo seed; ACNP boundary pipeline (reusable);
  session lifecycle (init/ack/catalog); deterministic bounds engine and
  seller strategy (counter/accept/reject/walk_away); clock-skew knob.
- **Explicitly out of scope:** LLM adapter wiring (Day 6), bundle_proposal
  generation (cut candidate #4), firewall/settlement handling, ledger
  persistence of events (Day 10 — rejections are logged via pino for now).
- **Flow sections touched (FLOW.md):** F1 steps 2, 4, 5; F5.
- **Architecture sections touched (ARCHITECTURE.md):** S1, S3 (boundary).
- **Risk class:** low (no money path), but the bounds engine carries
  CONSTRAINTS #5 — its adversarial test is the deliverable.
- **Amendments from approval:** sync binding specced first (D013, 39acfc4);
  escalation/receipt polling written into FLOW (772c56a); seed includes a
  non-giftable category and a near-floor variant; CLOCK_SKEW_SEC env knob
  (default 120, compose ships default); boundary module has zero
  merchant-specific imports.

## Plan (approved before implementation)
- Ordered sub-tasks (one commit each):
  1. Storage + seed: catalog/variants/policy/sessions/replay tables,
     SqliteReplayStore, demo seed (8 products incl. "industrial" RAM and a
     near-floor variant).
  2. Boundary + session lifecycle: POST /acnp pipeline
     parse → clock skew → key pin (TOFU) → verify → replay → state check;
     session_init/session_ack, catalog_request/catalog_offer.
  3. Bounds engine + deterministic seller strategy + offer handling.
- New dependencies: better-sqlite3 (runtime), @types/better-sqlite3 (dev) —
  MIT, approved D007.
- How verified: Gate 0; Gate 1 boundary items service-side; Gate 2 clamp
  adversarial + determinism tests. Real output pasted below.

## Work log (append as you go; newest on top)
- 2026-08-24 [Claude Fable 5] — Feature file created after approval with
  amendments; spec + flow commits landed first.

## Verification record
(pending)

## Outcome
- **Status:** in-progress
- **Decisions generated:** D013 (+ any found during build)
- **Follow-ups spawned:** (pending)
- **Plain-language explanation (for the pitch):** (pending)
