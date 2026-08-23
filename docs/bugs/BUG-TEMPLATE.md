# BUG-NNN — <short name>

> Copy to `docs/bugs/BUG-NNN-slug.md` BEFORE committing the fix. The trace
> matters as much as the fix — it is what makes the next occurrence cheap.

## Discovery
- **Found via:** <test gate / demo run / eval / manual>
- **Symptom:** <what was observed, exactly>
- **Expected:** <what should have happened>
- **Reproduction:** <concrete steps or fixture; must be re-runnable>
- **Flow section (FLOW.md):** <where in the path it lives>

## Investigation log (append as you go)
- YYYY-MM-DD [model] — Hypothesis: … → Tried: … → Result: …

## Root cause
- <the actual cause, in plain language — not the patch description>

## Fix
- **Change made:**
- **Why this fixes the root cause (not just the symptom):**
- **Blast radius checked:** <what else uses the changed code>

## Verification
- **Regression test added:** <test name/location — mandatory for any bug that
  reached main>
- **Gate items re-run, with pasted output:**

## Outcome
- **Status:** open / fixed / won't-fix (with reasoning)
- **Decisions generated:** <DECISIONS.md ids or "none">
- **Prevention:** <checklist item, constraint, or lint added so this class of
  bug is caught earlier next time — "none possible" must be argued, not
  assumed>
