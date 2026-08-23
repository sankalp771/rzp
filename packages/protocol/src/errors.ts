/**
 * ACNP error codes, PROTOCOL.md §10. The classification drives the state
 * machine: fatal codes terminate the session; recoverable codes reject one
 * message and leave the session untouched.
 */
export const FATAL_ERROR_CODES = [
  'VERSION_UNSUPPORTED',
  'SIG_INVALID',
  'REPLAY_DETECTED',
  'SEQUENCE_GAP',
  'ACCEPT_MISMATCH',
  'STATE_INVALID',
  'ROUNDS_EXCEEDED',
  'MANDATE_EXPIRED',
  'MANDATE_UNKNOWN',
  'MANDATE_SIG_INVALID',
  'MANDATE_CONFLICT',
] as const;

export const RECOVERABLE_ERROR_CODES = [
  'SCHEMA_INVALID',
  'TOTAL_MISMATCH',
  'CLOCK_SKEW',
  'RATE_LIMITED',
  'ITEM_UNAVAILABLE',
  'SESSION_UNKNOWN',
  'CAPABILITY_UNSUPPORTED',
] as const;

export const SETTLEMENT_ERROR_CODES = [
  'VERDICT_MISSING',
  'VERDICT_MISMATCH',
  'SETTLEMENT_RETRY_EXHAUSTED',
  'WEBHOOK_SIG_INVALID',
] as const;

export const ERROR_CODES = [
  ...FATAL_ERROR_CODES,
  ...RECOVERABLE_ERROR_CODES,
  ...SETTLEMENT_ERROR_CODES,
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type FatalErrorCode = (typeof FATAL_ERROR_CODES)[number];

export function isFatal(code: ErrorCode): code is FatalErrorCode {
  return (FATAL_ERROR_CODES as readonly string[]).includes(code);
}

/** Ledger-only event types (§10) — never sent on the wire. */
export const LEDGER_EVENT_TYPES = [
  'BOUNDS_CLAMPED',
  'ESCALATION_TIMEOUT',
  'SETTLEMENT_ATTEMPT',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];
