# FEATURE-009 — Firewall layer 2 (intent-verifier) + escalation queue + the semantic flagship

## Scope
- **Goal:** The Compliance Firewall's second layer exists: an LLM
  intent-verifier reads the cart and the STORED Intent Mandate and answers
  one question — *does this cart semantically satisfy this mandate?* — and
  may only narrow the deterministic layer's allow (veto or hold), never
  widen it. Escalations land in a token-gated human queue with approve /
  reject / timeout, all three exercised live through the buyer's `/verdict`
  poll. The flagship demo becomes semantic: a cart every layer-1 number
  waves through is stopped (or held) on meaning alone.
- **In scope:** `services/firewall/src/intent.ts` (the only firewall file
  that may import `@negotiator/llm`); `Layer2Input` union + applier rules;
  `escalations` table + `/review` endpoints (`x-review-token`); human
  verdict re-issue (append-only `verdicts`, seq 2) with a layer-1 re-check;
  timeout sweep (lazy on read + unref'd timer); `FIREWALL_LLM_PROVIDER` /
  `FIREWALL_LLM_BUDGET_MS` wiring; merchant escalate → held → human verdict;
  buyer hold → `pending` (never `FAILED`) with `VERDICT_POLL_TIMEOUT_MS`;
  seed `itm_corp_hamper`; `scripts/review.mjs`; `negotiate.mjs` hold banner
  + layer rendering; spec: human-layer reason codes.
- **Explicitly out of scope:** the dashboard UI over `/review` (Day 10 —
  the endpoints are shaped for it); the global ledger (Day 10 absorbs
  `verdicts`, `escalations`, `verifier_json`); resuming a held buyer run
  after its poll window closes (Day 10 carry-forward — the run ends
  `pending` with the hash printed); prompt-injection live trials against
  the verifier (Day 11/12 candidate); `bundle_proposal` (cut candidate #4).
- **Flow sections touched (FLOW.md):** F1 step 7 (layer 2 real); F3
  escalate (queue, human, timeout).
- **Architecture sections touched (ARCHITECTURE.md):** S4.
- **Risk class:** HIGH — the firewall is the trust root of the money path
  (CONSTRAINTS #3, #6, #8, #9, #16: spec change shipped alone).
- **Amendments from approval:**
  1. **First decision wins, atomically.** An escalation moves from
     `pending` to `decided` exactly once, inside one DB transaction. A late
     human decision gets `ALREADY_DECIDED` (HTTP 409 with the standing
     verdict); a late timeout sweep skips a decided row. Two race tests:
     approve-after-timeout → rejected, no third verdict; sweep-after-approve
     → no second verdict. Recorded in D022. Same family as FEATURE-008
     amendment #3 (`MANDATE_IN_REVIEW`): closing the race window around
     the human.
  2. If Mistral allows the hamper live, that transcript is KEPT and
     reported as a layer-2 false-allow finding (the human layer above it
     and the Day 11 false-allow/false-block metrics exist for exactly
     this) — not retried until green.

## Design (approved)
- **Layer 2 can only narrow.** Applier table (`verdict.ts`):
  | layer 1 | layer 2 input | verdict | layer |
  |---|---|---|---|
  | block | (never consulted) | block | policy |
  | allow | `not_configured` | allow | policy |
  | allow | recommendation `allow`, no reasons | allow | intent_verifier |
  | allow | recommendation `block`, ≥1 reason | block | intent_verifier |
  | allow | recommendation `escalate` | escalate | intent_verifier |
  | allow | absent (timeout, 429, non-JSON, unknown code, schema miss) | escalate | intent_verifier |
  | allow | self-inconsistent (`allow` with reasons / `block` without) | escalate | intent_verifier |
- **`FIREWALL_LLM_PROVIDER` unset/`stub` ⇒ `not_configured`** (layer 1
  only, visible in `/health`, log, and `layer: policy` on every verdict);
  a named provider with a missing key refuses to boot (D015).
- **Human above the LLM, below the policy:** approve re-runs layer 1 at
  decision time; approve ⇒ `allow`/`human`/`[HUMAN_APPROVED]` then the same
  dispatch + notify path as an immediate allow; reject ⇒
  `block`/`human`/`[HUMAN_REJECTED]`; timeout ⇒
  `block`/`human`/`[ESCALATION_TIMEOUT]`.
- **Review endpoints token-gated** (`FIREWALL_REVIEW_TOKEN`; unset → 503).
- **Buyer:** hold past the window ⇒ outcome `pending` (`HELD_IN_REVIEW`),
  state stays `COMPLIANCE_REVIEW`; `VERDICT_POLL_TIMEOUT_MS` default 120 s.
- **Latency inequality:** `BUYER_HTTP_TIMEOUT_MS (30 000) >
  FIREWALL_LLM_BUDGET_MS (8 000) + FIREWALL_DISPATCH_TIMEOUT_MS (8 000) +
  FIREWALL_NOTIFY_TIMEOUT_MS (5 000) + processing`.
- **Semantic flagship item:** `itm_corp_hamper` — category `gifts`,
  ₹4,800 list / ₹4,000 floor, "pack of 12 logo-branded desk calendars for
  client distribution": every layer-1 number passes; semantics do not.
- **Mistral takes the firewall role live** (three providers, three roles).

## Plan (approved before implementation)
- Ordered commits (one logical change each):
  1. spec(protocol): §7.9 human-layer reason codes + narrow-only rule +
     human re-runs layer 1; §10 `ESCALATION_TIMEOUT` is on the wire. Alone.
  2. feat(firewall): `intent.ts` + `Layer2Input` union + applier rules;
     unit tests for every row of the table.
  3. feat(firewall): escalation queue — table, `/review`, human re-issue
     with layer-1 re-check and first-decision-wins, sweep, provider wiring,
     `/health`; HTTP tests incl. both race directions, "verifier down →
     escalate never allow", "approve after expiry → still blocked".
  4. feat(merchant): escalate → held; human verdict on the seller stream.
  5. feat(merchant): seed `itm_corp_hamper`.
  6. feat(buyer): hold → pending; `VERDICT_POLL_TIMEOUT_MS`; testkit
     `firewallLlm`/`reviewToken`; E2E: semantic block, escalate→approve→
     SETTLED, escalate→reject→BLOCKED, timeout→BLOCKED, benign passes
     without escalation, verifier absent → escalate.
  7. feat(demo): `scripts/review.mjs`; `negotiate.mjs` hold banner + layer;
     `gen-keys` + `.env.example` + compose.
  8. docs close + D021/D022 + tag `known-good-2`.
- New dependencies: none.
- How verified: Gate 0 every commit; Gate 1 for commit 1; Gate 3 all five
  items; Gate 6 escalate scenario in CI; Compose live with Mistral as the
  firewall: benign → `layer: intent_verifier` allow → real order; hamper →
  whatever Mistral says; approve-to-SETTLED and reject-to-BLOCKED runs;
  relay layer-1 regression. Transcripts read top to bottom.

## Implementation log
(appended as commits land)

## Verification record
(real commands, real output — appended at close)

## Outcome
(at close)
