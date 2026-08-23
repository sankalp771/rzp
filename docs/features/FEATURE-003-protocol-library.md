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
- 2026-08-23 [Claude Fable 5] — Four commits: crypto core (e7e1d95),
  schemas + parseMessage (4797006), replay guard + JSON Schema artifacts
  (d71adea), spec field alignment (526fe18). The RFC 8785 test vector
  caught a real ordering bug in the first canonicalizer (BUG-002). Field
  check found three fields the spec tables omitted — spec amended in its own
  commit per CONSTRAINTS #16.
- 2026-08-23 [Claude Fable 5] — Plan approved by user (node:crypto,
  hand-rolled JCS, 3-commit split).

## Verification record
Gate 0:
```
$ pnpm lint            → All matched files use Prettier code style! (eslint clean)
$ pnpm typecheck       → 8 × Done, 0 errors
$ npx vitest run       → Tests  84 passed (84)
```
Gate 1 — schema validation (validate.test.ts, 27 cases):
```
✓ accepts a well-formed <type>                         ×17 (every §7 type)
✓ missing envelope field -> SCHEMA_INVALID
✓ missing body field -> SCHEMA_INVALID naming the path
✓ wrong type (float money) -> SCHEMA_INVALID
✓ unknown major version -> VERSION_UNSUPPORTED even when the rest is broken
✓ unknown minor version of a supported major is accepted (§12)
✓ unknown message type -> SCHEMA_INVALID
✓ unknown envelope field -> SCHEMA_INVALID (envelope is strict)
✓ wrong protocol literal or non-object input -> SCHEMA_INVALID, never throws
✓ error code outside §10 -> SCHEMA_INVALID
✓ firewall verdict with an unknown verdict value -> SCHEMA_INVALID
```
Gate 1 — signature (sign.test.ts):
```
✓ correctly signed object verifies
✓ verification ignores key order of the signed object
✓ tampered payload fails                                   → bad_signature
✓ wrong key fails with key_id_mismatch
✓ forged key_id with wrong signature fails as bad_signature
✓ missing or malformed signature fails without throwing
```
Gate 1 — replay (replay.test.ts, 9 cases):
```
✓ rejects a replayed message (same seq, same id) as REPLAY_DETECTED
✓ rejects an old seq even with a fresh message_id
✓ rejects a reused message_id even with a fresh seq (second barrier)
✓ rejects a gap as SEQUENCE_GAP and does not advance
✓ check() does not consume the seq; only commit() does
```
NOT yet verified from Gate 1 replay: "and ledger-logged" — no ledger exists
until Day 10; the guard returns the code, the service will log it.
Gate 1 — spec/implementation field check: done by reading every §7 table
against `schemas/bodies.ts`; three omissions fixed in 526fe18. Remaining
intentional looseness: `settlement_request` embeds the two signed envelopes
as `looseObject({signature})` — full re-validation of the embedded messages
is the settlement service's job (§7.10 a–d), Day 7.
JSON Schema artifacts: `jsonschema.test.ts` — 19 files on disk equal the
zod export (would fail on drift).

## Outcome
- **Status:** done
- **Decisions generated:** D012
- **Follow-ups spawned:** BUG-002 (fixed). Day 4+: back `ReplayStore` with
  SQLite; ledger-log replay rejections (Gate 1 item 3 second half).
- **Plain-language explanation (for the pitch):** This package is the
  rulebook every service obeys before it trusts a message. A message is
  first checked for shape against a schema generated from one source of
  truth — the same source produces the JSON Schema files in the repo, so
  spec and code cannot drift. Then its Ed25519 signature is verified over a
  canonical byte form (RFC 8785), so two parties always sign and check the
  exact same bytes regardless of whitespace or key order — and we caught a
  real ordering bug with the RFC's own test vector. Finally a replay guard
  insists every message from a sender in a session arrives exactly once and
  in order; a rejected message never consumes a sequence number, so garbage
  can't be used to desync an honest peer. We used Node's built-in crypto
  rather than a third-party library: one less thing to audit.
