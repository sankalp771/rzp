# BUG-001 — Service /health tests time out under CPU contention

## How found
2026-08-23, FEATURE-001. `pnpm test` run while `docker compose down` and
`pnpm typecheck` were still executing: 4 of 8 tests failed (all four
fastify `/health` tests), suite duration 20.5s. Immediately re-run on an idle
machine: 8/8 pass, each service test ~500ms, suite 2.8s.

## Hypothesis
Cold import of fastify + its plugin tree inside a vitest worker takes
~400–600ms idle, and stretched past vitest's 5s default `testTimeout` when
the CPU was saturated. Not a logic bug; a budget too tight for noisy
environments (CI runners are exactly that).

## Investigation log (append as you go)
- Earlier in the same session the forked `pool` made every service test take
  ~5s even idle; switched to `pool: 'threads'` (12.3s → 2.8s suite).
- Plain Node (no vitest) builds + injects + closes the app in 252ms, so the
  cost is worker startup + module transform, not the app.
- 3 consecutive idle runs after the fix: 8/8 pass, 2.5–2.8s.

## What worked
`testTimeout: 15_000` in `vitest.config.ts`. Headroom only — real tests must
still be fast; any test that *needs* the headroom is a smell.

## How verified
```
$ npx vitest run   (×3)
Tests  8 passed (8)  Duration 2.54s / 2.79s / 2.78s
```

## Status
Fixed in FEATURE-001 commit. Model: Claude Fable 5.
