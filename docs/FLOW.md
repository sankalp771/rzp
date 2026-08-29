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
   **Intent Mandate** with the principal key (PROTOCOL §8; the demo seed
   signs a fresh one per run because a mandate is single-use, D019). Buyer
   Agent holds it read-only, generates a session keypair, and sends
   `mandate_register` → **Firewall**: principal key must be trusted and
   the signature verify → mandate stored by `intent_mandate_ref` → buyer
   key pinned to the ref → signed `mandate_ack`. **No ack, no session:**
   the buyer refuses to send `session_init` unregistered
   (`FIREWALL_UNREACHABLE`, D010) and flips `mandate_registered = 1` only
   on a verified ack. Ledger entries on both sides (Day 10; pino + rows
   until then).
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
   the accept that closed the deal, per-item `catalog_hash` **and the
   seller's exact `catalog_item` snapshot** (D019), and the final total →
   `mandate_hash` over all of it → signs → sends the **seller's copy
   first** (own envelope on the seller stream; the merchant checks it
   against the accept it issued, the agreed terms and the snapshots it
   served in this session → `COMPLIANCE_REVIEW`, or `ACCEPT_MISMATCH`),
   then `cart_mandate` to the **Firewall** (its own stream, seq 1).
   Seller-copy-first because the firewall delivers the verdict to the
   seller inside its own handler (step 7) and the seller must already
   hold the cart.
7. **Firewall** audits the cart against the mandate it stored in step 1 —
   never against anything the buyer sends now; the cart must be signed by
   the key pinned at registration (`MANDATE_UNKNOWN` / `SIG_INVALID`
   otherwise), and hash and total are recomputed.
   - Layer 1 deterministic checks (`policy.ts`): amount cap, quantity
     cap, category from the snapshot, catalog-hash recomputation,
     merchant allowlist, per-principal velocity, expiry/deadline by the
     firewall's clock, one-mandate-one-purchase incl. a pending escalate
     → every violated rule listed → hard block possible (→ F3).
   - Layer 2 LLM intent-verifier (`intent.ts`, D021; runs only on a
     layer-1 allow; `FIREWALL_LLM_PROVIDER` unset = `not_configured`,
     layer 1 only, visible in `/health`): one fenced question — does
     this cart semantically satisfy the STORED mandate? — answered as a
     strict-JSON recommendation or `absent` → `applyVerdict` enforces
     the narrow-only table (D020/D021: clean allow → allow, block with
     reasons → block, escalate / absent / self-inconsistent → escalate;
     never an allow layer 1 did not grant) → append-only `verdicts` row
     with the verifier attribution (`verifier_json`) → signed
     `firewall_verdict` (with `verifier_summary`, untrusted prose) is the
     HTTP reply to the buyer, and is delivered to the seller in its own
     envelope (best-effort, recorded as `seller_notified`). Escalate →
     `escalations` row (`expires_at`) and F3.
     **Latency (FEATURE-009):** the verifier runs inside the buyer's HTTP
     call too: `BUYER_HTTP_TIMEOUT_MS (30s) > FIREWALL_LLM_BUDGET_MS (8s)
     + FIREWALL_DISPATCH_TIMEOUT_MS (8s) + FIREWALL_NOTIFY_TIMEOUT_MS (5s)
     + processing`.
