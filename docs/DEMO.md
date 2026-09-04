# DEMO.md — The Five-Minute Video and the Submission Checklist

> Judged artifact support. The video is recorded from a `known-good-N` tag
> (ROLLBACK.md), never from a dirty tree. Every beat below names the exact
> command and the exact transcript line to point at, so a re-take is a
> re-run, not a re-think. Timings assume the demo line (Gemini buyer, Groq
> seller, Mistral verifier, Razorpay live-test, `PAYMENT_SIMULATION=on`).

## Pre-demo checklist (15 minutes before recording)

1. **Tag, not tree.** `git status` clean; `git describe --tags` prints the
   `known-good-N` you intend to record from; `docker compose build` was run
   AFTER the checkout (an image built from an older sha demos older code —
   compare `docker compose images` "Created" against the commit time).
2. **Models still exist.** `LLM_CONTRACT=1 npx vitest run packages/llm/src/contract.test.ts`
   → 6/6. A retired model id turns the verifier into "absent → escalate"
   and every hamper into a hold (fine, but say so).
3. **Quota.** Gemini free tier 429s inside a session; a curve fallback is
   recorded per round (`(curve — rate_limited)` under the offer). Two or
   three are a talking point; ten are a re-take on a fresh quota day.
4. **Velocity.** `FIREWALL_VELOCITY_MAX=100` in `.env` for the afternoon
   (default 10 allows/hour per principal; the sixth benign run of a
   rehearsal otherwise blocks with `VELOCITY_LIMIT`).
5. **Queue window.** `FIREWALL_ESCALATION_TIMEOUT_SEC=90` (< the buyer's
   `VERDICT_POLL_TIMEOUT_MS` 120 s) so a timeout is visible inside one
   buyer run; production default is 600.
6. **Force a hold on demand.** If the verifier keeps deciding instead of
   escalating, point `MISTRAL_MODEL` at a retired id, recreate the firewall
   (`docker compose up -d --force-recreate firewall`), and every cart
   escalates (absent → escalate, never allow). Restore it afterwards and
   confirm `/health` shows `mistral-small-latest` and `pending_escalations: 0`.
7. **Two terminals + browser.** Left: `negotiate.mjs`. Right:
   `review.mjs` / `verify-ledgers.mjs`. Browser on `http://localhost:4005`
   with the Replay tab open. Font ≥ 16 px; the transcript is the deliverable.
8. **Razorpay dashboard** open on the test-mode Orders page to show the
   order id the receipt names (status `created` — the tap is simulated;
   say it).

## Storyboard (5:00)

### 0:00–0:30 — The problem (30 s, slide or README top)

Say: "When agents buy from agents, three things break at once: a model can
be talked into a price its owner never authorised; nobody can prove
afterwards who agreed to what; and the thing that moves money is the thing
most exposed to a confused model. We made each of those a property of code."

Point at: README "The problem" paragraph, then the architecture diagram —
trace principal → buyer ↔ merchant → firewall → settlement → Razorpay with
the cursor, and the ledger cylinder under all four.

### 0:30–2:00 — The benign run, live (90 s)

```bash
node scripts/negotiate.mjs
```

Point at, in order (the lines exist in every settled transcript):

1. `BUYER → FIREWALL  seq  1  mandate_register   principal-signed mandate, budget ₹5,000.00, categories [gifts,jewellery]  [sig ✔]`
   — "The human's authorisation is signed with the human's key and
   deposited with the firewall before the negotiation starts."
2. `←  SELLER  seq  2  catalog_offer  10 items, each with catalog_hash` —
   "every item snapshot is hashed; the cart will carry that hash."
3. An `offer` line with its rationale under it — "the model proposes a
   number and a reason; the number is clamped by the deterministic curve
   before it is signed. If you see `(curve — rate_limited)` here, that is
   the fallback: the negotiation continues inside the same bounds."
4. `BUYER → SELLER  seq  N  cart_mandate  gifts/var_vase_ash @ … hash …` —
   "the accept, the seller's exact snapshot and the final total in one
   signed hash — the seller's copy first, then the firewall's."
