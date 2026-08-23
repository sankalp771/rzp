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
Docs-only change; Gate 0 applies.
```
$ pnpm lint
All matched files use Prettier code style!
```
Cross-document consistency check (done by reading, item by item):

| Concept | PROTOCOL.md | FLOW.md | ARCHITECTURE.md | THREAT_MODEL.md |
|---|---|---|---|---|
| Mandate signer | principal key (§5, §8) | F1 step 1 | S2 | T5 |
| Mandate reaches firewall | `mandate_register` §7.0 | F1 step 1 | S4 | T5 |
| Settlement caller | firewall §7, §7.10 | F1 step 8 + note | S3 flow, S4, §5 | (n/a) |
| Message names | §7 | F1–F5 use spec names | S3 canonical flow | — |
| Terminal states | §9 | F2 WALKED_AWAY, F3 BLOCKED, F4 FAILED | — | — |
| Ledger-only events | §10 | BOUNDS_CLAMPED, ESCALATION_TIMEOUT, SETTLEMENT_ATTEMPT | — | — |

Remaining known divergence (intentional, fixed in code on Day 3): the
`PROTOCOL_VERSION = 'acnp/0.1'` constant in `packages/protocol`.

## Outcome
- **Status:** done
- **Decisions generated:** D010, D011
- **Follow-ups spawned:** Day 3 — align `PROTOCOL_VERSION` pin with envelope
  fields (`protocol: "ACNP"`, `version: "0.1"`); add `FIREWALL_PUBLIC_KEY`,
  `SETTLEMENT_PUBLIC_KEY`, principal key variables to `.env.example` when the
  key tooling lands.
- **Plain-language explanation (for the pitch):** The spec review closed
  one real hole: the firewall used to receive the buyer's authorization from
  the buyer itself at settlement time, so a misbehaving buyer could just
  rewrite it. Now the human principal signs the Intent Mandate with their
  own key and deposits it with the firewall before the negotiation even
  starts — the firewall judges the final cart only against that frozen copy.
  Second, settlement now has exactly one caller, the firewall, so "no agent
  can move money on its own" is something you can prove by showing there is
  no route, not something you argue. Everything else was tightening:
  one hashing convention, explicit key bootstrap, a complete state table
  and error catalogue, so Day 3's code implements one unambiguous spec.
