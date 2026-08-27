# FEATURE-010 — The audit ledger (per-service hash chains) + the thin dashboard — feature freeze

## Scope
- **Goal:** Every service keeps a tamper-evident, append-only, hash-chained
  ledger of every message in, every message out, every boundary
  rejection and every decision it made (PROTOCOL.md §11), with a `verify`
  routine that reports the first broken entry; the four chains are
  readable and verifiable from a terminal script and from a thin
  dashboard that also drives the demo (run, approve/reject, policy,
  replay). End of day = **feature freeze**.
- **In scope:** `packages/ledger` (chain, verify, SQLite store, list);
  wiring at the boundary of merchant, buyer, firewall, settlement
  (settlement alone, CONSTRAINTS #16) + domain events; `GET /ledger`,
  `GET /ledger/verify` per service and merchant `GET/PUT /policy`, buyer
  `GET /sessions`, all behind `DASHBOARD_TOKEN`; `dashboard/` Fastify
  server + static page + token-injecting proxy (Run / Queue / Policy /
  Replay / Evals tabs); `scripts/verify-ledgers.mjs`; Compose `:4005`;
  CI health.
- **Explicitly out of scope:** a central ledger service (D023 — per-party
  chains by design); operator identity on the dashboard (one fully
  trusted operator console, THREAT_MODEL non-goal); the evals report
  itself (Day 11 — the tab reads it if present); `bundle_proposal` (cut).
- **Flow sections touched (FLOW.md):** F6 rewritten (real), F5 (rejections
  as entries), F3 (queue/verdict entries), dashboard entry to F1.
- **Architecture sections touched (ARCHITECTURE.md):** S5 ledger, §3
  dashboard.
- **Risk class:** MEDIUM-HIGH — touches every service's boundary and the
  settlement service (own commit); ~1,900 lines on freeze day.
- **Amendments from approval:**
  1. **`scripts/verify-ledgers.mjs` ships in the demo commit** — both
     money shots (cross-party replay, tamper detection) must run from a
     terminal, never only behind the dashboard.
  2. **Honest sentence — one token reads and writes everything:** the
     dashboard is a fully trusted operator console (`DASHBOARD_TOKEN`
     reads all four chains and, via the proxy, approves holds, edits
     policy, starts runs). Real deployment = per-party read tokens.
     Stated in THREAT_MODEL.
  3. **Honest wording — a session view is not a session chain-verify:**
     chains are per service with sessions interleaved, so a filtered
     slice cannot be hash-verified on its own. UI and docs say "whole
     ledger verified ✓ + this session's envelopes match across parties
     ✓", never "this session's chain verified".
  4. **Tamper-demo hygiene:** the out-of-band `UPDATE` runs on a
     throwaway copy of a service DB, never the live volume; `known-good-3`
     is tagged on clean data.
  5. Drop order today: (1) resume a held/pending run, (2) re-dispatch a
     failed settlement request, (3) evals tab stub, (4) the Policy tab.

## Design (approved)
- **Entry:** `{entry_seq, at, entry_type, session_id|null, ref|null,
  payload}`; `entry_hash = sha256(prev_entry_hash ‖ JCS(entry))`,
  genesis prev = 64 zero nibbles (D018 generalised). One chain per
  service (`ledger_entries`), sessions interleaved. `verify()` walks the
  whole chain and reports the first break by `entry_seq` (bad prev, bad
  hash, or sequence gap). The library exports no update/delete; a
  source-search test greps every workspace for `UPDATE|DELETE …
  ledger_entries`.
- **Entry types:** `MESSAGE_IN`, `MESSAGE_OUT`, `BOUNDARY_REJECTED`,
  `HANDLER_REJECTED`, `BOUNDS_CLAMPED`, `LLM_MOVE`, `VERDICT`,
  `ESCALATION_DECIDED`, `VERIFIER_ABSENT`, `ESCALATION_TIMEOUT`,
  `SETTLEMENT_EVENT` (settlement: D018's event verbatim incl. its
  `entry_hash` — absorbed, not re-derived).
- **Cross-party consistency:** the same signed envelope appears in both
  parties' chains; compared by `message_id` → `hashCanonical(envelope)`.
- **Reads:** `DASHBOARD_TOKEN` (header `x-dashboard-token`; unset → 503).
- **Dashboard:** vanilla page + Fastify proxy `/api/:service/*` injecting
  the tokens server-side; no new dependencies.

## Plan (approved before implementation)
1. feat(ledger): `packages/ledger` + Gate 5 tests (verify, tamper at k
   breaks at k, gap detection, no update/delete anywhere).
2. feat(merchant): boundary + events + `/ledger`, `/ledger/verify`,
   `/policy` GET/PUT; HTTP tamper test.
3. feat(buyer): boundary + events + `/ledger`, `/sessions`.
4. feat(firewall): boundary + verdict/escalation/verifier events.
5. feat(settlement): boundary + `SETTLEMENT_EVENT` import entries. Alone.
6. feat(dashboard): server, page, proxy; Compose; CI health;
   `scripts/verify-ledgers.mjs`.
7. feat(buyer): resume (drop candidate #1).
8. docs close, D023/D024, FLOW F6, THREAT_MODEL T6 + non-goal, README;
   tag `known-good-3`; feature freeze in HANDOVER.
- New dependencies: none.
- Verified by: Gate 0; Gate 5 in the library and per service; Gate 6
  compose-healthy incl. dashboard + CI; live: run from the dashboard,
  approve from the Queue tab, replay with four chains verified +
  cross-party match, tamper a DB copy and see the break reported at that
  entry — from `verify-ledgers.mjs` AND the Replay tab.

## Implementation log
(appended as commits land)

## Verification record
(appended at close)

## Outcome
(at close)
