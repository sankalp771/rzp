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
- 2026-08-26 [Claude Fable 5] — Live over Compose: the chain closed
  (Gemini buyer, Groq seller, real Razorpay test order behind a real
  verdict). The first block demo never reached the firewall — the RAM kit
  costs more than the budget, so the buyer walked away (a strategy
  success, not a firewall catch); added `itm_relay` (industrial, ₹4,200)
  and made seeding additive (506270b). Second block demo: BLOCKED /
  CATEGORY_BLOCKED at the firewall, settlement never saw the cart. Two
  findings recorded below (Gemini 429s → curve fallbacks; the seller
  model quoted its own floor in a rationale).
- 2026-08-26 [Claude Fable 5] — Commits reordered: merchant (5) before
  buyer (6) so the four-service E2E runs against a merchant that already
  accepts the cart copy. The forged-verdict test exposed BUG-004 (an
  unauthenticated message could terminate a live merchant session) —
  fixed in its own commit (6b27456). A dispatch-inside-the-verdict bug of
  my own: the embedded verdict was numbered on the settlement stream and
  the request landed at seq 2 (`SEQUENCE_GAP` — the guard was right);
  the request now embeds the very verdict envelope the buyer receives.
- 2026-08-26 [Claude Fable 5] — Feature file created after approval with
  amendments; commits 1–2 landed.

## Verification record
Gate 0 (final tree):
```
$ pnpm lint      → All matched files use Prettier code style! (eslint clean)
$ pnpm typecheck → 8 × Done, 0 errors
$ npx vitest run → Test Files 30 passed | 1 skipped; Tests 267 passed | 6 skipped (live-LLM contract)
```
Gate 1 — spec change 4f6e33d: zod + committed JSON schema agree (drift
test); fixtures carry `catalog_item`; settlement suite (22) unchanged.

Gate 3 — firewall (policy.test.ts 13, verdict.test.ts 5, app.test.ts 17):
```
item 1 — every rule pass + block: AMOUNT_CAP_EXCEEDED (500000 passes, 500001 blocks),
  QUANTITY_CAP_EXCEEDED, CATEGORY_BLOCKED (industrial vs gifts|jewellery),
  CATALOG_HASH_MISMATCH (relabelled snapshot; snapshot not describing the line),
  MERCHANT_NOT_ALLOWLISTED, VELOCITY_LIMIT (9 pass / 10 block, per principal),
  MANDATE_EXPIRED + DEADLINE_PASSED (firewall clock), MANDATE_ALREADY_USED
  (block does not consume), MANDATE_IN_REVIEW (amendment #3); all violations listed
item 2 (layer-1 form) — server RAM under a gifts mandate → block CATEGORY_BLOCKED;
  zero settlement rows, zero Razorpay create calls
item 3 — benign cart → allow, layer policy, reasons []; settlement_request accepted
  with the pinned buyer key; receipt paid (order_sim_000001); seller notified seq 1
item 5 — source search: only intent.ts may import @negotiator/llm (none today);
  policy.ts/verdict.ts contain no adapter, no fetch
over HTTP — mandate_register: ack + idempotent repeat; second key → MANDATE_CONFLICT;
  untrusted principal / tampered mandate → MANDATE_SIG_INVALID; expired → MANDATE_EXPIRED;
  no trusted keys → refused, /health principal_keys 0, intent_verifier "not_configured (Day 9)"
  cart: MANDATE_UNKNOWN (no seq consumed) · SIG_INVALID · REPLAY_DETECTED · re-sent cart →
  same verdict, ONE order · second cart in session → STATE_INVALID · TOTAL_MISMATCH · SCHEMA_INVALID
amendment #4 — settlement down → allow stands, settlement_dispatched=0 "ECONNREFUSED";
  settlement hangs → gives up at FIREWALL_DISPATCH_TIMEOUT_MS ("timeout after 50ms", <2s);
  settlement rejects (SIG_INVALID) → recorded verbatim; seller unreachable → seller_notified=0
```
Merchant (chain.test.ts 6 + BUG-004): faithful cart copy → 204 →
COMPLIANCE_REVIEW → allow → SETTLING → receipt → SETTLED; block → BLOCKED;
wrong accept / price / relabelled snapshot → ACCEPT_MISMATCH (fatal); cart
before AGREED and verdict for another cart → STATE_INVALID; forged verdict
→ SIG_INVALID **and the session survives** (real verdict lands after);
unconfigured firewall key → SESSION_UNKNOWN; bad-signature receipt →
`receipt_invalid`; poll timeout → `pending`, state SETTLING.

