# ARCHITECTURE.md — The Negotiator: System Map

Purpose: the shape of the system, so no session re-derives it. This is a map,
not implementation detail. If reality diverges from this document, update the
document in the same commit that causes the divergence.

---

## 1. One-paragraph overview

A buyer agent, carrying a signed **Intent Mandate**, discovers a merchant's
agent-readable storefront, negotiates a multi-round deal over a versioned,
signed wire protocol, and — only after passing a two-layer **Compliance
Firewall** — settles the transaction through Razorpay (test mode). Every
message and settlement event lands in a hash-chained, append-only audit log,
making the whole negotiation cryptographically replayable.

## 2. Services (5)

### S1 — Merchant Commerce Server (seller side)
- Serves the structured catalog: products, variants, stock, list price.
- Serves a capabilities manifest: supported negotiation features (quantity
  discounts, bundling, delivery SLAs) and supported protocol version(s).
- Holds merchant policy config: floor prices, max discount %, margin rules,
  configured via the dashboard and stored server-side.
- Hosts the **Seller Agent**: LLM (behind the adapter layer) that generates
  counteroffers WITHIN policy bounds. Bounds are checked deterministically on
  every outbound offer before signing; an out-of-bounds LLM proposal is
  clamped or regenerated, never sent.

### S2 — Buyer Agent
- Instantiated with a principal-signed Intent Mandate (read-only): goal,
  budget ceiling, preferences (hard vs soft), deadline, max rounds. Registers
  it with the firewall before opening a session (D010).
- Pipeline per session: discover catalog → shortlist → plan strategy →
  negotiate rounds → decide (accept / counter / walk away) → request
  settlement.
- Negotiation strategy is explicit and explainable: reservation price,
  opening-offer ratio, concession curve across rounds, walk-away condition.
  The LLM does reasoning and natural-language offer generation ON TOP of the
  strategy parameters; the strategy math itself is deterministic code.

### S3 — Protocol Layer (shared library, not a runtime service)
- Versioned JSON messages over HTTP. Canonical flow:
  `mandate_register → session_init → session_ack → catalog_request →
  catalog_offer → offer → counter_offer (×N) → [bundle_proposal] → accept →
  cart_mandate → firewall_verdict → settlement_request → settlement_receipt`.
- Every message: schema-validated, carries protocol version, session id,
  monotonically increasing sequence number, timestamp, and an Ed25519
  signature over the canonical serialization. Per-agent keypairs.
- Modeled on AP2's mandate structure (Intent Mandate → Cart Mandate →
  payment authorization). Cited in PROTOCOL.md alongside ACP and x402.
- Replay protection: (session id, sequence number) uniqueness enforced at
  every receiving boundary; duplicates rejected and logged.
- The full normative spec lives in `PROTOCOL.md` at the repo root. That file
  is a submission deliverable — spec quality, with field tables, a state
  machine, error codes, and versioning rules.

