# FLOW.md — How Execution Travels

Bugs live in the gaps between services. This file traces the canonical paths
end to end. Update it in the SAME commit as any change to these paths, and
mark the section you are currently modifying with `⚠ UNDER CHANGE — <task>`.

---

## F1 — Happy path: intent to receipt

Trigger: a run starts via the buyer's token-gated control plane —
`POST /control/run` with the `x-control-token` shared secret (D014). The
demo, the operator, and the evals harness (F7) all enter here; the endpoint
returns the full signed transcript when the session reaches a terminal
state.

1. Operator (or demo seed) — the **principal** — authors and signs an
   **Intent Mandate** with the principal key (PROTOCOL §8). Buyer Agent is
   instantiated with it read-only, generates a session keypair, and sends
   `mandate_register` → **Firewall**: principal signature verified → mandate
   stored by `intent_mandate_ref` → buyer key pinned → `mandate_ack`;
   ledger entries on both sides.
2. Buyer Agent → Merchant Server: `session_init` (self-signed, carries key +
   `intent_mandate_ref` hash only) → seller pins key, replies `session_ack`
   with capabilities manifest + chosen version → Buyer verifies compatibility
   → `catalog_request` → `catalog_offer` (with per-item `catalog_hash`).
3. Buyer Agent internal: shortlist against mandate preferences → strategy
   engine computes reservation price + opening offer → LLM adapter proposes a
   price and drafts the rationale text (`proposeMove`, D015: null on any
   failure → curve) → `clampBuyerPrice` bounds the number → protocol layer
   wraps, sequences, signs → send `offer`. Per-round attribution lands in
   `llm_moves`.
4. Merchant Server: boundary checks (signature, schema, session/sequence
   replay check) → seller policy engine computes allowable response envelope
   (floor, max discount) → LLM adapter drafts counteroffer WITHIN envelope →
   deterministic bounds check on the drafted number (clamp/regenerate if
   breached; `BOUNDS_CLAMPED` ledger event) → sign → respond `counter_offer`
   (or `bundle_proposal` if advertised).
   **Latency (D013 × D015):** the seller's LLM call runs inside this HTTP
   reply, so the buyer's client timeout must exceed the seller's whole
   proposal budget: `BUYER_HTTP_TIMEOUT_MS (30s) > LLM_TOTAL_BUDGET_MS (12s,
   retries inside) + merchant processing`. Change one, keep the inequality.
5. Rounds repeat (each message: boundary checks → ledger entry) until Buyer
   strategy decides accept or walk-away.
6. On accept: Buyer sends `accept` (echoing the accepted line items; seller
   verifies the echo) → builds **Cart Mandate** binding `intent_mandate_ref`,
   the accepted message id, per-item `catalog_hash`es and final total → signs
   → sends `cart_mandate` to the **Firewall**, copy to the seller.
7. **Firewall** audits the cart against the mandate it stored in step 1 —
   never against anything the buyer sends now.
   - Layer 1 deterministic checks → hard block possible (→ F3).
   - Layer 2 LLM intent-verifier → recommends allow / block / escalate →
     deterministic applier enforces verdict; ledger entry with reasoning
     summary → signed `firewall_verdict` sent to buyer and seller.
8. On allow: **Firewall → Settlement**: `settlement_request` (cart mandate +
   verdict, both signed, + the firewall-attested `buyer_public_key`).
   Settlement re-verifies firewall envelope, verdict signature, mandate
   hash (recomputed), buyer signature → replies HTTP 204 → looks the order
   up by receipt (crash recovery) or creates the Razorpay order (test mode,
   `mandate_hash` as idempotency key, bounded retry F4) → payment
   confirmation: v0.1 has no public endpoint for real inbound webhooks, so
   with `PAYMENT_SIMULATION` on, settlement posts a correctly HMAC-signed
   `order.paid` to its own `/webhook/razorpay` (the production verifier);
   `ORDER_STATUS_POLL` may also confirm from the Orders API → every step an
   append-only `settlement_events` entry (D018) → signed
   `settlement_receipt`. Transport (D013): the HTTP response to
   `settlement_request` only acknowledges acceptance; buyer and seller poll
   `GET /receipt/{mandate_hash}` (signed, idempotent) until it returns a
   `settlement_receipt` with `paid` or `failed` → final ledger entries →
   session `SETTLED`.

The buyer and seller never call Settlement; it accepts requests only from the
firewall's configured key (D011).

## F2 — Negotiation walk-away

Same as F1 through step 5; Buyer strategy hits walk-away condition (offer
above reservation price at final round / deadline reached) → sends
`walk_away` with a `reason_code` → both sides write closing ledger entries →
session `WALKED_AWAY`. Evals count this path — it is a success of strategy,
not a failure of the system.

## F3 — Firewall block & escalate

- **Block (layer 1):** deterministic rule fails (amount cap, velocity,
  allowlist, category, time window) → settlement refused with machine-readable
  reason code → ledger entry → signed `firewall_verdict` (`block`) sent to
  buyer and seller → session `BLOCKED`.
- **Block (layer 2 applied):** intent-verifier finds semantic mismatch with
  the Intent Mandate → same closure path, reason includes verifier summary.
- **Escalate:** verdict `escalate` → session held in `COMPLIANCE_REVIEW` →
  appears in dashboard approval queue. Transport (D013): the firewall's HTTP
  response to `cart_mandate` is the signed `escalate` verdict acknowledging
  the hold; the buyer then polls `GET /verdict/{cart_mandate_hash}` (signed,
  idempotent) until a terminal verdict exists. Human approves (verdict
  re-issued with `layer: human`, resume F1 step 8) or rejects (block closure
  path). Timeout on the queue → `ESCALATION_TIMEOUT` ledger event →
  auto-block → the poll returns the `block` verdict.
- **Flagship demo:** buyer seeded with corrupted goal walks this path and is
  caught between step 7 and 8.

## F4 — Settlement failure & retry

Order creation fails → retry with exponential backoff up to a ceiling
(`SETTLEMENT_MAX_ATTEMPTS`, default 5; same idempotency key and a
lookup-by-receipt before each attempt — no duplicate orders; each try is a
`SETTLEMENT_ATTEMPT` event; non-retryable 4xx fails fast) → on exhaustion
`SETTLEMENT_RETRY_EXHAUSTED`, session enters `FAILED` → both agents receive
a `settlement_receipt` with `status: failed` via `GET /receipt`. A
`payment.failed` webhook closes the same way (`PAYMENT_FAILED`). Refund
path: cut candidate #3, not implemented in v0.1.

## F5 — Boundary rejection (any step)

Any received message that fails signature, schema, version, or replay checks:
rejected at the boundary → never reaches agent logic → rejection ledger entry
with reason → sender receives an `error` message with a code from PROTOCOL.md
§10 (fatal codes terminate the session → `FAILED`). Repeated rejections from
a peer trip a per-session circuit breaker.

## F6 — Ledger write path (cross-cutting)

Every event above → ledger service: fetch previous entry hash → build entry
(event payload + prev hash + timestamp) → compute entry hash → append. The
"verify audit trail" dashboard action walks the full chain recomputing hashes
and reports the first break, if any.

## F7 — Evals run

Eval harness → spins up N sessions across scenario mix (honest / aggressive /
corrupted-goal buyers × merchant policies) → each session runs F1/F2/F3 paths
→ outcomes collected → metrics computed (deal-close rate, avg discount
conceded, firewall catch rate, false-block rate) → report written to a
committed artifact → dashboard evals page reads latest report.
