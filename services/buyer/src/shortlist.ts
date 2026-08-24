import { hashCanonical, type CatalogItem, type IntentMandate } from '@negotiator/protocol';

/**
 * Deterministic catalog shortlist (FLOW F1 step 3). Two duties, in order:
 *
 * 1. TRUST: recompute every item's `catalog_hash` over the public snapshot
 *    the merchant claims to have hashed. A mismatch means the item body was
 *    altered after hashing (or the hash is a lie) — such items are excluded
 *    and reported, because the hash is what the eventual cart mandate binds.
 * 2. CHOICE: filter to the mandate's allowed categories, in-stock variants,
 *    list price within budget; rank by list price descending (the "nicest
 *    affordable" rule — explainable, if simplistic). Day 6's LLM re-ranks
 *    WITHIN this candidate set; it can never add a candidate this filter
 *    rejected.
 */

export interface Candidate {
  item: CatalogItem;
  variant: CatalogItem['variants'][number];
  /** min(list, budget) — the strategy's hard ceiling for this line. */
  reservation: number;
}

export interface ShortlistResult {
  candidates: Candidate[];
  /** item_ids whose catalog_hash failed recomputation (excluded, report-worthy). */
  hash_mismatches: string[];
}

export function shortlist(items: CatalogItem[], mandate: IntentMandate): ShortlistResult {
  const hashMismatches: string[] = [];
  const candidates: Candidate[] = [];

  for (const item of items) {
    const { catalog_hash, ...snapshot } = item;
    if (hashCanonical(snapshot) !== catalog_hash) {
      hashMismatches.push(item.item_id);
      continue;
    }
    if (!mandate.constraints.categories_allowed.includes(item.category)) continue;
    for (const variant of item.variants) {
      if (variant.stock < 1) continue;
      if (variant.list_price > mandate.budget_ceiling) continue;
      candidates.push({
        item,
        variant,
        reservation: Math.min(variant.list_price, mandate.budget_ceiling),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.variant.list_price - a.variant.list_price ||
      a.variant.variant_id.localeCompare(b.variant.variant_id),
  );
  return { candidates, hash_mismatches: hashMismatches };
}
