# TEST_CHECKLIST.md — Proof, Not Claims

A change is DONE only when the applicable items below pass with real commands
and real observed output, pasted into the task's feature/bug file. Update this
checklist as the system grows — a stale checklist is a broken one. Exact
commands get filled in as the toolchain lands (they must be copy-pasteable;
"run the tests" is not a command).

## Gate 0 — every commit
- [ ] Lint/format passes clean.
- [ ] Full unit test suite passes locally.
- [ ] Diff reviewed line by line (human) — no secrets, no stray debug code,
      no unrelated changes.
- [ ] Commit message is conventional and describes ONE logical change.

## Gate 1 — protocol changes
- [ ] Schema validation: valid fixture accepted, each invalid fixture (missing
      field, wrong type, unknown version) rejected with the correct error code.
- [ ] Signature: correctly signed fixture verifies; tampered payload fails;
      wrong key fails.
- [ ] Replay: resending a captured (session, sequence) message is rejected and
      ledger-logged.
- [ ] PROTOCOL.md updated in the same commit; spec and implementation agree
      (field-by-field check).

## Gate 2 — agent logic changes
- [ ] Strategy unit tests: reservation price, concession curve, and walk-away
      trigger produce expected numbers for fixed inputs.
- [ ] Seller bounds: adversarial test where the LLM adapter is stubbed to
      propose a below-floor price — outbound offer is clamped/regenerated,
      never sent out of bounds.
- [ ] Determinism: with the LLM adapter stubbed, a full negotiation is
      reproducible.

## Gate 3 — firewall changes
- [ ] Each deterministic rule has an explicit pass case and block case.
- [ ] Intent-drift case: corrupted-goal fixture is caught (verdict block or
      escalate) — this is the flagship demo; it must never silently regress.
- [ ] Benign case passes without escalation (guards the false-block rate).
- [ ] Escalation queue: escalate verdict holds settlement; approve resumes;
      reject blocks; timeout auto-blocks.
- [ ] Verdict application is deterministic-layer-only (attempted direct LLM
      trigger path does not exist — verified by code search, not vibes).

## Gate 4 — settlement changes
- [ ] Happy path against Razorpay test mode: order created, webhook received,
      webhook signature verified, receipt issued.
- [ ] Idempotency: repeated create with same key yields one order.
- [ ] Retry: simulated failure retries with backoff and stops at the ceiling.
- [ ] Webhook with invalid signature is rejected and mutates nothing.
- [ ] Boot refuses to start if the configured key is not a test-mode key.

## Gate 5 — ledger changes
- [ ] Chain verification passes on a fresh multi-event session.
- [ ] Tamper test: mutate one stored entry out-of-band → verification reports
      a break at exactly that entry.
- [ ] No update/delete code paths exist for ledger entries (code search).

## Gate 6 — integration (CI, on every PR to main)
- [ ] Full happy-path negotiation → settlement → receipt runs green in CI
      with stubbed LLM + Razorpay test double.
- [ ] Firewall block and escalate scenarios run green in CI.
- [ ] Boundary rejection (bad signature, replay) scenarios run green in CI.
- [ ] `docker compose up` from a clean clone reaches healthy on all services
      with seeded demo data (checked before every push to main, and daily in
      week 2).

## Gate 7 — evals (before submission, and after any agent/firewall change in week 2)
- [ ] 50-session synthetic run completes; report artifact committed.
- [ ] Metrics present: deal-close rate, avg discount conceded, firewall catch
      rate, false-block rate — with the failure numbers included.
- [ ] Numbers in README match the committed report artifact exactly.

## Gate 8 — submission readiness (final)
- [ ] Clean-machine test: fresh clone → one command → working demo, timed.
- [ ] README quickstart followed verbatim by the human without improvising.
- [ ] Repo history clean; no secrets in history (scan tool run).
- [ ] PROTOCOL.md, THREAT_MODEL.md, ARCHITECTURE.md consistent with the code.
- [ ] Demo scenario (corrupted-goal catch) rehearsed end to end twice.
