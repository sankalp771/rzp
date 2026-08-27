# DECISIONS.md — Why, Not Just What

Log every meaningful decision with reasoning: why this over that, what
tradeoff was accepted, what was rejected. An entry without a "because" and an
"instead of" is invalid. Newest on top. Never edit past entries — supersede
them with a new entry that references the old one.

Entry format:

### DNNN — YYYY-MM-DD — <title> — [model/version or human]
- **Decision:**
- **Because:**
- **Instead of:** <rejected alternatives and why they lost>
- **Tradeoff accepted:**
- **Revisit if:** <condition under which this should be reconsidered>

---

### D024 — 2026-08-28 — One operator token for the read API; a thin console that proxies and injects secrets server-side; verification claims stay whole-ledger — [human + Claude Fable 5]
- **Decision:** Every service exposes `GET /ledger`, `GET /ledger/verify`
  and `GET /sessions` (the merchant also `GET/PUT /policy`) behind one
  shared `DASHBOARD_TOKEN` (`x-dashboard-token`; unset → 503). The
  dashboard (`dashboard/`, `:4005`, published on localhost only) is one
  static page plus a Fastify proxy `/api/:party/*` restricted to an
  allowlist of paths, which injects `DASHBOARD_TOKEN`,
  `FIREWALL_REVIEW_TOKEN` and `CONTROL_TOKEN` server-side — the browser
  never holds a secret. No new dependencies. `scripts/verify-ledgers.mjs`
  performs the same verification and cross-party comparison from a
  terminal (and verifies a copied database offline with `--db`). Any
  claim on a single session is worded "whole ledger verified ✓ + this
  session's envelopes match across parties ✓" — never "this session's
  chain verified".
