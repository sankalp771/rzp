import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, clampUnitPrice, effectiveFloor } from './policy.js';
import { askPrice, decideSeller, type BuyerOfferView } from './strategy.js';

/** Vase: list 480000, absolute floor 360000, category gifts (cap 25%). */
const vase = { list_price: 480_000, floor_price: 360_000, category: 'gifts' };
/** Bookend: floor 500000 ≈ 96% of list 520000 — clamp playground. */
const bookend = { list_price: 520_000, floor_price: 500_000, category: 'gifts' };
/** Earrings: jewellery category cap 15% → discount floor 297500 > 260000. */
const earrings = { list_price: 350_000, floor_price: 260_000, category: 'jewellery' };

const view = (pricing: typeof vase, proposed: number, quantity = 1): BuyerOfferView => ({
  line: {
    item_id: 'x',
    variant_id: `var_${pricing.list_price}`,
    quantity,
    proposed_unit_price: proposed,
  },
  pricing,
});

describe('effectiveFloor', () => {
  it('is the tighter of absolute floor and category discount cap', () => {
    expect(effectiveFloor(vase, DEFAULT_POLICY)).toBe(360_000); // 25% cap → 360000, equal
    expect(effectiveFloor(bookend, DEFAULT_POLICY)).toBe(500_000); // absolute floor wins
    expect(effectiveFloor(earrings, DEFAULT_POLICY)).toBe(297_500); // 15% jewellery cap wins
  });
});

describe('clampUnitPrice (Gate 2 adversarial — CONSTRAINTS #5)', () => {
  it('clamps a below-floor proposal up to the effective floor', () => {
    // Simulates a prompt-injected/hallucinating LLM proposing 1 rupee.
    const r = clampUnitPrice(100, vase, DEFAULT_POLICY);
    expect(r).toMatchObject({ price: 360_000, clamped: true });
    expect(r.reason).toContain('below effective floor');
  });

  it('clamps an above-list proposal down to list', () => {
    const r = clampUnitPrice(9_990_000, vase, DEFAULT_POLICY);
    expect(r).toMatchObject({ price: 480_000, clamped: true });
  });

  it('clamps a non-integer proposal to list', () => {
    expect(clampUnitPrice(400000.5, vase, DEFAULT_POLICY)).toMatchObject({
      price: 480_000,
      clamped: true,
    });
  });

  it('passes an in-bounds proposal through untouched', () => {
    expect(clampUnitPrice(400_000, vase, DEFAULT_POLICY)).toEqual({
      price: 400_000,
      clamped: false,
    });
  });

  it('a below-floor LLM proposal is NEVER emitted by decideSeller', () => {
    const decision = decideSeller(
      [view(vase, 100_000)],
      1,
      DEFAULT_POLICY,
      new Map([[`var_${vase.list_price}`, 50_000]]), // stubbed LLM: sell at 500 rupees
    );
    expect(decision.kind).toBe('counter');
    if (decision.kind === 'counter') {
      expect(decision.line_items[0]!.proposed_unit_price).toBe(360_000);
      expect(decision.clamp_reasons[0]).toContain('below effective floor');
    }
  });
});

describe('askPrice concession curve', () => {
  it('starts at list and lands exactly on the effective floor at max_rounds', () => {
    expect(askPrice(vase, 0, DEFAULT_POLICY)).toBe(480_000);
    expect(askPrice(vase, DEFAULT_POLICY.max_rounds, DEFAULT_POLICY)).toBe(360_000);
  });

  it('is monotonically non-increasing across rounds', () => {
    let prev = Infinity;
    for (let r = 0; r <= DEFAULT_POLICY.max_rounds; r++) {
      const ask = askPrice(vase, r, DEFAULT_POLICY);
      expect(ask).toBeLessThanOrEqual(prev);
      expect(ask).toBeGreaterThanOrEqual(360_000);
      prev = ask;
    }
  });

  it('concedes late with exponent > 1 (fixed expected numbers)', () => {
    // (r/6)^1.6 of the 120000 range below list, floored, for r = 1..3.
    expect(askPrice(vase, 1, DEFAULT_POLICY)).toBe(480_000 - Math.floor(120_000 * (1 / 6) ** 1.6));
    expect(askPrice(vase, 2, DEFAULT_POLICY)).toBe(480_000 - Math.floor(120_000 * (2 / 6) ** 1.6));
    expect(askPrice(vase, 3, DEFAULT_POLICY)).toBe(480_000 - Math.floor(120_000 * (3 / 6) ** 1.6));
  });
});

describe('decideSeller', () => {
  it('accepts when the buyer meets the round ask on every line', () => {
    const ask = askPrice(vase, 2, DEFAULT_POLICY);
    expect(decideSeller([view(vase, ask)], 2, DEFAULT_POLICY).kind).toBe('accept');
    expect(decideSeller([view(vase, ask + 1)], 2, DEFAULT_POLICY).kind).toBe('accept');
  });

  it('counters at the round ask when the buyer is below it', () => {
    const d = decideSeller([view(vase, 300_000)], 1, DEFAULT_POLICY);
    expect(d.kind).toBe('counter');
    if (d.kind === 'counter') {
      expect(d.line_items[0]!.proposed_unit_price).toBe(askPrice(vase, 1, DEFAULT_POLICY));
      expect(d.total).toBe(d.line_items[0]!.proposed_unit_price);
      expect(d.clamp_reasons).toEqual([]); // curve output needs no clamping
    }
  });

  it('multi-line: one low line blocks acceptance; counter covers all lines', () => {
    const askV = askPrice(vase, 3, DEFAULT_POLICY);
    const d = decideSeller([view(vase, askV), view(earrings, 100_000, 2)], 3, DEFAULT_POLICY);
    expect(d.kind).toBe('counter');
    if (d.kind === 'counter') {
      expect(d.line_items).toHaveLength(2);
      expect(d.total).toBe(
        d.line_items[0]!.proposed_unit_price + 2 * d.line_items[1]!.proposed_unit_price,
      );
    }
  });

  it('near-floor variant: counters stay pinned at the floor from round 1 headroom', () => {
    const d = decideSeller([view(bookend, 400_000)], DEFAULT_POLICY.max_rounds, DEFAULT_POLICY);
    expect(d.kind).toBe('counter');
    if (d.kind === 'counter') expect(d.line_items[0]!.proposed_unit_price).toBe(500_000);
  });

  it('is deterministic: identical inputs give identical outputs (Gate 2)', () => {
    const run = () =>
      decideSeller([view(vase, 380_000), view(earrings, 310_000, 2)], 2, DEFAULT_POLICY);
    expect(run()).toEqual(run());
  });
});
