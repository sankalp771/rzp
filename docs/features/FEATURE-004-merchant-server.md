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
- 2026-08-24 [Claude Fable 5] — All three sub-tasks landed (f2dfbf7,
  236316c, 51f4fbc) plus two spec amendments discovered while building:
  HTTP 204 for no-reply exchanges (45efd98) and the sequence-consumption
  rule (fc2e9e1) — a TOTAL_MISMATCH otherwise wedged the session in
  SEQUENCE_GAP. Two bugs our own invariants caught: the seed had a float
  attribute (weight_kg 2.8) that the canonicalizer refused to hash — the
  float ban working as designed; and the Docker runtime user could not
  mkdir data/ (EACCES) — fixed with chown before the privilege drop +
  merchant volume.
- 2026-08-24 [Claude Fable 5] — Feature file created after approval with
  amendments; spec + flow commits landed first.

## Verification record
Gate 0:
```
$ pnpm lint      → All matched files use Prettier code style! (eslint clean)
$ pnpm typecheck → 8 × Done, 0 errors
$ npx vitest run → Tests  115 passed (115)
```
Gate 1 (service-side boundary, boundary.test.ts + app.test.ts over HTTP):
```
✓ accepts a valid signed message and commits only when asked
✓ schema-invalid input → SCHEMA_INVALID
✓ tampered payload → SIG_INVALID
✓ message signed by a different key than resolved → SIG_INVALID
✓ unknown session (resolveKey null) → SESSION_UNKNOWN
✓ sequence gap → SEQUENCE_GAP; stale timestamp → CLOCK_SKEW
✓ clock-skew window is configurable (amendment #4)
✓ unsigned garbage → signed SCHEMA_INVALID error message      (over POST /acnp)
✓ replayed message → REPLAY_DETECTED error                    (over POST /acnp)
✓ unknown session → SESSION_UNKNOWN error                     (over POST /acnp)
```
Gate 2 — seller bounds adversarial (strategy.test.ts):
```
✓ clamps a below-floor proposal up to the effective floor
✓ clamps an above-list proposal down to list
✓ clamps a non-integer proposal to list
✓ a below-floor LLM proposal is NEVER emitted by decideSeller
    (stubbed adapter proposes ₹500 on a ₹4,800 list / ₹3,600 floor item →
     outbound counter is exactly 360000 with clamp reason logged)
```
Gate 2 — strategy determinism + numbers (strategy.test.ts):
```
✓ starts at list and lands exactly on the effective floor at max_rounds
✓ is monotonically non-increasing across rounds
✓ concedes late with exponent > 1 (fixed expected numbers)
✓ is deterministic: identical inputs give identical outputs (Gate 2)
```
Gate 2 — full reproducible negotiation over HTTP (app.test.ts):
```
✓ session_init → signed session_ack with capabilities from policy
✓ catalog_request → catalog_offer with verifiable per-item hashes
    (floors proven absent from the wire payload)
✓ lowball offer → deterministic counter_offer at the round-1 ask
✓ offer with a wrong total → TOTAL_MISMATCH error, session survives
✓ offer meeting the ask → seller accept echoing our numbers
    (then STATE_INVALID on a post-AGREED offer)
```
Gate 6 (last item) — Compose all healthy with better-sqlite3 built in image:
```
$ docker compose up --build -d && docker compose ps
buyer/firewall/merchant/settlement — Up (healthy)
$ curl localhost:4001/health
{"status":"ok","service":"merchant","protocol":"ACNP","version":"0.1"}
```
Not verified: clamp events are pino-logged, not ledger-logged (ledger is
Day 10); `bundle_proposal`/`cart_mandate` handling deferred (out of scope).

## Outcome
- **Status:** done
- **Decisions generated:** D013
- **Follow-ups spawned:** move boundary.ts to a shared package when the
  buyer lands (Day 5); wire clamp events into the ledger (Day 10);
  cart_mandate copy handling with the firewall (Day 8).
- **Plain-language explanation (for the pitch):** The merchant is now a
  complete negotiating counterparty with no AI in it at all. Its prices
  come from a concession curve: start at list price, concede toward a floor
  as rounds pass, accept when the buyer meets the current ask. That floor
  is enforced by a separate clamp that checks every single outbound price —
  we wrote a test where a fake "hijacked AI" proposes selling at one
  percent of list, and what actually leaves the server is exactly the floor
  price, with the correction logged. When the real AI arrives on Day 6 it
  only gets to phrase things and suggest numbers; this same clamp stands
  between it and the wire. The security perimeter also runs before any
  business logic: bad signature, replayed message, wrong schema or a stale
  timestamp are all turned away at the door with a signed, coded error.
