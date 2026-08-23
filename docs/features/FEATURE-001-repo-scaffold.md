# FEATURE-001 — Repo scaffold, Docker Compose skeleton, CI

## Scope
- **Goal:** A clean clone runs `pnpm install && pnpm test` green, CI runs the
  same on every push, and `docker compose up` brings every service stub to
  healthy — with no real protocol or business logic yet.
- **In scope:** pnpm workspace layout, TypeScript/ESLint/Prettier config,
  vitest with one placeholder test per package, Dockerfiles + compose with
  healthchecks, GitHub Actions CI, `.env.example`, LICENSE, `.gitignore`,
  `.gitattributes`, README skeleton.
- **Explicitly out of scope:** Any protocol schema, signing, LLM adapter,
  Razorpay code, dashboard UI. Those are Days 2–7.
- **Flow sections touched (FLOW.md):** none (no execution paths yet).
- **Architecture sections touched (ARCHITECTURE.md):** §2 services map to
  directories; §4 deployment (Compose).
- **Risk class:** low

## Plan (approved before implementation)
- Approach: pnpm workspaces monorepo. Shared code in `packages/`, runtime
  services in `services/`, each service a tiny fastify app exposing `/health`
  so Compose healthchecks are real from day one.
- Ordered sub-tasks (one logical change each):
  1. Workspace root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
     lint/format config, `.nvmrc`, `.gitignore`, `.gitattributes`, LICENSE.
  2. Packages: `packages/protocol` (placeholder export + test),
     `packages/llm` (adapter interface placeholder + test).
  3. Services: `services/merchant`, `services/buyer`, `services/firewall`,
     `services/settlement` — each a fastify `/health` endpoint + test.
  4. `dashboard/` placeholder package, `evals/` placeholder package.
  5. Dockerfiles + `docker-compose.yml` with healthchecks.
  6. CI workflow (`.github/workflows/ci.yml`): install, lint, typecheck, test.
  7. `.env.example` documenting every variable; README skeleton.
- Files expected to change: all new; ~40 small files.
- New dependencies (approved via D006): typescript, vitest, eslint,
  prettier, fastify, zod, @noble/ed25519, better-sqlite3, tsx.
  (zod/noble/better-sqlite3 are declared now so the lockfile is stable, used
  from Day 3.)
- How it will be verified: Gate 0 (lint, tests, diff review, conventional
  commit) and Gate 6 last item (`docker compose up` reaches healthy).

## Work log (append as you go; newest on top)
- 2026-08-23 [Claude Fable 5] — All sub-tasks done in one commit (they are
  one logical change: "the scaffold"; nothing is runnable until all exist).
  Three problems hit and fixed: (a) vitest forked pool made each fastify
  test ~5s on Windows → `pool: 'threads'`; (b) Docker build copied the
  host's `tsconfig.tsbuildinfo`, so tsc emitted nothing and the image had no
  `dist/` → added to `.dockerignore`; (c) Compose healthcheck used `CMD`
  form so `$PORT` never expanded → `CMD-SHELL`. Flaky timeout under load
  → BUG-001.
- 2026-08-23 [Claude Fable 5] — Feature file created; toolchain verified:
  node v22.20.0, pnpm 10.18.1, docker 29.7.2.

## Verification record
Gate 0 — lint/format:
```
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
```
Gate 0 — unit suite (three consecutive runs):
```
$ npx vitest run
Tests  8 passed (8)   Duration 2.54s
Tests  8 passed (8)   Duration 2.79s
Tests  8 passed (8)   Duration 2.78s
```
Gate 0 — typecheck: `pnpm typecheck` → 8 × "Done", no errors.
Gate 0 — secret scan of staged diff for provider key prefixes: no matches;
`git check-ignore .env` → ignored.
Gate 6 (last item) — Compose from clean images:
```
$ docker compose up --build -d && docker compose ps
SERVICE      STATUS
buyer        Up 16 seconds (healthy)
firewall     Up 22 seconds (healthy)
merchant     Up 28 seconds (healthy)
settlement   Up 28 seconds (healthy)
$ curl localhost:4001/health
{"status":"ok","service":"merchant","protocol":"acnp/0.1"}
```
Not verified: the GitHub Actions workflow has not run yet (no remote pushed).

## Outcome
- **Status:** done (CI workflow unverified until first push)
- **Decisions generated:** D006, D007, D008, D009
- **Follow-ups spawned:** BUG-001 (fixed in same commit)
- **Plain-language explanation (for the pitch):** The repo is a single
  TypeScript monorepo: two shared libraries (the protocol and the LLM
  adapter) and four small services that mirror the architecture one-to-one
  — merchant, buyer, firewall, settlement. Each service is a tiny HTTP
  server with a health endpoint, so `docker compose up` already brings the
  whole system to "healthy" and every later feature plugs into a running
  skeleton rather than a blank page. Tests, lint and typecheck run with one
  command locally and in CI, and CI never needs provider keys because the
  LLM layer has a deterministic stub from day one.
