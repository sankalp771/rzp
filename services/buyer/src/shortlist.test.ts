import { describe, expect, it } from 'vitest';
import { generateKeyPair, hashCanonical, type CatalogItem } from '@negotiator/protocol';
import { seedDemoMandate } from './mandate.js';
import { shortlist } from './shortlist.js';

const NOW = () => new Date('2026-08-25T10:00:00.000Z');
const mandate = seedDemoMandate(generateKeyPair(), NOW); // budget 500000, gifts+jewellery

/** Build a catalog item the way the merchant does: hash over the snapshot. */
function mkItem(
  item_id: string,
  category: string,
  variants: { variant_id: string; list_price: number; stock: number }[],
): CatalogItem {
  const snapshot = {
    item_id,
    title: `Title of ${item_id}`,
    description: `Description of ${item_id}`,
    category,
    variants: variants.map((v) => ({ ...v, attributes: {} })),
  };
  return { ...snapshot, catalog_hash: hashCanonical(snapshot) };
}

const vase = mkItem('itm_vase', 'gifts', [
  { variant_id: 'var_vase_ash', list_price: 480_000, stock: 3 },
  { variant_id: 'var_vase_teal', list_price: 390_000, stock: 5 },
]);
const scarf = mkItem('itm_scarf', 'gifts', [
  { variant_id: 'var_scarf_red', list_price: 620_000, stock: 8 }, // over budget
]);
const ram = mkItem('itm_ram', 'industrial', [
  { variant_id: 'var_ram_64', list_price: 185_000, stock: 40 }, // cheap but wrong category
]);
const soldOut = mkItem('itm_gone', 'gifts', [
  { variant_id: 'var_gone', list_price: 100_000, stock: 0 },
]);

describe('shortlist', () => {
  it('ranks affordable allowed-category variants by list price descending', () => {
    const r = shortlist([vase, scarf, ram, soldOut], mandate);
    expect(r.candidates.map((c) => c.variant.variant_id)).toEqual([
      'var_vase_ash',
      'var_vase_teal',
    ]);
    expect(r.candidates[0]!.reservation).toBe(480_000); // min(list, budget)
    expect(r.hash_mismatches).toEqual([]);
  });

  it('excludes disallowed categories even when affordable (T5 stays a firewall job)', () => {
    const r = shortlist([ram], mandate);
    expect(r.candidates).toEqual([]);
  });

  it('excludes over-budget and out-of-stock variants', () => {
    const r = shortlist([scarf, soldOut], mandate);
    expect(r.candidates).toEqual([]);
  });

  it('excludes and reports items whose catalog_hash does not verify (T1)', () => {
    // Tamper AFTER hashing: the price shown no longer matches the hash the
    // cart mandate would bind — the item must not be trusted.
    const tampered: CatalogItem = JSON.parse(JSON.stringify(vase));
    tampered.variants[0]!.list_price = 100;
    const r = shortlist([tampered, ram], mandate);
    expect(r.candidates).toEqual([]);
    expect(r.hash_mismatches).toEqual(['itm_vase']);
  });

  it('caps reservation at the budget ceiling', () => {
    const near = mkItem('itm_near', 'gifts', [
      { variant_id: 'var_near', list_price: 499_999, stock: 1 },
    ]);
    const r = shortlist([near], mandate);
    expect(r.candidates[0]!.reservation).toBe(499_999);
  });
});
