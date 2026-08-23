# FEATURE-002 — PROTOCOL.md v0.1 review pass

## Scope
- **Goal:** PROTOCOL.md is internally consistent, closes two design holes,
  and agrees with ARCHITECTURE.md / FLOW.md / THREAT_MODEL.md — so Day 3's
  protocol library implements one unambiguous spec.
- **In scope:** Normative text of PROTOCOL.md; DECISIONS entries; FLOW.md and
  ARCHITECTURE.md naming/path alignment.
- **Explicitly out of scope:** Any code. JSON Schemas (Day 3).
- **Flow sections touched (FLOW.md):** F1 steps 1, 3, 6–8; F3; F5 names.
- **Architecture sections touched (ARCHITECTURE.md):** S3 canonical flow, S4
  position relative to settlement.
- **Risk class:** low (docs only), but PROTOCOL.md is a highest-blast-radius
  file — its commit ships alone (CONSTRAINTS #16).

## Plan (approved before implementation)
- Approach: review found two holes (H1: firewall has no trustworthy copy of
  the Intent Mandate; H2: spec and flow disagree on who calls settlement) and
  eight consistency gaps. User approved the recommended fixes on 2026-08-23.
- Ordered sub-tasks:
  1. PROTOCOL.md edits (H1 → principal-signed mandate + `mandate_register`;
     H2 → firewall → settlement; gaps: bootstrap signing, hash/encoding
     conventions, verdict recipients, state-machine rows, conformance gate
     reference, error codes) + D010, D011. One commit.
  2. FLOW.md + ARCHITECTURE.md aligned to spec names and the settlement
     caller. One commit.
- Files expected to change: PROTOCOL.md, docs/DECISIONS.md, docs/FLOW.md,
  docs/ARCHITECTURE.md, this file, docs/HANDOVER.md.
- New dependencies: none.
- How it will be verified: Gate 0; field-by-field cross-check table below.

## Work log (append as you go; newest on top)
- 2026-08-23 [Claude Fable 5] — Review done, plan approved, starting edits.

## Verification record
(pending)

## Outcome
- **Status:** in-progress
- **Decisions generated:** D010, D011
- **Follow-ups spawned:** Day 3 must change `PROTOCOL_VERSION` pin in
  `packages/protocol` to match envelope fields `protocol: "ACNP"`,
  `version: "0.1"`.
- **Plain-language explanation (for the pitch):** (pending)