Gate 6 — four services in one process (buyer e2e.test.ts 12, llm.test.ts 3):
```
✓ vase deal SETTLED on every side: outcome settled, rounds 4, total 417276, verdict allow/policy,
  receipt paid order_sim_000001; transcript = register, ack, init, ack, catalog ×2, 4×(offer,
  counter), accept, cart(seller), cart(firewall), verdict, receipt; every received message
  verifies against its key; streams: seller-bound 1..8, firewall-bound 1, from seller 1..6,
  verdict seq 1; merchant SETTLED/paid, buyer mandate_registered=1/SETTLED, firewall
  dispatched=1 notified=1, settlement paid, exactly one create call
✓ deterministic across two stacks       ✓ reused fixed mandate → MANDATE_CONFLICT at registration
✓ bookend walk-away (registered first)  ✓ FLAGSHIP: industrial relay under a gifts mandate →
                                           BLOCKED/CATEGORY_BLOCKED on the default budget, 0 orders
✓ tampered reply SIG_INVALID · replayed reply REPLAY_DETECTED · tampered cart → SIG_INVALID at
  the firewall, 0 orders · firewall down → FIREWALL_UNREACHABLE, no session_init ever sent
✓ CHAOS LLMs both sides → settled|walked_away, every price in bounds
```
Compose — LIVE (`live-test` Razorpay, Gemini buyer, Groq seller, PAYMENT_SIMULATION on):
```
/health: merchant firewall_key_configured/settlement_key_configured true; buyer chain_configured
  true, mandate demo-seed; firewall principal_keys 1, intent_verifier "not_configured (Day 9)",
  policy {merchant-demo, 10/3600s}; settlement live-test, payment_simulation true
$ node scripts/negotiate.mjs   (session 52a9e448…)
  BUYER → FIREWALL seq 1 mandate_register … [sig ✔]   ← FIREWALL seq 1 mandate_ack [sig ✔]
  … 2 rounds (Gemini opened 20% under list; Groq accepted ₹4,600 in round 2) …
  BUYER → SELLER seq 5 cart_mandate gifts/var_vase_ash ₹4,600 hash d75f825e2c6b… [sig ✔]
  BUYER → FIREWALL seq 1 cart_mandate (same body, own envelope) [sig ✔]
  ← FIREWALL seq 1 firewall_verdict ALLOW (layer policy) [sig ✔]
  ← SETTLEMENT seq 1 settlement_receipt PAID — order_TUOpxWo7bDMyht, ₹4,600.00 [sig ✔]
  DEAL: list ₹4,800.00 → settled ₹4,600.00 — 4.2% below list, in 2 rounds
  Signatures: 14 verified, 0 invalid · LLM calls 2, fallbacks 0 · mandate_registered=true
firewall log: "firewall_verdict allow" → "settlement_request accepted by settlement"
settlement log: "settlement_request accepted" → "PAYMENT_SIMULATION on: self-posting … order.paid"
$ GET https://api.razorpay.com/v1/orders/order_TUOpxWo7bDMyht  (independent, test keys)
  HTTP 200 {"amount":460000,"currency":"INR","receipt":"d75f825e2c6b…140a","status":"created",
    "notes":{"mandate_hash":"d75f825e2c6b…baab","session_id":"52a9e448-…"}}
$ node scripts/negotiate.mjs --target var_relay_8ch   (session a446db3a…)
  … 5 rounds, Groq accepted ₹4,160 …
  BUYER → SELLER seq 8 cart_mandate industrial/var_relay_8ch ₹4,160 hash cd929744e450… [sig ✔]
  BUYER → FIREWALL seq 1 cart_mandate [sig ✔]
  ← FIREWALL seq 1 firewall_verdict BLOCK (layer policy) — CATEGORY_BLOCKED [sig ✔]
  BLOCKED by the firewall (layer policy): CATEGORY_BLOCKED — agreed ₹4,160.00 never reached settlement
  Signatures: 19 verified, 0 invalid · mandate_registered=true
firewall log (level 40): verdict block, details ["itm_relay is \"industrial\"; mandate allows gifts, jewellery"]
merchant log: "cart copy verified; awaiting verdict" → "firewall_verdict received" block
settlement: GET /receipt/cd929744… → HTTP 404 (it never saw the cart)
firewall:   GET /verdict/cd929744… → the same signed firewall_verdict envelope (seq 1,
            in_reply_to the cart's message_id) — idempotent polling works live
```
Honest readings: Razorpay's own order status is `created` (the tap is
simulated, D017). The first `--target var_ram_64` attempt ended in a
**walk-away**, not a block — the ₹18,500 kit is above the ₹5,000 budget,
so the strategy stopped it before the firewall could; that is why
`itm_relay` exists. Two model findings for Day 11: Gemini returned HTTP
429 (quota) on rounds 5–6 of that run → the buyer fell back to the curve
exactly as D015 says (`fallbacks 2`, visible in the transcript); and the
Groq seller wrote "above the floor of 378000" in a rationale — the
merchant shows its model the effective floor by design (D015) and the
model repeated it to the counterparty. Rationale is informational and
the floor is enforced in code, but a leaked private bound is an evals
metric and a Day 9/10 hardening candidate (strip numbers from seller
rationale, or stop showing the raw floor).

