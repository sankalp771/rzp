import { describe, expect, it } from 'vitest';
import {
  LiveRazorpayClient,
  RazorpayError,
  SimulatedRazorpayClient,
  razorpayModeFromEnv,
} from './razorpay.js';

describe('razorpayModeFromEnv — boot rule (CONSTRAINTS #2)', () => {
  it('refuses a live key id outright', () => {
    expect(() =>
      razorpayModeFromEnv({ RAZORPAY_KEY_ID: 'rzp_live_ABC123', RAZORPAY_KEY_SECRET: 's' }),
    ).toThrow(/not a test-mode key/);
  });

  it('refuses the .env.example placeholder and an empty secret', () => {
    expect(() =>
      razorpayModeFromEnv({ RAZORPAY_KEY_ID: 'rzp_test_xxxxxxxxxxxxxx', RAZORPAY_KEY_SECRET: 's' }),
    ).toThrow(/placeholder or empty/);
    expect(() =>
      razorpayModeFromEnv({ RAZORPAY_KEY_ID: 'rzp_test_RealLooking1', RAZORPAY_KEY_SECRET: '' }),
    ).toThrow(/placeholder or empty/);
  });

  it('accepts real-looking test credentials as live-test', () => {
    expect(
      razorpayModeFromEnv({ RAZORPAY_KEY_ID: 'rzp_test_RealLooking1', RAZORPAY_KEY_SECRET: 'sec' }),
    ).toBe('live-test');
  });

  it('simulated must be named explicitly; unknown modes refuse', () => {
    expect(razorpayModeFromEnv({ RAZORPAY_MODE: 'simulated' })).toBe('simulated');
    expect(() => razorpayModeFromEnv({ RAZORPAY_MODE: 'live' })).toThrow(/refusing to start/);
  });

  it('LiveRazorpayClient itself refuses non-test keys', () => {
    expect(() => new LiveRazorpayClient({ keyId: 'rzp_live_x', keySecret: 's' })).toThrow(
      /test-mode keys only/,
    );
  });
});

describe('LiveRazorpayClient request shapes (fake fetch)', () => {
  it('creates an order with basic auth and the documented fields; classifies errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/orders') && init.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'order_test_1',
            amount: 417276,
            currency: 'INR',
            receipt: 'r',
            status: 'created',
            notes: {},
          }),
          { status: 200 },
        );
      }
      if (url.includes('/orders?receipt=')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      return new Response('{"error":{"code":"BAD_REQUEST_ERROR"}}', { status: 401 });
    }) as unknown as typeof fetch;
    const client = new LiveRazorpayClient({ keyId: 'rzp_test_K', keySecret: 'S', fetchImpl });

    const order = await client.createOrder({
      amount: 417276,
      currency: 'INR',
      receipt: 'r',
      notes: { mandate_hash: 'h' },
    });
    expect(order.id).toBe('order_test_1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      'Basic ' + Buffer.from('rzp_test_K:S').toString('base64'),
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      amount: 417276,
      currency: 'INR',
      receipt: 'r',
    });
    expect(await client.findOrderByReceipt('r')).toBeNull();
    await expect(client.fetchOrder('order_x')).rejects.toMatchObject({ status: 401 });
  });

  it('RazorpayError.retryable: 429/5xx/network yes, 4xx no', () => {
    expect(new RazorpayError('http', 'x', 503).retryable).toBe(true);
    expect(new RazorpayError('http', 'x', 429).retryable).toBe(true);
    expect(new RazorpayError('network', 'x').retryable).toBe(true);
    expect(new RazorpayError('http', 'x', 401).retryable).toBe(false);
  });
});

describe('SimulatedRazorpayClient', () => {
  it('mimics the shapes and scripts failures', async () => {
    const sim = new SimulatedRazorpayClient();
    sim.failNext(1);
    await expect(
      sim.createOrder({ amount: 1, currency: 'INR', receipt: 'r', notes: {} }),
    ).rejects.toBeInstanceOf(RazorpayError);
    const o = await sim.createOrder({ amount: 1, currency: 'INR', receipt: 'r', notes: {} });
    expect(o.id).toMatch(/^order_sim_/);
    expect(await sim.findOrderByReceipt('r')).toEqual(o);
    expect(sim.createCalls).toBe(2);
  });
});
