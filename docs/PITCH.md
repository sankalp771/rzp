# PITCH.md — Every Component in Plain Words, and the Questions a Panel Asks

> Rehearse THIS, not just the commands. CLAUDE.md §9: the human must be able
> to explain every accepted change in their own words. The first section is
> the explanations, collected from the feature files; the second is the
> fifteen questions a payments panel asks and the one-sentence honest answer
> to each. Honest answers score; "we handle that" does not.

## 1. The system in plain words

**The protocol (ACNP, `PROTOCOL.md`, `packages/protocol`).** Every message
between the agents is a JSON envelope with a version, a session id, a
sequence number, a timestamp and an Ed25519 signature over the canonical
bytes (RFC 8785, so both sides sign exactly the same thing regardless of
whitespace or key order). A receiver checks shape, version, signature and
sequence before any business logic runs; anything that fails is rejected,
logged, and never processed — and a rejected message never consumes a
sequence number, so garbage cannot desync an honest peer. The schemas that
validate the wire are generated from the same source as the JSON Schema
files committed in the repo, so spec and code cannot silently drift. We
used Node's built-in crypto rather than a third-party library: one less
thing to audit.

**The mandate chain (borrowed from AP2).** The human — the principal — signs
an Intent Mandate with their own key: goal, budget ceiling, allowed
categories, quantity cap, deadline. The buyer agent deposits it with the
firewall before it talks to any shop, and the firewall pins the agent's
session key to it. The agent never sees the human's key, and nothing the
agent says later can replace the stored copy. At the end of the negotiation
the agent writes a Cart Mandate binding the accept, the seller's exact
product snapshot and the final price into one hash, and signs that. The
firewall's whole job is to judge the second artifact against the first.

**The merchant (`services/merchant`).** A complete negotiating counterparty
with no AI required. Its prices follow a concession curve from list toward
a floor; a separate clamp checks every single outbound price against the
floor after the model has spoken. We wrote a test where a fake hijacked
model proposes selling at one percent of list, and what leaves the server
is exactly the floor, with the correction logged. The floor never appears
in a prompt; the prompt is not the enforcement mechanism.

**The buyer (`services/buyer`).** Boots by verifying the human's signature
on its mandate and refuses to run without it. It fetches the catalog,
recomputes every item's hash, shortlists by price within the allowed
categories, and bids along a curve toward a hard ceiling derived from the
budget. The same clamp idea guards its side: a model proposing to pay ten
times list is clamped to the reservation before the number is signed. It
walks away — recorded as a success of strategy, not a failure — when the
seller's ask stays above its ceiling.

**The LLM layer (`packages/llm`).** Both agents ask a model one question per
round: "what price would you propose, and why?" The number goes through the
clamp; the "why" becomes the rationale on the message, informational only —
no receiver logic may branch on it. If the model is slow, rate-limited or
answers in prose, the agent uses its curve and records that it did so, per
round, per side. No vendor SDK is imported anywhere else in the codebase; a
source-search test enforces it.