Not verified: escalation (Day 9 — the buyer's `/verdict` poll loop has no
live exercise yet); resuming a failed settlement dispatch (recorded as
visible state, Day 10); the merchant's receipt poll under a real
multi-minute settlement delay (bounded at 60 s by config).

## Outcome
- **Status:** done — the F1 chain closes live; tag `known-good-1`.
- **Decisions generated:** D019, D020 (+ §6/§7.8/§7.9 spec changes,
  4f6e33d; BUG-004).
- **Follow-ups spawned:** Day 9 — layer 2 replaces the `not_configured`
  literal (absence → escalate), escalation queue + `/verdict` polling
  exercised live, corrupted-goal flagship in its semantic form. Day 10 —
  ledger absorbs `verdicts` + `settlement_events` + `llm_moves`; resume
  failed dispatches; per-session circuit breaker (F5). Day 11 — evals must
  set `FIREWALL_VELOCITY_MAX` (or distinct principals) for 50 sessions;
  compare LLM-advised vs pure-curve economics per model (4.2% vs 13.1%
  again today); count 429 fallbacks; count rationale bound-leaks.
  Hardening candidate: seller rationale must not carry the floor.
- **Plain-language explanation (for the pitch):** Before the buyer agent
  talks to any shop, it deposits the human's signed shopping authorization
  with the firewall — and the firewall pins the agent's key to it, so only
  that agent can ever present a cart against it. The agent then negotiates
  exactly as before, and when a deal closes it writes a cart that binds
  the accept, the seller's exact product snapshot and the final price into
  one hash, signs it, and sends a copy to the seller and the original to
  the firewall. The firewall judges the cart only against the copy of the
  authorization it stored — never against anything the agent says now —
  with plain deterministic rules: budget, quantity, allowed category read
  from the seller's snapshot, an allow-listed merchant, how many purchases
  this person has made this hour, expiry, and "one authorization, one
  purchase" (a cart waiting on a human counts as in use). If it allows,
  it is the firewall — never the agent — that asks settlement to create
  the Razorpay order, and it does so before telling the agent "yes", so
  when the agent hears yes the receipt is already on its way; if
  settlement is down the yes stands but the money is marked pending, never
  paid. If it blocks, nothing reaches settlement at all — today a
  corrupted agent that agreed ₹4,160 for an industrial relay under a gift
  mandate was stopped with `CATEGORY_BLOCKED`, and every message on both
  paths carries a signature we re-verified on screen.
