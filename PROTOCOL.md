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
| Principal | The human (or org) on whose behalf an agent acts. Holds its own long-lived keypair, distinct from any agent's session key |
| Intent Mandate | Signed object stating what the buyer's principal authorized the buyer agent to achieve, and its limits |
| Cart Mandate | Signed object binding the final agreed deal to an exact catalog snapshot and price |
| Round | One offer/counter exchange pair within the negotiation phase |
| Firewall | The compliance service that must approve every settlement request |
| Ledger | The append-only, hash-chained audit log |

## 3. Transport and encoding

- Messages are JSON documents sent as the body of HTTP `POST` requests to the counterparty's single ACNP endpoint. The HTTP layer carries no protocol semantics beyond delivery; all meaning lives in the message.
- **Transport binding (v0.1, normative):** the binding is synchronous request/response. The receiver's reply — the next ACNP message it owes the sender, or a signed `error` message — rides in the HTTP `200` response body, itself fully signed, sequenced and schema-validated like any message. Where the receiver owes no reply message (e.g. after `accept`, `reject`, or a terminal `walk_away`), it returns HTTP `204` with an empty body, meaning "accepted, nothing owed". HTTP status codes other than 200/204 carry no protocol meaning; a sender MUST treat them, or an unparseable 200 body, as delivery failure, not as a protocol reply. Messages whose outcome is inherently asynchronous (an `escalate` verdict pending a human, a `settlement_receipt` pending a payment webhook) are handled by polling a signed, idempotent status endpoint — see §7.9 and §7.11. Asynchronous webhook delivery between agents is a candidate v0.2 binding (Appendix A).
- Character encoding is UTF-8. Monetary amounts are integers in **minor units** (paise) with an ISO 4217 `currency` field (v0.1 fixes this to INR). Floating-point money is prohibited everywhere, including internally.
- Timestamps are RFC 3339 UTC with millisecond precision.
- For signing and hashing, the message MUST be serialized with **JSON Canonicalization Scheme (JCS, RFC 8785)**. Implementations MUST NOT sign pretty-printed or key-order-dependent serializations.
- **Hash and encoding conventions (apply everywhere in this spec):** every hash (`key_id`, `catalog_hash`, `mandate_hash`, `intent_mandate_ref`, ledger entry hashes) is SHA-256 over the JCS serialization of the object in question, encoded as **lowercase hex** (64 chars). Public keys are raw 32-byte Ed25519 keys and signatures raw 64-byte values, both encoded as **standard base64 with padding**. Identifiers (`message_id`, `session_id`, `agent_id`) are opaque strings; where a UUID is required it is lowercase UUIDv4.
- A receiver MUST validate an incoming message against the JSON Schema for its `type` before any other processing. (Non-normative: the reference implementation's schemas are generated from `packages/protocol/src/schemas/` and committed under `packages/protocol/schemas/json/`.) Schema-invalid messages are rejected with error `SCHEMA_INVALID` and ledger-logged; they MUST NOT advance session state.

## 4. Message envelope

Every ACNP message consists of an **envelope** and a type-specific **body**. Envelope fields:

| Field | Type | Req | Rules |
|---|---|---|---|
| `protocol` | string | MUST | Literal `"ACNP"` |
| `version` | string | MUST | `"0.1"`. Receiver rejects unknown major versions with `VERSION_UNSUPPORTED` |
| `type` | string | MUST | One of the message types in §7 |
| `message_id` | string (UUIDv4) | MUST | Globally unique per message |
| `session_id` | string (UUIDv4) | MUST | Constant for the whole session; minted by the buyer in `session_init` |
| `seq` | integer | MUST | Per (session, sender, receiver) stream — see §6; starts at 1, increments by exactly 1 per message sent on that stream |
| `in_reply_to` | string | SHOULD | `message_id` of the message being answered; absent only on `mandate_register` and `session_init` |
| `sender` | object | MUST | `{ agent_id, role }` where role ∈ `buyer` \| `seller` \| `firewall` \| `settlement` |
| `timestamp` | string | MUST | RFC 3339 UTC; receiver rejects if outside ±120 s of local clock (`CLOCK_SKEW`) |
| `body` | object | MUST | Type-specific payload (§7) |
| `signature` | object | MUST | `{ alg: "Ed25519", key_id, value }`; see §5 |

## 5. Identity and signatures

- Each agent holds an Ed25519 keypair generated **per session** (limits blast radius of key compromise; see THREAT_MODEL T9). `key_id` is the SHA-256 hash of the raw public key bytes, lowercase hex.
- Public keys are exchanged in `session_init` / `session_ack` and pinned for the session. Any later message signed by a different key is rejected with `SIG_INVALID`.
- **Bootstrap (trust-on-first-use within a session):** `session_init` and `session_ack` are signed with the key they carry. The receiver verifies the signature against the *embedded* key, then pins that key to `sender.agent_id` for the rest of the session. The firewall's and settlement's public keys are **not** session-scoped: they are long-lived and distributed to agents by configuration (`FIREWALL_PUBLIC_KEY`, `SETTLEMENT_PUBLIC_KEY` environment variables); messages from those roles are verified against the configured keys.
- The signature is computed over the JCS serialization of the envelope with the `signature` field removed. Receivers MUST verify: (a) the signature, (b) that `key_id` matches the pinned (or configured) key for `sender.agent_id` / `sender.role`, before any body processing.
- The firewall and settlement services each hold their own keypair; verdicts and receipts are signed artifacts like any other message.
- The **principal** holds a long-lived keypair that signs the Intent Mandate (§8) and nothing else. An agent's session key MUST NOT be accepted as a mandate signature — otherwise a compromised buyer agent could simply re-author its own authorization (THREAT_MODEL T5). The firewall is configured with the set of acceptable principal public keys.

## 6. Ordering, replay, and idempotency

- Receivers MUST track the highest `seq` seen per (session, sender). A message with `seq` ≤ that value is a replay: reject with `REPLAY_DETECTED`, log to ledger, do not process. A gap (seq jumps by >1) is rejected with `SEQUENCE_GAP`.
- **Streams are per (session, sender, receiver).** A sender that talks to more than one receiver within a session — the buyer (seller and firewall), the firewall (buyer, seller and settlement) — numbers each receiver's stream independently from 1, because each receiver can only observe the messages addressed to it and would otherwise see gaps. Receivers therefore track the highest `seq` per (session, sender) *as seen by them*. A message "copied" to a second receiver (§7.8) is the same body in a fresh envelope on that receiver's stream, not a byte-identical resend.
- `message_id` uniqueness is additionally enforced session-wide — across all streams and senders — as a second replay barrier; the per-receiver stream rule above does not narrow this.
- **Sequence consumption:** a message that passes the boundary checks (schema, version, signature, replay) consumes its `seq` even when it is then rejected with a recoverable error (§10) — the sender continues with the next number. A message rejected at the boundary consumes nothing; the sender retries the same `seq`. Without this split, either an attacker could burn an honest sender's numbers with forged garbage, or a single recoverable rejection would wedge the session in `SEQUENCE_GAP`.
- Settlement is further guarded by an idempotency key equal to the `cart_mandate` hash (§7.9): repeated `settlement_request`s for the same cart MUST return the original outcome, never create a second order.

## 7. Message types

Lifecycle order: `mandate_register → session_init → session_ack → catalog_request → catalog_offer → offer → counter_offer ×N → [bundle_proposal] → accept | reject | walk_away → cart_mandate → firewall_verdict → settlement_request → settlement_receipt`. `error` may occur at any point.

Who talks to whom (normative): buyer ↔ seller for everything from `session_init` through `accept`/`reject`/`walk_away`; buyer → firewall for `mandate_register` and `cart_mandate`; **firewall → settlement** for `settlement_request`. The buyer and seller agents have no endpoint on, and no route to, the settlement service. Settlement accepts `settlement_request` only from the firewall's configured key.

### 7.0 `mandate_register` (buyer → firewall)
Sent once, before `session_init`, to deposit the principal-signed Intent Mandate with the firewall. Body:

| Field | Req | Rules |
|---|---|---|
| `intent_mandate` | MUST | The full Intent Mandate object (§8) including its principal signature |
| `buyer_public_key` | MUST | The session key the buyer will use in `session_init`, base64 — lets the firewall pin the buyer for this session |

Firewall rules: verify the principal signature against a configured principal key (`MANDATE_SIG_INVALID` otherwise); reject if `valid_until` has passed (`MANDATE_EXPIRED`); compute `intent_mandate_ref` = hash of the mandate (§3) and store the mandate by that ref. A second registration with the same ref is idempotent; a registration whose body differs but whose `session_id` is already bound is rejected (`MANDATE_CONFLICT`). The firewall replies with `mandate_ack` (body: `intent_mandate_ref`). **The stored copy is the only mandate the firewall will ever audit against** — nothing the buyer sends later can replace it.

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
| `category` | Seller-declared category string; matched against the Intent Mandate's `categories_allowed` by the firewall (§7.9 `CATEGORY_BLOCKED`) |
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
A structured multi-item offer: `bundles[]`, each with `bundle_id`, `line_items[]`, `bundle_price`, `expires_at`. Semantics: accepting a bundle means accepting exactly its line items at exactly its price. May be cut under schedule pressure (BUILD_PLAN cut order #4).

### 7.7 `accept` / `reject` / `walk_away`
- `accept` body: `accepted_message_id` (the exact offer/counter/bundle accepted) plus a full echo of its `line_items` and `total`. Receiver MUST verify the echo matches the referenced message byte-for-byte after canonicalization (`ACCEPT_MISMATCH` otherwise). This prevents "accept" from quietly accepting different terms.
- `reject` body: `rejected_message_id`, optional `rationale` (untrusted, informational).
- `walk_away` body: `reason_code` ∈ `budget_exhausted` | `rounds_exhausted` | `no_acceptable_terms` | `deadline` | `policy`. Terminates the session; no further non-error messages are valid.

### 7.8 `cart_mandate` (buyer → firewall, copied to seller)
The bridge from negotiation to money. The firewall MUST reject a `cart_mandate` whose `intent_mandate_ref` was not previously deposited via `mandate_register` (`MANDATE_UNKNOWN`), or whose sender key is not the one pinned at registration (`SIG_INVALID`). Body:

| Field | Rules |
|---|---|
| `intent_mandate_ref` | Hash from §7.1 — binds the cart to the original authorization |
| `accepted_message_id` | The accept that closed the deal |
| `line_items[]` | `{ item_id, variant_id, quantity, unit_price, catalog_hash, catalog_item }`. `catalog_item` is the seller's exact item snapshot as received in `catalog_offer` (§7.4, all fields except `catalog_hash`); `catalog_hash` is the seller's hash over it. Every receiver MUST recompute `catalog_hash` over `catalog_item` and reject a mismatch (firewall: verdict reason `CATALOG_HASH_MISMATCH`; seller: `ACCEPT_MISMATCH`). The firewall reads the seller-declared `category` from the snapshot (§7.9 `CATEGORY_BLOCKED`) — it never sees the catalog otherwise. The seller's copy lets the merchant confirm the snapshot against what it served in this session, so a buyer who relabels an item and re-hashes is provable from the ledger even though the firewall alone cannot detect it (THREAT_MODEL T1; a seller-signed snapshot is a v0.2 candidate) |
| `total`, `currency` | Final settlement amount, minor units |
| `seller_agent_id`, `buyer_agent_id` | Parties |
| `mandate_hash` | Hash of this mandate's canonical form; doubles as the settlement idempotency key |

Signed by the buyer agent. This is the artifact the firewall audits.

### 7.9 `firewall_verdict` (firewall → buyer, seller, ledger, dashboard; attached to `settlement_request`)
Every verdict is delivered to both agents so each can advance its own state machine (§9); `allow` verdicts are additionally carried inside the `settlement_request` the firewall sends to settlement. Body: `cart_mandate_hash`, `verdict` ∈ `allow` | `block` | `escalate`, `layer` ∈ `policy` | `intent_verifier` | `human`, `reasons[]` (machine-readable codes — layer 1: `AMOUNT_CAP_EXCEEDED`, `QUANTITY_CAP_EXCEEDED`, `CATEGORY_BLOCKED`, `CATALOG_HASH_MISMATCH`, `MERCHANT_NOT_ALLOWLISTED`, `VELOCITY_LIMIT`, `MANDATE_EXPIRED`, `DEADLINE_PASSED`, `MANDATE_ALREADY_USED`, `MANDATE_IN_REVIEW`; layer 2: `INTENT_DRIFT_QUANTITY`, `INTENT_DRIFT_CATEGORY`, `INTENT_DRIFT_BUDGET`; human layer: `HUMAN_APPROVED`, `HUMAN_REJECTED`, `ESCALATION_TIMEOUT`), optional `verifier_summary` (LLM prose, informational, UNTRUSTED). Rules:
- Layer 1 (deterministic policy) runs first and can block alone.
- **One mandate, one purchase.** An Intent Mandate is consumed by its first `allow` verdict; any later cart bound to the same `intent_mandate_ref` is blocked with `MANDATE_ALREADY_USED`. While a cart on that ref is held in `escalate`, a second cart on it is blocked with `MANDATE_IN_REVIEW` — a pending human decision counts as "in use", so no cart can race an escalation to an `allow`. A `block` does not consume the mandate; the buyer may negotiate a compliant cart. Velocity limits are keyed by `principal_id`, not by mandate, so issuing fresh mandates does not evade them.
- **Layer 2 can only narrow, never widen.** The LLM intent-verifier runs only if layer 1 allows, and can only *recommend*; a deterministic component applies the final verdict. A recommendation of `allow` (with no reasons) yields `allow`; `block` with at least one `INTENT_DRIFT_*` reason yields `block`; `escalate` yields `escalate`; a recommendation that is absent (timeout, transport failure, unparseable, unknown reason code) or self-inconsistent (`allow` carrying reasons, `block` carrying none) yields `escalate` — never `allow`. There is no input to layer 2 that produces an `allow` layer 1 did not already grant.
- **The human sits above the LLM and below the policy.** `escalate` parks the settlement in the human approval queue. A human decision re-issues the verdict with `layer: human` and reason `HUMAN_APPROVED` (→ `allow`) or `HUMAN_REJECTED` (→ `block`); before an approval is issued, layer 1 is re-evaluated at decision time by the firewall's clock, so a human cannot approve past an expired mandate, a passed deadline, a consumed mandate or a velocity limit — a failed re-check yields `block` with the layer-1 reasons. A queue timeout auto-resolves to `block` with reason `ESCALATION_TIMEOUT` (THREAT_MODEL T10) and is itself a ledger event. **An escalation is decided exactly once:** the first of {human decision, timeout} to commit wins; a later decision is refused (`ALREADY_DECIDED`, transport-level) and never produces a further verdict. Every verdict for a cart is appended, never replaced; the latest is the current one.
- Synchronous binding (§3): the firewall's HTTP response to `cart_mandate` is the `firewall_verdict` itself for `allow`/`block`, or an `escalate` verdict acknowledging the hold. After `escalate`, the buyer polls `GET /verdict/{cart_mandate_hash}` — an idempotent endpoint returning the latest signed verdict for that hash — until a human decision or queue-timeout auto-block produces a terminal verdict (`layer: human`). A held cart whose poller gives up is still held: the buyer's outcome is *pending*, not failed, and the verdict, once issued, remains retrievable from the same endpoint.

### 7.10 `settlement_request` (firewall → settlement, only with an `allow` verdict)
Body: `cart_mandate` (full, still carrying the buyer's signature), `firewall_verdict` (full, carrying the firewall's signature), `buyer_public_key` (the buyer session key the firewall pinned at `mandate_register`, base64 — attested here because settlement has no other way to obtain it; the cart's `signature.key_id` MUST equal the SHA-256 of this key, so a substituted key cannot verify a cart it did not sign). Settlement MUST, independently of the transport-level envelope check: (a) verify the envelope is signed by the configured firewall key; (b) verify the embedded verdict's own signature; (c) verify `verdict == "allow"` and `verdict.cart_mandate_hash == cart_mandate.mandate_hash` after recomputing that hash itself (`VERDICT_MISMATCH` otherwise); (d) verify the cart mandate's buyer signature against `buyer_public_key`. Defense in depth: even a compromised firewall host cannot make settlement accept a mandate the buyer never signed. Settlement then creates a Razorpay test-mode order with the mandate hash as idempotency key, bounded retry with exponential backoff, and awaits webhook confirmation (webhook signature verified; THREAT_MODEL T8).

### 7.11 `settlement_receipt` (settlement → buyer, seller, ledger)
Body: `mandate_hash`, `razorpay_order_id`, `status` ∈ `paid` | `failed` | `refunded`, `amount`, `currency`, `timestamp_paid` (absent unless `paid`), `ledger_entry_hash`. The receipt embeds the cart mandate hash, closing the accountability chain: intent → cart → verdict → receipt, every link signed.
Settlement is asynchronous behind Razorpay's webhook (§3): the immediate HTTP response to `settlement_request` acknowledges acceptance; the parties obtain the receipt by polling `GET /receipt/{mandate_hash}` — idempotent, returning the latest signed `settlement_receipt` or a signed pending status — until `paid` or `failed`.

### 7.12 `error`
Body: `code` (from §10), `detail` (string, no secrets), `offending_message_id` if applicable. Errors never advance state; fatal errors (§10) terminate the session.

## 8. Mandates (the authorization chain)

**Intent Mandate** — authored and signed by the **principal** (not the buyer agent) before the buyer agent is instantiated; deposited with the firewall via `mandate_register` (§7.0); held buyer-side as read-only input to strategy; never revealed to the seller:

| Field | Rules |
|---|---|
| `goal` | Natural-language objective ("anniversary gift for spouse") |
| `budget_ceiling` | Hard cap, minor units. Deterministically enforced by buyer strategy AND re-checked by the firewall |
| `constraints` | Structured: `max_quantity`, `categories_allowed[]`, `deadline`, `delivery_max_days` |
| `preferences` | Soft, for LLM reasoning only |
| `max_rounds`, `valid_until` | Session limits |
| `principal_id`, `principal_public_key`, `issued_at`, `signature` | Provenance. `signature` is Ed25519 by the principal key over the JCS form of the mandate with `signature` removed (same scheme as §5) |

The firewall's layer 2 question is exactly: *does this cart mandate semantically satisfy this intent mandate?* Drift examples it must catch: quantity drift (intent implies 1, cart has 3), category drift (goal "gift", cart "server RAM"), budget drift (cart within cap but wildly inconsistent with goal).

**Cart Mandate** — §7.8. The pairing of the two, connected by `intent_mandate_ref`, is ACNP's core AP2-inspired structure.

## 9. Session state machine

States: `INIT → NEGOTIATING → AGREED → COMPLIANCE_REVIEW → SETTLING → SETTLED` with terminal alternatives `WALKED_AWAY`, `BLOCKED`, `FAILED`, `EXPIRED`.

| From | Event | To |
|---|---|---|
| — | `mandate_ack` received (buyer) / `session_init` sent or received | INIT |
| INIT | `session_ack` received / sent | NEGOTIATING |
| NEGOTIATING | `catalog_request`, `catalog_offer`, `offer`, `counter_offer`, `bundle_proposal`, `reject` | NEGOTIATING |
| NEGOTIATING | `accept` (echo verified) | AGREED |
| NEGOTIATING | `walk_away` / rounds exhausted | WALKED_AWAY |
| NEGOTIATING, AGREED | `valid_until` passed | EXPIRED |
| AGREED | `cart_mandate` submitted | COMPLIANCE_REVIEW |
| COMPLIANCE_REVIEW | verdict `allow` | SETTLING |
| COMPLIANCE_REVIEW | verdict `block` or escalation timeout | BLOCKED |
| COMPLIANCE_REVIEW | verdict `escalate` | COMPLIANCE_REVIEW (held; human decision → SETTLING or BLOCKED) |
| SETTLING | receipt `paid` | SETTLED |
| SETTLING | retries exhausted / receipt `failed` | FAILED (refund path if partially captured) |
| any non-terminal | fatal `error` (§10) | FAILED |

Terminal states: `SETTLED`, `WALKED_AWAY`, `BLOCKED`, `FAILED`, `EXPIRED`. Any message arriving in a state where it is not listed as a valid event is rejected with `STATE_INVALID`. Both agents, the firewall, and settlement each maintain the state machine independently; divergence is detectable from the ledger.

## 10. Error codes

| Class | Codes |
|---|---|
| Fatal (terminate session) | `VERSION_UNSUPPORTED`, `SIG_INVALID`, `REPLAY_DETECTED`, `SEQUENCE_GAP`, `ACCEPT_MISMATCH`, `STATE_INVALID`, `ROUNDS_EXCEEDED`, `MANDATE_EXPIRED`, `MANDATE_UNKNOWN`, `MANDATE_SIG_INVALID`, `MANDATE_CONFLICT` |
| Recoverable (reject message, session continues) | `SCHEMA_INVALID`, `TOTAL_MISMATCH`, `CLOCK_SKEW`, `RATE_LIMITED`, `ITEM_UNAVAILABLE`, `SESSION_UNKNOWN`, `CAPABILITY_UNSUPPORTED` |
| Settlement domain | `VERDICT_MISSING`, `VERDICT_MISMATCH`, `SETTLEMENT_RETRY_EXHAUSTED`, `WEBHOOK_SIG_INVALID` |

`CAPABILITY_UNSUPPORTED` is returned when a message relies on a capability the `session_ack` manifest did not advertise (e.g. a `bundle_proposal` after `bundling: false`). `SESSION_UNKNOWN` is returned for any `session_id` the receiver has no state for (other than `session_init`). Every emitted error is a ledger entry.

Ledger-only event types (not errors, never sent on the wire): `BOUNDS_CLAMPED` (seller policy engine altered an LLM proposal, §7.5), `SETTLEMENT_ATTEMPT` (each Razorpay call, §7.10), `VERIFIER_ABSENT` (layer 2 configured but no usable recommendation arrived, §7.9). `ESCALATION_TIMEOUT` is both a ledger event and the reason code carried by the resulting `block` verdict (§7.9), since that verdict is polled by the parties.

## 11. Ledger requirements

Every protocol message, firewall verdict, settlement event, clamp event (§7.5), and error MUST be written to the append-only ledger as an entry containing: `entry_seq`, `timestamp`, `entry_type`, the full canonical message (or event payload), and `prev_entry_hash` — the hash of the previous entry — forming a verifiable chain. A `verify` routine MUST be able to walk the chain end-to-end and report the first inconsistency. There are no update or delete operations, in any environment, ever.

## 12. Versioning

`version` is MAJOR.MINOR. MINOR increments add optional fields/message types only (receivers ignore unknown optional fields). MAJOR increments may break anything and require re-negotiation in `session_init`. Every spec change lands as a DECISIONS.md entry citing the section changed, plus a version bump in this header. The implementation MUST reject, not "best-effort parse," messages from unknown MAJOR versions.

## 13. Conformance checklist (used by integration tests)

An implementation conforms if it: validates schema before processing; verifies every signature against the pinned session key (or configured key for firewall/settlement/principal roles); enforces seq monotonicity and rejects replays; recomputes all totals and hashes it is asked to trust; enforces `max_rounds`; verifies `accept` echoes; audits carts only against a mandate deposited via `mandate_register`; never settles without an `allow` verdict bound to the exact mandate hash; exposes no buyer- or seller-reachable route to settlement; treats all free-text fields as untrusted LLM input; and ledger-logs every message and rejection. Each clause maps to at least one test in `docs/TEST_CHECKLIST.md` Gates 1 (protocol), 3 (firewall), 4 (settlement) and 6 (integration).

---

## Appendix A — Relationship to AP2, ACP, x402

- **Future transport bindings:** v0.1 is synchronous request/response only (§3). A v0.2 MAY add asynchronous delivery — each party exposes its own ACNP endpoint and messages are POSTed as they occur, with `in_reply_to` carrying correlation — without changing message semantics, since no message's meaning depends on the binding.
- **AP2:** ACNP adopts AP2's central idea — a verifiable chain from human intent to payment (Intent Mandate → Cart Mandate → authorization) — and its stance that agent autonomy is made safe by *artifacts*, not by trusting agent behavior. ACNP diverges by adding a multi-round negotiation phase between the mandates and by inserting an independent compliance firewall as a mandatory verdict-issuing party.
- **ACP:** shared goal of standardized agent-to-agent commerce interactions; ACNP is deliberately narrower (one buyer, one seller, one settlement rail) to stay implementable within the buildathon window while remaining honest about that scope.
- **x402:** shares the HTTP-native, machine-payable philosophy. ACNP does not use HTTP 402 semantics or per-request micropayments; settlement is a single order at the end of a negotiated session. Cite-and-diverge is the stance, but the fit for one step is concrete enough to sketch for v0.2: when a `cart_mandate` yields an `escalate` verdict, the firewall could answer **HTTP 402** with a challenge header (e.g. `ACNP-Verdict-Pending: <cart_mandate_hash>`) instead of a 200 body, telling the buyer that payment authorization is pending a decision. The buyer would then retry the same request carrying the verdict reference (`ACNP-Verdict-Ref: <cart_mandate_hash>`) once `GET /verdict/{cart_mandate_hash}` reports a terminal verdict, and receive the `allow` verdict — or a final 4xx with the `block` verdict — in the normal body. This would replace v0.1's poll-until-terminal loop (§7.9) with x402's challenge/retry shape without changing any message semantics; it is not implemented.