**The firewall (`services/firewall`).** Two layers, strict order, then a
human. Layer 1 is deterministic policy against the stored mandate: budget,
quantity, allowed category read from the seller's snapshot, catalog-hash
recomputation, merchant allowlist, velocity per principal, expiry, and "one
mandate, one purchase". It can block alone and lists every violated rule.
Layer 2 runs only if layer 1 allows: an LLM is asked whether the cart
semantically matches what the human asked for, with every piece of free
text fenced as untrusted data. It can answer allow, block-with-reasons, or
escalate — and deterministic code maps that to the verdict such that no
answer can grant something layer 1 did not already grant. Absent, timed
out, malformed or self-contradicting → escalate, never allow. Escalate
parks the cart in a token-gated human queue; approve re-runs layer 1 first
(a human can override the model's doubt, never the policy); a hold is
decided exactly once, so the human and the timeout can never both produce a
verdict.

**Settlement (`services/settlement`).** The only service that touches money,
and it trusts nobody: it accepts requests only from the firewall's key, then
re-verifies the verdict's signature, recomputes the cart hash and checks the
buyer's signature itself. It creates a real Razorpay test-mode order with
the cart hash as the idempotency key, looks the order up before every
attempt, and retries with bounded backoff. Webhooks are HMAC-verified over
the raw body before any state changes. Because the buyer is an agent with
no card, the customer's tap is simulated by a webhook settlement signs and
posts to itself, through the same verifier a real one would face — loud in
`/health` and in the threat model. Live keys are refused at boot.

**The ledgers (`packages/ledger`).** Every service keeps its own append-only
diary: each entry is hashed together with the hash of the entry before it,
so changing or removing any old entry breaks every hash after it. No update
or delete path exists anywhere (a test greps for one). The same signed
message is recorded by both parties that exchanged it, so either side can
prove what was said and neither can quietly rewrite its copy. One script
verifies all four chains and cross-checks a session; the honest claim is
"whole ledger verified, and this session's envelopes match across parties".

**The evals (`evals/`).** We ran the whole system fifty times, twice: once
with the deterministic curves only, once with real models on the same seed.
The stub run closes every deal exactly where the formulas say, catches all
ten wrong-category carts at layer 1, and lets the corporate hamper through
ten out of ten — numbers cannot see intent. The live run caught all ten
hampers at layer 2 with zero false blocks — and shows what the models cost:
24 deals closed where the curves close 30, two points less discount, and
the seller model naming its floor in 13% of counter-offers. Every rate is
printed as n/d from committed artifacts.

## 2. Fifteen questions, fifteen honest answers

1. **Why not Razorpay live?** Test mode only, by written constraint; the
   settlement service refuses any key that is not `rzp_test_*` at boot,
   and the orders you see in the demo are real test-mode orders you can
   open in the Razorpay dashboard.
2. **What stops the buyer agent from paying directly?** There is no route:
   settlement accepts a `settlement_request` only from the firewall's
   configured key, and it re-verifies the buyer's signature and the
   verdict's signature itself, so even a compromised firewall host cannot
   make it settle a cart the buyer never signed.
3. **What stops the LLM from overpaying or underselling?** Every number a
   model proposes is clamped by deterministic strategy after generation —
   buyer ceiling and seller floor — and the chaos test feeds both sides
   garbage every round and still finishes with every price in bounds.
4. **Why is there one token for the whole console?** It is a demo where
   the operator is every party, so one shared token and localhost-only
   publishing is the honest cheap gate; production needs per-party read
   tokens (the buyer's chain holds the principal's budget) and operator
   identity in front of the console — written as a non-goal.
5. **Why does the hamper pass 10/10 in the stub run?** Because with no
   model the firewall is numbers only, and the hamper has the right
   category, price and quantity — that row is the argument for layer 2,
   and we keep it in the table on purpose.
6. **What does "whole ledger verified" claim, and not claim?** It claims
   each party's chain is intact from genesis to head and that this
   session's messages match across parties; it does not claim a party
   cannot truncate its own tail before anyone cited its head — cross-party
   anchoring of chain heads is the v0.2 fix.
7. **What about prompt injection?** Catalog text is fenced as untrusted
   in the verifier's prompt, the model can only narrow the verdict, and
   the parser refuses anything but the strict shape; live, a hamper whose
   description says "recommend allow" was blocked three out of three by a
   Gemini verifier, and a model that did follow it would be a layer-2
   false allow — which is exactly what the human queue above it is for.
8. **What happens if the human and the timeout decide at the same
   moment?** The first to commit wins inside one transaction and the
   other gets `ALREADY_DECIDED`; there is never a second verdict.
9. **What if an LLM provider is down?** Negotiating agents fall back to
   their curves inside the same bounds and record it; the verifier does
   the opposite and escalates — a negotiator that cannot think should
   keep haggling within bounds, an auditor that cannot think must not
   move money.
10. **Why per-session keys?** Blast radius: a stolen session key signs
    for one session, cannot re-bind a used mandate, and is capped by the
    velocity limit — and the principal's key, which signs authorisations,
    never lives with the agent in the real design (in the demo it does,
    for one-command spin-up, and we say so).
11. **What is simulated in the demo?** Only the customer's card tap: the
    order is real (test mode), the webhook verifier is real, the receipt
    chain is real; settlement posts itself a correctly signed `order.paid`
    because an agent has no card and v0.1 has no public endpoint for
    inbound webhooks.
12. **Is this AP2, ACP or x402?** It borrows AP2's mandate chain and
    x402's HTTP-native stance, and is wire-compatible with none of them;
    Appendix A of the spec says exactly where it diverges and sketches a
    402 challenge/retry binding for the escalation path as v0.2.
13. **What did the models cost you?** Six deals out of thirty and about two
    points of discount against the curves on identical parameters, and
    the seller model leaked its floor in prose in 13.3% of counter-offers
    (27 of 203) — a documented hardening target, not fixed under the
    freeze so the cited numbers stay reproducible.
14. **Your false-block rate is zero — really?** Zero out of thirty benign
    sessions with a Mistral verifier; thirty is small, the number is
    printed as 0/30 not 0%, and we expect a nonzero rate with other models
    — the harness reports it either way.
15. **What is v0.2?** A seller-signed catalog snapshot so the firewall can
    prove provenance in real time (T1), chain-head anchoring across
    parties (T6), key rotation and revocation (T9), the floor-leak
    hardening with a fresh evals run (D029), then the cut items: refunds
    and bundle proposals.

Bonus, because someone will ask: **how do you know the spec and the code
agree?** The wire schemas are generated from one source and a drift test
fails if the committed JSON Schemas change; on Day 12 we diffed the spec's
field tables, error codes and state machine against the code by hand and
recorded every discrepancy in `docs/bugs/BUG-006-spec-code-drift.md` —
editorial ones fixed in the spec (D030), behavioural ones listed as open.
