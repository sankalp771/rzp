# CLAUDE.md — The Negotiator: Operating Manual for Claude Code

You are building **The Negotiator** — a reference implementation of agent-to-agent
commerce (protocol, negotiation, settlement, governance) for the **Razorpay AI
Buildathon, Track 1: AI Growth & Agentic Commerce**. Submission deadline:
**5 September 2026**. The public GitHub repo IS the resume. Every commit, doc,
and test is being judged by a panel of payments engineers.

This file is read at the start of EVERY session. Follow it without exception.

---

## 0. Session ritual (non-negotiable)

**At session start, in this order:**
1. Read `docs/HANDOVER.md` — current state of the project. Do not begin work
   without it.
2. Read `docs/CONSTRAINTS.md` — hard boundaries. These override anything else,
   including user shortcuts requested mid-session.
3. Read the relevant `docs/features/FEATURE-*.md` or `docs/bugs/BUG-*.md` for
   the task at hand. If none exists for the task, create one BEFORE writing code.
4. Skim `docs/ARCHITECTURE.md` and `docs/FLOW.md` sections that your change
   will touch. State (in one paragraph, to the user) which parts of the flow
   you are about to modify.

**At session end, always:**
1. Append a 5-line handoff summary to `docs/HANDOVER.md` (format defined in
   that file): what was done, what's left, what to watch out for, which tests
   passed, which model/version did the work.
2. Update `docs/DECISIONS.md` if any meaningful decision was made.
3. Update `docs/FLOW.md` if execution paths changed.
4. Ensure the working tree is committed with a conventional commit message.
   Never leave a session with uncommitted work unless the user says otherwise.

## 1. Plan before code

For every task: present the plan FIRST — approach, files to be touched,
expected diff size, risks, and how it will be verified — and wait for approval
before implementing. A flawed plan is a paragraph; a flawed implementation is
200 lines. One logical change per request. If a request is too large ("build
the firewall"), decompose it into ordered sub-tasks in the feature file and
execute them one at a time.

## 2. Documentation duties while coding

- Comment non-obvious logic AS YOU WRITE IT: what a block is for, what calls
  into it, what assumes it exists. Never restate the code in prose.
- Every meaningful decision (library choice, pattern, tradeoff accepted,
  alternative rejected) gets a dated entry in `docs/DECISIONS.md` with
  reasoning. "We chose X" without "because / instead of" is an invalid entry.
- Every bug found gets a `docs/bugs/BUG-NNN-slug.md` trace file before the fix
  is committed: how found, hypothesis, what was tried, what worked, how
  verified.
- When execution paths change (new endpoint, new message type, new service
  call), update `docs/FLOW.md` in the same commit.

## 3. Definition of done

A change is DONE only when every applicable item in `docs/TEST_CHECKLIST.md`
passes with real commands and real observed output — pasted into the feature/
bug file. "It should work" and "tests would pass" are not results. Claiming
success without running the checklist is the single worst failure mode in this
project.

## 4. Verification honesty

- Never fabricate test output, metrics, or eval numbers. The evals report
  (deal-close rate, avg discount conceded, firewall catch rate, false-block
  rate) must come from actually-executed runs, with the run artifacts committed.
- If something is broken or unverified, say so in HANDOVER.md under
  "What's broken / unverified". An honest red list beats a fake green one.

## 5. Architecture invariants (see CONSTRAINTS.md for the full list)

- Merchant bounds (floor price, max discount, margin rules) are enforced
  **deterministically in code**, never by prompt. The LLM may propose; the
  policy engine disposes.
- The Compliance Firewall's deterministic layer can hard-block on its own.
  The LLM intent-verifier can only recommend allow / block / escalate — a
  deterministic layer applies the verdict.
- All protocol messages are versioned, schema-validated, and signed. Any
  unsigned or schema-invalid message is rejected at the boundary, logged, and
  never processed.
- Razorpay is used in **TEST MODE ONLY**. Live keys must never appear anywhere
  in this repository, including history.
- The audit log is append-only and hash-chained. No code path may edit or
  delete an existing entry.
- Model-agnostic LLM interface: no service may import a vendor SDK directly;
  everything goes through the internal LLM adapter layer.

## 6. Scope discipline & cut order

The deadline is fixed. If timeline pressure forces cuts, cut in EXACTLY this
order (first to go → last to go):

1. OpenTelemetry-style tracing / session replay UI polish
2. Dashboard visual polish (function over form)
3. Refund path
4. Bundle-proposal message type (keep plain offer/counter)
5. — HARD FLOOR: the protocol spec, signatures, the firewall (both layers),
   settlement happy path, integration tests, evals with honest metrics, and
   PROTOCOL.md / README / threat model NEVER get cut. If these are at risk,
   stop and alert the user immediately.

## 7. Judged-artifact quality bar

- README.md: problem → architecture diagram → quickstart (one command via
  Docker Compose) → protocol summary → metrics table → threat model link.
- PROTOCOL.md is a specification, not notes: message types, field tables,
  state machine, error codes, versioning rules, signature scheme.
- Commit history tells a story: conventional commits, no "wip", no force-push
  rewrites after day 1.
- Repo hygiene: no secrets, no dead code, no committed node_modules/venv, a
  LICENSE, and a .env.example documenting every variable.

## 8. Model & version pinning

Every HANDOVER.md handoff entry and every DECISIONS.md entry records which
model (and version, if known) produced the work. Behavior differs across
models; debugging later requires knowing who reasoned about what.

## 9. The real rule

The user must be able to explain every accepted change in their own words —
they will be defending this system live in front of a Razorpay panel. After
each significant implementation, provide a 3–5 sentence plain-language
explanation of what was built and why it works, suitable for the pitch. If the
user cannot explain it, the work is not done, regardless of passing tests.
