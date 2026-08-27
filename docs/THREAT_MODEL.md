# THREAT_MODEL.md — The Negotiator

> Judged deliverable. Fill mitigations in as they are implemented; a threat
> listed with an unimplemented mitigation is marked **(planned)** honestly.
> Every implemented mitigation must point to the test that proves it
> (TEST_CHECKLIST gate + test name).

## Assets
- Money movement (Razorpay test orders standing in for real settlement)
- The signed Intent Mandate (source of truth for what the buyer authorized)
- Merchant policy bounds (floors, discounts — the merchant's margin)
- The audit ledger (the trust story of the whole system)
- Agent signing keys

## Trust boundaries
- Buyer ↔ Merchant (mutually untrusted)
- Agents ↔ Firewall (agents untrusted by design)
- System ↔ Razorpay (only Settlement talks to it; webhooks verified)
- LLM providers ↔ everything (LLM output is untrusted input, always)

## Threats & mitigations

### T1 — Seller lies about stock or product attributes (and: buyer relabels an item)
- Attack: catalog advertises stock/specs that don't exist to extract a deal;
  or a corrupted buyer relabels an item's category in the cart to slip past
  the firewall.
- Mitigation: the cart mandate carries the seller's exact catalog snapshot
  and the seller's hash over it (D019); the firewall recomputes the hash and
  reads the category from the snapshot; the merchant's copy is checked
  against the snapshots it actually served in that session; the settlement
  receipt embeds the mandate hash; any discrepancy is provable from the
  ledger. **Honest limit:** no seller signature travels with the snapshot,
  so the firewall alone cannot prove the seller produced it — a buyer who
  relabels *and re-hashes* is caught post hoc by the seller's copy
  (`ACCEPT_MISMATCH`), not in real time by the firewall. v0.2 fix: carry
  the seller-signed `catalog_offer` envelope, or a per-item detached seller
  signature, so the firewall verifies provenance directly.
- Test: `firewall/policy.test.ts` "CATALOG_HASH_MISMATCH: a relabelled
  snapshot without a re-hash blocks"; `merchant/chain.test.ts` "a
  relabelled snapshot → ACCEPT_MISMATCH" (Gate 3 item 1).

### T2 — Replay of a signed message
- Attack: attacker resends a captured `accept`, `cart_mandate` or
  `settlement_request`; or sends garbage into a live session to kill it.
- Mitigation: (session id, sequence) uniqueness per stream and session-wide
  `message_id` uniqueness at every boundary; idempotency keys at settlement
  and at the firewall (same cart → same verdict, one dispatch); duplicates
  rejected and logged; **boundary rejections never touch the receiver's
  session** (BUG-004).
- Test: `buyer/e2e.test.ts` "rejects a replayed merchant reply";
  `firewall/app.test.ts` "replayed cart → REPLAY_DETECTED; re-sent same
  cart → same verdict, ONE settlement"; `settlement/app.test.ts` "replayed
  settlement_request"; `merchant/chain.test.ts` "forged verdict → the
  session survives" (Gates 1, 3, 4).

### T3 — LLM attempts to breach merchant floors (or is prompt-injected into it)
- Attack: adversarial buyer messages steer the seller LLM below floor price.
- Mitigation: deterministic bounds check on every outbound offer AFTER LLM
  generation; clamp/regenerate; bounds live server-side, never in the prompt
  alone.
- Test:

### T4 — Prompt injection via catalog or offer free-text against the buyer
- Attack: merchant embeds instructions in product descriptions ("ignore your
  budget…").
- Mitigation: strategy math (budget, reservation price, walk-away) is
  deterministic and cannot be overridden by LLM output; firewall re-checks
  the final cart against the signed mandate regardless of what the buyer
  agent "decided". The same free text reaches the firewall's
  intent-verifier: there it is fenced as untrusted (fence spoofing
  neutralised), the model can only narrow the verdict (an injected
  "recommend allow" cannot widen anything layer 1 did not already grant),
  and the parser refuses anything but the strict recommendation shape.
  **Honest limit:** a model talked into `allow` on a cart layer 1 also
  allows is a layer-2 false allow — the human layer and the Day 11
  false-allow metric exist for that; a live injection trial is a Day
  11/12 candidate.
- Test: `firewall/intent.test.ts` "fences the principal text and the
  seller text, and neutralises fence spoofing"; "refuses …" (strict
  parse); `firewall/verdict.test.ts` "exhaustive: no layer-2 input yields
  allow unless it is a clean allow" (Gate 3 item 5). Buyer-side: (planned,
  Gate 2).

