# BUG-006 — Spec/code drift found by the Day 12 field-by-field reconciliation

> Not a single defect: the catalogue of every place PROTOCOL.md §4/§7/§8/§9/
> §10/§11 and the implementation disagreed on 2026-09-04, with a triage.
> Under the feature freeze nothing behavioural was changed; editorial
> discrepancies were fixed in the spec alone (D030), behavioural ones are
> listed here as open so they are never "fixed" by quietly editing a doc.

## Discovery
- **Found via:** Gate 8 item 4 — a grep-driven diff of the spec tables
  against `packages/protocol/src/schemas/*.ts`, `errors.ts`, the ledger
  entry types, and the buyer/merchant state literals; plus every quoted
  test name in THREAT_MODEL.md against the test files.
- **Symptom:** 8 schema-level, 10 error/ledger-code, 7 state-machine and 5
  test-citation discrepancies (below).
- **Expected:** "PROTOCOL.md, THREAT_MODEL.md, ARCHITECTURE.md consistent
  with the code" (TEST_CHECKLIST Gate 8).
- **Reproduction:** re-run the greps in the investigation log; the
  THREAT_MODEL check is `grep -n "<quoted title>" <named test file>`.
- **Flow section (FLOW.md):** F1–F5 (all), F6 (entry types).

## Investigation log
- 2026-09-04 [Claude Fable 5.1] — Audit run read-only over the tree at
  `4b744cd`. Results triaged below into (A) spec under-describes what the
  code does → editorial spec fix, D030; (B) code does not do what the spec
  says → open, v0.2 unless trivial; (C) doc citation wrong → fixed in
  THREAT_MODEL.md.

### A — spec under-described the implementation (fixed in PROTOCOL.md, D030)
- §7 lifecycle line listed 16 types; `mandate_ack` is a wire type in the
  schema (17) with no subsection or field table.
- §7.3 read as if `max_items` were required; the schema makes it optional.
- §8 `preferences` is optional on input (`.default([])`) — the spec
  listed it as a plain field.
- §12 says receivers ignore unknown optional fields; the envelope schema
  is `strictObject` (unknown envelope fields → `SCHEMA_INVALID`), bodies
  are not strict.
- Fields that reference a `message_id` (`accepted_message_id`,
  `rejected_message_id`, `offending_message_id`, `in_reply_to`) are typed
  as opaque strings, not re-validated as UUIDs.
- §7.9 `reasons[]` is validated as `^[A-Z_]+$`, not as the enumerated list.
- §7.2/§8 `max_rounds` has an implementation bound of 50.
- §10 defines `ROUNDS_EXCEEDED`, `RATE_LIMITED`, `CAPABILITY_UNSUPPORTED`,
  `VERDICT_MISSING`; none is emitted (rounds → `walk_away{rounds_exhausted}`;
  a missing verdict is `SCHEMA_INVALID` before settlement's checks).
- §11 named no entry types; the ledger has twelve; `SETTLEMENT_ATTEMPT`
  is a settlement *event* type inside `SETTLEMENT_EVENT`, not an entry type.
- §9: the merchant has no `INIT` (records `NEGOTIATING` on
  `session_init`); the buyer writes `INIT` before `mandate_register` is
  sent; a closed receipt-poll window leaves both parties in `SETTLING`
  (outcome *pending*); local run failures (`FIREWALL_UNREACHABLE`,
  `INTERNAL`) move the buyer to `FAILED` from any non-terminal state.

### B — implementation diverges from the spec's intent (OPEN)
- **B1** `EXPIRED` is never entered by any party (`valid_until` is enforced
  by the firewall as `MANDATE_EXPIRED` instead). Spec now marks it
  reserved; a v0.2 buyer should enter it when its own clock passes
  `valid_until` mid-negotiation.
- **B2** The buyer treats a seller `reject` or `bundle_proposal` as
  `STATE_INVALID` → `FAILED` (`services/buyer/src/runner.ts` expects only
  `counter_offer | accept | walk_away`); §9 lists both as
  `NEGOTIATING` self-transitions. Harmless today (the reference seller
  emits neither; `bundle_proposal` is cut candidate #4) but a conforming
  third-party seller would end the buyer's session. v0.2.
- **B3** Recoverable errors on the buyer side (`TOTAL_MISMATCH`, …) end
  the run as `FAILED` rather than continuing the session as §10's
  "recoverable" implies. v0.2: retry the round.
- **B4** `VERIFIER_ABSENT` is missing from `LEDGER_EVENT_TYPES` in
  `packages/protocol/src/errors.ts` although it is a ledger entry type and
  is emitted by the firewall. A one-line constant fix; deferred only
  because the constant is exported by the protocol package (Gate 1 change
  under freeze). v0.2 or first post-submission commit.
- **B5** `NOT_FOUND` (firewall `GET /verdict`), and the buyer's run-outcome
  codes `FIREWALL_UNREACHABLE`, `INTERNAL`, `HELD_IN_REVIEW`,
  `RECEIPT_TIMEOUT`, `SETTLEMENT_FAILED`, are transport/local codes that
  surface in run results but are not in §10. Spec now says local
  failures are ledger events on that party only; a v0.2 §10 could list
  the transport-level codes.

### C — THREAT_MODEL test citations (fixed 2026-09-04)
- T2: `firewall/app.test.ts` title has "(new envelope)"; `merchant/chain.test.ts`
  "forged verdict → the session survives" does not exist — replaced with the
  actual title "a verdict signed by anything but the configured firewall
  key → SIG_INVALID; unconfigured key → SESSION_UNKNOWN".
- T5: "verifier DOWN → escalate, never allow" is a prefix of a longer
  title (now quoted with an ellipsis); "no firewall → no negotiation" lives
  in `buyer/e2e.test.ts`, not `firewall/app.test.ts` (re-attributed).
- T6: `firewall/app.test.ts` "… tamper breaks at that entry" → actual
  "… an out-of-band edit breaks verification at that entry".

## Root cause
- The spec was written on Day 2 and the code grew for nine days with the
  schema drift test guarding only zod ↔ JSON Schema, not zod ↔ prose.
  THREAT_MODEL citations were written from memory of test names.

## Fix
- **Change made:** PROTOCOL.md editorial reconciliation (D030, its own
  commit); THREAT_MODEL.md citations corrected; this file.
- **Why this fixes the root cause (not just the symptom):** it does not —
  it discharges the Day 12 gate honestly. Prevention below is the fix.
- **Blast radius checked:** docs only; no schema, service or test changed.

## Verification
- **Regression test added:** none (docs). The audit greps are re-runnable
  from this file.
- **Gate items re-run, with pasted output:** Gate 0 on the Day 12 close
  (FEATURE-012 verification record).

## Outcome
- **Status:** A and C fixed; B1–B5 open (v0.2 list in HANDOVER).
- **Decisions generated:** D030.
- **Prevention:** add to Gate 1 a "spec prose ↔ schema" line: any change
  to a body schema re-reads the matching §7 table; and to Gate 8 the
  THREAT_MODEL citation grep (Day 12 did it by hand; a 20-line script is
  the v0.2 version).
