# PROTOCOL.md — Agent Commerce Negotiation Protocol (ACNP) v0.1

**Status:** Draft specification, normative for this implementation.
**Audience:** Anyone implementing a conforming buyer agent, seller agent, firewall, or settlement service.
**Editors' note:** ACNP is informed by Google's Agent Payments Protocol (AP2) — specifically its mandate chain (Intent Mandate → Cart Mandate → payment authorization) — and by the design goals of ACP (agent-to-agent commerce interoperability) and x402 (HTTP-native machine payments). ACNP is not wire-compatible with any of them; it borrows their trust architecture and adapts it to a two-party negotiation setting with an independent compliance layer. Divergences are noted in Appendix A.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as in RFC 2119.

---

## 1. Scope and design goals

ACNP governs a single negotiation **session** between exactly one buyer agent and one seller agent, from catalog discovery through settlement receipt. It is designed for four properties, in priority order:

1. **Accountability.** Every material commitment (what the buyer authorized, what the seller offered, what was finally agreed) is a signed, timestamped artifact. Disputes are resolved by reading the ledger, not by trusting either agent's memory.
2. **Bounded autonomy.** Agents negotiate freely, but money can only move through a settlement request that a compliance firewall has verified against the buyer's *original* signed authorization. The LLM layer of either agent has no direct path to funds.
3. **Determinism at the edges.** All validation (schemas, signatures, sequence, bounds, caps) is deterministic. Model output is treated as untrusted proposal text everywhere in the pipeline.
4. **Replayability.** A complete session MUST be reconstructable, message by message, from the audit ledger alone.

Out of scope for v0.1: multi-merchant discovery, auctions/broadcast negotiation, currency conversion, partial shipments, and payment instruments other than a Razorpay test-mode order.

## 2. Terminology

| Term | Meaning |
|---|---|
| Session | One negotiation lifecycle, identified by `session_id`, between one buyer and one seller |
| Principal | The human (or org) on whose behalf an agent acts |
| Intent Mandate | Signed object stating what the buyer's principal authorized the buyer agent to achieve, and its limits |
| Cart Mandate | Signed object binding the final agreed deal to an exact catalog snapshot and price |
| Round | One offer/counter exchange pair within the negotiation phase |
| Firewall | The compliance service that must approve every settlement request |
| Ledger | The append-only, hash-chained audit log |

## 3. Transport and encoding

- Messages are JSON documents sent as the body of HTTP `POST` requests to the counterparty's single ACNP endpoint. The HTTP layer carries no protocol semantics beyond delivery; all meaning lives in the message.
- Character encoding is UTF-8. Monetary amounts are integers in **minor units** (paise) with an ISO 4217 `currency` field (v0.1 fixes this to INR). Floating-point money is prohibited everywhere, including internally.
- Timestamps are RFC 3339 UTC with millisecond precision.
- For signing and hashing, the message MUST be serialized with **JSON Canonicalization Scheme (JCS, RFC 8785)**. Implementations MUST NOT sign pretty-printed or key-order-dependent serializations.
- A receiver MUST validate an incoming message against the JSON Schema for its `type` before any other processing. Schema-invalid messages are rejected with error `SCHEMA_INVALID` and ledger-logged; they MUST NOT advance session state.

## 4. Message envelope

Every ACNP message consists of an **envelope** and a type-specific **body**. Envelope fields:

| Field | Type | Req | Rules |
|---|---|---|---|
| `protocol` | string | MUST | Literal `"ACNP"` |
| `version` | string | MUST | `"0.1"`. Receiver rejects unknown major versions with `VERSION_UNSUPPORTED` |
| `type` | string | MUST | One of the message types in §7 |
| `message_id` | string (UUIDv4) | MUST | Globally unique per message |
| `session_id` | string (UUIDv4) | MUST | Constant for the whole session; minted by the buyer in `session_init` |
| `seq` | integer | MUST | Per-sender, per-session, starts at 1, increments by exactly 1 per message sent |
| `in_reply_to` | string | SHOULD | `message_id` of the message being answered; absent only on `session_init` |
| `sender` | object | MUST | `{ agent_id, role }` where role ∈ `buyer` \| `seller` \| `firewall` \| `settlement` |
| `timestamp` | string | MUST | RFC 3339 UTC; receiver rejects if outside ±120 s of local clock (`CLOCK_SKEW`) |
| `body` | object | MUST | Type-specific payload (§7) |
| `signature` | object | MUST | `{ alg: "Ed25519", key_id, value }`; see §5 |

