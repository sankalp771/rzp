import { describe, expect, it } from 'vitest';
import { hashCanonical, type CartMandateBody } from '@negotiator/protocol';
import { makeIntentMandate, makePrincipal } from '@negotiator/protocol/fixtures';
import {
  DEFAULT_POLICY,
  evaluateLayer1,
  policyFromEnv,
  type PolicyContext,
  type PolicyConfig,
} from './policy.js';

/**
 * Gate 3 item 1: every deterministic rule has an explicit pass case and an
 * explicit block case. The benign cart is the vase deal from the E2E
 * (417276 < 500000, "gifts", one item, allowlisted seller).
 */
const principal = makePrincipal();
const mandate = makeIntentMandate(principal); // budget 500000, gifts|jewellery, max_quantity 1
const NOW = new Date('2026-08-26T10:00:00.000Z'); // before deadline/valid_until (2026-09-01)

const VASE = {
  item_id: 'itm_vase',
  title: 'Hand-thrown ceramic vase',
  description: 'Stoneware vase.',
  category: 'gifts',
  variants: [{ variant_id: 'var_vase_ash', attributes: {}, list_price: 480_000, stock: 3 }],
};
const RAM = {
  item_id: 'itm_ram',
  title: 'Server RAM 64GB DDR5 ECC kit',
  description: 'Registered ECC DIMM kit for rack servers.',
  category: 'industrial',
  variants: [{ variant_id: 'var_ram_64', attributes: {}, list_price: 1_850_000, stock: 40 }],
};

function cart(over: Partial<CartMandateBody> = {}, snapshot = VASE, unit = 417_276) {
  const body = {
    intent_mandate_ref: hashCanonical(mandate),
    accepted_message_id: 'msg-accept',
    line_items: [
      {
        item_id: snapshot.item_id,
        variant_id: snapshot.variants[0]!.variant_id,
        quantity: 1,
        unit_price: unit,
        catalog_hash: hashCanonical(snapshot),
        catalog_item: snapshot,
      },
    ],
    total: unit,
    currency: 'INR' as const,
    seller_agent_id: 'merchant-demo',
    buyer_agent_id: 'buyer-demo',
    ...over,
  };
  return { ...body, mandate_hash: hashCanonical(body) } as CartMandateBody;
}

const benign: PolicyContext = { now: NOW, recentAllowsForPrincipal: 0, mandateStatus: 'unused' };
const run = (
  c: CartMandateBody,
  ctx: Partial<PolicyContext> = {},
  cfg: PolicyConfig = DEFAULT_POLICY,
) => evaluateLayer1(c, mandate, cfg, { ...benign, ...ctx });

describe('layer 1 — benign cart', () => {
  it('the vase deal passes every rule with no reasons', () => {
    expect(run(cart())).toEqual({ verdict: 'allow', reasons: [], details: [] });
  });
});

