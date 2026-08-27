# The Negotiator

> Reference implementation of **agent-to-agent commerce**: a buyer agent and a
> seller agent negotiate over a signed, versioned wire protocol (ACNP), pass a
> two-layer compliance firewall, and settle through Razorpay (test mode) — with
> every step in a hash-chained, append-only audit ledger.

Built for the Razorpay AI Buildathon, Track 1: AI Growth & Agentic Commerce.

**Status:** Day 9 of 13 — **both firewall layers and the human in the
loop.** Done: ACNP v0.1 spec + protocol library (signatures, schemas,
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
```

Next: the hash-chained ledger and the dashboard — see
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Quickstart

```bash
cp .env.example .env                       # then fill in Razorpay TEST keys (+ optional LLM keys)
pnpm install && pnpm build
node scripts/gen-keys.mjs >> .env          # principal/firewall/settlement keys + control + review tokens
docker compose up --build                  # merchant :4001, buyer :4002, firewall :4003, settlement :4004
node scripts/negotiate.mjs                 # one full run, every signature re-verified
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
| `services/merchant`   | S1 Merchant Commerce Server + seller agent                          |
| `services/buyer`      | S2 Buyer Agent                                                      |
| `services/firewall`   | S4 Compliance Firewall (deterministic rules + LLM intent-verifier)  |
| `services/settlement` | S5 Razorpay settlement + hash-chained ledger                        |
| `dashboard/`          | Policy config, escalation queue, session replay, evals summary      |
| `evals/`              | Synthetic-negotiation harness and honest metrics report             |
| `docs/`               | Architecture, decisions, flow, threat model, test gates, handover   |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system map
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — trust boundaries and attack cases
- [docs/DECISIONS.md](docs/DECISIONS.md) — why, not just what

Sections to come as they are built: architecture diagram, protocol summary,
metrics table.

## License

MIT
