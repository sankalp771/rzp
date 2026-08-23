# FLOW.md — How Execution Travels

Bugs live in the gaps between services. This file traces the canonical paths
end to end. Update it in the SAME commit as any change to these paths, and
mark the section you are currently modifying with `⚠ UNDER CHANGE — <task>`.

---

## F1 — Happy path: intent to receipt

1. Operator (or demo seed) creates an **Intent Mandate** → Buyer Agent signs
   it and stores it; ledger entry written.
2. Buyer Agent → Merchant Server: fetch capabilities manifest → verify
   protocol version compatibility → fetch catalog.
3. Buyer Agent internal: shortlist against mandate preferences → strategy
   engine computes reservation price + opening offer → LLM adapter drafts the
   offer text → protocol layer wraps, sequences, signs → send `intent` +
   first `counter`.
4. Merchant Server: boundary checks (signature, schema, session/sequence
   replay check) → seller policy engine computes allowable response envelope
   (floor, max discount) → LLM adapter drafts counteroffer WITHIN envelope →
   deterministic bounds check on the drafted number (clamp/regenerate if
   breached) → sign → respond `counter` (or `bundle_proposal`).
5. Rounds repeat (each message: boundary checks → ledger entry) until Buyer
   strategy decides accept or walk-away.
6. On accept: Buyer builds **Cart Mandate** referencing the Intent Mandate id
   and final terms → signs → sends `accept` + `cart_mandate`.
7. Buyer Agent → **Firewall**: `settlement_request` (cart mandate + original
   intent mandate).
   - Layer 1 deterministic checks → hard block possible (→ F3).
   - Layer 2 LLM intent-verifier → recommends allow / block / escalate →
     deterministic applier enforces verdict; ledger entry with reasoning
     summary.
8. On allow: Firewall → Settlement service: create Razorpay order (test mode,
   idempotency key) → payment simulated/authorized in test mode → Razorpay
   webhook → webhook signature verified → settlement confirmed → `receipt`
   message signed and sent to both agents → final ledger entries → session
   closed.

## F2 — Negotiation walk-away

Same as F1 through step 5; Buyer strategy hits walk-away condition (offer
above reservation price at final round / deadline reached) → sends a terminal
decline message → both sides write closing ledger entries → session closed
with outcome `no_deal`. Evals count this path — it is a success of strategy,
not a failure of the system.

## F3 — Firewall block & escalate

- **Block (layer 1):** deterministic rule fails (amount cap, velocity,
  allowlist, category, time window) → settlement refused with machine-readable
  reason code → ledger entry → buyer notified via terminal `settlement_denied`
  message → session closed `blocked`.
- **Block (layer 2 applied):** intent-verifier finds semantic mismatch with
  the Intent Mandate → same closure path, reason includes verifier summary.
- **Escalate:** verdict `escalate` → settlement held in `pending_approval` →
  appears in dashboard approval queue → human approves (resume F1 step 8) or
  rejects (block closure path). Timeout on the queue → auto-block after a
  configured window.
- **Flagship demo:** buyer seeded with corrupted goal walks this path and is
  caught between step 7 and 8.

## F4 — Settlement failure & retry

Order creation or payment fails → retry with exponential backoff up to a
ceiling (same idempotency key — no duplicate orders) → on exhaustion, session
enters `settlement_failed`, ledger records each attempt → refund path invoked
if any partial capture exists → both agents receive terminal failure message.

## F5 — Boundary rejection (any step)

Any received message that fails signature, schema, version, or replay checks:
rejected at the boundary → never reaches agent logic → rejection ledger entry
with reason → sender receives a protocol error message with an error code from
PROTOCOL.md. Repeated rejections from a peer trip a per-session circuit
breaker.

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