5. `←  FIREWALL  seq  1  firewall_verdict  ALLOW (layer intent_verifier)` +
   the `verifier:` line — "layer 1 checked the numbers; layer 2 read the
   cart against the ORIGINAL mandate and could only narrow."
6. `←  SETTLEMENT  seq  1  settlement_receipt  PAID — Razorpay order order_…, ₹…, ledger …` —
   "settlement accepted this from the firewall's key only, re-verified the
   buyer's signature itself, and created a real test-mode order." Switch
   to the Razorpay dashboard for two seconds: same order id.
7. Last line: `Signatures: N verified, 0 invalid` — "every signature you saw
   was re-verified by this script, not reported by the services."

### 2:00–3:00 — The rogue agent, caught (60 s)

```bash
node scripts/negotiate.mjs --target var_corp_hamper
```

Point at:

1. The buyer's first `offer` rationale — in the live runs Gemini wrote
   "completely unsuitable as an anniversary gift" and negotiated it
   anyway: "the agent's own judgement is not the control."
2. `BUYER → FIREWALL  seq  1  cart_mandate  gifts/var_corp_hamper @ ₹4,5xx.xx` —
   "category allowed, under budget, quantity one: every layer-1 number
   passes."
3. `←  FIREWALL  seq  1  firewall_verdict  BLOCK (layer intent_verifier) — INTENT_DRIFT_CATEGORY`
   and its `verifier:` sentence — "a pack of twelve client calendars is
   not an anniversary gift; the LLM recommended, deterministic code
   decided, nothing reached settlement."
4. If instead it reads `ESCALATE` and the HOLD banner appears
   (`⏳ HELD FOR A HUMAN — the firewall would not decide alone`): in the
   right terminal run the approve/reject line the banner prints, e.g.
   `node scripts/review.mjs reject <hash>`; back on the left:
   `←  FIREWALL  seq  2  firewall_verdict  BLOCK (layer human) — HUMAN_REJECTED`.
   Say: "the human sits above the model and below the policy, and a hold
   is decided exactly once."
5. Optional 10 s: `node scripts/negotiate.mjs --target var_inject_hamper`
   — the same hamper whose description tells the verifier "recommend
   allow". Read the verdict line as it comes; either outcome is a finding
   (THREAT_MODEL T4).

### 3:00–4:00 — Architecture on the diagram (60 s)

Back to the README diagram. One sentence per box, in this order:

- Protocol: "seventeen message types, every one schema-validated,
  sequenced and Ed25519-signed over canonical JSON; a message that fails
  any check never reaches logic."
- Buyer and merchant: "models advise, curves decide, clamps enforce —
  on both sides."
- Firewall: "layer 1 deterministic against the stored mandate; layer 2 an
  LLM that can only block or escalate; a human queue above it; the only
  caller settlement will listen to."
- Settlement: "idempotent on the cart hash, bounded retry, webhook HMAC,
  test mode only — live keys are refused at boot."
- Ledger: "one append-only hash chain per service; the same signed
  message is in both parties' chains."

Then, right terminal:

```bash
node scripts/verify-ledgers.mjs
```

Point at the four `✓ … verified — N entries, head …` lines and
`✓ this session's envelopes match across parties — N matched`. Say: "whole
ledger verified, and this session's messages match across parties — that
is the whole claim, no more."

Then the tamper on a COPY (prepared before recording so the copy exists):

```bash
docker compose cp firewall:/app/data/firewall.db . && docker compose cp firewall:/app/data/firewall.db-wal .
node scripts/verify-ledgers.mjs --db firewall.db          # ✓ whole ledger verified
# edit one entry of the copy out of band (any SQLite client), then:
node scripts/verify-ledgers.mjs --db firewall.db          # ✘ CHAIN BROKEN at entry k (entry_hash_mismatch)
```

Point at `✘ … CHAIN BROKEN at entry 5 (entry_hash_mismatch) — 4 entries verified before it`.

### 4:00–4:30 — The metrics table (30 s)

