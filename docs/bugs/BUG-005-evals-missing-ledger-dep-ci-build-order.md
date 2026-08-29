# BUG-005 — `pnpm build` fails on a clean clone: evals typechecks before ledger has built

## Discovery
- **Found via:** CI, run `33258233847` on `5d3c686` (the Day 11 close
  commit) — the first red `main` since Day 1. Reported by the user; the
  Day 11 session had pushed without waiting for the CI verdict.
- **Symptom:** the `pnpm build` step exits 2 with twelve
  `error TS2307: Cannot find module '@negotiator/ledger' or its
  corresponding type declarations` from the `evals build` task, every one
  pointing into `services/*/src/*.ts` (plus three cascading `TS7006`
  implicit-any errors in `services/buyer/src/runner.ts` where the missing
  ledger types leave callback parameters untyped). Lint, typecheck and
  tests never ran.
- **Expected:** a clean clone builds green — CI's `test` job (an empty
  checkout) is the only place that is checked, and it is checked on every
  push.
- **Reproduction:** delete every `dist/` and `*.tsbuildinfo` outside
  `node_modules` (what a fresh clone has), then `pnpm build`. Reproduced
  locally on 2026-08-29 with exactly the CI errors; the
  `packages/ledger build` and `evals build` tasks are visibly started in
  the same tier.
- **Flow section (FLOW.md):** none — build tooling, not an execution path.

## Investigation log
- 2026-08-29 [user + Claude Fable 5] — Hypothesis: `evals/package.json`
  declares `@negotiator/llm` and `@negotiator/protocol` but not
  `@negotiator/ledger`, while `evals/src/session.ts` typechecks
  `services/buyer/src/*` and `services/merchant/src/*` source, which
  import `@negotiator/ledger` (a package only two days old). pnpm's
  recursive `build` runs workspace packages in dependency order; with no
  declared edge, `evals` and `packages/ledger` land in the same tier and
  run concurrently, so when `tsc` resolves `@negotiator/ledger` (its
  `exports` point at `./dist/index.d.ts`) the file does not exist yet.
  → Tried: scrub all `dist/` locally and build → Result: reproduced
  verbatim. → Tried: declare the dependency, scrub, rebuild → Result:
  `packages/ledger build: Done` before `evals build` starts; green.
- Why every local run was green: stale `dist/` folders from earlier
  builds sat on the machine, so ledger's declarations were always
  findable regardless of order. CI is the only machine in the loop that
  starts empty, which is its job.

## Root cause
- An undeclared workspace dependency. The evals package compiles service
  source files from outside its own directory, so its real dependency set
  is the services' dependency set (`ledger`, `llm`, `protocol`), and one
  of the three was missing. The build order was correct for what the
  manifest said; the manifest was wrong.

## Fix
- **Change made:** `pnpm --filter @negotiator/evals add
  '@negotiator/ledger@workspace:*'` — one line in `evals/package.json`,
  three in `pnpm-lock.yaml`.
- **Why this fixes the root cause (not just the symptom):** the manifest
  now states the true edge, so pnpm's topological order builds ledger
  before evals on any machine, with or without stale outputs. It does not
  rely on alphabetical luck or a serial `--workspace-concurrency=1`.
- **Blast radius checked:** nothing imports evals; the dependency is
  `workspace:*`, so no version is pinned and no install changes for any
  other package (`pnpm install --frozen-lockfile` after the change:
  "Done in 1.9s", nothing added).

## Verification
- **Regression test added:** none as code — the regression test for a
  clean-clone build is CI itself (`.github/workflows/ci.yml`, the `test`
  job starts from an empty checkout). Prevention below makes the
  *process* gap the actual fix.
- **Gate items re-run, with pasted output** (2026-08-29, local, after
  deleting every `dist/` and `*.tsbuildinfo` first — CI's exact step
  order):

  ```
  === install --frozen-lockfile ===
  Done in 1.9s using pnpm v10.18.1
  === build ===
  packages/ledger build$ tsc -p tsconfig.json
  packages/ledger build: Done
  evals build$ tsc -p tsconfig.json --noEmit
  evals build: Done
  build exit 0
  === lint ===
  Checking formatting...
  All matched files use Prettier code style!
  lint exit 0
  === typecheck ===
  typecheck exit 0
  ```

  ```
   Test Files  34 passed | 1 skipped (35)
        Tests  348 passed | 6 skipped (354)
  ```

  CI on the fix commit: see the HANDOVER entry of the same date for the
  run id and verdict (this file is written before that run exists).

## Outcome
- **Status:** fixed
- **Decisions generated:** D027 (the `known-good-4` tag is moved onto the
  fix commit).
- **Prevention:** `docs/TEST_CHECKLIST.md` Gate 0 gains two lines: the
  local build runs after scrubbing `dist/` + `*.tsbuildinfo` whenever a
  package manifest or workspace dependency changed (a stale tree cannot
  vouch for build order), and a session's close report quotes the CI run
  id and verdict for the pushed sha — the Day 11 close was the only
  session that skipped the CI verdict and the only red one.
