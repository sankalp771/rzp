import type { FastifyInstance } from 'fastify';
import type { EntryType, Ledger } from '@negotiator/ledger';

/**
 * Operator read API over a service's own ledger (FEATURE-010, D024):
 *   GET /ledger?session_id=&ref=&entry_type=&after=&limit=  → { entries }
 *   GET /ledger/verify                                      → whole-chain verdict
 * Both behind `x-dashboard-token` = DASHBOARD_TOKEN (unset → 503, like the
 * other control secrets). A filtered listing is a VIEW over the chain,
 * never a sub-chain; only /verify says anything about integrity.
 *
 * Identical copies live in each service (like the replay store) — the
 * services share no runtime beyond the workspace packages by design.
 */
export function ledgerRoutes(app: FastifyInstance, ledger: Ledger, token: string | undefined) {
  const gate = (req: { headers: Record<string, unknown> }) => {
    if (!token) return { status: 503, error: 'DASHBOARD_TOKEN not configured' };
    if (req.headers['x-dashboard-token'] !== token)
      return { status: 401, error: 'invalid dashboard token' };
    return null;
  };
  app.get('/ledger', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    const q = req.query as Record<string, string | undefined>;
    const entries = ledger.list({
      ...(q['session_id'] ? { session_id: q['session_id'] } : {}),
      ...(q['ref'] ? { ref: q['ref'] } : {}),
      ...(q['entry_type'] ? { entry_type: q['entry_type'] as EntryType } : {}),
      ...(q['after'] ? { after: Number(q['after']) } : {}),
      ...(q['limit'] ? { limit: Number(q['limit']) } : {}),
    });
    return reply.code(200).send({ entries, total: ledger.count() });
  });
  app.get('/ledger/verify', async (req, reply) => {
    const denied = gate(req);
    if (denied) return reply.code(denied.status).send({ error: denied.error });
    return reply.code(200).send(ledger.verify());
  });
  return gate;
}
