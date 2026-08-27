import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, PARTIES, type FetchLike } from './server.js';

/** The console never leaks a token to the browser and forwards only what it should. */
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function stack(
  seen: { url: string; init: RequestInit }[],
  status = 200,
  body: unknown = { ok: true },
) {
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const app = buildApp({
    urls: { merchant: 'http://m', buyer: 'http://b', firewall: 'http://f', settlement: 'http://s' },
    dashboardToken: 'D',
    reviewToken: 'R',
    controlToken: 'C',
    fetchImpl,
    evalsReportPath: 'does/not/exist.json',
  });
  apps.push(app);
  return app;
}

describe('dashboard proxy (D024)', () => {
  it('serves the page and a health that names tokens without showing them', async () => {
    const app = stack([]);
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('The Negotiator');
    expect(page.body).not.toMatch(/x-dashboard-token|x-review-token|x-control-token/);
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health).toMatchObject({
      tokens: { dashboard: 'set', review: 'set', control: 'set' },
      evals_report: 'absent',
    });
    expect(JSON.stringify(health)).not.toMatch(/"D"|"R"|"C"/);
  });

  it('injects the right secrets per party server-side and forwards query strings', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const app = stack(seen);
    await app.inject({ method: 'GET', url: '/api/merchant/ledger?session_id=abc&limit=5' });
    await app.inject({
      method: 'POST',
      url: '/api/firewall/review/' + 'a'.repeat(64),
      payload: { decision: 'approve', reviewer: 'x' },
    });
    await app.inject({ method: 'POST', url: '/api/buyer/control/run', payload: {} });
    expect(seen[0]!.url).toBe('http://m/ledger?session_id=abc&limit=5');
    expect(seen[0]!.init.headers).toEqual({
      'content-type': 'application/json',
      'x-dashboard-token': 'D',
    });
    expect(seen[1]!.init.headers).toMatchObject({
      'x-dashboard-token': 'D',
      'x-review-token': 'R',
    });
    expect(seen[1]!.init.body).toBe('{"decision":"approve","reviewer":"x"}');
    expect(seen[2]!.init.headers).toMatchObject({ 'x-control-token': 'C' });
    expect((seen[2]!.init.headers as Record<string, string>)['x-review-token']).toBeUndefined();
  });

  it('refuses unknown parties and non-allowlisted paths; passes upstream status through', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const app = stack(seen, 401, { error: 'nope' });
    expect((await app.inject({ method: 'GET', url: '/api/razorpay/health' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/merchant/acnp' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/buyer/policy' })).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
    const up = await app.inject({ method: 'GET', url: '/api/settlement/ledger/verify' });
    expect(up.statusCode).toBe(401);
    expect(up.json()).toEqual({ error: 'nope' });
    expect((await app.inject({ method: 'GET', url: '/api/evals/report' })).statusCode).toBe(404);
    expect(PARTIES).toHaveLength(4);
  });

  it('an unreachable party is a 502, never a hang', async () => {
    const app = buildApp({
      urls: { merchant: 'http://m' },
      dashboardToken: 'D',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/merchant/health' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('ECONNREFUSED') });
  });
});