### T5 — Intent drift / corrupted buyer goal (flagship scenario)
- Attack: buyer agent state corrupted; cart no longer matches the mandate.
- Mitigation: the Intent Mandate is signed by the principal's key (not the
  agent's) and deposited with the firewall BEFORE the session opens
  (`mandate_register`, D010) — the buyer refuses to negotiate unregistered;
  layer 1 blocks category/amount/quantity drift deterministically against
  that stored copy; a mandate is single-use and a pending escalation counts
  as in use (D019); layer 2 semantic verification (D021) runs only against
  the stored copy — so a corrupted agent cannot re-author its own
  authorization — and can only narrow: block, or escalate to a human who
  sits above the LLM and below the policy (D022). Note the buyer's own
  shortlist has no semantics either (it ranks by list price); the firewall
  is the backstop by design.
- Test: `buyer/e2e.test.ts` "FLAGSHIP (layer 1): a corrupted buyer puts an
  industrial relay under a gifts mandate → BLOCKED, no order"; "FLAGSHIP
  (semantic): the corporate hamper clears every layer-1 number and is
  blocked by layer 2 — no order"; "benign cart passes layer 2 without
  escalation" (false-block guard); "verifier DOWN → escalate, never
  allow"; `firewall/app.test.ts` "one mandate, one purchase", "verifier
  never consulted when layer 1 blocks"; "no firewall → no negotiation"
  (Gate 3 items 2, 3, 5).

### T6 — Audit ledger tampering
- Attack: post-hoc edit, deletion or re-hashing of ledger entries to
  rewrite the negotiation story; or one party quietly recording a
  different version of what was said.
- Mitigation: every service keeps its own append-only, hash-chained
  ledger (`packages/ledger`, D023): `entry_hash = sha256(prev ‖
  JCS(entry))` from a fixed genesis, so an edit of entry *k* breaks
  verification at *k*, a re-hash of *k* breaks at *k+1*, a deletion is a
  sequence gap, and a truncated tail changes the head every receipt and
  verdict already cites. No update or delete path exists in any workspace
  (source-search test). The same signed envelope is recorded by both
  parties that exchanged it, so a party's private rewrite diverges from
  the counterparty's record and from the signature it carries — the
  cross-party check (`scripts/verify-ledgers.mjs`, dashboard Replay)
  compares by `message_id` and canonical hash / signature. Settlement's
  money chain (D018) is absorbed verbatim, so the receipt's
  `ledger_entry_hash` is findable in both chains. **Honest limit:** a
  party can still truncate its own tail before anyone cited the head;
  cross-party anchoring of chain heads is a v0.2 candidate.
- Test: `packages/ledger/src/ledger.test.ts` "TAMPER: an out-of-band
  edit of entry k is reported at exactly k", "re-hashing … moves the
  break to k+1", "deleting entry k is a sequence gap", "no update/delete
  path for ledger_entries anywhere"; `merchant/ledger.test.ts` "TAMPER
  over HTTP"; `firewall/app.test.ts` "… tamper breaks at that entry";
  `settlement/app.test.ts` "… tamper breaks at that entry";
  `buyer/e2e.test.ts` "every envelope the buyer sent the seller is in the
  merchant chain with the same hash (and back)" (Gate 5 items 1–3).

