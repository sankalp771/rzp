import { describe, expect, it } from 'vitest';
import { generateKeyPair, parseMessage, verifyObject } from '@negotiator/protocol';
import { buildMandateRegister, seedDemoMandate, verifyIntentMandate } from './mandate.js';

const NOW = () => new Date('2026-08-25T10:00:00.000Z');
const principal = generateKeyPair();

describe('verifyIntentMandate (boot gate, D010)', () => {
  it('accepts a well-formed principal-signed mandate and derives its ref', () => {
    const mandate = seedDemoMandate(principal, NOW);
    const check = verifyIntentMandate(mandate, NOW);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.ref).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a tampered budget (principal signature breaks)', () => {
    const mandate = seedDemoMandate(principal, NOW);
    const tampered = { ...mandate, budget_ceiling: 99_999_999 };
    const check = verifyIntentMandate(tampered, NOW);
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain('principal signature');
  });

  it('rejects a mandate signed by a key other than principal_public_key', () => {
    const imposter = generateKeyPair();
    const forged = seedDemoMandate(
      { privateKey: imposter.privateKey, publicKey: imposter.publicKey },
      NOW,
      { principal_public_key: principal.publicKey }, // claims the real principal
    );
    expect(verifyIntentMandate(forged, NOW)).toMatchObject({ ok: false });
  });

  it('rejects an expired mandate', () => {
    const mandate = seedDemoMandate(principal, () => new Date('2026-08-01T00:00:00.000Z'));
    const late = () => new Date('2026-09-15T00:00:00.000Z');
    const check = verifyIntentMandate(mandate, late);
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain('expired');
  });

  it('rejects schema garbage', () => {
    expect(verifyIntentMandate({ goal: 42 }, NOW)).toMatchObject({ ok: false });
  });
});

describe('buildMandateRegister (§7.0 — constructed Day 5, delivered Day 8)', () => {
  it('produces a schema-valid, buyer-signed mandate_register message', () => {
    const buyerKey = generateKeyPair();
    const msg = buildMandateRegister(seedDemoMandate(principal, NOW), buyerKey, 'buyer-demo', NOW);
    const parsed = parseMessage(JSON.parse(JSON.stringify(msg)));
    expect(parsed.ok).toBe(true);
    expect(verifyObject(msg, buyerKey.publicKey).ok).toBe(true);
    expect(msg.body.buyer_public_key).toBe(buyerKey.publicKey);
  });
});