- **Because:** The buyer's chain carries the principal's budget and
  preferences, which the seller's side must never read, so the read API
  cannot be open; one token is the cheapest real gate (memory rule: cheap
  fix over a non-goal). A proxy is the cheapest way to keep every secret
  out of the browser. The money shots (cross-party replay, tamper
  detection) must not depend on ~700 lines of untested UI, hence the
  terminal script (amendment #1). Chains are per service with sessions
  interleaved, so a filtered slice's `prev_entry_hash` points at other
  sessions' entries — a session is a VIEW over a verified ledger, and
  saying more would be caught by one question (amendment #3).
- **Instead of:** Per-party read tokens (right for production, four more
  secrets for a demo where the operator is every party — stated as the
  real design in THREAT_MODEL); tokens in the browser's localStorage
  (leaks on any shared screen); a framework SPA (a dependency and a build
  step for a function-over-form page); a per-session sub-chain (would
  need a second chain per session — the whole point of one chain is that
  nothing can be removed unnoticed).
- **Tradeoff accepted:** The console is a fully trusted operator surface
  with no login of its own — whoever reaches it reads every chain and acts
  as reviewer, policy owner and buyer operator. Written into THREAT_MODEL
  non-goals; the demo binds it to localhost.
- **Revisit if:** the console is ever exposed beyond localhost — then
  per-party tokens and operator identity come first.

### D023 — 2026-08-28 — One ledger library, one chain per service, no central ledger service; settlement's money chain is absorbed verbatim — [human + Claude Fable 5]
- **Decision:** `packages/ledger` implements PROTOCOL.md §11:
  `ledger_entries(entry_seq, at, entry_type, session_id, ref, payload,
  prev_entry_hash, entry_hash)` with `entry_hash = sha256(prev ‖ JCS(entry))`
  and a 64-zero genesis (D018 generalised). Each of the four services
  keeps its own chain in its own SQLite and appends every accepted
  message in, every signed message out (with the receiver, since streams
  are per receiver), every boundary rejection (without trusting the
  claimed session id), every handler rejection, and its domain events
  (`BOUNDS_CLAMPED`, `LLM_MOVE`, `VERDICT`, `VERIFIER_ABSENT`,
  `ESCALATION_DECIDED`, `ESCALATION_TIMEOUT`, `SESSION_STATE`,
  `SETTLEMENT_EVENT`). `verify()` walks the whole chain and names the
  first broken entry and why. The library exports no update and no
  delete; a test greps every workspace for one. Settlement keeps D018's
  `settlement_events` as the money chain and appends each event verbatim
  — including its money-chain `entry_hash` — as a `SETTLEMENT_EVENT`
  inside the same transaction, so a receipt's `ledger_entry_hash` is
  findable in both.
- **Because:** PROTOCOL §9 says each party keeps its own state machine and
  divergence is detectable from the ledger — that only works if each
  party's record is its own. A central ledger service would be a trusted
  party this architecture deliberately does not have, and a service that
  must call another service to record what it did has a failure mode the
  money path cannot afford (settlement must confirm money without a
  dependency, D018). The same signed envelope in two parties' chains is
  what makes "who said what" provable from either side. D018 pre-committed
  "absorb rather than re-derive" and its revisit-if was exactly "if the
  global ledger's entry format cannot embed these entries verbatim" — it
  can.
- **Instead of:** A ledger service (trusted party, extra hop on the money
  path); replacing `settlement_events` (receipts already cite its hashes;
  Day 7's Gate 5 tests keep passing); per-session chains (see D024);
  recording only messages (clamps, moves and verdict details are the
  evidence an eval or a panel asks for).
- **Tradeoff accepted:** Entries are large (full envelopes, twice for a
  cart mandate that goes to two parties); the buyer's private `receiver`
  note and the firewall's `delivery` outcome ride inside the payload and
  must be stripped before comparing envelopes across parties.
- **Revisit if:** a cross-party anchor is wanted (each party periodically
  signing its chain head into another party's chain) — v0.2 candidate.

### D022 — 2026-08-27 — The human sits above the LLM and below the policy; an escalation is decided exactly once; the queue is token-gated — [human + Claude Fable 5]
- **Decision:** An `escalate` verdict parks the cart in the firewall's
  `escalations` table (`held_since`, `expires_at`). `GET /review` and
  `POST /review/:hash {decision, reviewer, note}` are gated by
  `FIREWALL_REVIEW_TOKEN` (unset → 503, like `CONTROL_TOKEN`). A
  decision — human approve, human reject, or queue timeout — is claimed
  with `UPDATE escalations SET status='decided' … WHERE status='pending'`
  in the SAME synchronous transaction that appends the human verdict
  (seq n+1 on the append-only `verdicts` table) and moves the session;
  `changes === 0` means someone else decided first → `ALREADY_DECIDED`
  (HTTP 409 with the standing verdict), never a further verdict. Approve
  re-runs layer 1 at decision time by the firewall's clock; a failed
  re-check yields `block/policy` with the layer-1 reasons — a human can
  override semantic doubt, never policy. Approve → `allow/human/
  [HUMAN_APPROVED]` then the same dispatch + seller-notify path as an
  immediate allow; reject → `block/human/[HUMAN_REJECTED]`; timeout →
  `block/human/[ESCALATION_TIMEOUT]`, evaluated lazily on every
  `/verdict` and `/review` read and by an unref'd timer
  (`FIREWALL_ESCALATION_SWEEP_MS`). The buyer treats a hold whose poll
  window (`VERDICT_POLL_TIMEOUT_MS`, 120 s) closes as `pending`, never
  `failed`. Recorded in PROTOCOL.md §7.9.
- **Because:** With a lazy sweep AND a timer AND a human endpoint, a human
  approving at second 599.9 while the sweep marks timeout would otherwise
  append seq 2 = timeout-block and seq 3 = human-allow and dispatch money
  on a cart already announced as blocked — the approval amendment closed
  exactly this: first decision wins, atomically (same family as
  FEATURE-008 #3, `MANDATE_IN_REVIEW`). Re-running layer 1 on approve
  keeps expiry, velocity and one-mandate rules deterministic even when a
  human is in the loop. A token on the queue is one env var and five
  lines (memory rule: cheap real fix over a non-goal). Lazy + timer
  because fake-clock tests need determinism and an unpolled hold must
  still expire.
- **Instead of:** A mutable "current verdict" column (would violate the
  append-only rule and hide the history); letting the human override
  layer 1 (a human cannot un-expire a mandate); a timer-only sweep (an
  unpolled test hold never expires; a polled one could return stale
  state); an unauthenticated `/review` declared as a non-goal (the fix is
  cheaper than the sentence); treating a closed buyer poll window as
  `FAILED` (a lie — the cart is still held and decidable).
- **Tradeoff accepted:** A held buyer run cannot resume after its window
  closes (v0.1 prints the hash; Day 10 carries "resume a held session");
  the human queue is a bearer token, not operator auth (demo grade, stated
  in `.env.example`).
- **Revisit if:** the dashboard (Day 10) adds real operator identity — the
  token then becomes its session, not the API's.

### D021 — 2026-08-27 — Layer 2 can only narrow, never widen; `stub` means no verifier; three providers, three roles — [human + Claude Fable 5]
- **Decision:** `services/firewall/src/intent.ts` is the only firewall
  module that may import `@negotiator/llm` (source-search test). It asks
  one question — does this cart semantically satisfy the STORED mandate?
  — with the principal's text and the seller's snapshots both fenced as
  untrusted, and returns a strict-JSON recommendation
  `{recommendation, reasons: INTENT_DRIFT_*[], summary}` or `absent`
  (timeout, 429, non-JSON, unknown code, schema miss). `applyVerdict`
  (verdict.ts, pure data, no LLM import) maps it: clean `allow` → allow
  (`layer: intent_verifier`); `block` with ≥1 reason → block; `escalate`
  → escalate; absent → escalate; self-inconsistent (`allow` carrying
  reasons, `block` carrying none) → escalate. No input yields an allow
  layer 1 did not already grant. `FIREWALL_LLM_PROVIDER` unset/`stub` →
  `'not_configured'` (layer 1 only, `layer: policy` on every verdict,
  loud in `/health` and the log); a named provider with a missing key
  refuses to boot (D015). The verifier gets its own budget
  (`FIREWALL_LLM_BUDGET_MS`, 8 s) so `30 s > 8 + 8 + 5 + processing`
  holds. The demo runs Gemini (buyer), Groq (seller), Mistral (firewall).
- **Because:** CONSTRAINTS #6 — the LLM recommends, code decides — is
  only meaningful if the decision table is exhaustive and written down;
  the self-consistency rule means the applier trusts only explanations
  that agree with themselves, so a confused model is a hold, not a
  decision. D020 pre-committed absence → escalate; this entry makes the
  rest of the table equally explicit. A stub auditor that allowed
  everything would be a fake, and one that answered nothing would
  escalate every key-less quickstart run — "not configured, loudly" is
  the honest third option. Separate providers per role mean a
  rate-limited buyer (Gemini 429s on Day 8) never starves the verifier.
- **Instead of:** Mapping an LLM `block` to `escalate` always (safer, but
  the spec allows layer-2 block, block does not consume the mandate, and
  an unexplained block still escalates); a confidence score (unfalsifiable
  and overfit); letting the verifier see the database or the dispatch
  path (it returns data only — the source-search test proves it cannot
  reach storage, the wire, or settlement); a shared 12 s budget (5 s of
  slack under the buyer's 30 s window).
- **Tradeoff accepted:** A block from a flaky model on a benign cart is a
  false block — it costs the buyer a renegotiation, not money; the Day 11
  evals measure the false-block and false-allow rates per model. Live
  models may still allow the flagship hamper — that transcript is a
  finding (the human layer above it exists for this), not a failed demo.
- **Revisit if:** the evals show a provider's false-allow rate on the
  drift fixtures is material — then the default for that provider's
  `allow` on flagged categories becomes `escalate`.

### D020 — 2026-08-26 — The verdict applier is the only decider; the layer-2 slot is explicit and its absence means escalate; dispatch happens inside the verdict — [human + Claude Fable 5]
- **Decision:** `applyVerdict(layer1, layer2)` in `services/firewall/src/verdict.ts`
  is the single place a verdict is decided (CONSTRAINTS #6). Layer 1
  blocks alone. The layer-2 argument is the literal `'not_configured'`
  on Day 8 and becomes a union with an explicit recommendation object on
  Day 9; the written pre-commitment is that once layer 2 is configured a
  missing, failed, malformed or timed-out recommendation maps to
  `escalate`, never `allow`. On `allow` the firewall dispatches the
  `settlement_request` (embedding the very verdict envelope the buyer
  receives, plus the attested `buyer_public_key`) and delivers the
  verdict to the seller BEFORE replying to the buyer; a failed or
  timed-out dispatch leaves the signed allow standing and records
  `settlement_dispatched = 0` + the error on the cart row, so the
  invariant is "allow with dispatch success ⇒ a receipt row exists" and
  the buyer's outcome becomes `pending` with bounded polling. The
  firewall bounds its own outbound waits (8 s dispatch, 5 s notify) so
  the buyer's 30 s client timeout holds.
- **Because:** D015's fallback-to-curve is right for agents (a model
  that cannot think still negotiates inside deterministic bounds) and
  wrong for a verifier (a verifier that cannot think must not wave money
  through); writing the rule into the type today means Day 9 cannot
  inherit the wrong default by accident. Dispatching inside the verdict
  gives the demo a clean "buyer hears allow → receipt exists" story;
  keeping the verdict truthful when settlement is down keeps compliance
  and payment as separate facts, both visible.
- **Instead of:** Deciding the verdict where the LLM answer lands (Day 9
  would then own the money decision); replying the verdict first and
  dispatching after (the buyer would poll a 404 for a while and the
  invariant would be fuzzy); turning a dispatch failure into a `block`
  (a lie — the purchase was compliant).
- **Tradeoff accepted:** A failed dispatch is not retried in v0.1 — the
  row says so, Day 10 may resume it; the verdict reply carries the
  dispatch latency.
- **Revisit if:** an async binding (Appendix A) arrives — dispatch then
  moves out of the reply path.

### D019 — 2026-08-26 — Cart line items carry the seller's snapshot; one mandate, one purchase (pending escalate counts); seq streams are per receiver — [human + Claude Fable 5]
- **Decision:** (1) `cart_mandate.line_items[]` gain `catalog_item`, the
  seller's exact snapshot from `catalog_offer`; every receiver recomputes
  `catalog_hash` over it and the firewall reads the seller-declared
  `category` from it (PROTOCOL §7.8). (2) An Intent Mandate is consumed
  by its first `allow` (`MANDATE_ALREADY_USED`); a cart held in
  `escalate` also counts as in use (`MANDATE_IN_REVIEW`); a `block` does
  not consume it. Velocity limits are keyed by `principal_id`. The demo
  seed therefore signs a fresh mandate per run. (3) Sequence streams are
  per (session, sender, receiver); `message_id` uniqueness stays
  session-wide across streams (§6).
- **Because:** (1) The firewall never sees the catalog, so
  `CATEGORY_BLOCKED` — the layer-1 catch of the flagship scenario — was
  unimplementable without the item on the wire; the snapshot form lets
  the hash be recomputed by anyone and lets the seller's copy prove a
  relabelled-and-re-hashed item post hoc. (2) Without single use, a
  corrupted agent could run a hundred sessions each "within budget" on
  one ₹5,000 authorization; without the escalate rule a second cart
  could race a human decision. Per-principal velocity survives the
  per-run mandate. (3) Day 7 already assumed settlement sees the
  firewall from seq 1; the buyer now talks to two receivers in one
  session and each receiver can only count what it sees.
- **Instead of:** Copying only `category`/`title` into the line item
  (uncheckable against the hash); having the firewall fetch the catalog
  from the merchant (a second trust path and a session it does not
  have); carrying the seller-signed `catalog_offer` envelope (correct,
  larger, and the firewall still could not tell a fabricated seller from
  a real one without a seller PKI — a v0.2 candidate named in THREAT_MODEL
  T1); a single global seq per sender (every receiver would see gaps).
- **Tradeoff accepted:** The firewall cannot prove the seller produced
  the snapshot — detection of a re-hashing buyer is post hoc via the
  seller copy. A legit agent that re-registers a used mandate under a
  new session key is refused with `MANDATE_CONFLICT` at registration,
  before the cart stage.
- **Revisit if:** a seller signs its snapshots (then the firewall verifies
  provenance directly) or multi-purchase mandates are needed (then a
  spend counter replaces single use).

### D018 — 2026-08-25 — Settlement keeps its own append-only hash chain; the receipt's `ledger_entry_hash` is real from day one — [human + Claude Fable 5]
- **Decision:** `settlement_events` is an append-only, per-mandate hash
  chain (`sha256(prev ‖ JCS(entry))`, genesis = 64 zero nibbles) with a
  `verifyChain` routine. The `settlement_receipt.ledger_entry_hash` is the
  entry hash of the confirming event (`PAYMENT_CONFIRMED` / failure). No
  update or delete path exists for the table; a test greps the source
  tree for one. Day 10's global ledger absorbs this table rather than
  replacing it.
- **Because:** The receipt schema requires the field and a placeholder
  would be a lie on the wire; the money path is exactly where an audit
  chain matters most; building the chain here lets Gate 5's tamper test
  run three days early on the highest-value data.
- **Instead of:** Emitting a dummy hash until Day 10 (fabricated
  evidence); standing up the ledger service today (out of scope, and
  settlement must not depend on another service to confirm money).
- **Tradeoff accepted:** Two chains until Day 10 folds them; the Day 10
  ledger must import rather than re-derive these entries.
- **Revisit if:** the global ledger's entry format cannot embed these
  entries verbatim.

### D017 — 2026-08-25 — Razorpay idempotency = local mandate key + receipt correlation; the card tap is simulated by a self-signed webhook — [human + Claude Fable 5]
- **Decision:** One `settlements` row per `mandate_hash` (local idempotency,
  CONSTRAINTS #10); Razorpay's 40-char `receipt` field carries the first
  40 hex chars of the hash and `notes` the full hash; before every create
  attempt settlement looks the order up by receipt and reuses it. Payment
  confirmation: the buyer is an agent with no card, so after the real
  test-mode order exists, settlement posts a correctly HMAC-signed
  `order.paid` event to its own verifier (`PAYMENT_SIMULATION`, code
  default OFF, loud at boot and in `/health`). Real inbound webhooks
  need a public HTTPS endpoint; v0.1 has none (no tunnels).
  `ORDER_STATUS_POLL` optionally cross-checks the Orders API.
- **Because:** Razorpay's Orders API has no idempotency header, so the
  correlation must be ours; the receipt lookup closes the crash window
  between "created" and "persisted". A real order id in the receipt and
  in the Razorpay dashboard is the "settles through Razorpay" claim; the
  simulated tap exercises the exact verifier a real webhook would hit.
- **Instead of:** Payment Links / hosted checkout (needs a human and a
  browser mid-demo); a tunnel for real webhooks (fragile, out of scope);
  skipping Razorpay for a pure simulator (would gut the claim).
- **Tradeoff accepted:** `payment.captured` never truly happens in test
  mode for the demo; the receipt says so through the simulation flag and
  the `source` field on the confirming event.
- **Revisit if:** a public endpoint or an agent-payable rail (UPI
  autopay / tokens) becomes available.

### D016 — 2026-08-25 — Provider adapters are raw `fetch`; Groq and Mistral share one OpenAI-compatible adapter — [human + Claude Fable 5]
- **Decision:** No vendor SDKs. `GeminiAdapter` speaks the generativelanguage
  REST API; `OpenAiCompatAdapter` speaks the chat-completions shape for Groq
  and Mistral (endpoint selected by `baseUrl`). All calls go through one
  budgeted `fetchWithBudget`. Model ids are env-overridable with defaults
  verified live and pinned in code comments.
- **Because:** CONSTRAINTS #8 is easiest to prove when the only provider
  code is ~150 lines in one package; three SDKs would triple the
  supply-chain surface for zero demo value, and the OpenAI shape is the de
  facto standard so one adapter covers two providers (and any future one).
- **Instead of:** Official SDKs (heavier, three dependency trees, each with
  its own retry semantics that would fight our budget); a single aggregator
  (D008 already rejected OpenRouter).
- **Tradeoff accepted:** We own the request/response shapes; a provider
  API change breaks us visibly (the contract suite exists for this — it
  caught a retired Groq model id and Gemini thinking-token starvation on
  day one).
- **Revisit if:** a provider drops its REST shape or json mode.

### D015 — 2026-08-25 — LLMs are advisory with deterministic fallback; no silent stub downgrade — [human + Claude Fable 5]
- **Decision:** Each side asks its model for `{proposed_prices, rationale}`
  once per round. Any failure — transport, timeout, rate limit, non-JSON,
  schema miss, unknown variant id — yields `null` and the deterministic
  curve proceeds; the fallback is recorded per round (`llm_moves`) and per
  session. Provider selection: unset → stub; a named provider with a
  missing key REFUSES TO BOOT; `/health` reports the effective provider.
  Latency is bounded by an explicit inequality: per-attempt 8s, total
  proposal budget 12s with retries inside it, buyer HTTP timeout 30s.
- **Because:** The demo and the 50-session eval must survive free-tier
  429s and flaky JSON without dying or degrading silently; the safety story
  (CONSTRAINTS #5/#6) already says the model only proposes, so "model
  unavailable" is just "no proposal". A silent stub downgrade would let a
  demo run on canned output while claiming a provider — the worst kind of
  quiet lie in front of a panel.
- **Instead of:** Hard-failing the round on LLM error (kills demos on a
  rate limit); retrying until success (unbounded, violates CONSTRAINTS #10
  spirit); defaulting to stub when a key is missing (silent downgrade).
- **Tradeoff accepted:** A run can silently-to-the-counterparty be partly
  deterministic; mitigated by per-round attribution so the evals report
  the unusable-output rate per provider honestly.
- **Revisit if:** the firewall's intent-verifier (Day 9) needs a different
  failure policy — it must, since "no verdict" cannot mean "allow".

### D014 — 2026-08-25 — Buyer runs are triggered by a token-gated control endpoint — [human + Claude Fable 5]
- **Decision:** The buyer exposes `POST /control/run` (shared-secret header
  `x-control-token` = `CONTROL_TOKEN`; refuses to serve when unset), which
  executes one negotiation and returns the full transcript. The demo, the
  operator, and the Day 11 evals harness all use this one seam.
- **Because:** An unauthenticated endpoint that triggers a spending workflow
  is a question the panel will ask; a shared secret is one env var and a few
  lines, and a single run-trigger seam means the evals harness needs no new
  surface later.
- **Instead of:** (a) an unauthenticated endpoint documented as a non-goal —
  answerable but weaker for the same effort; (b) a one-shot CLI script —
  no seam for evals, and no way to trigger runs inside Compose networking.
- **Tradeoff accepted:** Shared-secret auth is demo-grade (no rotation, no
  per-caller identity) — recorded in THREAT_MODEL.md non-goals.
- **Revisit if:** the dashboard (Day 10) grows real operator auth to sit in
  front of it.

### D013 — 2026-08-24 — Synchronous transport binding for ACNP v0.1 — [human + Claude Fable 5]
- **Decision:** v0.1 binds ACNP to synchronous HTTP request/response: the
  reply message rides in the 200 response body; inherently-async outcomes
  (escalation, settlement receipt) are polled via signed idempotent status
  endpoints (PROTOCOL.md §3, §7.9, §7.11). Async delivery noted as a v0.2
  candidate in Appendix A.
- **Because:** Debuggability (one request shows both sides of an exchange),
  and Day 5's stubbed buyer needs no inbound HTTP server; message semantics
  are binding-independent so nothing is painted into a corner.
- **Instead of:** Webhook-style async POSTs both ways — more "real" but
  doubles the surface (two servers, retries, ordering) for zero demo value
  in a two-week window.
- **Tradeoff accepted:** Long negotiations hold HTTP connections; polling
  adds latency to escalation/receipt paths. Both irrelevant at demo scale.
- **Revisit if:** v0.2, or if a judge asks for true agent-to-agent async.

### D012 — 2026-08-23 — Ed25519 and SHA-256 via `node:crypto`; JCS hand-rolled — [human + Claude Fable 5]
- **Decision:** Signatures and hashes use Node 22's built-in `node:crypto`
  (Ed25519 is native since Node 12). RFC 8785 canonicalization is ~30 lines
  of our own code, pinned by the RFC's test vector. Supersedes the
  `@noble/ed25519` line of D006.
- **Because:** Zero crypto dependencies means one less supply-chain link to
  defend in front of a payments panel, and the runtime's crypto is already
  audited. Our JSON subset (strings, integers, booleans, null, arrays,
  objects — floats are banned by PROTOCOL.md §3) makes JCS equal to
  `JSON.stringify` with recursively sorted keys, so a library adds risk
  surface without adding correctness.
- **Instead of:** `@noble/ed25519` (fine library, but redundant on Node 22)
  and the `canonicalize` npm package (correct, but opaque on a slide).
- **Tradeoff accepted:** Not portable to browsers without a shim — the
  dashboard verifies via the services, never client-side.
- **Revisit if:** a float or non-BMP string edge case ever reaches the
  canonicalizer — then adopt `canonicalize` and keep our tests.

### D011 — 2026-08-23 — Firewall, not buyer, calls Settlement — [human + Claude Fable 5]
- **Decision:** `settlement_request` is sent firewall → settlement and
  carries both the buyer-signed cart mandate and the firewall-signed
  verdict. Settlement accepts requests only from the configured firewall key
  and still re-verifies the verdict and mandate signatures itself. Buyer and
  seller agents have no route to settlement (PROTOCOL.md §7, §7.10).
- **Because:** A single trusted caller makes "no LLM output can trigger
  settlement" (CONSTRAINTS #6) a property provable by code search, not by
  argument; ARCHITECTURE.md and FLOW.md already assumed this shape and the
  draft spec contradicted them.
- **Instead of:** Buyer → settlement with a verdict reference (draft §7.10),
  which leaves a buyer-reachable settlement endpoint to defend.
- **Tradeoff accepted:** The firewall becomes a relay; if it is down,
  settlement cannot be reached — acceptable, it is the point of a firewall.
- **Revisit if:** multi-firewall or third-party-firewall topologies appear
  (out of scope for v0.1).

### D010 — 2026-08-23 — Principal-signed Intent Mandate registered with the firewall up front — [human + Claude Fable 5]
- **Decision:** The Intent Mandate is signed by a long-lived principal key
  (distinct from any agent session key) and deposited with the firewall via
  a new `mandate_register` message before `session_init`. The firewall audits
  carts only against its stored copy (PROTOCOL.md §5, §7.0, §8).
- **Because:** The draft had the buyer agent both sign the mandate and hand
  it to the firewall at settlement time — a corrupted buyer agent could
  re-author its own authorization, which silently defeats the flagship
  intent-drift demo (THREAT_MODEL T5). Registration up front gives the
  firewall a reference that cannot move after negotiation starts, which is
  the AP2 principle the protocol claims to follow (D003).
- **Instead of:** Mandate carried in `settlement_request` (draft FLOW F1 step
  7), or signed by the buyer agent's session key.
- **Tradeoff accepted:** One extra message type and a demo-seeded principal
  keypair; the firewall now holds per-session state before a session exists.
- **Revisit if:** never — it is the trust root of the whole firewall story.

### D009 — 2026-08-23 — Docs bundle flattened to repo root — [human + Claude Fable 5]
- **Decision:** `negotiator-docs/` packaging folder removed; `docs/` lives at
  the repo root, `CLAUDE.md` and `PROTOCOL.md` at the root, `README-DOCS.md`
  parked under `docs/` until merged into the real README.
- **Because:** `CLAUDE.md` references `docs/HANDOVER.md` etc.; a nested
  bundle makes every path reference wrong or longer.
- **Instead of:** Keeping the bundle and rewriting every path in CLAUDE.md.
- **Tradeoff accepted:** None material.
- **Revisit if:** never.

### D008 — 2026-08-23 — LLM providers: Gemini primary, Groq and Mistral secondary — [human + Claude Fable 5]
- **Decision:** Adapter interface built first; concrete adapters in order
  Gemini → Groq → Mistral. All three on free tiers, keys rotated via `.env`.
  Buyer and seller may run on different providers; model-per-side is recorded
  in every session.
- **Because:** Two or more working adapters prove the model-agnostic seam is
  real rather than theoretical. Gemini pairs narratively with AP2 (a Google
  spec). Multiple free-tier keys give headroom against rate limits during the
  50-session eval run.
- **Instead of:** OpenRouter as a single aggregator — kept as documented
  fallback only, to avoid one more account and a less direct story.
- **Tradeoff accepted:** Three adapters to keep working; mitigated by a
  shared contract test run against each.
- **Revisit if:** a provider's free tier blocks evals — swap order, do not
  add a fourth without a D-entry.

### D007 — 2026-08-23 — SQLite (better-sqlite3) per service — [human + Claude Fable 5]
- **Decision:** Each service owns a SQLite file; ledger, sessions, policy
  config, and escalation queue all live in SQLite.
- **Because:** Zero-infra `docker compose up` is a judged quality; the Gate 5
  tamper demo (edit a row out-of-band, watch chain verification catch it)
  is trivially legible with a file DB.
- **Instead of:** Postgres — more "production" but adds a container, startup
  ordering, and migrations for no demo benefit.
- **Tradeoff accepted:** Not horizontally scalable; irrelevant for a
  reference implementation.
- **Revisit if:** a service needs concurrent writers from multiple
  processes.

### D006 — 2026-08-23 — TypeScript monorepo (Node 22, pnpm workspaces) — [human + Claude Fable 5]
- **Decision:** One language end to end. Stack: pnpm workspaces, zod for
  schemas (exported to JSON Schema so PROTOCOL.md and validators share one
  source), `@noble/ed25519` for signatures, fastify for HTTP, vitest for
  tests. Node and pnpm versions pinned (`engines`, `.nvmrc`,
  `packageManager`).
- **Because:** The human defending the code live is a JS/TS developer; the
  dashboard (demo money-shot) gets first-class attention instead of being a
  second stack; spec and code cannot drift when schemas are one source.
- **Instead of:** Python/FastAPI — LLM plumbing advantage is moot when all
  providers are called over HTTP through an adapter.
- **Tradeoff accepted:** Slightly heavier container images than Python.
- **Revisit if:** never within this submission.

### D005 — 2026-08-23 — Two-layer firewall with deterministic verdict application — [human + Claude]
- **Decision:** Compliance firewall = deterministic policy engine (can
  hard-block alone) followed by an LLM intent-verifier that only recommends
  allow/block/escalate; deterministic code applies the verdict.
- **Because:** Money movement can never depend on unvalidated LLM output; the
  LLM adds semantic drift detection the rule engine can't express.
- **Instead of:** LLM-only firewall (unreliable, unexplainable) or rules-only
  (misses intent drift — the flagship demo).
- **Tradeoff accepted:** Two components to build and test instead of one.
- **Revisit if:** never — this is a submission-defining invariant.

### D004 — 2026-08-23 — Ed25519 per-agent signatures over canonical JSON — [human + Claude]
- **Decision:** Every protocol message signed with per-agent Ed25519 keys
  over a canonical serialization; unsigned/invalid messages rejected at the
  boundary.
- **Because:** Makes the audit trail cryptographically verifiable rather than
  a trust-me log; small, fast, well-supported primitive.
- **Instead of:** No signatures (just logs — weak story) or full mTLS PKI
  (overkill for two weeks, worse demo legibility).
- **Tradeoff accepted:** Must define canonical serialization carefully to
  avoid signature mismatch bugs.
- **Revisit if:** canonicalization bugs eat more than a day — fall back to
  signing a hash of a stable field ordering.

### D003 — 2026-08-23 — Protocol modeled on AP2 mandate structure — [human + Claude]
- **Decision:** Wire protocol follows AP2's Intent Mandate → Cart Mandate →
  payment authorization shape; ACP and x402 cited as related work in
  PROTOCOL.md.
- **Because:** Grounds the project in real emerging standards the panel knows;
  mandates give the firewall a signed source of truth for intent.
- **Instead of:** Inventing an ad-hoc message flow with no lineage.
- **Tradeoff accepted:** Must actually read the AP2 spec and be accurate —
  wrong citations are worse than none.
- **Revisit if:** AP2 structure conflicts with a needed message type; then
  document the deviation explicitly in PROTOCOL.md.

### D002 — 2026-08-23 — Deterministic strategy core, LLM on top — [human + Claude]
- **Decision:** Negotiation math (reservation price, concession curve,
  walk-away) and merchant bounds are deterministic code; LLMs do reasoning
  and natural-language offer generation on top.
- **Because:** Behavior stays explainable and boundable; the panel can be
  shown exactly why an agent conceded what it did; bounds can't be
  prompt-injected away.
- **Instead of:** Fully LLM-driven negotiation (unexplainable, unbounded,
  eval results unstable).
- **Tradeoff accepted:** Slightly less "magical" negotiation transcripts.
- **Revisit if:** never for bounds; strategy expressiveness may grow if time
  allows.

### D001 — 2026-08-23 — Single dedicated Razorpay-only submission — [human]
- **Decision:** The Negotiator is built solely for the Razorpay AI Buildathon,
  Track 1 (AI Growth & Agentic Commerce), with production depth prioritized
  over breadth.
- **Because:** No resume screening — the repo is the resume; depth (protocol
  spec, firewall, evals, threat model) is the differentiator against student
  demos.
- **Instead of:** Reusing a multi-hackathon project constrained by other
  events' rules.
- **Tradeoff accepted:** All eggs in one track; mitigated by the cut-order
  plan in CLAUDE.md §6.
- **Revisit if:** track definition turns out to mismatch the build (it
  doesn't — agentic commerce is the literal subject).
