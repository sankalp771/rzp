# ROLLBACK.md — The Way Back Out

Confidence to let the AI make big changes comes from knowing exactly how to
reverse them. Before any HIGH-RISK change, fill in a rollback entry FIRST.

## What counts as high-risk (rollback entry mandatory before starting)
- Any change to PROTOCOL.md normative sections or message schemas.
- Any change to signing/canonicalization (can invalidate all stored
  signatures and recorded demos).
- Settlement code (Razorpay calls, webhooks, idempotency, retries).
- Firewall verdict logic or verdict application.
- Ledger entry format or hashing (can break the chain for existing data).
- Dependency upgrades of crypto, HTTP, or Razorpay libraries.

## Standing rules
- Main is always demo-able. High-risk work happens on a branch; merge only
  after Gate 6 (integration) passes.
- Tag the last known-good state before every high-risk merge:
  `known-good-YYYYMMDD-N`. The demo video is only ever recorded from a tag.
- Seeded demo data and eval report artifacts are committed, so any tag is
  fully reproducible.
- Schema/ledger format changes must be additive during the buildathon window
  (new fields optional; version bumped). If a breaking change is unavoidable,
  regenerating all seed data and recorded sessions is part of the task's
  definition of done — plan the time for it.
- After any rollback: re-run Gate 6, re-run the flagship demo scenario, and
  write a BUG file for what forced the rollback.

## Rollback entry format (append below, newest on top)

### RB-NNN — YYYY-MM-DD — <change being protected>
- Revert to: <tag / commit>
- Files in blast radius:
- Data/state to restore or regenerate:
- Re-check after revert: <specific checklist gates>
- Notes:

<!-- entries begin below -->
