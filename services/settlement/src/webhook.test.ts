import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSimulatedWebhook, verifyWebhookSignature } from './webhook.js';

const SECRET = 'whsec_test_123';

describe('verifyWebhookSignature (CONSTRAINTS #4, T8)', () => {
  it('accepts the HMAC-SHA256 of the raw body', () => {
    const raw = '{"event":"order.paid","payload":{}}';
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verifyWebhookSignature(raw, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(raw), sig.toUpperCase(), SECRET)).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, a missing header, and an empty secret', () => {
    const raw = '{"event":"order.paid"}';
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verifyWebhookSignature(raw, sig, 'other')).toBe(false);
    expect(verifyWebhookSignature(raw + ' ', sig, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, sig, '')).toBe(false);
    expect(verifyWebhookSignature(raw, 'deadbeef', SECRET)).toBe(false); // length mismatch path
  });

  it('buildSimulatedWebhook produces a body that verifies and names the order', () => {
    const w = buildSimulatedWebhook({ id: 'order_1', amount: 417276 }, SECRET);
    expect(verifyWebhookSignature(w.rawBody, w.signature, SECRET)).toBe(true);
    const body = JSON.parse(w.rawBody) as {
      event: string;
      payload: { payment: { entity: { order_id: string; amount: number; id: string } } };
    };
    expect(body.event).toBe('order.paid');
    expect(body.payload.payment.entity).toMatchObject({
      order_id: 'order_1',
      amount: 417276,
      id: w.paymentId,
    });
  });
});
