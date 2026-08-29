/**
 * mulberry32 — a tiny seeded PRNG so every scenario parameter is a pure
 * function of (seed, scenario, index): the stub and live runs of one seed
 * negotiate the same budgets, and a resumed run redraws exactly what it
 * would have drawn. Not for anything cryptographic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform draw on the grid lo, lo+step, …, hi (inclusive). */
export function drawStep(rng: () => number, lo: number, hi: number, step: number): number {
  const slots = Math.floor((hi - lo) / step) + 1;
  return lo + step * Math.min(slots - 1, Math.floor(rng() * slots));
}
