# DECISIONS.md — Why, Not Just What

Log every meaningful decision with reasoning: why this over that, what
tradeoff was accepted, what was rejected. An entry without a "because" and an
"instead of" is invalid. Newest on top. Never edit past entries — supersede
them with a new entry that references the old one.

Entry format:

### DNNN — YYYY-MM-DD — <title> — [model/version or human]
- **Decision:**
- **Because:**
- **Instead of:** <rejected alternatives and why they lost>
- **Tradeoff accepted:**
- **Revisit if:** <condition under which this should be reconsidered>

---

### D009 — 2026-08-23 — Docs bundle flattened to repo root — [human + Claude Fable 5]
- **Decision:** `negotiator-docs/` packaging folder removed; `docs/` lives at
  the repo root, `CLAUDE.md` and `PROTOCOL.md` at the root, `README-DOCS.md`
  parked under `docs/` until merged into the real README.
- **Because:** `CLAUDE.md` references `docs/HANDOVER.md` etc.; a nested
  bundle makes every path reference wrong or longer.
- **Instead of:** Keeping the bundle and rewriting every path in CLAUDE.md.
- **Tradeoff accepted:** None material.
- **Revisit if:** never.

### D008 — 2026-08-23 — LLM providers: Gemini primary, Groq and Mistral secondary — [human + Claude Fable 5]
- **Decision:** Adapter interface built first; concrete adapters in order
  Gemini → Groq → Mistral. All three on free tiers, keys rotated via `.env`.
  Buyer and seller may run on different providers; model-per-side is recorded
  in every session.
- **Because:** Two or more working adapters prove the model-agnostic seam is
  real rather than theoretical. Gemini pairs narratively with AP2 (a Google
  spec). Multiple free-tier keys give headroom against rate limits during the
  50-session eval run.
- **Instead of:** OpenRouter as a single aggregator — kept as documented
  fallback only, to avoid one more account and a less direct story.
- **Tradeoff accepted:** Three adapters to keep working; mitigated by a
  shared contract test run against each.
- **Revisit if:** a provider's free tier blocks evals — swap order, do not
  add a fourth without a D-entry.

### D007 — 2026-08-23 — SQLite (better-sqlite3) per service — [human + Claude Fable 5]
- **Decision:** Each service owns a SQLite file; ledger, sessions, policy
  config, and escalation queue all live in SQLite.
- **Because:** Zero-infra `docker compose up` is a judged quality; the Gate 5
  tamper demo (edit a row out-of-band, watch chain verification catch it)
  is trivially legible with a file DB.
- **Instead of:** Postgres — more "production" but adds a container, startup
  ordering, and migrations for no demo benefit.
- **Tradeoff accepted:** Not horizontally scalable; irrelevant for a
  reference implementation.
- **Revisit if:** a service needs concurrent writers from multiple
  processes.

### D006 — 2026-08-23 — TypeScript monorepo (Node 22, pnpm workspaces) — [human + Claude Fable 5]
- **Decision:** One language end to end. Stack: pnpm workspaces, zod for
  schemas (exported to JSON Schema so PROTOCOL.md and validators share one
  source), `@noble/ed25519` for signatures, fastify for HTTP, vitest for
  tests. Node and pnpm versions pinned (`engines`, `.nvmrc`,
  `packageManager`).
- **Because:** The human defending the code live is a JS/TS developer; the
  dashboard (demo money-shot) gets first-class attention instead of being a
  second stack; spec and code cannot drift when schemas are one source.
- **Instead of:** Python/FastAPI — LLM plumbing advantage is moot when all
  providers are called over HTTP through an adapter.
- **Tradeoff accepted:** Slightly heavier container images than Python.
- **Revisit if:** never within this submission.

### D005 — 2026-08-23 — Two-layer firewall with deterministic verdict application — [human + Claude]
- **Decision:** Compliance firewall = deterministic policy engine (can
  hard-block alone) followed by an LLM intent-verifier that only recommends
  allow/block/escalate; deterministic code applies the verdict.
- **Because:** Money movement can never depend on unvalidated LLM output; the
  LLM adds semantic drift detection the rule engine can't express.
- **Instead of:** LLM-only firewall (unreliable, unexplainable) or rules-only
  (misses intent drift — the flagship demo).
- **Tradeoff accepted:** Two components to build and test instead of one.
- **Revisit if:** never — this is a submission-defining invariant.

### D004 — 2026-08-23 — Ed25519 per-agent signatures over canonical JSON — [human + Claude]
- **Decision:** Every protocol message signed with per-agent Ed25519 keys
  over a canonical serialization; unsigned/invalid messages rejected at the
  boundary.
- **Because:** Makes the audit trail cryptographically verifiable rather than
  a trust-me log; small, fast, well-supported primitive.
- **Instead of:** No signatures (just logs — weak story) or full mTLS PKI
  (overkill for two weeks, worse demo legibility).
- **Tradeoff accepted:** Must define canonical serialization carefully to
  avoid signature mismatch bugs.
- **Revisit if:** canonicalization bugs eat more than a day — fall back to
  signing a hash of a stable field ordering.

### D003 — 2026-08-23 — Protocol modeled on AP2 mandate structure — [human + Claude]
- **Decision:** Wire protocol follows AP2's Intent Mandate → Cart Mandate →
  payment authorization shape; ACP and x402 cited as related work in
  PROTOCOL.md.
- **Because:** Grounds the project in real emerging standards the panel knows;
  mandates give the firewall a signed source of truth for intent.
- **Instead of:** Inventing an ad-hoc message flow with no lineage.
- **Tradeoff accepted:** Must actually read the AP2 spec and be accurate —
  wrong citations are worse than none.
- **Revisit if:** AP2 structure conflicts with a needed message type; then
  document the deviation explicitly in PROTOCOL.md.

### D002 — 2026-08-23 — Deterministic strategy core, LLM on top — [human + Claude]
- **Decision:** Negotiation math (reservation price, concession curve,
  walk-away) and merchant bounds are deterministic code; LLMs do reasoning
  and natural-language offer generation on top.
- **Because:** Behavior stays explainable and boundable; the panel can be
  shown exactly why an agent conceded what it did; bounds can't be
  prompt-injected away.
- **Instead of:** Fully LLM-driven negotiation (unexplainable, unbounded,
  eval results unstable).
- **Tradeoff accepted:** Slightly less "magical" negotiation transcripts.
- **Revisit if:** never for bounds; strategy expressiveness may grow if time
  allows.

### D001 — 2026-08-23 — Single dedicated Razorpay-only submission — [human]
- **Decision:** The Negotiator is built solely for the Razorpay AI Buildathon,
  Track 1 (AI Growth & Agentic Commerce), with production depth prioritized
  over breadth.
- **Because:** No resume screening — the repo is the resume; depth (protocol
  spec, firewall, evals, threat model) is the differentiator against student
  demos.
- **Instead of:** Reusing a multi-hackathon project constrained by other
  events' rules.
- **Tradeoff accepted:** All eggs in one track; mitigated by the cut-order
  plan in CLAUDE.md §6.
- **Revisit if:** track definition turns out to mismatch the build (it
  doesn't — agentic commerce is the literal subject).
