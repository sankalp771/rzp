import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay webhook signature (CONSTRAINTS #4, THREAT_MODEL T8):
 *   X-Razorpay-Signature = hex( HMAC-SHA256( raw_body, webhook_secret ) )
 * Verified over the RAW request bytes — never over re-serialized JSON —
 * with a constant-time comparison. Nothing downstream may run unless this
 * returns true.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookEventName = 'order.paid' | 'payment.captured' | 'payment.failed';

/** The subset of Razorpay's event shape the handler consumes. */
export interface WebhookEvent {
  event: WebhookEventName | string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
        status?: string;
        error_code?: string;
      };
    };
    order?: { entity: { id: string; amount: number; status?: string } };
  };
}

/**
 * PAYMENT SIMULATION (FEATURE-007 amendment #1): the buyer is an agent —
 * there is no card tap and no checkout UI — so after the (real) order
 * exists, settlement posts this correctly-signed `order.paid` event to its
 * own verifier. The order is real in Razorpay; only the customer's tap is
 * simulated. Real inbound webhooks need a public HTTPS endpoint, which
 * v0.1 does not have (THREAT_MODEL non-goals).
 */
export function buildSimulatedWebhook(
  order: { id: string; amount: number },
  secret: string,
  event: WebhookEventName = 'order.paid',
): { rawBody: string; signature: string; paymentId: string } {
  const paymentId = `pay_sim_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const body: WebhookEvent = {
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: order.id,
          amount: order.amount,
          status: event === 'payment.failed' ? 'failed' : 'captured',
        },
      },
      order: { entity: { id: order.id, amount: order.amount, status: 'paid' } },
    },
  };
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature, paymentId };
}
