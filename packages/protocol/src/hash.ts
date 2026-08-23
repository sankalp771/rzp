import { createHash } from 'node:crypto';
import { canonicalBytes } from './canonical.js';

/**
 * PROTOCOL.md §3 hash convention: SHA-256 over the JCS form, lowercase hex.
 * Used for `key_id`, `catalog_hash`, `mandate_hash`, `intent_mandate_ref`
 * and ledger entry hashes — one function so they can never drift apart.
 */
export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash of an arbitrary JSON value in its canonical form. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}
