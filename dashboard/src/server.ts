import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

export const SERVICE_NAME = 'dashboard';

/**
 * The operator console (ARCHITECTURE §3, FEATURE-010, D024). One static page
 * plus a proxy: the browser talks only to this origin, and the proxy injects
 * the operator secrets server-side — DASHBOARD_TOKEN (every party's read
 * API), FIREWALL_REVIEW_TOKEN (the approval queue), CONTROL_TOKEN (start a
 * run) — so no token ever reaches the browser. Only an allowlist of paths is
 * forwarded.
 *
 * HONEST SCOPE (THREAT_MODEL non-goals): this is a fully trusted operator
 * console. Whoever can reach it can read every party's chain (including the
 * principal's budget on the buyer's side) and act as the human reviewer,
 * the merchant's policy owner and the buyer's operator. It has no login of
 * its own; the demo publishes it on localhost only. A real deployment gives
 * each party its own read token and puts operator identity in front.
 */

export const PARTIES = ['merchant', 'buyer', 'firewall', 'settlement'] as const;
export type Party = (typeof PARTIES)[number];

/** What the page may reach through the proxy, per party. */
const ALLOW: Record<Party, RegExp[]> = {
  merchant: [/^\/health$/, /^\/ledger(\/verify)?$/, /^\/sessions$/, /^\/policy$/],
  buyer: [/^\/health$/, /^\/ledger(\/verify)?$/, /^\/sessions$/, /^\/control\/run$/],
  firewall: [
    /^\/health$/,
    /^\/ledger(\/verify)?$/,
    /^\/sessions$/,
    /^\/review(\/[0-9a-f]{64})?$/,
    /^\/verdict\/[0-9a-f]{64}$/,
  ],
  settlement: [/^\/health$/, /^\/ledger(\/verify)?$/, /^\/sessions$/, /^\/receipt\/[0-9a-f]{64}$/],
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AppOptions {
  urls?: Partial<Record<Party, string>>;
  dashboardToken?: string;
  reviewToken?: string;
  controlToken?: string;
  /** Injectable transport for tests. */
  fetchImpl?: FetchLike;
  /** Where the evals report lives (Day 11); 404 until it exists. */
  evalsReportPath?: string;
  /** Per-proxied-call timeout; a held run waits minutes (VERDICT_POLL_TIMEOUT_MS). */
  proxyTimeoutMs?: number;
}

const here = dirname(fileURLToPath(import.meta.url));

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });
  const env = process.env;
  const urls: Record<Party, string> = {
    merchant: (opts.urls?.merchant ?? env['MERCHANT_URL'] ?? 'http://merchant:4001').replace(
      /\/$/,
      '',
    ),
    buyer: (opts.urls?.buyer ?? env['BUYER_URL'] ?? 'http://buyer:4002').replace(/\/$/, ''),
    firewall: (opts.urls?.firewall ?? env['FIREWALL_URL'] ?? 'http://firewall:4003').replace(
      /\/$/,
      '',
    ),
    settlement: (
      opts.urls?.settlement ??
      env['SETTLEMENT_URL'] ??
      'http://settlement:4004'
    ).replace(/\/$/, ''),
  };
  const tokens = {
    dashboard: opts.dashboardToken ?? env['DASHBOARD_TOKEN'],
    review: opts.reviewToken ?? env['FIREWALL_REVIEW_TOKEN'],
    control: opts.controlToken ?? env['CONTROL_TOKEN'],
  };
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const proxyTimeoutMs =
    opts.proxyTimeoutMs ?? Number(env['DASHBOARD_PROXY_TIMEOUT_MS'] ?? 600_000);
  const evalsReportPath =
    opts.evalsReportPath ?? env['EVALS_REPORT_PATH'] ?? resolve(here, '../../evals/report.json');
  const page = readFileSync(resolve(here, '../public/index.html'), 'utf8');

  for (const [name, value] of Object.entries(tokens)) {
    if (!value)
      app.log.warn(
        {},
        `${name} token not set: the matching console actions will fail (503 upstream)`,
      );
  }
  app.log.info({ urls, proxyTimeoutMs }, 'dashboard config');

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    parties: urls,
    tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v ? 'set' : 'missing'])),
    evals_report: existsSync(evalsReportPath) ? 'present' : 'absent',
  }));

  app.get('/api/evals/report', async (_req, reply) => {
    if (!existsSync(evalsReportPath))
      return reply.code(404).send({ error: 'no evals report yet (Day 11)' });
    return reply.type('application/json').send(readFileSync(evalsReportPath, 'utf8'));
  });

  app.all('/api/:party/*', async (req, reply) => {
    const party = (req.params as { party: string }).party as Party;
    const path = `/${(req.params as Record<string, string>)['*'] ?? ''}`;
    if (!PARTIES.includes(party)) return reply.code(404).send({ error: 'unknown party' });
    if (!ALLOW[party].some((re) => re.test(path))) {
      return reply.code(403).send({ error: `path not proxied for ${party}: ${path}` });
    }
    const qs = req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (tokens.dashboard) headers['x-dashboard-token'] = tokens.dashboard;
    if (party === 'firewall' && tokens.review) headers['x-review-token'] = tokens.review;
    if (party === 'buyer' && tokens.control) headers['x-control-token'] = tokens.control;
    const method = req.method.toUpperCase();
    try {
      const res = await fetchImpl(`${urls[party]}${path}${qs}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(req.body ?? {}) }),
        signal: AbortSignal.timeout(proxyTimeoutMs),
      });
      const text = await res.text();
      reply.code(res.status).type(res.headers.get('content-type') ?? 'application/json');
      return reply.send(text);
    } catch (err) {
      return reply.code(502).send({ error: `${party} unreachable: ${String(err)}` });
    }
  });

  return app;
}
