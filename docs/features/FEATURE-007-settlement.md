# FEATURE-007 — Settlement service (Razorpay test mode)

## Scope
- **Goal:** The money path, owned deterministically: a firewall-signed
  `settlement_request` becomes a real Razorpay test-mode order, is
  confirmed through the production webhook verifier, and yields a signed
  `settlement_receipt` that closes the accountability chain
  intent → cart → verdict → receipt.
- **In scope:** settlement storage with an append-only hash-chained event
  table; Razorpay client in `live-test` and explicitly-named `simulated`
  modes with the CONSTRAINTS #2 boot rule; idempotency (local key +
  receipt correlation with crash-recovery lookup); bounded retry with
  backoff (F4); `POST /acnp` accepting `settlement_request` from the
  firewall key only, with the §7.10 a–d verification chain; webhook HMAC
  verification (CONSTRAINTS #4); `GET /receipt/{mandate_hash}` polling;
  payment simulation behind a flag (OFF in code, loud when on); optional
  Orders-API status poll as a second confirmation source (flag).
- **Explicitly out of scope:** refund path (cut candidate #3); resuming
  in-flight settlements after a process crash (persisted state makes it a
  Day 10 polish item); real inbound webhooks from Razorpay — they require
  a public HTTPS endpoint, which v0.1 does not have (no tunnels); the
  firewall itself (Day 8) — today's caller is a test stand-in signing with
  the long-lived `FIREWALL_*` key.
- **Flow sections touched (FLOW.md):** F1 step 8 (settlement side), F4.
- **Architecture sections touched (ARCHITECTURE.md):** S5.
- **Risk class:** HIGH — this is the money path (CONSTRAINTS #2, #4, #10,
  #16: settlement code ships alone).
- **Amendments from approval:**
  1. Simulation framing accepted: real order in Razorpay test mode,
     self-posted webhook through the production HMAC verifier,
     `PAYMENT_SIMULATION` default OFF, loud at boot and in `/health`,
     plain-words THREAT_MODEL non-goal. Docs state the reachability fact:
     real inbound webhooks need a public endpoint; v0.1 confirms via the
     simulated path, no tunnels.
  2. Orders-API status poll as a second confirmation source behind
     `ORDER_STATUS_POLL` — included only because it is small.
  3. Day 6 economics finding preserved as a Day 11 obligation (see
     Follow-ups): compare LLM-advised vs pure-curve economics per model;
     any strategy guard is a post-measurement D-entry.
  4. x402 Appendix A sketch lands as its own small docs commit.
  5. Live Gate 4 + LLM contract suite re-run when the user says "keys in"
     (Razorpay test keys + rotated LLM keys go straight into `.env`).
  6. Tag `known-good` #1 on Day 8 when the F1 chain closes.
- **Three details the verification record must show:** crash-recovery
  lookup by receipt before create; boot refusal on non-test keys; the
  append-only `settlement_events` chain with no update/delete path.

## Plan (approved before implementation)
- Ordered sub-tasks (one commit each, settlement code alone):
  1. Storage + events chain + Razorpay client (live-test/simulated) + boot
     rule + retry engine. Unit tests.
  2. ACNP surface: `/acnp` (firewall-only, §7.10 a–d), async settle,
     `/webhook/razorpay` (raw-body HMAC), `/receipt/:hash`, payment
     simulation, status poll. HTTP tests for every Gate 4 item.
  3. Compose/env + D017/D018 + FLOW/THREAT_MODEL + docs close.
- New dependencies: better-sqlite3 (+types) into the settlement package
  (already approved D007). No Razorpay SDK — raw fetch, one base URL.
- How verified: Gate 0; Gate 4 all five items over HTTP with the firewall
  stand-in (simulated Razorpay until keys land, then live); Gate 5-style
  chain tests early (tamper detection, no update/delete by code search);
  Compose healthy with `/health` showing mode + simulation flag.

## Work log (append as you go; newest on top)
- 2026-08-26 [Claude Fable 5] — Live Gate 4 against Razorpay test mode
  from the Compose stack: real order `order_TULvJMWlrc12qi`, paid via the
  self-signed webhook, signed receipt, idempotent repeat → same order;
  the order fetched back from Razorpay's Orders API independently. Two
  operational findings: Compose interpolates `$` inside `.env` (the user's
  webhook secret contained one → escaped as `$$`, rule documented), and
  the first live driver used the wrong seq — the replay guard's
  `SEQUENCE_GAP` was correct.
- 2026-08-25 [Claude Fable 5] — Spec hole found while writing the
  verifier: §7.10 (d) demands the buyer's signature be checked, but the
  buyer's public key was nowhere on the wire. Fixed spec-first, alone
  (78327fc): the firewall attests `buyer_public_key`; verifyObject's
  key_id pin makes substitution detectable. Sub-tasks 1–2 landed
  (228c059, 279737d): 37 tests first run.
- 2026-08-25 [Claude Fable 5] — Feature file created after approval with
  amendments.

## Verification record
Gate 0:
```
$ pnpm lint      → All matched files use Prettier code style! (eslint clean)
$ pnpm typecheck → 9 × Done, 0 errors
$ npx vitest run → Test Files 27 passed | 1 skipped; Tests 221 passed | 6 skipped
```
Gate 4 — over HTTP with the firewall stand-in, simulated Razorpay (app.test.ts):
```
✓ firewall request → 204 → order → signed paid receipt with a real order id + chain hash
    events: REQUEST_ACCEPTED → SETTLEMENT_ATTEMPT → ORDER_CREATED →
            PAYMENT_CONFIRMED → RECEIPT_ISSUED; receipt.ledger_entry_hash ==
            PAYMENT_CONFIRMED.entry_hash; verifyChain ok (5)
✓ idempotency: a second request for the same cart is acknowledged and creates NO second order
✓ crash recovery: an order that already exists for the receipt is reused, never re-created
    (pre-seeded order → zero create calls → ORDER_RECOVERED event)
✓ pending status is signed while PAYMENT_SIMULATION is off; a valid real webhook then confirms
✓ ORDER_STATUS_POLL: the Orders API is a second confirmation source (amendment #2)
✓ retry: transient failures back off and succeed within the ceiling (attempts [1,2,3])
✓ retry: stops at the ceiling → failed receipt with SETTLEMENT_RETRY_EXHAUSTED (createCalls == 3)
✓ a non-retryable 4xx fails fast without exhausting the ceiling
✓ webhook with an invalid signature → 401 and mutates nothing
✓ a validly signed webhook for a wrong amount is ignored, not applied
```
§7.10 chain + sole-caller (D011) — every rejection is a signed error, zero create calls:
```
✓ a request signed by anyone but the firewall key is refused at the boundary (SIG_INVALID)
✓ a verdict signed by a non-firewall key → SIG_INVALID (b)
✓ a block verdict → VERDICT_MISMATCH (c)
✓ a verdict for a different cart hash → VERDICT_MISMATCH (c)
✓ a cart whose total was edited after signing → SIG_INVALID (d), even with an allow verdict
✓ a substituted buyer_public_key cannot verify the cart (key_id pin)
✓ replayed settlement_request → REPLAY_DETECTED
✓ /acnp is disabled (503) without a firewall key; /health reports mode and flags
```
Boot rule (CONSTRAINTS #2) and chain integrity (Gate 5 in miniature):
```
✓ refuses a live key id outright            ✓ refuses the placeholder and an empty secret
✓ simulated must be named explicitly        ✓ refuses to boot with a live key id (buildApp)
✓ refuses PAYMENT_SIMULATION without a webhook secret
✓ chains entries from genesis and verifies end to end
✓ tamper test: mutating one stored entry out-of-band breaks verification at exactly that entry
✓ NO update/delete code path exists for settlement_events (source search, CONSTRAINTS #7)
```
Gate 4 — LIVE against Razorpay test mode (Compose, `gate4-live.mjs` as firewall stand-in):
```
health: {"razorpay_mode":"live-test","payment_simulation":true,"order_status_poll":false,
         "firewall_key_configured":true,"signing_key":"configured"}
POST /acnp → 204 (accepted)
poll → {"status":"pending","settlement_status":"accepted","order":null,"attempts":1}
receipt body: {"mandate_hash":"19deaee97b83…1004","razorpay_order_id":"order_TULvJMWlrc12qi",
  "status":"paid","amount":417276,"currency":"INR","timestamp_paid":"2026-08-26T09:42:01.809Z",
  "ledger_entry_hash":"8ad468ded283…0230"}
receipt signature (settlement key): sig ✔
repeat POST /acnp → 204 | same order id: true
container log: "PAYMENT_SIMULATION on: self-posting a signed order.paid webhook" (level 40),
               second request logged outcome "duplicate"
$ GET https://api.razorpay.com/v1/orders/order_TULvJMWlrc12qi  (independent, with the test keys)
HTTP 200 {"id":"order_TULvJMWlrc12qi","entity":"order","amount":417276,"currency":"INR",
  "receipt":"19deaee97b83159000ffdc7e080332418073e868","status":"created",
  "notes":{"mandate_hash":"19deaee9…1004","session_id":"38f32d03-…"}}
```
Honest reading of that last line: Razorpay's own status is `created`, not
`paid` — no card was tapped; the `paid` in our receipt comes from the
self-signed webhook through the production verifier (D017), and the
confirming event records `source: webhook`. A real payer would flip
Razorpay's status too.

Not verified: an in-flight settlement is not resumed after a process
crash (state is persisted; Day 10 polish); Razorpay's real webhook
delivery (needs a public endpoint — none in v0.1); refund path (cut #3);
LLM contract suite re-run awaits the rotated keys.

## Outcome
- **Status:** done (live-verified against Razorpay test mode)
- **Decisions generated:** D017, D018 (+ §7.10 spec fix, 78327fc)
- **Follow-ups spawned:** Day 8 — firewall sends `settlement_request`
  with the attested `buyer_public_key`; buyer/seller poll `/receipt`;
  tag `known-good` #1 when F1 closes. Day 10 — ledger absorbs
  `settlement_events`; resume in-flight settlements on boot. Day 11
  evals MUST compare LLM-advised vs pure-curve economics per model
  (Day 6 finding: 4.2% vs 13.1% below list) — any buyer strategy guard is
  a post-measurement D-entry, not a fix before numbers exist. Keys: LLM
  keys still to be rotated by the user.
- **Plain-language explanation (for the pitch):** Settlement is the only
  service that touches money, and it trusts nobody. It accepts a request
  only from the firewall's key, then re-checks everything inside it
  itself: the firewall's signature on the verdict, that the verdict says
  "allow" for exactly this cart (it recomputes the cart's hash rather than
  reading it), and that the buyer really signed that cart. Then it creates
  a real Razorpay order in test mode — you can look it up in the Razorpay
  dashboard by its id — using the cart's hash as the idempotency key, so
  sending the same request twice can never create two orders, and if the
  process died between "order created" and "order saved" it finds the
  order again instead of making another. Because the buyer is an agent
  with no card, the customer's tap is simulated by a webhook that
  settlement signs and posts to itself, through the same signature check a
  real Razorpay webhook would face; we say so out loud in the health
  endpoint and the threat model. Every step is written to an append-only
  hash chain, and the signed receipt carries the hash of the confirming
  entry — so intent, cart, verdict and receipt are one verifiable line.