8. On allow, **inside the same handler, before the verdict is replied**:
   **Firewall → Settlement**: `settlement_request` (the buyer's cart
   envelope + the very verdict envelope the buyer gets + the attested
   `buyer_public_key`). Settlement re-verifies firewall envelope, verdict
   signature, mandate hash (recomputed), buyer signature → replies HTTP
   204 → looks the order up by receipt (crash recovery) or creates the
   Razorpay order (test mode, `mandate_hash` as idempotency key, bounded
   retry F4) → payment confirmation: v0.1 has no public endpoint for real
   inbound webhooks, so with `PAYMENT_SIMULATION` on, settlement posts a
   correctly HMAC-signed `order.paid` to its own `/webhook/razorpay` (the
   production verifier); `ORDER_STATUS_POLL` may also confirm from the
   Orders API → every step an append-only `settlement_events` entry
   (D018) → signed `settlement_receipt`. The firewall records
   `settlement_dispatched` on the cart row; **a failed dispatch does not
   change the verdict** (amendment #4, D020) — the buyer then ends
   `pending`. Transport (D013): the HTTP response to `settlement_request`
   only acknowledges acceptance; buyer and seller each poll
   `GET /receipt/{mandate_hash}` (signed, idempotent; bounded by time and
   poll count) until it returns a `settlement_receipt` with `paid` or
   `failed` → session `SETTLED` / `FAILED`, or `pending` when the window
   closes (state stays `SETTLING`).
   **Latency (D020):** the firewall's dispatch and seller notification
   run inside the buyer's HTTP call: `BUYER_HTTP_TIMEOUT_MS (30s) >
   FIREWALL_DISPATCH_TIMEOUT_MS (8s) + FIREWALL_NOTIFY_TIMEOUT_MS (5s) +
   processing`. Settlement answers 204 before touching Razorpay, so F4's
   retry is outside this window.

The buyer and seller never call Settlement; it accepts requests only from the
firewall's configured key (D011).

## F2 — Negotiation walk-away

Same as F1 through step 5; Buyer strategy hits walk-away condition (offer
above reservation price at final round / deadline reached) → sends
`walk_away` with a `reason_code` → both sides write closing ledger entries →
session `WALKED_AWAY`. Evals count this path — it is a success of strategy,
not a failure of the system.

## F3 — Firewall block & escalate

- **Block (layer 1):** any deterministic rule fails (amount cap, quantity
  cap, category, catalog hash, allowlist, velocity, expiry/deadline,
  mandate already used / in review) → nothing is sent to settlement →
  `verdicts` row + log with every reason and a human-readable detail →
  signed `firewall_verdict` (`block`, all reasons) replied to the buyer
  and delivered to the seller → both sessions `BLOCKED`. Layer 2 is never
  consulted. Demo: `node scripts/negotiate.mjs --target var_relay_8ch`
  (an industrial relay under a gifts mandate → `CATEGORY_BLOCKED`; the
  ₹18,500 RAM kit ends in a walk-away instead — the strategy stops it).
- **Block (layer 2):** every layer-1 number passes; the intent-verifier
  recommends `block` with ≥1 `INTENT_DRIFT_*` reason → same closure path,
  `layer: intent_verifier`, `verifier_summary` on the wire; the mandate is
  NOT consumed (a compliant cart may follow). Demo: `--target
  var_corp_hamper` (a pack of 12 branded calendars for client
  distribution, category gifts, ₹4,700 — only semantics can stop it).
- **Escalate:** the verifier recommends `escalate`, is absent (timeout,
  429, unparseable) or contradicts itself → verdict `escalate`
  (`layer: intent_verifier`) → `escalations` row (`held_since`,
  `expires_at = now + FIREWALL_ESCALATION_TIMEOUT_SEC`) → both sessions
  held in `COMPLIANCE_REVIEW`; the buyer's row says `verdict=escalate`.
  Transport (D013): the firewall's HTTP response to `cart_mandate` is the
  signed `escalate` verdict acknowledging the hold; the buyer then polls
  `GET /verdict/{cart_mandate_hash}` (signed, idempotent, sweeps expired
  holds first) for `VERDICT_POLL_TIMEOUT_MS` (120 s). The queue:
  `GET /review` lists holds (goal, items, reasons, verifier attribution);
  `POST /review/{hash} {decision, reviewer, note}` decides — both behind
  `x-review-token` (`scripts/review.mjs`, the Day 10 dashboard). **A hold
  is decided exactly once (D022):** the claim, the layer-1 re-check and
  the appended human verdict are one transaction; a late human or a late
  sweep gets `ALREADY_DECIDED`, never a second verdict.
  - **Approve** → layer 1 re-run by the firewall's clock (expired /
    consumed / velocity → `block/policy` with those reasons) → else
    `allow/human/[HUMAN_APPROVED]` appended as seq 2 → dispatch to
    settlement + seller notification exactly as F1 step 8 → the buyer's
    poll returns the allow → `SETTLING` → receipt → `SETTLED`.
  - **Reject** → `block/human/[HUMAN_REJECTED]` → block closure path.
  - **Timeout (T10)** → `block/human/[ESCALATION_TIMEOUT]` (also a ledger
    event) issued by the sweep (lazy on reads + `FIREWALL_ESCALATION_SWEEP_MS`
    timer) → the poll returns it → `BLOCKED`.
  - **Buyer gives up** (window closes, human still thinking) → outcome
    `pending` / `HELD_IN_REVIEW`, state stays `COMPLIANCE_REVIEW`, the hash
    is in the notes and the hold remains decidable (resuming the run is
    Day 10). Never `FAILED`.
- **Flagship demo (three stops, three defenses):** `--target var_bookend`
  → the strategy walks away; `--target var_relay_8ch` → layer 1 blocks;
  `--target var_corp_hamper` → layer 2 blocks or holds for a human, who
  approves/rejects from a second terminal while the transcript waits.

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
with reason → sender receives an advisory `error` message with a code from
PROTOCOL.md §10, signed with the receiver's service key at seq 1, outside
every stream. **The receiver's session is untouched** — no state change, no
seq consumed (BUG-004: anything else lets a stranger who knows a
`session_id` kill a live session). Fatal codes terminate a session only
when the message was authenticated (handler-level rejection) or on the
*sender's* side when it receives one. Repeated rejections from a peer trip
a per-session circuit breaker (planned).

## F6 — Ledger write path (cross-cutting)

There is no ledger service (D023): each of the four services keeps its own
append-only chain (`ledger_entries`, `packages/ledger`) in its own SQLite.
On every step above the service appends, in one transaction: read the
head → build the entry `{entry_seq, at, entry_type, session_id, ref,
payload}` → `entry_hash = sha256(prev_entry_hash ‖ JCS(entry))` → insert.
What is appended, per party:
- **Messages:** every message that passed the boundary (`MESSAGE_IN`, the
  full signed envelope), every signed message sent or replied
  (`MESSAGE_OUT`, with the `receiver` since streams are per receiver, and
  for the firewall's pushes the `delivery` outcome), every boundary
  rejection (`BOUNDARY_REJECTED`, session id recorded as *claimed*, never
  trusted), every handler-level refusal (`HANDLER_REJECTED`). Polled
  messages (verdicts, receipts) are `MESSAGE_IN` once verified.
- **Decisions:** merchant `BOUNDS_CLAMPED` and `LLM_MOVE`; buyer
  `LLM_MOVE`; firewall `VERDICT` (with the details and verifier
  attribution the wire never carries), `VERIFIER_ABSENT`,
  `ESCALATION_DECIDED`, `ESCALATION_TIMEOUT`; settlement
  `SETTLEMENT_EVENT` (D018's money-chain event verbatim, including its
  own `entry_hash`, so a receipt's `ledger_entry_hash` is in both chains).
- **State:** every party's own §9 transition (`SESSION_STATE`), so
  divergence between parties is provable from the two records.

**Reading it (D024):** `GET /ledger?session_id=|ref=|entry_type=|after=`,
`GET /ledger/verify`, `GET /sessions` on each service behind
`DASHBOARD_TOKEN`. Verification is always whole-ledger: chains are per
service with sessions interleaved, so a session slice is a *view*, not a
sub-chain. `scripts/verify-ledgers.mjs` (terminal) and the dashboard's
Replay tab (browser, through the proxy) both do the same two things:
verify all four ledgers, and cross-check one session — every `MESSAGE_OUT`
one party recorded must match, by `message_id` and canonical hash (the
script) or signature (the page), the `MESSAGE_IN` another party recorded.
The honest claim is therefore "whole ledger verified ✓ + this session's
envelopes match across parties ✓". An out-of-band edit of entry *k* makes
`verify` report `break_at_seq: k` with the reason; the script can also
verify a copied database offline (`--db`), which is how the tamper demo
runs without touching a live volume.

## F7 — Evals run (FEATURE-011, `pnpm evals`)

`evals/src/cli.ts` → for each scenario × index (honest, aggressive,
stingy_merchant, corrupted_layer1, corrupted_semantic; ground truth fixed
by the scenario) → a seeded PRNG draws the session's parameters (budget;
buyer tuning; merchant policy; pinned target) → **one fresh in-process
stack** (`stack.testkit.ts`: merchant, firewall, settlement with the
simulated Razorpay client, buyer — the same boundary/firewall/settlement
code Compose runs) → `POST /control/run` → the session walks F1 and, per
scenario, F2 or F3 → the record is built from the buyer's result plus the
services' own tables (`llm_moves` on both agents, `verdicts.verifier_json`
on the firewall) → classified against ground truth (settled / walked_away /
false_block / caught / escalated / false_allow / failed) and attributed to
the layer that stopped it (strategy / policy / intent_verifier / human) →
the curve prediction for the same parameters is computed with the
services' own `bidPrice` / `askPrice` / `effectiveFloor` → appended to
`evals/runs/<run-id>/sessions.jsonl` (re-running the run id resumes) →
live mode: sleep `EVALS_PACE_MS`, back off after a rate-limited session,
stop cleanly after three in a row → `report.json` + `REPORT.md` in the run
dir (every rate with n/d; providers; floor leaks; curve-vs-LLM comparison
with an optional `--baseline` run; failures; provenance incl. git commit
and models) → `--publish` copies them to `evals/report.json` /
`evals/REPORT.md` → the dashboard's Evals tab (`GET /api/evals/report`,
bind-mounted read-only under Compose) renders the tables; the README
metrics table is copied from the same file (Gate 7).

Two modes over the same seed: `stub` (deterministic curves, layer 1 only —
exact, CI-checked by `evals/src/harness.test.ts`) and `live` (the three
adapters from `.env`, real clock).
