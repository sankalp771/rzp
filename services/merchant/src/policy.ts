import { z } from 'zod';
import type { MerchantDb } from './db.js';

/**
 * Deterministic bounds engine (CONSTRAINTS #5, PROTOCOL.md §7.5).
 * Every outbound seller price passes through `clampUnitPrice` AFTER whatever
 * proposed it (today the deterministic strategy, from Day 6 an LLM). The
 * prompt is never the enforcement mechanism; this file is.
 */

export const MerchantPolicy = z.object({
  /** Hard cap on discount from list, e.g. 0.25 = never more than 25% off. */
  max_discount_pct: z.number().min(0).max(0.9),
  /** Per-category overrides of max_discount_pct. */
  category_max_discount_pct: z.record(z.string(), z.number().min(0).max(0.9)),
  /** Refuse carts larger than this many units total. */
  max_quantity_per_order: z.number().int().positive(),
  /** Negotiation cap the merchant advertises in session_ack. */
  max_rounds: z.number().int().positive().max(50),
  /**
   * Concession curve exponent for the deterministic strategy: 1 = linear
   * from list to effective floor across rounds; >1 concedes late.
   */
  concession_exponent: z.number().min(0.25).max(4),
  /** Capabilities advertised in session_ack. */
  capabilities: z.object({
    bundling: z.boolean(),
    quantity_discounts: z.boolean(),
    delivery_sla_negotiation: z.boolean(),
  }),
});
export type MerchantPolicy = z.infer<typeof MerchantPolicy>;

export const DEFAULT_POLICY: MerchantPolicy = {
  max_discount_pct: 0.25,
  category_max_discount_pct: { jewellery: 0.15, industrial: 0.1 },
  max_quantity_per_order: 5,
  max_rounds: 6,
  concession_exponent: 1.6,
  capabilities: { bundling: false, quantity_discounts: true, delivery_sla_negotiation: false },
};

export function loadPolicy(db: MerchantDb): MerchantPolicy {
  const row = db.prepare('SELECT config FROM merchant_policy WHERE id = 1').get() as
    { config: string } | undefined;
  // Invalid stored config is a boot error, not a fallback — silently
  // reverting to defaults could widen discounts behind the merchant's back.
  if (!row) throw new Error('merchant_policy row missing — seed did not run');
  return MerchantPolicy.parse(JSON.parse(row.config));
}

/** Dashboard `PUT /policy`: validated by the same schema that guards boot. */
export function savePolicy(db: MerchantDb, policy: MerchantPolicy): MerchantPolicy {
  const parsed = MerchantPolicy.parse(policy);
  db.prepare('UPDATE merchant_policy SET config = ? WHERE id = 1').run(JSON.stringify(parsed));
  return parsed;
}

export interface VariantPricing {
  list_price: number;
  floor_price: number;
  category: string;
}

/**
 * The effective floor is the tighter of the variant's absolute floor and the
 * policy discount cap for its category. Both bounds are merchant-side only.
 */
export function effectiveFloor(v: VariantPricing, policy: MerchantPolicy): number {
  const maxDiscount = policy.category_max_discount_pct[v.category] ?? policy.max_discount_pct;
  const discountFloor = Math.ceil(v.list_price * (1 - maxDiscount));
  return Math.max(v.floor_price, discountFloor);
}

export interface ClampResult {
  price: number;
  clamped: boolean;
  /** Set when clamped; goes to the log (and the ledger from Day 10). */
  reason?: string;
}

/**
 * Force a proposed outbound unit price into [effectiveFloor, list price].
 * Prices above list are also clamped — a "negotiation" that drifts above
 * list is either a bug or an LLM hallucination, never sent.
 */
export function clampUnitPrice(
  proposed: number,
  v: VariantPricing,
  policy: MerchantPolicy,
): ClampResult {
  const floor = effectiveFloor(v, policy);
  if (!Number.isSafeInteger(proposed)) {
    return { price: v.list_price, clamped: true, reason: `non-integer price ${proposed}` };
  }
  if (proposed < floor) {
    return { price: floor, clamped: true, reason: `below effective floor ${floor}` };
  }
  if (proposed > v.list_price) {
    return { price: v.list_price, clamped: true, reason: `above list ${v.list_price}` };
  }
  return { price: proposed, clamped: false };
}
