/**
 * @negotiator/protocol — ACNP v0.1 (see /PROTOCOL.md).
 * Pure library: canonicalization, hashing, keys, signatures, schemas,
 * validation and replay guarding. No I/O, no transport, no persistence.
 */
export { CanonicalizationError, canonicalBytes, canonicalize } from './canonical.js';
export type { JsonValue } from './canonical.js';
export { hashCanonical, sha256Hex } from './hash.js';
export { generateKeyPair, keyIdOf, publicKeyFromPrivate } from './keys.js';
export type { KeyPair } from './keys.js';
export { SIGNATURE_ALG, signObject, verifyObject } from './sign.js';
export type { Signature, VerifyFailure, VerifyResult } from './sign.js';
export {
  ERROR_CODES,
  FATAL_ERROR_CODES,
  LEDGER_EVENT_TYPES,
  RECOVERABLE_ERROR_CODES,
  SETTLEMENT_ERROR_CODES,
  isFatal,
} from './errors.js';
export type { ErrorCode, FatalErrorCode, LedgerEventType } from './errors.js';
export {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SUPPORTED_MAJOR_VERSIONS,
  CatalogSnapshot,
  LineItem,
  SignatureSchema,
} from './schemas/common.js';
export { IntentMandate, CartMandateBody } from './schemas/mandate.js';
export { BODY_SCHEMAS, MESSAGE_TYPES } from './schemas/bodies.js';
export type {
  BodyOf,
  CatalogItem,
  FirewallVerdictBody,
  MessageType,
  OfferBody,
} from './schemas/bodies.js';
export { EnvelopeSchema, messageSchema } from './schemas/envelope.js';
export type { Envelope, Message } from './schemas/envelope.js';
export { isMessageType, parseMessage } from './validate.js';
export type { ParseResult } from './validate.js';
export { MemoryReplayStore, ReplayGuard } from './replay.js';
export type { ReplayCheckInput, ReplayStore, ReplayVerdict } from './replay.js';
export { makeBoundary } from './boundary.js';
export type { BoundaryConfig, BoundaryResult } from './boundary.js';
export { exportJsonSchemas } from './jsonschema.js';
