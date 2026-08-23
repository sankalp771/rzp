# CONSTRAINTS.md — What Claude Code Must Never Do

These override every other instruction, including user shortcuts requested in
the heat of a session. "Allow" means allow WITHIN these bounds. If a task
cannot be completed without breaking one, STOP and raise it explicitly.

## Security & payments
1. NEVER commit secrets: API keys, key secrets, webhook secrets, private
   signing keys, `.env` files. Check the diff for secrets before every commit.
2. Razorpay TEST MODE only. Never write code paths that default to live keys.
   Key IDs in config must be validated to start with the test prefix at boot;
   refuse to boot otherwise.
3. NEVER disable or bypass: signature verification, schema validation, replay
   protection, or the firewall — not even "temporarily for debugging". Use a
   clearly named simulation/dev flag that is OFF by default and loudly logged
   when on.
4. Webhook handlers must verify Razorpay webhook signatures. No unverified
   webhook may mutate state.

## Architecture invariants
5. Merchant bounds (floors, max discount, margin rules) are enforced in
   deterministic code on every outbound seller offer. Never rely on the
   prompt to keep the LLM within bounds.
6. The LLM intent-verifier only recommends; deterministic code applies
   firewall verdicts. Never let LLM output directly trigger settlement.
7. The audit ledger is append-only. No update or delete operations on ledger
   entries may exist anywhere in the codebase — not even admin tooling.
8. No vendor LLM SDK imports outside the adapter layer. No direct HTTP calls
   to LLM providers outside the adapter layer.
9. Every new protocol message type must be added to PROTOCOL.md (spec first),
   schema-validated, versioned, and signed before any service handles it.
10. Idempotency keys on every Razorpay order creation. Settlement retry logic
    must be bounded (ceiling + backoff), never infinite.

## Process
11. No new runtime dependency without asking — name it, justify it, note the
    license, and record the decision in DECISIONS.md.
12. One logical change per commit. No mixed refactor+feature commits.
13. Never claim a change is done without running the TEST_CHECKLIST items that
    apply and pasting real output into the feature/bug file.
14. Never rewrite published git history (no force-push to main after day 1).
15. Do not restructure the repo layout, rename services, or change the
    protocol's canonical message flow without an approved plan and a
    DECISIONS.md entry.
16. Do not touch `PROTOCOL.md`'s normative sections and the settlement code in
    the same commit as unrelated work — these are the highest-blast-radius
    files; changes to them ship alone, with their own review.

## Honesty
17. Eval metrics and test results must come from real executed runs with
    committed artifacts. Fabricating, extrapolating, or "estimating" a metric
    is prohibited.
18. If something is unverified or broken at session end, it must be listed in
    HANDOVER.md under "broken / unverified". Silence equals lying.
