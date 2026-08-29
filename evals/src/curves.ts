import {
  DEFAULT_BUYER_TUNING,
  bidPrice,
  type BuyerLineView,
  type BuyerParams,
} from '../../services/buyer/src/strategy.js';
import {
  DEFAULT_POLICY as MERCHANT_DEFAULT_POLICY,
  effectiveFloor,
  type MerchantPolicy,
  type VariantPricing,
} from '../../services/merchant/src/policy.js';
import { askPrice } from '../../services/merchant/src/strategy.js';
import type { CurvePrediction, SessionParams } from './types.js';

/**
 * What the two deterministic curves do on their own for a parameter set —
 * computed with the services' OWN pure functions (`bidPrice`, `askPrice`,
 * `effectiveFloor`), so the prediction cannot drift from the code. This is
 * the per-session "curve" column beside every LLM-advised outcome
 * (amendment #1) and the oracle the stub smoke test checks the harness
 * against; the closed-form formulas in the test guard it from tautology.
 *
 * Round order, as the services play it: the buyer offers bid(r); the seller
 * accepts iff bid(r) ≥ ask(r), else counters ask(r); the buyer accepts iff
 * ask(r) ≤ min(reservation, budget) and ask(r) ≤ bid(r+1) (bid past the
 * last round is the reservation), else counters — or walks away when no
 * round is left. Accept and walk-away never consult a model.
 */

/** The demo mandate's and the merchant policy's round cap (min applies). */
export const MANDATE_MAX_ROUNDS = 6;

export function policyFor(params: SessionParams): MerchantPolicy {
  return { ...MERCHANT_DEFAULT_POLICY, ...(params.policy ?? {}) };
}

export function effectiveFloorFor(pricing: VariantPricing, params: SessionParams): number {
  return effectiveFloor(pricing, policyFor(params));
}

export function predictCurve(params: SessionParams, pricing: VariantPricing): CurvePrediction {
  const policy = policyFor(params);
  const maxRounds = Math.min(MANDATE_MAX_ROUNDS, policy.max_rounds);
  const reservation = Math.min(pricing.list_price, params.budget);
  const view: BuyerLineView = {
    item_id: '',
    variant_id: params.target,
    quantity: 1,
    list_price: pricing.list_price,
    reservation,
  };
  const buyer: BuyerParams = {
    ...(params.tuning ?? DEFAULT_BUYER_TUNING),
    max_rounds: maxRounds,
    budget_ceiling: params.budget,
    deadline: '9999-12-31T00:00:00.000Z',
  };
  for (let r = 1; r <= maxRounds; r++) {
    const bid = bidPrice(view, r, buyer);
    const ask = askPrice(pricing, r, policy);
    if (bid >= ask)
      return { outcome: 'settled', price: bid, rounds: r, closed_by: 'seller_accept' };
    const acceptable =
      ask <= Math.min(reservation, params.budget) && ask <= bidPrice(view, r + 1, buyer);
    if (acceptable) return { outcome: 'settled', price: ask, rounds: r, closed_by: 'buyer_accept' };
    if (r + 1 > maxRounds) return { outcome: 'walked_away', rounds: r };
  }
  return { outcome: 'walked_away', rounds: maxRounds };
}