describe('layer 1 — each rule: pass and block', () => {
  it('AMOUNT_CAP_EXCEEDED: 500000 passes (== ceiling), 500001 blocks', () => {
    expect(run(cart({}, VASE, 500_000)).verdict).toBe('allow');
    const r = run(cart({}, VASE, 500_001));
    expect(r.verdict).toBe('block');
    expect(r.reasons).toEqual(['AMOUNT_CAP_EXCEEDED']);
    expect(r.details[0]).toContain('500001');
  });

  it('QUANTITY_CAP_EXCEEDED: quantity 1 passes, 2 blocks', () => {
    const li = cart().line_items[0]!;
    const two = cart({ line_items: [{ ...li, quantity: 2 }], total: li.unit_price * 2 });
    expect(run(two).reasons).toContain('QUANTITY_CAP_EXCEEDED');
    expect(run(cart()).reasons).not.toContain('QUANTITY_CAP_EXCEEDED');
  });

  it('CATEGORY_BLOCKED: "gifts" passes, "industrial" (server RAM) blocks — the T5 layer-1 catch', () => {
    const r = run(cart({}, RAM, 450_000));
    expect(r.verdict).toBe('block');
    expect(r.reasons).toEqual(['CATEGORY_BLOCKED']);
    expect(r.details[0]).toMatch(/industrial.*gifts, jewellery/);
  });

  it('CATALOG_HASH_MISMATCH: a relabelled snapshot without a re-hash blocks; honest hash passes', () => {
    const relabelled = cart({}, RAM, 450_000);
    // The corrupted buyer edits the category but keeps the seller's hash.
    relabelled.line_items[0]!.catalog_item = { ...RAM, category: 'gifts' };
    const r = run(relabelled);
    expect(r.reasons).toEqual(['CATALOG_HASH_MISMATCH']);
    expect(run(cart()).reasons).not.toContain('CATALOG_HASH_MISMATCH');
  });

  it('CATALOG_HASH_MISMATCH: a snapshot that does not describe the line item blocks', () => {
    const c = cart();
    c.line_items[0]!.variant_id = 'var_other'; // hash still commits to VASE, but VASE has no var_other
    expect(run(c).reasons).toEqual(['CATALOG_HASH_MISMATCH']);
  });

  it('MERCHANT_NOT_ALLOWLISTED: merchant-demo passes, an unknown seller blocks', () => {
    const r = run(cart({ seller_agent_id: 'evil-corp' }));
    expect(r.reasons).toEqual(['MERCHANT_NOT_ALLOWLISTED']);
    expect(
      run(cart(), {}, { ...DEFAULT_POLICY, merchantAllowlist: ['evil-corp'] }).reasons,
    ).toEqual(['MERCHANT_NOT_ALLOWLISTED']);
  });

  it('VELOCITY_LIMIT: 9 recent allows pass, 10 block (max 10) — keyed per principal', () => {
    expect(run(cart(), { recentAllowsForPrincipal: 9 }).verdict).toBe('allow');
    const r = run(cart(), { recentAllowsForPrincipal: 10 });
    expect(r.reasons).toEqual(['VELOCITY_LIMIT']);
    expect(r.details[0]).toContain(mandate.principal_id);
  });

  it('MANDATE_EXPIRED / DEADLINE_PASSED: judged by the firewall clock', () => {
    const late = new Date('2026-09-01T00:00:00.001Z');
    const r = run(cart(), { now: late });
    expect(r.reasons).toEqual(['MANDATE_EXPIRED', 'DEADLINE_PASSED']);
    expect(run(cart(), { now: new Date('2026-08-31T23:59:59.999Z') }).verdict).toBe('allow');
  });

  it('MANDATE_ALREADY_USED: an earlier allow consumes the mandate; an earlier block does not', () => {
    expect(run(cart(), { mandateStatus: 'allowed' }).reasons).toEqual(['MANDATE_ALREADY_USED']);
    expect(run(cart(), { mandateStatus: 'blocked' }).verdict).toBe('allow');
  });

  it('MANDATE_IN_REVIEW: a pending escalation counts as in use (amendment #3)', () => {
    expect(run(cart(), { mandateStatus: 'in_review' }).reasons).toEqual(['MANDATE_IN_REVIEW']);
  });

  it('lists every violation, not just the first', () => {
    const r = run(cart({ seller_agent_id: 'evil-corp' }, RAM, 1_850_000), {
      recentAllowsForPrincipal: 10,
    });
    expect(r.verdict).toBe('block');
    expect(r.reasons).toEqual([
      'MERCHANT_NOT_ALLOWLISTED',
      'CATEGORY_BLOCKED',
      'AMOUNT_CAP_EXCEEDED',
      'VELOCITY_LIMIT',
    ]);
    expect(r.details).toHaveLength(4);
  });
});

describe('policyFromEnv', () => {
  it('unset → safe defaults; set → parsed', () => {
    expect(policyFromEnv({})).toEqual(DEFAULT_POLICY);
    expect(
      policyFromEnv({
        FIREWALL_MERCHANT_ALLOWLIST: 'merchant-demo, other',
        FIREWALL_VELOCITY_MAX: '50',
        FIREWALL_VELOCITY_WINDOW_SEC: '60',
      }),
    ).toEqual({
      merchantAllowlist: ['merchant-demo', 'other'],
      velocityMax: 50,
      velocityWindowSec: 60,
    });
  });
});
