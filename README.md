# The Negotiator

> Reference implementation of **agent-to-agent commerce**: a buyer agent and a
> seller agent negotiate over a signed, versioned wire protocol (ACNP), pass a
> two-layer compliance firewall, and settle through Razorpay (test mode) — with
> every step in a hash-chained, append-only audit ledger.

Built for the Razorpay AI Buildathon, Track 1: AI Growth & Agentic Commerce.

**Status:** Day 11 / 13 — **feature freeze + the evals score sheet**
(see [Metrics](#metrics--evals-run-live-42-mistral)). Done: ACNP v0.1 spec + protocol library (signatures, schemas,
replay guard) + merchant server (catalog, policy bounds engine,
deterministic negotiation) + buyer agent (mandate registration,
deterministic strategy, budget clamp, signed cart) + LLM adapter layer
(Gemini, Groq, Mistral — advisory proposals, deterministic fallback, every
number clamped) + compliance firewall: layer 1 (deterministic policy
against the principal-signed mandate it stored; one mandate, one purchase)
and layer 2 (an LLM intent-verifier that can only _narrow_ — block or
escalate — never widen; absent or self-contradicting → escalate) + a
token-gated human approval queue (approve re-runs policy; a hold is
decided exactly once; timeout auto-blocks) + settlement (firewall-only,
Razorpay test-mode orders with idempotency and bounded retry, webhook
HMAC, append-only receipt chain). Live over Compose, three stops for three
defenses:

```bash
node scripts/negotiate.mjs                              # benign: intent → … → real Razorpay order → receipt
node scripts/negotiate.mjs --target var_bookend         # the buyer's STRATEGY walks away (near-floor item)
node scripts/negotiate.mjs --target var_relay_8ch       # firewall LAYER 1 blocks (industrial under a gifts mandate)
node scripts/negotiate.mjs --target var_corp_hamper     # every number passes; LAYER 2 blocks or HOLDS for a human
node scripts/review.mjs list | approve <hash> | reject <hash>   # the human, from a second terminal
node scripts/verify-ledgers.mjs                         # all four audit chains verified + cross-party check
node scripts/verify-ledgers.mjs --db copy.db            # verify a copied service database offline
```

**Day 10 — feature freeze.** Every service now keeps its own append-only,
hash-chained audit ledger (every message in and out, every rejection,
every decision and state change; settlement's money chain absorbed
verbatim) with a verify routine that names the first broken entry, and a
thin operator console on `http://localhost:4005` (run, approval queue,
policy, session replay with all four chains verified + cross-party
envelope match, evals). **Day 11:** the evals harness ran the whole
system 50 times, twice — deterministic curves alone, then the real
models on the same seed — and the failure numbers are in the table below
(FEATURE-011, [docs/EVALS.md](docs/EVALS.md)). Days 12–13: polish, video,
submission — see [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Quickstart

```bash
cp .env.example .env                       # then fill in Razorpay TEST keys (+ optional LLM keys)
pnpm install && pnpm build
node scripts/gen-keys.mjs >> .env          # principal/firewall/settlement keys + control + review tokens
docker compose up --build                  # merchant :4001, buyer :4002, firewall :4003, settlement :4004, dashboard :4005
node scripts/negotiate.mjs                 # one full run, every signature re-verified
open http://localhost:4005                 # operator console: run, queue, replay & audit, policy
```

Local development:

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

## Layout

| Path                  | Role                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `PROTOCOL.md`         | ACNP v0.1 wire-protocol specification (normative)                   |
| `packages/protocol`   | Schemas, canonical serialization, Ed25519 signing, replay guard     |
| `packages/llm`        | Model-agnostic LLM adapter layer (only place vendor calls may live) |
| `packages/ledger`     | Append-only hash-chained audit ledger (one chain per service)       |
| `services/merchant`   | S1 Merchant Commerce Server + seller agent                          |
| `services/buyer`      | S2 Buyer Agent                                                      |
| `services/firewall`   | S4 Compliance Firewall (deterministic rules + LLM intent-verifier)  |
| `services/settlement` | S5 Razorpay settlement + hash-chained ledger                        |
| `dashboard/`          | Operator console: run, approval queue, replay & audit, policy, evals |
| `scripts/`            | Terminal demos: negotiate, review (the human), verify-ledgers, keys  |
| `evals/`              | Synthetic-negotiation harness and honest metrics report             |
| `docs/`               | Architecture, decisions, flow, threat model, test gates, handover   |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system map
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — trust boundaries and attack cases
- [docs/DECISIONS.md](docs/DECISIONS.md) — why, not just what

## Metrics — evals run `live-42-mistral`

Copied from [evals/report.json](evals/report.json) (rendered in
[evals/REPORT.md](evals/REPORT.md)); 50 sessions, executed 2026-08-29,
commit `d8e5daa`. Buyer `mistral/mistral-small-latest`, seller
`groq/openai/gpt-oss-120b`, intent-verifier `mistral/mistral-small-latest`.
Settlement inside the evals is the in-process simulated client (the live
Razorpay leg was proven separately, Gate 4). Every rate is `pct (n/d)`; the
failure numbers sit in the same tables as the wins. Re-run with
`pnpm evals -- --mode live --n 10 --seed 42 --baseline stub-42 --publish`.

**Benign scenarios** (ground truth: settle or walk away cleanly; any block or hold is a false block)

| Scenario          | Deal-close   | Walk-away   | False block | Avg discount | Avg rounds |
| ----------------- | ------------ | ----------- | ----------- | ------------ | ---------- |
| `honest`          | 100% (10/10) | 0% (0/10)   | 0% (0/10)   | 13.1%        | 4.5        |
| `aggressive`      | 90% (9/10)   | 10% (1/10)  | 0% (0/10)   | 11.8%        | 4.8        |
| `stingy_merchant` | 50% (5/10)   | 50% (5/10)  | 0% (0/10)   | 1.1%         | 5.0        |
| **pooled**        | 80% (24/30)  | 20% (6/30)  | 0% (0/30)   | 10.1%        | 4.7        |

**Corrupted scenarios** (ground truth: must be caught; a settle is a false allow)

| Scenario             | Caught       | False allow | Caught by             |
| -------------------- | ------------ | ----------- | --------------------- |
| `corrupted_layer1`   | 100% (10/10) | 0% (0/10)   | layer 1 (policy) 10   |
| `corrupted_semantic` | 100% (10/10) | 0% (0/10)   | layer 2 (verifier) 10 |
| **pooled**           | 100% (20/20) | 0% (0/20)   | critical misses: 0    |

**What the models cost, on identical parameters** — the curves alone would
have closed 30/30 at an average 12.3% below list; the LLM-advised pair
closed 24/30 at 10.1% (−2.1 points, 0.3 fewer rounds). Both agents were
model-advised, so this measures the pair. Providers: 502 calls, 502
answered, 0 fallbacks (median latency ≈ 1.0 s). **Seller floor leaks:**
13.3% (27/203) of the seller's counter-offer rationales named the floor it
cannot cross (the number can't leak; the prose does — a hardening target).

The deterministic run of the same seed (`evals/runs/stub-42`) closes every
benign deal exactly where the formulas predict, catches all ten relays at
layer 1, and lets the corporate hamper through **10/10** — numbers alone
cannot see intent; that row is why layer 2 exists. Two truncated live
attempts are kept and not cited (`live-42`: Gemini buyer, 4/50 on quota;
`live-42-lite-outage`: 12 sessions through a network outage) — D026.

Sections to come: architecture diagram, protocol summary.

## License

MIT
