# The Negotiator — Documentation System

Drop this bundle into the repo root of the project. It implements a
full-discipline AI-assisted workflow (handover, decisions, flow tracing,
guardrails, verification, rollback) tailored to The Negotiator and the
Razorpay AI Buildathon deadline of 5 September 2026.

## Layout

```
CLAUDE.md                      ← Claude Code reads this every session (keystone)
PROTOCOL.md                    ← ACNP v0.1 wire-protocol spec (flagship judged doc)
docs/
  HANDOVER.md                  ← living current-state + 5-line session handoffs
  DECISIONS.md                 ← why, not just what (seeded with D001–D005)
  FLOW.md                      ← how execution travels (F1–F7)
  ARCHITECTURE.md              ← the system map (5 services + cross-cutting)
  CONSTRAINTS.md               ← hard boundaries; overrides everything
  TEST_CHECKLIST.md            ← Gates 0–8; done = pasted real output
  ROLLBACK.md                  ← high-risk change protocol + entry log
  THREAT_MODEL.md              ← judged deliverable, pre-structured (T1–T10)
  BUILD_PLAN.md                ← day-by-day two-week plan + cut order
  EVALS.md                     ← eval methodology: 50-session matrix, honest metrics
  features/FEATURE-TEMPLATE.md ← copy before building anything
  bugs/BUG-TEMPLATE.md         ← copy before fixing anything
```

## How to run a session

1. Open Claude Code in the repo. It reads `CLAUDE.md` automatically.
2. State the task. CC must respond with a plan referencing a FEATURE/BUG file
   (creating one if missing) before writing code.
3. You read every diff. You approve plans, not vibes.
4. Session ends with the 5-line handoff appended to HANDOVER.md — if it
   doesn't, the session isn't over.

## House rules for you (the human)

- Never accept a change you can't explain in your own words — you will be
  explaining this system to a Razorpay panel, live.
- One logical change per request. "Build the firewall" is a feature file with
  sub-tasks, not a prompt.
- If the schedule slips past one cumulative day, invoke the cut order —
  that decision is pre-made so panic can't make it for you.
- PROTOCOL.md, THREAT_MODEL.md, and the evals report are as much the product
  as the code. Guard their time.
