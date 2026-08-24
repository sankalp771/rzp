import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUYER_TUNING,
  bidPrice,
  clampBuyerPrice,
  decideBuyer,
  type BuyerLineView,
  type BuyerParams,
  type CounterView,
} from './strategy.js';

/** Vase: list 480000; ample budget → reservation = list. */
const vase: BuyerLineView = {
  item_id: 'itm_vase',
  variant_id: 'var_vase_ash',
  quantity: 1,
  list_price: 480_000,
  reservation: 480_000,
};
/** Bookend under a tight budget: reservation capped at 450000 < list. */
const bookend: BuyerLineView = {
  item_id: 'itm_bookend',
  variant_id: 'var_bookend',
  quantity: 1,
  list_price: 520_000,
  reservation: 450_000,
};

const NOW = () => new Date('2026-08-25T10:00:00.000Z');

const params = (over: Partial<BuyerParams> = {}): BuyerParams => ({
  ...DEFAULT_BUYER_TUNING,
  max_rounds: 6,
  budget_ceiling: 500_000,
  deadline: '2026-09-01T00:00:00.000Z',
  ...over,
});

const counter = (view: BuyerLineView, sellerPrice: number): CounterView => ({
  line: {
    item_id: view.item_id,
    variant_id: view.variant_id,
    quantity: view.quantity,
    proposed_unit_price: sellerPrice,
  },
  view,
});

describe('bidPrice concession curve', () => {
  it('starts at opening_ratio × list and lands exactly on the reservation at max_rounds', () => {
    expect(bidPrice(vase, 1, params())).toBe(336_000); // floor(480000 × 0.7)
    expect(bidPrice(vase, 6, params())).toBe(480_000);
  });

  it('is monotonically non-decreasing and never exceeds the reservation', () => {
    let prev = 0;
    for (let r = 1; r <= 6; r++) {
      const bid = bidPrice(vase, r, params());
      expect(bid).toBeGreaterThanOrEqual(prev);
      expect(bid).toBeLessThanOrEqual(vase.reservation);
      prev = bid;
    }
  });

  it('concedes late with exponent > 1 (fixed expected numbers)', () => {
    // opening 336000 + floor(144000 × ((r-1)/5)^1.3) for r = 2..4.
    expect(bidPrice(vase, 2, params())).toBe(336_000 + Math.floor(144_000 * (1 / 5) ** 1.3));
    expect(bidPrice(vase, 3, params())).toBe(336_000 + Math.floor(144_000 * (2 / 5) ** 1.3));
    expect(bidPrice(vase, 4, params())).toBe(336_000 + Math.floor(144_000 * (3 / 5) ** 1.3));
  });

  it('collapses to the reservation when opening already meets it (tight budget)', () => {
    // floor(520000 × 0.7) = 364000 < 450000 → normal curve; but with a very
    // tight reservation below opening the bid must clamp to the reservation.
    const tight = { ...bookend, reservation: 300_000 };
    expect(bidPrice(tight, 1, params())).toBe(300_000);
    expect(bidPrice(tight, 6, params())).toBe(300_000);
  });
});

describe('clampBuyerPrice (Gate 2 adversarial — CONSTRAINTS #5 mirror)', () => {
  it('a proposal above the reservation is clamped down to it', () => {
    // Simulates a prompt-injected/hallucinating LLM proposing 10× list.
    const r = clampBuyerPrice(4_800_000, vase, 3, params());
    expect(r).toMatchObject({ price: 480_000, clamped: true });
    expect(r.reason).toContain('above reservation');
  });

  it('a non-integer or non-positive proposal falls back to the deterministic bid', () => {
    expect(clampBuyerPrice(400000.5, vase, 3, params())).toMatchObject({
      price: bidPrice(vase, 3, params()),
      clamped: true,
    });
    expect(clampBuyerPrice(-5, vase, 3, params()).clamped).toBe(true);
  });

  it('passes an in-bounds proposal through untouched', () => {
    expect(clampBuyerPrice(400_000, vase, 3, params())).toEqual({
      price: 400_000,
      clamped: false,
    });
  });

  it('an above-reservation LLM proposal is NEVER emitted by decideBuyer', () => {
    const d = decideBuyer(
      [counter(vase, 470_000)],
      2,
      params(),
      NOW,
      new Map([['var_vase_ash', 4_800_000]]), // stubbed LLM: pay 10× list
    );
    expect(d.kind).toBe('counter');
    if (d.kind === 'counter') {
      expect(d.line_items[0]!.proposed_unit_price).toBe(480_000);
      expect(d.clamp_reasons[0]).toContain('above reservation');
    }
  });
});

describe('decideBuyer', () => {
  it('accepts when the seller counter is at or below next round’s bid', () => {
    // Seller counters 417273 after our round-4 offer; bid(5) = 443740 ≥ that.
    const d = decideBuyer([counter(vase, 417_273)], 4, params(), NOW);
    expect(d.kind).toBe('accept');
  });

  it('counters at next round’s bid when the seller is still above it', () => {
    const d = decideBuyer([counter(vase, 473_183)], 1, params(), NOW);
    expect(d.kind).toBe('counter');
    if (d.kind === 'counter') {
      expect(d.line_items[0]!.proposed_unit_price).toBe(bidPrice(vase, 2, params()));
      expect(d.total).toBe(d.line_items[0]!.proposed_unit_price);
      expect(d.clamp_reasons).toEqual([]);
    }
  });

  it('never accepts above the budget ceiling even if the curve would', () => {
    // reservation = list = 480000 but budget_ceiling caps at 400000.
    const d = decideBuyer([counter(vase, 450_000)], 5, params({ budget_ceiling: 400_000 }), NOW);
    expect(d.kind).not.toBe('accept');
  });

  it('walks away with budget_exhausted when the budget was the binding constraint', () => {
    // Bookend: seller pinned at its 500000 floor; our reservation is 450000.
    const d = decideBuyer([counter(bookend, 500_000)], 6, params({ budget_ceiling: 450_000 }), NOW);
    expect(d).toEqual({ kind: 'walk_away', reason_code: 'budget_exhausted' });
  });

  it('walks away with no_acceptable_terms when budget was not the blocker', () => {
    // Ample budget (reservation = list) but the seller still asks above it.
    const d = decideBuyer([counter(vase, 490_000)], 6, params(), NOW);
    expect(d).toEqual({ kind: 'walk_away', reason_code: 'no_acceptable_terms' });
  });

  it('walks away past the mandate deadline regardless of price', () => {
    const d = decideBuyer(
      [counter(vase, 100)],
      1,
      params({ deadline: '2026-08-20T00:00:00.000Z' }),
      NOW,
    );
    expect(d).toEqual({ kind: 'walk_away', reason_code: 'deadline' });
  });

  it('is deterministic: identical inputs give identical outputs (Gate 2)', () => {
    const run = () => decideBuyer([counter(vase, 459_315)], 2, params(), NOW);
    expect(run()).toEqual(run());
  });
});
