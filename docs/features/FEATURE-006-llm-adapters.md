# FEATURE-006 — LLM adapter layer, both agents wired

## Scope
- **Goal:** Real free-tier models propose prices and write rationales on
  both sides — *advisory, never load-bearing*: every number still passes
  the Day 4/5 clamps, every failure falls back to the deterministic curve.
- **In scope:** `@negotiator/llm` — adapter contract, Gemini adapter,
  OpenAI-compatible adapter (Groq, Mistral) via raw `fetch`, structured
  proposal protocol (strict JSON → zod → null), retry-within-budget HTTP,
  env factory with a no-silent-downgrade boot rule; merchant + buyer wiring
  through the existing `proposedPrices` seams; per-session model and
  per-round fallback attribution; chaos E2E; demo transcript script.
- **Explicitly out of scope:** LLM re-ranking of the shortlist (allowed by
  ARCHITECTURE S2, not needed for the demo); firewall intent-verifier
  (Day 9 reuses this package); ledger persistence of clamp/fallback events
  (Day 10 — recorded in `llm_moves` + pino for now); live verification of
  Mistral (amendment #2: key-gated contract suite only).
- **Flow sections touched (FLOW.md):** F1 steps 3 and 4 (LLM drafts now
  real); one latency line for the sync binding.
- **Architecture sections touched (ARCHITECTURE.md):** S1, S2, §4 LLM
  adapter layer.
- **Risk class:** medium — first external network dependency in the
  negotiation loop; mitigated by bounded timeouts + deterministic fallback.
- **Amendments from approval:**
  1. Sync-binding latency is a written inequality, not luck: per-attempt
     LLM timeout 8s, total proposal budget 12s with retries *inside* it,
     buyer HTTP client timeout 30s > 12s + processing (FLOW F1 note; code
     comment in `http.ts` and the buyer transport).
  2. Mistral is a bonus: adapter included (OpenAI-compatible), contract
     suite key-gated, no live-verification time spent on it today.
  3. Per-message model attribution: `llm_moves` rows per round on both
     sides (model_id, used_llm, fallback_reason, latency_ms) — the evals'
     "unusable output rate per provider" costs one table now.
  - Transcript upgrades (demo): mandate goal + budget in the header;
    economics summary line (list → settled, % below list); rationale per
    line.
  - Keys: the three pasted keys are still the ORIGINAL ones (the user
    re-pasted them); rotation has NOT happened — HANDOVER keeps the
    obligation until the user confirms.

## Plan (approved before implementation)
- Ordered sub-tasks (one commit each):
  1. `@negotiator/llm`: contract + stub, retry-within-budget fetch,
     Gemini + OpenAI-compat adapters, proposal protocol, env factory,
     tests (unit + key-gated contract suite).
  2. Merchant wiring: seller proposal + rationale, `seller_model`,
     `llm_moves`, health reports provider/model.
  3. Buyer wiring: buyer proposal + rationale, `buyer_model`, `llm_moves`,
     RunResult carries mandate summary + per-message attribution; chaos
     E2E; `scripts/negotiate.mjs` demo transcript.
  4. Docs close (D015/D016 land with sub-task 1).
- New dependencies: `zod` added to `@negotiator/llm` (already in the
  workspace, MIT). No vendor SDKs (CONSTRAINTS #8).
- How verified: Gate 0; contract suite live against Gemini + Groq (real
  output pasted); T4 injection test; chaos E2E; stub determinism unchanged;
  Compose healthy with `/health` showing real providers; live transcript
  with rationales.

## Work log (append as you go; newest on top)
- 2026-08-25 [Claude Fable 5] — Feature file created after approval with
  amendments.

## Verification record
(to be filled with real output)

## Outcome
- **Status:** in progress
