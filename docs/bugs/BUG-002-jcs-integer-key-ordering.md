# BUG-002 — JCS canonicalizer mis-ordered integer-like keys

## How found
2026-08-23, FEATURE-003 sub-task 1. The RFC 8785 §3.2.3 key-ordering test
vector (adapted to our integer-only subset) failed on the first run:
`"1":"One"` was emitted before `"\r":"Carriage Return"` although `"\r"`
(U+000D) sorts below `"1"` (U+0031).

## Hypothesis
The first implementation rebuilt each object with keys inserted in sorted
order and then called `JSON.stringify`, trusting insertion order. ECMAScript
`OrdinaryOwnPropertyKeys` always enumerates array-index-like keys (`"0"`,
`"1"`, `"42"`) first, in numeric order, before string keys in insertion
order — so any object with a numeric-looking key silently violated JCS.
Exactly the class of bug D004 warned would eat a day.

## Investigation log (append as you go)
- Confirmed with a minimal repro: `JSON.stringify({ a: 1, '1': 2 })` →
  `{"1":2,"a":1}` regardless of insertion order.
- Replaced the "sort then stringify" approach with a hand-written emitter
  that writes object members itself in code-unit order; `JSON.stringify` is
  now used only for string escaping (RFC 8785 §3.2.2.2 is identical to ES).
- Second red run was my test's fault: the expected strings contained a raw
  CR instead of the escaped `\r` JCS emits. Fixed the expectations.

## What worked
Hand-written emitter in `packages/protocol/src/canonical.ts`; regression
test `canonicalize — BUG-002 regression` locks the behaviour.

## How verified
```
$ npx vitest run packages/protocol
Tests  20 passed (20)
```
Why it matters: ACNP line items and catalog variants are unlikely to use
numeric keys, but `reasons[]` codes, attribute maps and future extensions
could — and a single mis-ordered key means two conforming implementations
compute different signatures over the same message.

## Status
Fixed in FEATURE-003 commit 1. Model: Claude Fable 5.
