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

### T1 — Seller lies about stock or product attributes
- Attack: catalog advertises stock/specs that don't exist to extract a deal.
- Mitigation: cart mandate binds exact catalog item snapshot + hash at accept
  time; settlement receipt embeds it; discrepancy is provable from the ledger.
- Test:

### T2 — Replay of a signed message
- Attack: attacker resends a captured `accept` or `settlement_request`.
- Mitigation: (session id, sequence) uniqueness enforced at every boundary;
  idempotency keys at settlement; duplicates rejected and ledger-logged.
- Test:

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
  agent "decided".
- Test:

### T5 — Intent drift / corrupted buyer goal (flagship scenario)
- Attack: buyer agent state corrupted; cart no longer matches the mandate.
- Mitigation: the Intent Mandate is signed by the principal's key (not the
  agent's) and deposited with the firewall BEFORE the session opens
  (`mandate_register`, D010); layer 2 semantic verification runs only
  against that stored copy, so a corrupted agent cannot re-author its own
  authorization; escalate path with human queue.
- Test:

### T6 — Audit ledger tampering
- Attack: post-hoc edit of ledger entries to rewrite the negotiation story.
- Mitigation: hash-chained append-only entries; chain verification routine;
  no update/delete paths in code.
- Test:

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

### T10 — Escalation-queue starvation
- Attack/failure: escalated settlements pile up unanswered, holding funds
  indefinitely.
- Mitigation: queue timeout auto-blocks after a configured window; timeout is
  a ledger event.
- Test:

## Explicit non-goals (state them — honesty scores points)
- Live payments, KYC, real merchant onboarding.
- Multi-merchant discovery/marketplace routing.
- Full PKI with revocation.
- Defense against a compromised host running both agents.
- Production control-plane auth: the buyer's `POST /control/run` (which
  triggers a spending workflow) is gated by a shared-secret header
  (`CONTROL_TOKEN`, D014) and refuses to serve without it — demo-grade by
  design; production would sit behind real operator authentication.
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
