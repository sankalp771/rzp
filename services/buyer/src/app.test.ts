import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@negotiator/protocol';
import { buildApp, SERVICE_NAME } from './app.js';
import { openDb } from './db.js';
import { seedDemoMandate } from './mandate.js';

const NOW = () => new Date('2026-08-25T10:00:00.000Z');

describe(`${SERVICE_NAME} service`, () => {
  it('answers /health', async () => {
    const app = buildApp({ db: openDb(':memory:') });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'buyer' });
    await app.close();
  });

  it('refuses /control/run when CONTROL_TOKEN is not configured (503)', async () => {
    const app = buildApp({ db: openDb(':memory:') });
    const res = await app.inject({ method: 'POST', url: '/control/run', payload: {} });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('rejects /control/run with a wrong or missing token (401)', async () => {
    const mandate = seedDemoMandate(generateKeyPair(), NOW);
    const app = buildApp({ db: openDb(':memory:'), now: NOW, mandate, controlToken: 'secret' });
    const missing = await app.inject({ method: 'POST', url: '/control/run', payload: {} });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/control/run',
      headers: { 'x-control-token': 'nope' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });

  it('refuses /control/run without a configured mandate (503)', async () => {
    const app = buildApp({ db: openDb(':memory:'), controlToken: 'secret' });
    const res = await app.inject({
      method: 'POST',
      url: '/control/run',
      headers: { 'x-control-token': 'secret' },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('refuses to boot on an invalid (tampered) mandate — D010 boot gate', () => {
    const mandate = seedDemoMandate(generateKeyPair(), NOW);
    const tampered = { ...mandate, budget_ceiling: 99_999_999 };
    expect(() => buildApp({ db: openDb(':memory:'), now: NOW, mandate: tampered })).toThrow(
      /refusing to start/,
    );
  });
});