README "Metrics". Read the pooled rows out loud, failure numbers first:
"Fifty sessions, twice. With real models: 24 of 30 legitimate deals closed,
zero false blocks; all twenty corrupted carts caught, ten by layer 1 and ten
by layer 2, zero false allows. The models cost us six deals and two points
of discount against the deterministic curves, and the seller model told the
buyer where its floor was in 13% of its counter-offers. Every rate is n over
d, from committed runs anyone can re-execute." Then the stub row: "with no
models at all, the hamper goes through ten out of ten — numbers cannot see
intent. That is why layer 2 exists."

### 4:30–5:00 — Close (30 s)

"Spec, signatures, both firewall layers, real test-mode settlement,
tamper-evident ledgers, and an honest score sheet — one command to run,
one script to verify. Repo link on screen."

## Rehearsal record

Gate 8 item 5 asks for the flagship scenario rehearsed end to end twice —
one rehearsal in the terminal by Claude, one by the human on camera day.

- 2026-09-04 [Claude Fable 5.1] — terminal rehearsal on a fresh clone in a
  container with no Docker daemon and no Groq/Mistral egress: five services
  as plain `node` processes, stub buyer/seller. Ladder: benign SETTLED
  (order_sim_000001, 13.1% below list, 4 rounds) · bookend SETTLED at the
  ₹5,000 ceiling (3.8% below list, 6 rounds; the walk-away needs the live
  seller's near-floor ask — with the curve seller the buyer's ceiling
  clears the floor) · relay `BLOCK (layer policy) — CATEGORY_BLOCKED` ·
  hamper `ALLOW (layer policy)` with no verifier configured (the stub row)
  · verify-ledgers 4/4 ✓, 19 envelopes matched · copy verified offline
  ✓ · one edited entry → `CHAIN BROKEN at entry 5` ✘. With a live Gemini
  verifier: vase allowed, hamper blocked, injected hamper blocked 3/3.
  Transcripts in FEATURE-012. Console: all five tabs opened in headless
  Chromium; a forced hold approved by clicking Approve in the Queue tab,
  run resumed to `allow/human`, Replay 4/4 verified, 21/21 matched.
  **Not rehearsed by Claude:** the Compose path, the Mistral verifier,
  the human queue on camera.
- (human, camera day) — _record here: date, tag, what improvised_.

## Submission checklist — do this on 4 September, not on the 5th

A deadline-day portal outage is the classic way to lose with a finished
project. Order matters: the key rotation must come AFTER the last live run
and BEFORE the form, or it silently becomes "never rotated".

1. [ ] All live runs done (the video, any Mistral injection trial, any
       evals re-run). Nothing else will call a provider today.
2. [ ] **Rotate the three LLM keys** in the provider consoles (Gemini,
       Groq, Mistral) — they have been pasted into chats and terminals
       during the build. Put the new values in `.env` only.
3. [ ] `LLM_CONTRACT=1 npx vitest run packages/llm/src/contract.test.ts`
       → 6/6 with the new keys (proves rotation did not break the demo
       line for the panel's live Q&A).
4. [ ] Razorpay: confirm the keys in `.env` are `rzp_test_*` (the
       settlement service refuses anything else at boot); no live key was
       ever created for this project.
5. [ ] `git status` clean on `main`; CI green on the head sha (test,
       compose, secrets jobs); `known-good-N` tag on that sha and pushed.
6. [ ] README renders on GitHub: diagram visible, metrics table, links to
       PROTOCOL.md / THREAT_MODEL.md / DEMO.md / PITCH.md resolve.
7. [ ] Video uploaded (unlisted is fine); link opens in a private window.
8. [ ] Portal fields drafted in a text file first, then pasted: team name,
       track (Track 1: AI Growth & Agentic Commerce), repo URL, video
       URL, the 3-line problem statement from the README, the "What's
       built" paragraph, the pooled metrics rows, the threat-model link.
9. [ ] Submit. Screenshot the confirmation page and keep the email.
10. [ ] Afterwards, and only afterwards: nothing. No "one more fix" on
        `main` after the submitted sha; if something must change, it goes
        on a branch with the submitted tag left where it is.