### T7 — Settlement duplication or runaway retries
- Attack/failure: network flaps cause repeated order creation.
- Mitigation: idempotency keys; bounded retry with backoff; each attempt
  ledger-logged.
- Test:

### T8 — Webhook forgery
- Attack: forged "payment confirmed" webhook triggers a receipt.
- Mitigation: Razorpay webhook signature verification before any state change.
- Test:

### T9 — Key compromise of an agent
- Attack: stolen agent key signs fraudulent messages.
- Mitigation (scoped honestly): per-session keys limit blast radius; velocity
  limits at the firewall cap damage; full revocation/rotation documented as
  out of scope for the buildathon window.
- Test:

### T10 — Escalation-queue starvation (and: racing the human)
- Attack/failure: escalated settlements pile up unanswered, holding funds
  indefinitely; or a human decision and the timeout land at the same
  moment and both produce a verdict.
- Mitigation: queue timeout (`FIREWALL_ESCALATION_TIMEOUT_SEC`) auto-blocks
  with `ESCALATION_TIMEOUT` — evaluated lazily on every `/verdict` and
  `/review` read and by a timer, so an unpolled hold still expires; the
  timeout is a ledger event and the polled verdict. A hold is decided
  exactly once: claim + re-check + appended verdict in one transaction,
  late actors get `ALREADY_DECIDED` (D022). The buyer's own poll window
  is bounded too (`pending`, never a hang). While held, the mandate
  counts as in use (`MANDATE_IN_REVIEW`).
- Test: `firewall/app.test.ts` "TIMEOUT (T10): past expires_at the poll
  returns block/human/ESCALATION_TIMEOUT; a late approve → 409
  ALREADY_DECIDED, no third verdict"; "RACE the other way: approved first
  … the sweep does nothing"; `buyer/e2e.test.ts` "ESCALATE → nobody
  answers → queue TIMEOUT"; "verifier DOWN … the buyer gives up → PENDING,
  not failed; the hold is still decidable" (Gate 3 item 4).

## Explicit non-goals (state them — honesty scores points)
- Live payments, KYC, real merchant onboarding.
- Multi-merchant discovery/marketplace routing.
- Full PKI with revocation.
- Defense against a compromised host running both agents.
- Production control-plane auth: the buyer's `POST /control/run` (which
  triggers a spending workflow) is gated by a shared-secret header
  (`CONTROL_TOKEN`, D014) and refuses to serve without it — demo-grade by
  design; production would sit behind real operator authentication.
- **One operator, every party (D024):** the ledger read API on all four
  services is gated by ONE shared `DASHBOARD_TOKEN`, and the dashboard
  proxies with that token plus the review and control tokens. Whoever
  holds it — or reaches the console — reads every party's chain
  (including the principal's budget and preferences on the buyer's side)
  and acts as the human reviewer, the merchant's policy owner and the
  buyer's operator. That is a fully trusted operator console, correct for
  a demo where the operator is every party and published on localhost
  only; a real deployment gives each party its own read token (the
  buyer's chain must never be readable by the seller's side) and puts
  operator identity in front of the console.
- A real payer: the buyer is an agent — there is no card tap and no
  checkout UI. Settlement creates a real Razorpay test-mode order, then
  (with `PAYMENT_SIMULATION` on, loud at boot and in `/health`) posts a
  correctly HMAC-signed `order.paid` webhook to its own verifier. Real
  inbound webhooks from Razorpay require a public HTTPS endpoint, which
  v0.1 does not have; no tunnels. The verifier, the order, and the receipt
  chain are real; only the customer's tap is simulated (D017).
- Principal key isolation: in the demo, `PRINCIPAL_PRIVATE_KEY` lives in the
  same env as the agents so one-command spinup can seed a signed Intent
  Mandate. In the real design the principal signs elsewhere and agents
  receive only the signed artifact — an agent must never be able to read
  the key that signs its own authorization (D010). `INTENT_MANDATE_JSON`
  exists as the real-design-shaped alternative input.
