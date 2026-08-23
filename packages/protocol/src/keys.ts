import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { sha256Hex } from './hash.js';

/**
 * Ed25519 key handling per PROTOCOL.md §5. On the wire a public key is the
 * raw 32-byte value, base64 (standard, padded); `key_id` is SHA-256 of those
 * raw bytes as lowercase hex. Private keys never leave the process — we
 * expose raw 32-byte seeds only so services can persist long-lived
 * firewall/settlement/principal keys via environment variables.
 */

// DER prefixes for SPKI / PKCS#8 Ed25519 (RFC 8410). node:crypto only
// imports/exports DER or PEM, so we wrap/unwrap the raw 32 bytes ourselves.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface KeyPair {
  /** Raw 32-byte public key, base64. This is what goes in messages. */
  publicKey: string;
  /** Raw 32-byte private seed, base64. Never put in a message. */
  privateKey: string;
  keyId: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX.length);
  return {
    publicKey: pub.toString('base64'),
    privateKey: priv.toString('base64'),
    keyId: keyIdOf(pub.toString('base64')),
  };
}

/** `key_id` = SHA-256 of the raw public key bytes, lowercase hex (§5). */
export function keyIdOf(publicKeyB64: string): string {
  return sha256Hex(decodeRaw(publicKeyB64, 'public key'));
}

/** Derive the public half from a base64 seed (for keys loaded from env). */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const pub = createPublicKey(toPrivateKeyObject(privateKeyB64))
    .export({ type: 'spki', format: 'der' })
    .subarray(SPKI_PREFIX.length);
  return pub.toString('base64');
}

export function toPublicKeyObject(publicKeyB64: string): KeyObject {
  const raw = decodeRaw(publicKeyB64, 'public key');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function toPrivateKeyObject(privateKeyB64: string): KeyObject {
  const raw = decodeRaw(privateKeyB64, 'private key');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function decodeRaw(b64: string, what: string): Buffer {
  const raw = Buffer.from(b64, 'base64');
  // Re-encode check catches non-base64 input that Buffer silently truncates.
  if (raw.length !== 32 || raw.toString('base64') !== b64) {
    throw new Error(`invalid ${what}: expected 32 raw bytes, standard base64`);
  }
  return raw;
}
