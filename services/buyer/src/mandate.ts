import { randomUUID } from 'node:crypto';
import {
  IntentMandate,
  hashCanonical,
  signObject,
  verifyObject,
  type BodyOf,
  type KeyPair,
  type Message,
} from '@negotiator/protocol';

/**
 * Intent Mandate handling (PROTOCOL.md §8, D010). The buyer holds the
 * mandate READ-ONLY: it verifies the principal's signature at boot and
 * refuses to run without a valid one — an agent that cannot prove its
 * authorization must not spend.
 */

export type MandateCheck =
  { ok: true; mandate: IntentMandate; ref: string } | { ok: false; reason: string };

/** Schema + principal-signature + expiry check. Boot gate and test surface. */
export function verifyIntentMandate(
  raw: unknown,
  now: () => Date = () => new Date(),
): MandateCheck {
  const parsed = IntentMandate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  const mandate = parsed.data;
  const sig = verifyObject(mandate, mandate.principal_public_key);
  if (!sig.ok) return { ok: false, reason: `principal signature: ${sig.reason}` };
  if (now().getTime() > Date.parse(mandate.valid_until)) {
    return { ok: false, reason: `mandate expired at ${mandate.valid_until}` };
  }
  return { ok: true, mandate, ref: hashCanonical(mandate) };
}

/**
 * DEMO CONVENIENCE ONLY — see THREAT_MODEL.md non-goals. In the real design
 * the principal key NEVER lives beside the agent: the human signs the
 * mandate elsewhere (dashboard/CLI) and the buyer receives only the signed
 * artifact. An agent that can read the key that signs its own authorization
 * defeats the point of D010. Here the demo stands in for that human by
 * signing at boot with PRINCIPAL_PRIVATE_KEY from env.
 */
export function seedDemoMandate(
  principal: Pick<KeyPair, 'publicKey' | 'privateKey'>,
  now: () => Date = () => new Date(),
  overrides: Partial<Omit<IntentMandate, 'signature'>> = {},
): IntentMandate {
  const week = 7 * 24 * 3600 * 1000;
  const unsigned = {
    goal: 'Anniversary gift for spouse — something thoughtful under budget',
    budget_ceiling: 500_000, // ₹5,000.00
    constraints: {
      max_quantity: 1,
      categories_allowed: ['gifts', 'jewellery'],
      deadline: new Date(now().getTime() + week).toISOString(),
      delivery_max_days: 7,
    },
    preferences: ['prefer handmade', 'avoid gold'],
    max_rounds: 6,
    valid_until: new Date(now().getTime() + week).toISOString(),
    principal_id: 'principal-demo',
    principal_public_key: principal.publicKey,
    issued_at: now().toISOString(),
    ...overrides,
  };
  return signObject(unsigned, principal.privateKey, principal.publicKey) as IntentMandate;
}

/**
 * Builds the signed `mandate_register` message (§7.0). Day 5 constructs it
 * but has nowhere to deliver it — the firewall lands on Day 8. Sessions
 * record `mandate_registered = 0` until delivery succeeds (amendment #3).
 */
export function buildMandateRegister(
  mandate: IntentMandate,
  buyerKey: KeyPair,
  agentId: string,
  now: () => Date = () => new Date(),
): Message<'mandate_register'> {
  const body: BodyOf<'mandate_register'> = {
    intent_mandate: mandate,
    buyer_public_key: buyerKey.publicKey,
  };
  const unsigned = {
    protocol: 'ACNP' as const,
    version: '0.1',
    type: 'mandate_register' as const,
    message_id: randomUUID(),
    // Registration precedes the negotiation session (§7.0): the firewall
    // keys its state by the mandate ref inside the body; this session_id
    // only scopes the registration exchange itself.
    session_id: randomUUID(),
    seq: 1,
    sender: { agent_id: agentId, role: 'buyer' as const },
    timestamp: now().toISOString(),
    body,
  };
  return signObject(
    unsigned,
    buyerKey.privateKey,
    buyerKey.publicKey,
  ) as unknown as Message<'mandate_register'>;
}
