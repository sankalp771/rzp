# BUG-003 — Key-gated contract suite crashed at collection on CI

- **Found:** 2026-08-25, CI run for 9dfd0e3 (`test` job), FEATURE-006.
- **Symptom:** `FAIL packages/llm/src/contract.test.ts — Error: refusing to
  start: SELLER_LLM_PROVIDER=gemini but GEMINI_API_KEY is not set`. Locally
  green (185 passed, 6 skipped).
- **Hypothesis:** `createAdapterFromEnv(...)` was called inside the
  `describe.skipIf(...)` callback body. Vitest executes describe bodies to
  *collect* tests even when the suite is skipped; on CI there is no `.env`,
  so the D015 refuse-to-boot rule threw during collection and the whole
  file failed to load. Locally `.env` supplied the keys, masking it.
- **Tried:** nothing else — the stack trace pointed at factory.ts:57 and
  the collection-time call was the only site.
- **What worked:** construct the adapter in `beforeAll` (skipped suites never
  run hooks). The gate condition itself was already correct.
- **How verified:** `.env` temporarily renamed to simulate a key-less
  runner → `vitest run packages/llm` collects the file and skips 6 tests
  cleanly; restored `.env` + `LLM_CONTRACT=1` → 6 live tests still pass;
  CI green on the fix commit.
- **Lesson:** anything that can throw on a missing secret must live inside a
  test or hook, never at module/describe scope — the refuse-to-boot rule is
  a feature, and it will fire wherever it is reachable.
