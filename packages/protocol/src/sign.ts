import { sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './canonical.js';
import { keyIdOf, toPrivateKeyObject, toPublicKeyObject } from './keys.js';

/**
 * Detached Ed25519 signatures over canonical JSON (PROTOCOL.md §5).
 * The signed bytes are the JCS form of the object WITHOUT its `signature`
 * member. The same scheme signs envelopes (agents, firewall, settlement) and
 * Intent Mandates (principal), so there is exactly one code path to audit.
 */

export const SIGNATURE_ALG = 'Ed25519' as const;

export interface Signature {
  alg: typeof SIGNATURE_ALG;
  key_id: string;
  /** Raw 64-byte signature, base64. */
  value: string;
}

type Unsigned = Record<string, unknown>;

/** Returns a copy of `obj` with `signature` attached. Does not mutate. */
export function signObject<T extends Unsigned>(
  obj: T,
  privateKeyB64: string,
  publicKeyB64: string,
): T & { signature: Signature } {
  const { signature: _drop, ...unsigned } = obj;
  const value = edSign(null, canonicalBytes(unsigned), toPrivateKeyObject(privateKeyB64));
  return {
    ...(unsigned as T),
    signature: {
      alg: SIGNATURE_ALG,
      key_id: keyIdOf(publicKeyB64),
      value: value.toString('base64'),
    },
  };
}

export type VerifyFailure =
  'missing_signature' | 'unsupported_alg' | 'key_id_mismatch' | 'bad_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/**
 * Verify `obj.signature` against `publicKeyB64`. The caller decides which
 * key is legitimate (pinned session key, configured role key, principal
 * key); this function only answers "did that key sign these bytes" and
 * "does the declared key_id match that key" — both MUST pass per §5.
 */
export function verifyObject(obj: Unsigned, publicKeyB64: string): VerifyResult {
  const { signature, ...unsigned } = obj;
  if (!isSignature(signature)) return { ok: false, reason: 'missing_signature' };
  if (signature.alg !== SIGNATURE_ALG) return { ok: false, reason: 'unsupported_alg' };
  if (signature.key_id !== keyIdOf(publicKeyB64)) return { ok: false, reason: 'key_id_mismatch' };
  const sig = Buffer.from(signature.value, 'base64');
  if (sig.length !== 64) return { ok: false, reason: 'bad_signature' };
  let valid = false;
  try {
    valid = edVerify(null, canonicalBytes(unsigned), toPublicKeyObject(publicKeyB64), sig);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

function isSignature(v: unknown): v is Signature {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Signature).alg === 'string' &&
    typeof (v as Signature).key_id === 'string' &&
    typeof (v as Signature).value === 'string'
  );
}
