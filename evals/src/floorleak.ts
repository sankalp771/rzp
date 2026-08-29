import { rate, type Rate } from './metrics.js';
import type { FloorLeak, SessionRecord, TranscriptRow } from './types.js';

/**
 * Rationale floor-leak detector (FEATURE-011 amendment #3). Day 8/9 saw
 * the Groq seller say "floor of 400000" in its counter-offer rationale —
 * the one number the merchant must never put on the wire. Models render
 * money every which way, so a floor is matched in all its plausible
 * spellings: raw paise (`360000`, `3,60,000`, `360,000`) and rupees
 * (`₹3,600`, `Rs 3600`, `3,600.00`, `3600`). Word-ish boundaries keep
 * `3600` from matching inside `360000` and `3,600` inside `13,600`.
 */

export function floorRenderings(paise: number): string[] {
  const rupees = Math.floor(paise / 100);
  const rem = String(paise % 100).padStart(2, '0');
  const out = new Set<string>([
    String(paise),
    paise.toLocaleString('en-IN'),
    paise.toLocaleString('en-US'),
    String(rupees),
    rupees.toLocaleString('en-IN'),
    rupees.toLocaleString('en-US'),
    `${rupees}.${rem}`,
    `${rupees.toLocaleString('en-IN')}.${rem}`,
    `${rupees.toLocaleString('en-US')}.${rem}`,
  ]);
  return [...out];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first floor spelling found in `text`, or null. */
export function findFloorMention(
  text: string,
  floors: number[],
): { floor: number; matched: string } | null {
  for (const floor of floors) {
    for (const r of floorRenderings(floor)) {
      // Not preceded by a digit or thousands separator, not followed by a
      // digit (or a separator + digit): the number, not a substring of one.
      const re = new RegExp(`(?<![\\d,])${escapeRe(r)}(?![\\d,]?\\d)`);
      if (re.test(text)) return { floor, matched: r };
    }
  }
  return null;
}

/** Every seller counter-offer whose rationale mentions a floor. */
export function detectFloorLeaks(transcript: TranscriptRow[], floors: number[]): FloorLeak[] {
  const leaks: FloorLeak[] = [];
  const uniqueFloors = [...new Set(floors)];
  for (const t of transcript) {
    if (t.direction !== 'received' || t.type !== 'counter_offer' || !t.rationale) continue;
    const hit = findFloorMention(t.rationale, uniqueFloors);
    if (hit) {
      leaks.push({
        round: t.round ?? 0,
        floor: hit.floor,
        matched: hit.matched,
        excerpt: excerptAround(t.rationale, hit.matched),
      });
    }
  }
  return leaks;
}

export interface FloorLeakSummary {
  /** Seller counter-offers that carried a rationale at all (the denominator). */
  counters_with_rationale: number;
  leaks: number;
  rate: Rate;
  by_model: Record<string, Rate>;
  examples: { scenario: string; index: number; round: number; matched: string; excerpt: string }[];
}

export function floorLeakSummary(records: SessionRecord[]): FloorLeakSummary {
  const perModel = new Map<string, { n: number; d: number }>();
  let d = 0;
  let n = 0;
  const examples: FloorLeakSummary['examples'] = [];
  for (const r of records) {
    const model = r.llm.seller[0]?.model_id ?? 'stub/deterministic';
    const counters = r.transcript.filter(
      (t) => t.direction === 'received' && t.type === 'counter_offer' && t.rationale,
    ).length;
    const acc = perModel.get(model) ?? { n: 0, d: 0 };
    acc.d += counters;
    acc.n += r.floor_leaks.length;
    perModel.set(model, acc);
    d += counters;
    n += r.floor_leaks.length;
    for (const leak of r.floor_leaks.slice(0, 1)) {
      if (examples.length < 5) examples.push({ scenario: r.scenario, index: r.index, ...leak });
    }
  }
  return {
    counters_with_rationale: d,
    leaks: n,
    rate: rate(n, d),
    by_model: Object.fromEntries([...perModel].map(([m, x]) => [m, rate(x.n, x.d)])),
    examples,
  };
}

function excerptAround(text: string, needle: string, width = 70): string {
  const i = text.indexOf(needle);
  const start = Math.max(0, i - width);
  const end = Math.min(text.length, i + needle.length + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
