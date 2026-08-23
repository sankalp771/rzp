import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app.js';

describe(`${SERVICE_NAME} service`, () => {
  it('answers /health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'buyer' });
    await app.close();
  });
});
