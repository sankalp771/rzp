# BUG-004 — An unauthenticated message could terminate a live merchant session

- **Found:** 2026-08-26, FEATURE-008 commit 5, by the new
  `chain.test.ts` case "a verdict signed by anything but the configured
  firewall key → SIG_INVALID": after the forged verdict the session was
  `FAILED`, not `COMPLIANCE_REVIEW`.
- **Symptom:** `services/merchant/src/app.ts` answered every boundary
  rejection through `handlers.protocolError(...)`, which (a) set the
  session to `FAILED` for any fatal code — and `SIG_INVALID`,
  `REPLAY_DETECTED`, `SEQUENCE_GAP` are all fatal — and (b) signed the
  reply with the session key at the seller's next outbound `seq`. So a
  third party who knows a `session_id` could kill the session with an
  unsigned message, and even a harmless replay would burn a seller seq the
  honest buyer never sees, wedging it in `SEQUENCE_GAP` on the next real
  reply. Present since Day 4; no Day 4–7 test sent unauthenticated traffic
  into a live session and then continued it.
- **Hypothesis:** §10's "fatal errors terminate the session" was applied
  to the *receiver's* state for messages that had not been authenticated.
  The rule is about a message the receiver has verified (e.g. an
  `ACCEPT_MISMATCH` from the real buyer) and about the *sender's* reaction
  to an error it receives — never about what unverified bytes may do to a
  receiver's state (F5: "never reaches agent logic").
- **Tried:** nothing else; the state write was the single site.
- **What worked:** `protocolError(..., { authenticated: false })` for
  boundary rejections: no state change, no session seq, reply signed with
  the boot-time service key at seq 1 (advisory, outside every stream —
  the same shape settlement and the firewall already used).
- **How verified:** the forged-verdict test now asserts the session stays
  `COMPLIANCE_REVIEW`, the error carries seq 1, and the real verdict still
  lands (`SETTLING`) afterwards; the Day 4 boundary-rejection suite
  (`SCHEMA_INVALID`, `REPLAY_DETECTED`, `SESSION_UNKNOWN`) still passes.
- **Lesson:** every receiver must have a test that sends garbage *into a
  live session* and then proves the session continues. The buyer and
  firewall already behaved (buyer: its own run fails on an unverifiable
  reply, which is its choice about its own session; firewall: service-key
  errors at seq 1). THREAT_MODEL T2 now cites this test.
