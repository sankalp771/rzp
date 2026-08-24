# FEATURE-005 — Buyer Agent (S2, no LLM)

## Scope
- **Goal:** A deterministic buyer that runs a full stubbed negotiation
  end-to-end against the Day 4 merchant: mandate at boot, discovery,
  strategy-driven rounds, accept or walk-away — so Day 6's LLM only adds
  phrasing and Day 11's evals harness has a run trigger to call.
- **In scope:** SQLite storage; principal-signed Intent Mandate loading and
  boot-time verification (+ demo seed mandate); deterministic strategy
  (reservation price, opening ratio, concession curve, accept rule,
  walk-away) with a buyer-side clamp (CONSTRAINTS #5 mirror); catalog
  shortlist with per-item hash verification; negotiation runner over the
  sync binding (D013); `/control/run` behind a shared-secret header;
  boundary.ts moved to `@negotiator/protocol` (Day 4 follow-up).
- **Explicitly out of scope:** LLM adapter wiring (Day 6); sending
  `mandate_register` (no firewall until Day 8 — but see amendment #3:
  the un-sent state is recorded, not skipped); `cart_mandate` construction
  (Day 8, needs the firewall to receive it); `bundle_proposal` (cut
  candidate #4).
- **Flow sections touched (FLOW.md):** F1 steps 1–3, 5–6 (buyer side);
  F2 first implementation; F5 now applies at the buyer's edge.
- **Architecture sections touched (ARCHITECTURE.md):** S2, S3 (boundary
  relocation).
- **Risk class:** low (no money path), but carries CONSTRAINTS #5 on the
  buyer side — the budget-clamp adversarial test is a deliverable.
- **Amendments from approval:**
  1. `/control/run` requires an `x-control-token` shared-secret header
     (`CONTROL_TOKEN` env) — an unauthenticated endpoint that triggers a
     spending workflow needs an answer; this also future-proofs the evals
     harness call.
  2. `PRINCIPAL_PRIVATE_KEY` beside the agent is demo convenience ONLY and
     is loudly labeled in `.env.example`, `mandate.ts`, and THREAT_MODEL
     non-goals — in the real design the principal key never lives beside
     the agent (that is exactly the hole D010 closed).
  3. The undelivered `mandate_register` is visible state: sessions carry
     `mandate_registered = 0` and the runner logs it on every run, so the
     Day 8 integration point is a screaming TODO in the data.

## Plan (approved before implementation)
- Ordered sub-tasks (one commit each):
  1. refactor: move `boundary.ts` (+ its tests) into `@negotiator/protocol`;
     merchant re-imports. Pure refactor, zero new deps. `SqliteReplayStore`
     stays per-service (schema is service-owned; the protocol package stays
     dependency-free).
  2. feat(buyer): storage (sessions + replay tables), mandate load/verify +
     demo seed, deterministic strategy with `clampBuyerPrice`, shortlist
     with catalog-hash verification. Pure-logic tests.
  3. feat(buyer): negotiation runner (injected transport; boundary on every
     reply), `/control/run` (token-gated), E2E vs merchant app (deal closes;
     walk-away on the near-floor bookend; tampered/replayed reply rejected),
     compose + env wiring.
- New dependencies: better-sqlite3 (+types) added to the buyer package —
  same dep already approved for merchant (D007), no new approval needed.
- How verified: Gate 0; Gate 1 boundary items buyer-side; Gate 2 buyer
  determinism + clamp adversarial + walk-away; full E2E over HTTP
  semantics; Compose all-healthy. Real output pasted below. Milestone
  ritual: print the full negotiation transcript for the user to read.

## Work log (append as you go; newest on top)
- 2026-08-25 [Claude Fable 5] — All three sub-tasks landed (5cdd52c
  boundary refactor, efa0b39 buyer core, f6f1e8e runner + control plane +
  E2E). The E2E's expected numbers are derived from the two curve
  formulas, not observed output, with a guard test that fails if either
  default is retuned. Two type-level findings while building: protocol
  `Message<union>` is not a discriminated union (each reply branch casts
  its body), and `seedDemoMandate` takes a structural key pair so env
  strings work. Live Compose run reproduced the E2E byte-for-byte.
- 2026-08-25 [Claude Fable 5] — Feature file created after approval with
  amendments (control token, principal-key labeling, visible
  mandate_registered state).

## Verification record
Gate 0:
```
$ pnpm lint      → All matched files use Prettier code style! (eslint clean)
$ pnpm typecheck → 8 × Done, 0 errors
$ npx vitest run → Test Files 19 passed (19); Tests 151 passed (151)
```
Gate 1 (boundary now shared; buyer-side items over the full E2E path):
```
✓ ACNP boundary suite moved to packages/protocol (7 items, unchanged)
✓ rejects a tampered merchant reply at the buyer boundary (SIG_INVALID)
✓ rejects a replayed merchant reply at the buyer boundary (REPLAY_DETECTED)
✓ refuses /control/run when CONTROL_TOKEN is not configured (503)
✓ rejects /control/run with a wrong or missing token (401)
✓ refuses to boot on an invalid (tampered) mandate — D010 boot gate
```
Gate 2 — buyer bounds adversarial (strategy.test.ts):
```
✓ a proposal above the reservation is clamped down to it
✓ a non-integer or non-positive proposal falls back to the deterministic bid
✓ an above-reservation LLM proposal is NEVER emitted by decideBuyer
    (stubbed adapter proposes ₹48,000 on a ₹4,800-list item →
     outbound offer is exactly 480000 with clamp reason logged)
```
Gate 2 — determinism + walk-away + E2E (strategy.test.ts, e2e.test.ts):
```
✓ decideBuyer is deterministic: identical inputs give identical outputs
✓ walks away with budget_exhausted / no_acceptable_terms / deadline (attributed)
✓ E2E closes the vase deal where the curves cross (F1 steps 2–6)
    deal total = sellerAsk(4) = 417276 in round 4; both sides AGREED;
    buyer seqs [1..7], seller seqs [1..6] — counters independent (§6)
✓ E2E is deterministic: two runs produce identical decision paths
✓ E2E walks away from the near-floor bookend on a tight budget (F2)
    reason budget_exhausted; no buyer offer ever exceeded 450000
✓ curve-formula guard: sellerAsk(4) ≤ buyerBid(5) and sellerAsk(3) > buyerBid(4)
```
Gate 6 — Compose all healthy, live run over container networking:
```
$ docker compose up --build -d && docker compose ps
buyer/firewall/merchant/settlement — Up (healthy)
$ POST :4002/control/run (x-control-token)  →
outcome=agreed state=AGREED rounds=4 total=417276 messages=13
transcript: init→ack→catalog→(offer/counter ×4)→accept, all 13 signatures
re-verified locally (sig ✔ on every message); notes carry
"mandate_registered=false: firewall (Day 8) not yet available"
```
Not verified: clamp/boundary events are pino-logged, not ledger-logged
(ledger Day 10); `mandate_register` is constructed and tested but not
delivered (firewall Day 8) — visible as `mandate_registered=0` per session.

## Outcome
- **Status:** done
- **Decisions generated:** D014
- **Follow-ups spawned:** Day 8 — deliver `mandate_register` at run start
  and flip `mandate_registered` to 1 (the row + the runner warn make this
  unmissable); Day 6 — feed `proposedPrices` into decideBuyer/decideSeller
  from the LLM adapter; Day 10 — ledger-log clamp reasons and hash
  mismatches from `notes`.
- **Plain-language explanation (for the pitch):** The buyer is now a
  complete negotiating agent with no AI in it. It boots by checking the
  human's signature on its shopping mandate and refuses to run without it.
  It asks for the catalog, re-computes every item's hash to catch a seller
  editing prices after the fact, and picks the nicest affordable item.
  Then it bids along a curve: start low, concede slowly toward a hard
  ceiling derived from the human's budget — and a separate clamp checks
  every outbound number against that ceiling, so even a hijacked AI
  proposing to overpay ten-fold can never put that number on the wire.
  It accepts when the seller's counter is cheaper than what it was about
  to offer next, and walks away — recorded as a success, not a failure —
  when the seller's floor sits above its budget. The whole exchange is
  thirteen signed messages that verify end to end, triggered through a
  token-guarded control endpoint so nobody on the network can spend on
  the buyer's behalf.
