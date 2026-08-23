# FEATURE-003 — Shared protocol library (`packages/protocol`)

## Scope
- **Goal:** Every service can build, sign, validate, verify, and replay-guard
  ACNP v0.1 messages through one library whose behavior matches PROTOCOL.md
  field for field.
- **In scope:** JCS canonicalization, SHA-256 hashing, Ed25519 keys +
  signatures, zod schemas for envelope + all message bodies + Intent
  Mandate, message validation with spec error codes, replay guard, JSON
  Schema export artifacts, fixtures.
- **Explicitly out of scope:** HTTP transport, ledger persistence, state
  machine enforcement (Day 4/5 in services), any LLM code.
- **Flow sections touched (FLOW.md):** F5 (boundary rejection) — semantics
  only; no service wires it yet.
- **Architecture sections touched (ARCHITECTURE.md):** S3.
- **Risk class:** low (library, no money path yet) — but it is the root of
  every later trust claim, so Gate 1 is mandatory and pasted below.

## Plan (approved before implementation)
- Approach: pure TypeScript, no I/O. `node:crypto` for Ed25519 and SHA-256
  (D012); hand-rolled JCS for the JSON subset we use (strings, integers,
  booleans, null, arrays, objects) pinned by the RFC 8785 test vector; zod v4
  for schemas with `z.toJSONSchema()` export committed to
  `packages/protocol/schemas/json/`.
- Ordered sub-tasks (one commit each):
  1. canonical.ts, hash.ts, keys.ts, sign.ts + tests.
  2. schemas/, errors.ts, validate.ts + fixtures + tests; fix version pin.
  3. replay.ts, JSON Schema export script + artifacts + tests.
- Files expected to change: packages/protocol/**, .env.example (key vars),
  PROTOCOL.md (link to JSON schemas — non-normative line only).
- New dependencies: zod (approved D006). `@noble/ed25519` dropped (D012).
- How it will be verified: Gate 1 all four items; Gate 0.

## Work log (append as you go; newest on top)
- 2026-08-23 [Claude Fable 5] — Plan approved by user (node:crypto,
  hand-rolled JCS, 3-commit split).

## Verification record
(pending)

## Outcome
- **Status:** in-progress
- **Decisions generated:** D012
- **Follow-ups spawned:** none yet
- **Plain-language explanation (for the pitch):** (pending)
