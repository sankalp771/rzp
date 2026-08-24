import type { BodyOf, LineItem } from '@negotiator/protocol';

/**
 * Deterministic buyer strategy (ARCHITECTURE §S2): pure function of
 * (mandate-derived params, catalog pricing, round, seller counter). No
 * randomness, no LLM — a full negotiation against the deterministic seller
 * is byte-reproducible (Gate 2).
 *
 * Model, the mirror image of the seller's curve: per line, the buyer's bid
 * starts at `opening = list × opening_ratio` and concedes UP toward the
 * reservation price as rounds progress:
 *   bid(r) = opening + (reservation - opening) · ((r-1)/(max_rounds-1))^exp
 * so bid(1) = opening and bid(max_rounds) = reservation exactly.
 *
 * `reservation = min(list_price, budget for the line)` is the buyer's HARD
 * ceiling: the number above which this deal is worse than no deal. Accept
 * when the seller's counter is at or below what we would bid NEXT round —
 * paying less than you were about to offer is always right. Walk away when
 * no round remains and the counter is still above acceptance, or past the
 * mandate deadline.
 */

export interface BuyerLineView {
  item_id: string;
  variant_id: string;
  quantity: number;
  list_price: number;
  /** min(list, budget allocated to this line), minor units. */
  reservation: number;
}

export interface BuyerParams {
  /** Opening bid as a fraction of list price. */
  opening_ratio: number;
  /** >1 concedes late (mirror of the seller's concession_exponent). */
  concession_exponent: number;
  /** min(mandate max_rounds, seller capabilities.max_rounds). */
  max_rounds: number;
  /** From the mandate; a counter above the sum of reservations can never be accepted. */
  budget_ceiling: number;
  deadline: string;
}

export const DEFAULT_BUYER_TUNING = { opening_ratio: 0.7, concession_exponent: 1.3 } as const;

export type BuyerDecision =
  | { kind: 'accept' }
  | {
      kind: 'counter';
      line_items: LineItem[];
      total: number;
      /** Non-empty when the clamp had to correct a proposal. */
      clamp_reasons: string[];
    }
  | { kind: 'walk_away'; reason_code: BodyOf<'walk_away'>['reason_code'] };

export function bidPrice(view: BuyerLineView, round: number, params: BuyerParams): number {
  const opening = Math.floor(view.list_price * params.opening_ratio);
  if (params.max_rounds <= 1 || opening >= view.reservation) return view.reservation;
  const progress = Math.min((round - 1) / (params.max_rounds - 1), 1);
  const concession = (view.reservation - opening) * Math.pow(progress, params.concession_exponent);
  // Round in the buyer's favour; stay in minor units.
  return opening + Math.floor(concession);
}

export interface ClampResult {
  price: number;
  clamped: boolean;
  reason?: string;
}

/**
 * The buyer-side bounds clamp (CONSTRAINTS #5 mirror, Day 6 LLM seam): no
 * outbound proposal may exceed the line's reservation — the LLM may plead,
 * this function disposes. Invalid proposals (non-integer, non-positive)
 * fall back to the deterministic curve, never to trust.
 */
export function clampBuyerPrice(
  proposal: number,
  view: BuyerLineView,
  round: number,
  params: BuyerParams,
): ClampResult {
  const fallback = bidPrice(view, round, params);
  if (!Number.isSafeInteger(proposal) || proposal <= 0) {
    return { price: fallback, clamped: true, reason: 'non-integer or non-positive proposal' };
  }
  if (proposal > view.reservation) {
    return {
      price: view.reservation,
      clamped: true,
      reason: `above reservation ${view.reservation}`,
    };
  }
  return { price: proposal, clamped: false };
}

export interface CounterView {
  /** The seller's counter line (their proposed_unit_price). */
  line: LineItem;
  view: BuyerLineView;
}

export function decideBuyer(
  counters: CounterView[],
  /** The round of the buyer offer the seller just countered. */
  round: number,
  params: BuyerParams,
  now: () => Date,
  /** Day 6 seam: an LLM may propose per-variant prices; they are clamped. */
  proposedPrices?: Map<string, number>,
): BuyerDecision {
  if (now().getTime() > Date.parse(params.deadline)) {
    return { kind: 'walk_away', reason_code: 'deadline' };
  }

  const counterTotal = counters.reduce(
    (sum, c) => sum + c.line.quantity * c.line.proposed_unit_price,
    0,
  );
  const reservationTotal = counters.reduce(
    (sum, c) => sum + c.line.quantity * c.view.reservation,
    0,
  );
  const nextRound = round + 1;
  const acceptable =
    counterTotal <= Math.min(reservationTotal, params.budget_ceiling) &&
    counters.every((c) => c.line.proposed_unit_price <= bidPrice(c.view, nextRound, params));
  if (acceptable) return { kind: 'accept' };

  if (nextRound > params.max_rounds) {
    // No round left to counter in. Attribute the failure: if the seller's
    // number would bust the budget-derived ceiling, the budget was the
    // binding constraint; otherwise the terms just never met.
    const overBudget = counterTotal > Math.min(reservationTotal, params.budget_ceiling);
    const budgetBound = counters.some((c) => c.view.reservation < c.view.list_price);
    return {
      kind: 'walk_away',
      reason_code: overBudget && budgetBound ? 'budget_exhausted' : 'no_acceptable_terms',
    };
  }

  const clampReasons: string[] = [];
  const lineItems = counters.map((c) => {
    const proposal = proposedPrices?.get(c.view.variant_id) ?? bidPrice(c.view, nextRound, params);
    const clamped = clampBuyerPrice(proposal, c.view, nextRound, params);
    if (clamped.clamped) {
      clampReasons.push(`${c.view.variant_id}: ${clamped.reason} (proposed ${proposal})`);
    }
    return { ...c.line, proposed_unit_price: clamped.price };
  });
  return {
    kind: 'counter',
    line_items: lineItems,
    total: lineItems.reduce((sum, li) => sum + li.quantity * li.proposed_unit_price, 0),
    clamp_reasons: clampReasons,
  };
}