## 5. Identity and signatures

- Each agent holds an Ed25519 keypair generated **per session** (limits blast radius of key compromise; see THREAT_MODEL T9). `key_id` is the SHA-256 fingerprint of the public key.
- Public keys are exchanged in `session_init` / `session_ack` and pinned for the session. Any later message signed by a different key is rejected with `SIG_INVALID`.
- The signature is computed over the JCS serialization of the envelope with the `signature` field removed. Receivers MUST verify: (a) the signature, (b) that `key_id` matches the pinned key for `sender.agent_id`, before any body processing.
- The firewall and settlement services each hold their own keypair; verdicts and receipts are signed artifacts like any other message.

## 6. Ordering, replay, and idempotency

- Receivers MUST track the highest `seq` seen per (session, sender). A message with `seq` ≤ that value is a replay: reject with `REPLAY_DETECTED`, log to ledger, do not process. A gap (seq jumps by >1) is rejected with `SEQUENCE_GAP`.
- `message_id` uniqueness is additionally enforced session-wide as a second replay barrier.
- Settlement is further guarded by an idempotency key equal to the `cart_mandate` hash (§7.9): repeated `settlement_request`s for the same cart MUST return the original outcome, never create a second order.

## 7. Message types

Lifecycle order: `session_init → session_ack → catalog_request → catalog_offer → offer → counter_offer ×N → [bundle_proposal] → accept | reject | walk_away → cart_mandate → firewall_verdict → settlement_request → settlement_receipt`. `error` may occur at any point.

### 7.1 `session_init` (buyer → seller)
Opens a session. Body:

| Field | Req | Rules |
|---|---|---|
| `buyer_public_key` | MUST | Ed25519 public key, base64 |
| `supported_versions` | MUST | Array; seller picks highest mutual |
| `intent_mandate_ref` | MUST | Hash of the buyer's signed Intent Mandate (§8). The mandate itself is NEVER sent to the seller — only its hash, so the final cart can be bound to it without leaking budget ceilings or preferences to the counterparty |

