import { describe, expect, it } from 'vitest';
import { hashCanonical, sha256Hex } from './hash.js';
import { generateKeyPair, keyIdOf, publicKeyFromPrivate } from './keys.js';
import { signObject, verifyObject } from './sign.js';

describe('keys', () => {
  it('generates 32-byte base64 keys with a hex key_id', () => {
    const kp = generateKeyPair();
    expect(Buffer.from(kp.publicKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(kp.privateKey, 'base64')).toHaveLength(32);
    expect(kp.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.keyId).toBe(keyIdOf(kp.publicKey));
  });

  it('derives the public key from a stored seed', () => {
    const kp = generateKeyPair();
    expect(publicKeyFromPrivate(kp.privateKey)).toBe(kp.publicKey);
  });

  it('rejects malformed keys', () => {
    expect(() => keyIdOf('not base64!')).toThrow();
    expect(() => keyIdOf(Buffer.alloc(31).toString('base64'))).toThrow();
  });
});

describe('hash', () => {
  it('sha256 of empty input matches the known constant', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('hashCanonical is key-order independent', () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
  });
});

describe('sign / verify', () => {
  const kp = generateKeyPair();
  const msg = { protocol: 'ACNP', version: '0.1', seq: 1, body: { total: 1000, items: ['a'] } };

  it('correctly signed object verifies', () => {
    const signed = signObject(msg, kp.privateKey, kp.publicKey);
    expect(signed.signature.alg).toBe('Ed25519');
    expect(signed.signature.key_id).toBe(kp.keyId);
    expect(verifyObject(signed, kp.publicKey)).toEqual({ ok: true });
  });

  it('verification ignores key order of the signed object', () => {
    const signed = signObject(msg, kp.privateKey, kp.publicKey);
    const reordered = {
      signature: signed.signature,
      body: signed.body,
      seq: 1,
      version: '0.1',
      protocol: 'ACNP',
    };
    expect(verifyObject(reordered, kp.publicKey)).toEqual({ ok: true });
  });

  it('tampered payload fails', () => {
    const signed = signObject(msg, kp.privateKey, kp.publicKey);
    const tampered = { ...signed, body: { ...signed.body, total: 999 } };
    expect(verifyObject(tampered, kp.publicKey)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('wrong key fails with key_id_mismatch (declared key_id is checked first)', () => {
    const other = generateKeyPair();
    const signed = signObject(msg, kp.privateKey, kp.publicKey);
    expect(verifyObject(signed, other.publicKey)).toEqual({ ok: false, reason: 'key_id_mismatch' });
  });

  it('forged key_id with wrong signature fails as bad_signature', () => {
    const other = generateKeyPair();
    const signed = signObject(msg, kp.privateKey, kp.publicKey);
    const forged = { ...signed, signature: { ...signed.signature, key_id: other.keyId } };
    expect(verifyObject(forged, other.publicKey)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('missing or malformed signature fails without throwing', () => {
    expect(verifyObject(msg, kp.publicKey)).toEqual({ ok: false, reason: 'missing_signature' });
    const garbage = { ...msg, signature: { alg: 'Ed25519', key_id: kp.keyId, value: 'AAAA' } };
    expect(verifyObject(garbage, kp.publicKey)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('re-signing an already signed object replaces the signature', () => {
    const once = signObject(msg, kp.privateKey, kp.publicKey);
    const twice = signObject(once, kp.privateKey, kp.publicKey);
    expect(twice.signature.value).toBe(once.signature.value); // Ed25519 is deterministic
  });
});
