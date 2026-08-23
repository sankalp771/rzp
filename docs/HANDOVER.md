# HANDOVER.md — Where Things Stand Right Now

Read this FIRST every session. This is a living record of current state, not a
history dump — keep the "Current state" section ruthlessly current and let old
handoff entries scroll down.

---

## Current state (edit in place)

**Phase:** Week 1 — not started. Repo scaffold pending.
**Done:** Documentation system initialized (this bundle).
**In progress:** —
**Broken / unverified:** —
**Do not touch / avoid:** —
**Next up (ordered):**
1. Repo scaffold + Docker Compose skeleton + CI pipeline (empty test passing)
2. PROTOCOL.md v0.1 draft — message types, field tables, state machine
3. Message signing + schema validation library (shared)
4. Merchant Commerce Server: catalog + capabilities manifest + policy config
5. Buyer Agent: intent mandate + discovery + strategy engine (no LLM yet)
6. LLM adapter layer + wire LLMs into both agents
7. End-to-end happy path: negotiate → accept → cart mandate
8. Settlement: Razorpay test-mode orders + webhooks + receipt
9. Firewall layer 1 (deterministic), then layer 2 (intent-verifier), then
   escalation queue
10. Audit ledger (hash chain) + verification routine
11. Dashboard: policy config, approval queue, session replay
12. Evals harness (50 synthetic negotiations) + metrics report
13. Threat model doc, README polish, demo seed data, pitch video assets

**Key dates:** Submission closes 5 Sept 2026. Feature freeze target: 2 Sept.
Video + README polish: 3–4 Sept.

---

## Handoff log (append one entry per session, newest on top)

Format — exactly five lines plus header:

### YYYY-MM-DD HH:MM — [model name/version]
- Did: <what was completed this session>
- Left: <what remains on the active task>
- Watch out: <traps, fragile areas, assumptions made>
- Tests: <which checklist items ran; pass/fail>
- Decisions: <"none" or pointer to DECISIONS.md entries added>

<!-- entries begin below -->