### 7.2 `session_ack` (seller → buyer)
Body: `seller_public_key`, `chosen_version`, `capabilities` — the manifest of what this merchant supports: `bundling` (bool), `quantity_discounts` (bool), `delivery_sla_negotiation` (bool), `max_rounds` (int, seller's cap), `currency`.

### 7.3 `catalog_request` (buyer → seller)
Body: optional `query` (free text, treated by the seller as untrusted input), optional `category`, `max_items`.

### 7.4 `catalog_offer` (seller → buyer)
Body: `items[]`, each:

| Field | Rules |
|---|---|
| `item_id` | Stable identifier |
| `title`, `description` | Free text. Buyer implementations MUST treat these as untrusted content w.r.t. their LLM (prompt-injection surface; THREAT_MODEL T4) |
| `variants[]` | Each with `variant_id`, attributes, `list_price`, `stock` |
| `catalog_hash` | Seller-computed hash of this exact item snapshot; later bound into the cart mandate (THREAT_MODEL T1) |

### 7.5 `offer` (buyer → seller) and `counter_offer` (either direction)
The negotiation workhorses. Body:

| Field | Req | Rules |
|---|---|---|
| `line_items[]` | MUST | `{ item_id, variant_id, quantity, proposed_unit_price }` |
| `total` | MUST | Sum of line items; receiver re-computes and rejects mismatch (`TOTAL_MISMATCH`) |
| `terms` | MAY | `{ delivery_days, notes }` — notes is free text, untrusted |
| `round` | MUST | Integer; both sides MUST enforce the negotiated `max_rounds`; exceeding it forces `walk_away` |
| `rationale` | MAY | Natural-language justification generated by the LLM. **Informational only.** No receiver logic may branch on it |

Seller-side rule (normative for this implementation): every outbound `counter_offer` passes a deterministic bounds check against merchant policy (floor price, max discount, margin) *after* LLM generation. Out-of-bounds proposals are clamped or regenerated and the event ledger-logged. The prompt is not the enforcement mechanism.

### 7.6 `bundle_proposal` (seller → buyer)
A structured multi-item offer: `bundles[]`, each with `line_items[]`, `bundle_price`, `expires_at`. Semantics: accepting a bundle means accepting exactly its line items at exactly its price. May be cut under schedule pressure (BUILD_PLAN cut order #4).

### 7.7 `accept` / `reject` / `walk_away`
- `accept` body: `accepted_message_id` (the exact offer/counter/bundle accepted) plus a full echo of its `line_items` and `total`. Receiver MUST verify the echo matches the referenced message byte-for-byte after canonicalization (`ACCEPT_MISMATCH` otherwise). This prevents "accept" from quietly accepting different terms.
- `reject` body: `rejected_message_id`, optional `rationale` (untrusted, informational).
- `walk_away` body: `reason_code` ∈ `budget_exhausted` | `rounds_exhausted` | `no_acceptable_terms` | `deadline` | `policy`. Terminates the session; no further non-error messages are valid.

### 7.8 `cart_mandate` (buyer → firewall, copied to seller)
The bridge from negotiation to money. Body:

| Field | Rules |
|---|---|
| `intent_mandate_ref` | Hash from §7.1 — binds the cart to the original authorization |
| `accepted_message_id` | The accept that closed the deal |
| `line_items[]` | Final items with `catalog_hash` per item (binds exact seller snapshot) |
| `total`, `currency` | Final settlement amount, minor units |
| `seller_agent_id`, `buyer_agent_id` | Parties |
| `mandate_hash` | Hash of this mandate's canonical form; doubles as the settlement idempotency key |

Signed by the buyer agent. This is the artifact the firewall audits.

### 7.9 `firewall_verdict` (firewall → settlement, ledger, dashboard)
Body: `cart_mandate_hash`, `verdict` ∈ `allow` | `block` | `escalate`, `layer` ∈ `policy` | `intent_verifier` | `human`, `reasons[]` (machine-readable codes: e.g. `AMOUNT_CAP_EXCEEDED`, `VELOCITY_LIMIT`, `MERCHANT_NOT_ALLOWLISTED`, `CATEGORY_BLOCKED`, `INTENT_DRIFT_QUANTITY`, `INTENT_DRIFT_CATEGORY`, `INTENT_DRIFT_BUDGET`), optional `verifier_summary` (LLM prose, informational). Rules:
- Layer 1 (deterministic policy) runs first and can block alone.
- Layer 2 (LLM intent-verifier) runs only if layer 1 allows, and can only *recommend*; a deterministic component applies the final verdict.
- `escalate` parks the settlement in the human approval queue; a queue timeout auto-resolves to `block` (THREAT_MODEL T10) and is itself a ledger event.

### 7.10 `settlement_request` (buyer → settlement, only with an `allow` verdict)
Body: `cart_mandate` (full), `firewall_verdict_ref`. Settlement MUST independently re-verify the verdict signature and that verdict ⟶ this exact `mandate_hash`. Settlement then creates a Razorpay test-mode order with the mandate hash as idempotency key, bounded retry with exponential backoff, and awaits webhook confirmation (webhook signature verified; THREAT_MODEL T8).

### 7.11 `settlement_receipt` (settlement → buyer, seller, ledger)
Body: `mandate_hash`, `razorpay_order_id`, `status` ∈ `paid` | `failed` | `refunded`, `amount`, `timestamp_paid`, `ledger_entry_hash`. The receipt embeds the cart mandate hash, closing the accountability chain: intent → cart → verdict → receipt, every link signed.

### 7.12 `error`
Body: `code` (from §10), `detail` (string, no secrets), `offending_message_id` if applicable. Errors never advance state; fatal errors (§10) terminate the session.

## 8. Mandates (the authorization chain)

**Intent Mandate** — created and signed at buyer instantiation, stored buyer-side and at the firewall, never revealed to the seller:

| Field | Rules |
|---|---|
| `goal` | Natural-language objective ("anniversary gift for spouse") |
| `budget_ceiling` | Hard cap, minor units. Deterministically enforced by buyer strategy AND re-checked by the firewall |
| `constraints` | Structured: `max_quantity`, `categories_allowed[]`, `deadline`, `delivery_max_days` |
| `preferences` | Soft, for LLM reasoning only |
| `max_rounds`, `valid_until` | Session limits |
| `principal_id`, `issued_at`, signature | Provenance |

The firewall's layer 2 question is exactly: *does this cart mandate semantically satisfy this intent mandate?* Drift examples it must catch: quantity drift (intent implies 1, cart has 3), category drift (goal "gift", cart "server RAM"), budget drift (cart within cap but wildly inconsistent with goal).

**Cart Mandate** — §7.8. The pairing of the two, connected by `intent_mandate_ref`, is ACNP's core AP2-inspired structure.

## 9. Session state machine

States: `INIT → NEGOTIATING → AGREED → COMPLIANCE_REVIEW → SETTLING → SETTLED` with terminal alternatives `WALKED_AWAY`, `BLOCKED`, `FAILED`, `EXPIRED`.

| From | Event | To |
|---|---|---|
| INIT | `session_ack` received | NEGOTIATING |
| NEGOTIATING | `accept` (verified) | AGREED |
| NEGOTIATING | `walk_away` / rounds exhausted / `valid_until` passed | WALKED_AWAY / EXPIRED |
| AGREED | `cart_mandate` submitted | COMPLIANCE_REVIEW |
| COMPLIANCE_REVIEW | verdict `allow` | SETTLING |
| COMPLIANCE_REVIEW | verdict `block` or escalation timeout | BLOCKED |
| COMPLIANCE_REVIEW | verdict `escalate` | COMPLIANCE_REVIEW (held; human decision → SETTLING or BLOCKED) |
| SETTLING | receipt `paid` | SETTLED |
| SETTLING | retries exhausted / receipt `failed` | FAILED (refund path if partially captured) |

Any message arriving in a state where it is not listed as a valid event is rejected with `STATE_INVALID`. Both agents, the firewall, and settlement each maintain the state machine independently; divergence is detectable from the ledger.

## 10. Error codes

Fatal (terminate session): `VERSION_UNSUPPORTED`, `SIG_INVALID`, `REPLAY_DETECTED`, `SEQUENCE_GAP`, `ACCEPT_MISMATCH`, `STATE_INVALID`, `MANDATE_EXPIRED`.
Recoverable (reject message, session continues): `SCHEMA_INVALID`, `TOTAL_MISMATCH`, `CLOCK_SKEW`, `RATE_LIMITED`, `ITEM_UNAVAILABLE`.
Settlement domain: `VERDICT_MISSING`, `VERDICT_MISMATCH`, `SETTLEMENT_RETRY_EXHAUSTED`, `WEBHOOK_SIG_INVALID`.
Every emitted error is a ledger entry.

## 11. Ledger requirements

Every protocol message, firewall verdict, settlement event, clamp event (§7.5), and error MUST be written to the append-only ledger as an entry containing: `entry_seq`, `timestamp`, `entry_type`, the full canonical message (or event payload), and `prev_entry_hash` — the hash of the previous entry — forming a verifiable chain. A `verify` routine MUST be able to walk the chain end-to-end and report the first inconsistency. There are no update or delete operations, in any environment, ever.

## 12. Versioning

`version` is MAJOR.MINOR. MINOR increments add optional fields/message types only (receivers ignore unknown optional fields). MAJOR increments may break anything and require re-negotiation in `session_init`. Every spec change lands as a DECISIONS.md entry citing the section changed, plus a version bump in this header. The implementation MUST reject, not "best-effort parse," messages from unknown MAJOR versions.

## 13. Conformance checklist (used by integration tests)

An implementation conforms if it: validates schema before processing; verifies every signature against the pinned session key; enforces seq monotonicity and rejects replays; recomputes all totals; enforces `max_rounds`; verifies `accept` echoes; never settles without an `allow` verdict bound to the exact mandate hash; treats all free-text fields as untrusted LLM input; and ledger-logs every message and rejection. Each clause maps to at least one test in `docs/TEST_CHECKLIST.md` Gate 5.

---

## Appendix A — Relationship to AP2, ACP, x402

- **AP2:** ACNP adopts AP2's central idea — a verifiable chain from human intent to payment (Intent Mandate → Cart Mandate → authorization) — and its stance that agent autonomy is made safe by *artifacts*, not by trusting agent behavior. ACNP diverges by adding a multi-round negotiation phase between the mandates and by inserting an independent compliance firewall as a mandatory verdict-issuing party.
- **ACP:** shared goal of standardized agent-to-agent commerce interactions; ACNP is deliberately narrower (one buyer, one seller, one settlement rail) to stay implementable within the buildathon window while remaining honest about that scope.
- **x402:** shares the HTTP-native, machine-payable philosophy. ACNP does not use HTTP 402 semantics or per-request micropayments; settlement is a single order at the end of a negotiated session. A future minor version could expose firewall verdicts via 402-style challenge responses.