### S4 — Compliance Firewall
Sits between the Buyer Agent and Settlement — it is the ONLY caller
Settlement accepts (D011). Holds the principal-signed Intent Mandate from
`mandate_register` and audits carts only against that stored copy. Two
layers, strict order:
1. **Deterministic policy engine** (`policy.ts`, runs first, can
   hard-block alone): amount cap, quantity cap, category (read from the
   seller's snapshot carried in the cart, D019), catalog-hash
   recomputation, merchant allowlist, velocity limit per principal per
   window, expiry/deadline by the firewall's clock, one-mandate-one-
   purchase (a pending escalate counts as in use). Every violated rule is
   listed. Pure code; the test suite greps the firewall source to prove
   no LLM import exists outside the (Day 9) verifier module.
2. **LLM intent-verifier** (`intent.ts`, runs only if layer 1 passes;
   D021): audits whether the cart semantically matches the ORIGINAL
   signed Intent Mandate — catches drift (e.g., mandate implies 1 item,
   cart is a "pack of 12"; goal says "gift for spouse", cart is a B2B
   lot). Principal text and seller snapshots are both fenced as
   untrusted. It returns a strict-JSON recommendation or `absent`; it
   never sees storage, the wire, or the dispatch path (source-search
   test). `FIREWALL_LLM_PROVIDER` unset = no verifier, loudly (layer 1
   only) — there is no fake auditor. Own budget: `FIREWALL_LLM_BUDGET_MS`.
- Verdicts: `allow` / `block` / `escalate` — **layer 2 can only narrow**:
  clean allow → allow (`layer: intent_verifier`), block with reasons →
  block, escalate / absent / self-inconsistent → escalate. Escalate
  lands in the human approval queue (`escalations` table; `GET/POST
  /review` behind `FIREWALL_REVIEW_TOKEN`; `scripts/review.mjs` today,
  the dashboard on Day 10); settlement is held until a human decides or
  the queue times out (`ESCALATION_TIMEOUT` → block, T10).
- **The human sits above the LLM and below the policy** (D022): approve
  re-runs layer 1 at decision time, then re-issues `allow/human`; reject
  → `block/human`. A hold is decided exactly once — claim + re-check +
  appended verdict in one transaction; a late decision gets
  `ALREADY_DECIDED`.
- The LLM only RECOMMENDS; `applyVerdict` (D020) is the single deterministic
  decider, and a missing recommendation maps to `escalate`, never `allow`.
- On allow the firewall dispatches `settlement_request` and delivers the
  verdict to the seller before replying to the buyer; dispatch outcome is
  recorded on the cart row (`settlement_dispatched`, `seller_notified`).
- Every verdict, with inputs and reasoning summary, is written to the audit
  log.
- Flagship demo scenario: a buyer agent seeded with a corrupted goal is
  caught by the firewall mid-settlement.

### S5 — Settlement + Ledger
- Razorpay Orders API, **test mode only**. Idempotency keys on every create;
  webhook-driven payment confirmation; retry with exponential backoff and a
  retry ceiling; refund path for the graceful-failure story.
- **Audit ledger**: append-only, hash-chained — each entry embeds the hash of
  the previous entry, so tampering is detectable by walking the chain. All
  protocol messages, firewall verdicts, and settlement events are entries.
- Ledger verification routine: recompute the chain end-to-end; exposed in the
  dashboard as a "verify audit trail" action.

## 3. Dashboard (thin, supporting)
- Merchant policy configuration (floors, discounts, rules).
- Escalation approval queue (firewall verdict = escalate).
- Session replay: step-by-step view of a negotiation from the audit log —
  negotiation transcript and signed audit trail side by side (the pitch
  money-shot screen).
- Evals summary page: metrics table from the latest eval run.

## 4. Cross-cutting

- **LLM adapter layer**: single internal interface; concrete adapters for the
  chosen free-tier provider(s). No vendor SDK imports outside the adapter.
  Buyer and seller can run on different models — record which model played
  which side in every session (feeds evals and version pinning).
- **Config & secrets**: all via environment; `.env.example` documents every
  variable; no secret ever committed.
- **Deployment**: Docker Compose one-command spinup of all services, seeded
  demo catalog and merchant policy included.
- **Evals harness**: runs N synthetic negotiations (target 50) across
  scenario mixes (honest buyer, aggressive buyer, corrupted-goal buyer,
  stingy merchant); reports deal-close rate, average discount conceded,
  firewall catch rate, false-block rate. Failure numbers are reported, not
  hidden.
- **Tests in CI**: at minimum one full happy-path negotiation-to-receipt
  integration test, plus firewall block and escalate cases, signature
  rejection, and replay rejection.

## 5. Trust boundaries (threat model summary — full doc: docs/THREAT_MODEL.md)

- Buyer ↔ Merchant: mutually untrusted. Signatures + schema validation +
  replay protection at both edges.
- Agents ↔ Firewall: agents are untrusted by the firewall by design; the
  firewall trusts only the principal-signed Intent Mandate it stored before
  the session began.
- Firewall ↔ Settlement: settlement trusts the firewall's configured key as
  the sole caller, but still re-verifies every embedded signature.
- System ↔ Razorpay: only S5 talks to Razorpay; test keys only; webhook
  signatures verified.
- Documented attack cases with mitigations: seller lies about stock; buyer
  replays a signed message; prompt-injected catalog content targeting the
  buyer LLM; LLM attempts to breach merchant floors; tampering with the
  audit log.
