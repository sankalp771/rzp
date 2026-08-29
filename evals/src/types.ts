import type { MerchantPolicy } from '../../services/merchant/src/policy.js';

/**
 * The evals vocabulary (FEATURE-011, docs/EVALS.md). One `SessionRecord`
 * per executed session is the unit of evidence: appended to
 * `evals/runs/<run-id>/sessions.jsonl` as soon as the session finishes, so
 * a run can stop at any point and resume without losing what ran.
 */

export type Mode = 'stub' | 'live';

export type ScenarioId =
  'honest' | 'aggressive' | 'stingy_merchant' | 'corrupted_layer1' | 'corrupted_semantic';

/** Assigned by the scenario at creation time, never inferred afterwards (EVALS.md §3). */
export type GroundTruth = 'benign' | 'corrupted';

/** Amendment #2: who stopped the money, when something did. */
export type CaughtBy = 'strategy' | 'policy' | 'intent_verifier' | 'human';

/**
 * Outcome judged against ground truth:
 *   benign    → settled | walked_away | false_block | failed
 *   corrupted → caught | escalated | false_allow | walked_away | failed
 * `failed` is an infrastructure/protocol failure (no verdict was reached)
 * and is reported on its own line, never folded into a rate.
 */
export type Classification =
  'settled' | 'walked_away' | 'false_block' | 'caught' | 'escalated' | 'false_allow' | 'failed';

export interface BuyerTuning {
  opening_ratio: number;
  concession_exponent: number;
}

export type PolicyOverride = Pick<MerchantPolicy, 'max_discount_pct' | 'concession_exponent'>;

/** Everything a session is parameterised by; drawn from the seed, identical in both modes. */
export interface SessionParams {
  /** Mandate budget ceiling, paise. */
  budget: number;
  /** The variant negotiated (pinned, so the budget can press the reservation below list). */
  target: string;
  tuning?: BuyerTuning;
  policy?: PolicyOverride;
}

export interface TargetPricing {
  variant_id: string;
  item_id: string;
  category: string;
  list_price: number;
  /** Merchant-private absolute floor (never on the wire). */
  floor_price: number;
  /** max(floor, policy discount cap) — the number the seller curve really bottoms at. */
  effective_floor: number;
}

/** What the two published curves alone would do with these parameters. */
export interface CurvePrediction {
  outcome: 'settled' | 'walked_away';
  price?: number;
  rounds: number;
  closed_by?: 'seller_accept' | 'buyer_accept';
}

/** One row of a service's `llm_moves` table. */
export interface MoveRow {
  round: number;
  model_id: string;
  used_llm: boolean;
  fallback_reason: string | null;
  latency_ms: number;
}

/** The firewall's layer-2 attribution for the cart (from `verdicts.verifier_json`). */
export interface VerifierRow {
  model_id: string;
  used_llm: boolean;
  latency_ms: number;
  failure_reason?: string;
  recommendation?: 'allow' | 'block' | 'escalate';
  reasons?: string[];
}

/** A compact, human-readable transcript line (the full envelopes live in the ledgers). */
export interface TranscriptRow {
  direction: 'sent' | 'received';
  type: string;
  seq: number;
  round?: number;
  total?: number;
  rationale?: string;
  verdict?: string;
  layer?: string;
  reasons?: string[];
  verifier_summary?: string;
}

/** A seller counter-offer rationale that mentioned a floor (amendment #3). */
export interface FloorLeak {
  round: number;
  /** Which floor leaked: the variant's absolute floor or the policy's effective floor. */
  floor: number;
  /** The spelling that matched. */
  matched: string;
  excerpt: string;
}

export interface SessionRecord {
  run_id: string;
  mode: Mode;
  scenario: ScenarioId;
  truth: GroundTruth;
  index: number;
  seed: number;
  params: SessionParams;
  target: TargetPricing | null;
  session_id: string | null;
  outcome: string;
  reason: string | null;
  state: string;
  rounds: number;
  list_total: number | null;
  settled_total: number | null;
  /** (list − settled) ÷ list, settled sessions only. */
  discount_pct: number | null;
  verdict: { verdict: string; layer: string; reasons: string[] } | null;
  classification: Classification;
  caught_by: CaughtBy | null;
  /** The cart was held for a human (verdict escalate) and nobody decided. */
  escalated: boolean;
  curve: CurvePrediction | null;
  llm: { buyer: MoveRow[]; seller: MoveRow[]; verifier: VerifierRow | null };
  floor_leaks: FloorLeak[];
  /** Some call in this session failed on a provider rate limit (live pacing reads this). */
  rate_limited: boolean;
  transcript: TranscriptRow[];
  notes: string[];
  /** Real wall-clock instant the session finished (provenance, not protocol time). */
  at: string;
  wall_ms: number;
  error: string | null;
}
