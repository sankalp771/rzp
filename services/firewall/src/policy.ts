import { hashCanonical, type CartMandateBody, type IntentMandate } from '@negotiator/protocol';

/**
 * Layer 1 — the deterministic policy engine (ARCHITECTURE S4, FLOW F1 step
 * 7 / F3, PROTOCOL.md §7.9). Pure code: cart + stored mandate + a small
 * context the caller reads from storage → verdict. No LLM anywhere in this
 * file, by construction (CONSTRAINTS #6; Gate 3 item 5 greps for it).
 *
 * Every rule is evaluated — the verdict lists ALL violations, not the first
 * one — so a blocked demo run and the evals report say exactly why.
 */

export const LAYER1_REASONS = [
  'AMOUNT_CAP_EXCEEDED',
  'QUANTITY_CAP_EXCEEDED',
  'CATEGORY_BLOCKED',
  'CATALOG_HASH_MISMATCH',
  'MERCHANT_NOT_ALLOWLISTED',
  'VELOCITY_LIMIT',
  'MANDATE_EXPIRED',
  'DEADLINE_PASSED',
  'MANDATE_ALREADY_USED',
  'MANDATE_IN_REVIEW',
] as const;
export type Layer1Reason = (typeof LAYER1_REASONS)[number];

export interface PolicyConfig {
  /** Seller agent ids this firewall will let a principal buy from. */
  merchantAllowlist: readonly string[];
  /** Max allowed carts per principal inside the window (amendment #5). */
  velocityMax: number;
  velocityWindowSec: number;
}

/** Facts the caller reads from storage; the engine never touches the DB. */
export interface PolicyContext {
  now: Date;
  /** Carts already ALLOWED for this principal inside the velocity window (this cart excluded). */
  recentAllowsForPrincipal: number;
  /**
   * Latest verdict on any OTHER cart bound to the same intent_mandate_ref
   * (§7.9 one-mandate-one-purchase): `allowed` consumed it; `in_review`
   * (pending escalate) counts as in use — amendment #3; `blocked`/`unused`
   * leave it available.
   */
  mandateStatus: 'unused' | 'allowed' | 'in_review' | 'blocked';
}

export interface Layer1Result {
  verdict: 'allow' | 'block';
  reasons: Layer1Reason[];
  /** One human-readable line per reason, same order. Logs and dashboard, never the wire. */
  details: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  merchantAllowlist: ['merchant-demo'],
  velocityMax: 10,
  velocityWindowSec: 3600,
};

export function evaluateLayer1(
  cart: CartMandateBody,
  mandate: IntentMandate,
  cfg: PolicyConfig,
  ctx: PolicyContext,
): Layer1Result {
  const reasons: Layer1Reason[] = [];
  const details: string[] = [];
  const fail = (r: Layer1Reason, d: string) => {
    reasons.push(r);
    details.push(d);
  };
  const t = ctx.now.getTime();

  // Time windows — judged by the firewall's clock, never the buyer's.
  if (t > Date.parse(mandate.valid_until)) {
    fail('MANDATE_EXPIRED', `mandate valid_until ${mandate.valid_until} has passed`);
  }
  if (t > Date.parse(mandate.constraints.deadline)) {
    fail('DEADLINE_PASSED', `mandate deadline ${mandate.constraints.deadline} has passed`);
  }

  // One mandate, one purchase (§7.9); a pending escalation is "in use".
  if (ctx.mandateStatus === 'allowed') {
    fail('MANDATE_ALREADY_USED', 'this Intent Mandate was already consumed by an allowed cart');
  } else if (ctx.mandateStatus === 'in_review') {
    fail('MANDATE_IN_REVIEW', 'another cart on this Intent Mandate is awaiting a human decision');
  }

  if (!cfg.merchantAllowlist.includes(cart.seller_agent_id)) {
    fail('MERCHANT_NOT_ALLOWLISTED', `seller ${cart.seller_agent_id} is not on the allowlist`);
  }

  // Per line: the snapshot must be the one the hash commits to, must
  // describe this very item/variant, and must be in an allowed category.
  let quantity = 0;
  for (const li of cart.line_items) {
    quantity += li.quantity;
    const snap = li.catalog_item;
    const describesLine =
      snap.item_id === li.item_id && snap.variants.some((v) => v.variant_id === li.variant_id);
    if (hashCanonical(snap) !== li.catalog_hash || !describesLine) {
      fail(
        'CATALOG_HASH_MISMATCH',
        `${li.item_id}/${li.variant_id}: catalog_hash does not commit to the snapshot given`,
      );
    }
    if (!mandate.constraints.categories_allowed.includes(snap.category)) {
      fail(
        'CATEGORY_BLOCKED',
        `${li.item_id} is "${snap.category}"; mandate allows ${mandate.constraints.categories_allowed.join(', ')}`,
      );
    }
  }
  if (quantity > mandate.constraints.max_quantity) {
    fail(
      'QUANTITY_CAP_EXCEEDED',
      `cart quantity ${quantity} exceeds max_quantity ${mandate.constraints.max_quantity}`,
    );
  }
  if (cart.total > mandate.budget_ceiling) {
    fail(
      'AMOUNT_CAP_EXCEEDED',
      `cart total ${cart.total} exceeds budget_ceiling ${mandate.budget_ceiling}`,
    );
  }
  if (ctx.recentAllowsForPrincipal >= cfg.velocityMax) {
    fail(
      'VELOCITY_LIMIT',
      `${ctx.recentAllowsForPrincipal} carts already allowed for ${mandate.principal_id} in the last ${cfg.velocityWindowSec}s (max ${cfg.velocityMax})`,
    );
  }

  return { verdict: reasons.length === 0 ? 'allow' : 'block', reasons, details };
}

/** Env → config; unset values take the safe-direction defaults. */
export function policyFromEnv(env: Record<string, string | undefined>): PolicyConfig {
  const list = (env['FIREWALL_MERCHANT_ALLOWLIST'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    merchantAllowlist: list.length > 0 ? list : DEFAULT_POLICY.merchantAllowlist,
    velocityMax: Number(env['FIREWALL_VELOCITY_MAX'] ?? DEFAULT_POLICY.velocityMax),
    velocityWindowSec: Number(
      env['FIREWALL_VELOCITY_WINDOW_SEC'] ?? DEFAULT_POLICY.velocityWindowSec,
    ),
  };
}
