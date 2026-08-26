# FEATURE-008 — Firewall layer 1 + the chain closes (F1 end to end)

## Scope
- **Goal:** The Compliance Firewall exists and the happy path runs intent →
  negotiation → cart → deterministic verdict → real Razorpay test-mode
  order → signed receipt, with every buyer session finally carrying
  `mandate_registered = 1`. The block path (F3, layer 1) is demoable.
- **In scope:** firewall storage (mandates, carts, append-only verdicts,
  per-receiver streams, replay memory); layer-1 deterministic policy engine
  (amount cap, quantity cap, category, catalog-hash recomputation, merchant
  allowlist, per-principal velocity, expiry/deadline, one-mandate-one-
  purchase incl. pending-escalate); verdict applier with an explicit
  `not_configured` layer-2 slot; `/acnp` (`mandate_register` →
  `mandate_ack`, `cart_mandate` → signed `firewall_verdict`), `/verdict/:hash`,
  `/health`; settlement dispatch inside the verdict with the attested
  `buyer_public_key`; verdict delivery to the seller; buyer registers before
  `session_init`, builds and signs the cart, handles the verdict, polls
  `/receipt` → `SETTLED`; merchant accepts the cart copy and the verdict
  and polls the receipt; demo script renders the new legs; `gen-keys.mjs`.
- **Explicitly out of scope:** layer 2 intent-verifier and the escalation
  queue (Day 9 — the applier slot is shaped for it and its absence maps to
  `escalate`, never `allow`); the global ledger (Day 10 — verdicts live in
  the firewall's append-only `verdicts` table and pino until then);
  resuming failed settlement dispatch (recorded as visible state, Day 10);
  `bundle_proposal` (cut candidate #4).
- **Flow sections touched (FLOW.md):** F1 steps 1, 6, 7, 8; F3 block.
- **Architecture sections touched (ARCHITECTURE.md):** S4, S2, S1.
- **Risk class:** HIGH — the firewall is the trust root of the money path
  (CONSTRAINTS #3, #6, #9, #16: spec change shipped alone, 4f6e33d).
- **Amendments from approval:**
  1. THREAT_MODEL T1 names the v0.2 fix for "the firewall cannot prove the
     seller produced the snapshot": carry the seller-signed `catalog_offer`
     envelope or a per-item detached seller signature.
  2. The §6 stream sentence must not narrow session-wide `message_id`
     uniqueness (done: 4f6e33d states it explicitly).
  3. **Pending escalate burns the mandate:** a cart held in `escalate`
     counts as "in use" — a second cart on the same ref is blocked with
     `MANDATE_IN_REVIEW`. One rule, one test; closes the double-spend race
     against a human decision.
  4. **Dispatch-failure branch is explicit:** if the settlement POST fails
     or times out, the firewall STILL replies the signed `allow` (the
     purchase is compliant); the cart row records
     `settlement_dispatched = 0` + the error; the buyer's outcome is
     `pending` with bounded `/receipt` polling. The invariant is therefore
     "allow **with dispatch success** ⇒ a receipt row exists". Timeout
     inequality (D015-style, written down and tested at the worst case):
     `BUYER_HTTP_TIMEOUT_MS (30 000) > FIREWALL_DISPATCH_TIMEOUT_MS (8 000)
     + FIREWALL_NOTIFY_TIMEOUT_MS (5 000) + firewall processing`. Settlement's
     `/acnp` answers 204 before touching Razorpay, so Razorpay's bounded
     retry is NOT inside this window.
  5. Velocity default stays 10/hour (safe direction), keyed by
     `principal_id` — never by mandate, since the demo signs a fresh
     mandate per run; `.env.example` carries a commented dev override and
     `negotiate.mjs` prints a hint when a run blocks on `VELOCITY_LIMIT`.
  6. Merchant receipt poll is the designated drop if the day runs long.

## Plan (approved before implementation)
- Ordered commits (one logical change each):
  1. ~~spec(protocol): `catalog_item` in cart line items; §6 per-receiver
     streams; §7.9 reason codes + one-mandate-one-purchase~~ ✅ 4f6e33d
  2. ~~feat(protocol): boundary resolver may name the rejection code~~ ✅
     c199991
  3. feat(firewall): storage, layer-1 policy engine, verdict applier —
     unit tests (every rule: pass + block).
  4. feat(firewall): ACNP surface + settlement dispatch + seller notify —
     HTTP tests driving the real settlement app (simulated Razorpay).
  5. feat(buyer): register → negotiate → cart → verdict → receipt; the
     four-service in-process E2E (settled / blocked / tampered / firewall
     down).
  6. feat(merchant): cart copy + verdict handling + receipt poll.
  7. feat(demo): `negotiate.mjs` legs + hints, `gen-keys.mjs`, compose
     volume, `.env.example`.
  8. docs close + tag `known-good-1`.
- New dependencies: better-sqlite3 (+types) into the firewall package
  (already approved, D007). No others.
- How verified: Gate 0 every commit; Gate 1 for commit 1; Gate 3 items 1,
  3, 5 (item 2 in its layer-1 form; item 4 is Day 9); Gate 6 in-process
  happy path + block + boundary rejections; Compose live run in
  `live-test` mode — a real order behind a real verdict — transcript read
  top to bottom.

## Work log (append as you go; newest on top)
- 2026-08-26 [Claude Fable 5] — Feature file created after approval with
  amendments; commits 1–2 landed.

## Verification record
(pasted as gates run)

## Outcome
- **Status:** in progress
- **Decisions generated:** D019, D020 (pending)
- **Follow-ups spawned:**
- **Plain-language explanation (for the pitch):**
