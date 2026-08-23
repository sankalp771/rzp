import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@negotiator/protocol';

export const SERVICE_NAME = 'firewall';

/**
 * Builds the fastify instance without listening, so tests can use
 * `app.inject()` and main.ts can bind the port. Only /health exists until
 * the service's feature work lands.
 */
export function buildApp() {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    protocol: PROTOCOL_VERSION,
  }));
  return app;
}
