import type { BodyOf, LineItem } from '@negotiator/protocol';
import {
  clampUnitPrice,
  effectiveFloor,
  type MerchantPolicy,
  type VariantPricing,
} from './policy.js';

/**
 * Deterministic seller strategy (D002): pure function of (offer, round,
 * policy, catalog pricing). No randomness, no clock, no LLM — a full
 * negotiation with a fixed buyer script is byte-reproducible (Gate 2).
 *
 * Model: per variant, the seller's asking price starts at list and concedes
 * toward the effective floor as rounds progress:
 *   ask(r) = list - (list - floor) * (r / max_rounds) ^ concession_exponent
 * The seller accepts a buyer offer when every line's proposed price >= that
 * round's ask (i.e. the buyer met or beat where we were willing to land).
 * Otherwise it counters at ask(r) — clamped, like every outbound price, by
 * the bounds engine even though ask() is already in-bounds by construction:
 * the clamp is the enforcement layer the LLM path will share (Day 6), so it
 * must be on this path too, tested, from the start.
 */

export interface BuyerOfferView {
  line: LineItem;
  pricing: VariantPricing;
}

export type SellerDecision =
  | { kind: 'accept' }
  | {
      kind: 'counter';
      line_items: LineItem[];
      total: number;
      /** Non-empty when the bounds engine had to correct a proposal. */
      clamp_reasons: string[];
    };

export function askPrice(pricing: VariantPricing, round: number, policy: MerchantPolicy): number {
  const floor = effectiveFloor(pricing, policy);
  const progress = Math.min(round / policy.max_rounds, 1);
  const concession = (pricing.list_price - floor) * Math.pow(progress, policy.concession_exponent);
  // Round in the merchant's favour; stay in minor units.
  return pricing.list_price - Math.floor(concession);
}

export function decideSeller(
  views: BuyerOfferView[],
  round: number,
  policy: MerchantPolicy,
  /** Day 6 seam: an LLM may propose per-variant prices; they are clamped. */
  proposedPrices?: Map<string, number>,
): SellerDecision {
  const acceptable = views.every(
    (v) => v.line.proposed_unit_price >= askPrice(v.pricing, round, policy),
  );
  if (acceptable) return { kind: 'accept' };

  const clampReasons: string[] = [];
  const lineItems = views.map((v) => {
    const proposal = proposedPrices?.get(v.line.variant_id) ?? askPrice(v.pricing, round, policy);
    const clamped = clampUnitPrice(proposal, v.pricing, policy);
    if (clamped.clamped) {
      clampReasons.push(`${v.line.variant_id}: ${clamped.reason} (proposed ${proposal})`);
    }
    return { ...v.line, proposed_unit_price: clamped.price };
  });
  return {
    kind: 'counter',
    line_items: lineItems,
    total: lineItems.reduce((sum, li) => sum + li.quantity * li.proposed_unit_price, 0),
    clamp_reasons: clampReasons,
  };
}

/** Convenience for tests: full counter body from raw offer parts. */
export type CounterBody = BodyOf<'counter_offer'>;
