import { randomUUID } from 'node:crypto';
import {
  signObject,
  type BodyOf,
  type FirewallVerdictBody,
  type Message,
  type MessageType,
} from '@negotiator/protocol';
import type { Layer1Result } from './policy.js';

/**
 * The verdict APPLIER — the only place a firewall verdict is decided
 * (CONSTRAINTS #6: deterministic code applies; the LLM only recommends).
 * PROTOCOL.md §7.9 "layer 2 can only narrow, never widen" is this file's
 * whole job: there is no input to `applyVerdict` that yields an `allow`
 * layer 1 did not already grant, and every degraded input — the verifier
 * absent, unparseable, timed out, or contradicting itself — yields
 * `escalate`, never `allow` (D020's pre-commitment, D021's rules). This is
 * the opposite of the agents' D015 fallback-to-curve, on purpose: an agent
 * that cannot think still negotiates within deterministic bounds; a
 * verifier that cannot think must not wave money through.
 *
 * The types below are plain data on purpose: this module never imports the
 * LLM layer (Gate 3 item 5 greps for it); intent.ts produces a
 * `Layer2Outcome`, app.ts hands it here.
 */

export const LAYER2_REASONS = [
  'INTENT_DRIFT_QUANTITY',
  'INTENT_DRIFT_CATEGORY',
  'INTENT_DRIFT_BUDGET',
] as const;
export type Layer2Reason = (typeof LAYER2_REASONS)[number];

/** Per-audit attribution (D008 pinning, Day 11 metrics): who judged, or why nobody could. */
export interface VerifierRecord {
  model_id: string;
  used_llm: boolean;
  failure_reason?: string;
  latency_ms: number;
}

export type Layer2Outcome =
  | {
      kind: 'recommendation';
      recommendation: 'allow' | 'block' | 'escalate';
      reasons: Layer2Reason[];
      /** Model prose; informational and UNTRUSTED (§7.9 verifier_summary). */
      summary: string;
      record: VerifierRecord;
    }
  | { kind: 'absent'; reason: string; record: VerifierRecord };

/** `not_configured` = no verifier at all (layer 1 only, loudly visible in /health). */
export type Layer2Input = 'not_configured' | Layer2Outcome;

export interface AppliedVerdict {
  verdict: FirewallVerdictBody['verdict'];
  layer: FirewallVerdictBody['layer'];
  reasons: string[];
  details: string[];
  /** Goes on the wire as `verifier_summary` when present. */
  summary?: string;
}

export function applyVerdict(layer1: Layer1Result, layer2: Layer2Input): AppliedVerdict {
  // Layer 1 blocks alone; layer 2 never sees a cart layer 1 rejected (§7.9).
  if (layer1.verdict === 'block') {
    return { verdict: 'block', layer: 'policy', reasons: layer1.reasons, details: layer1.details };
  }
  if (layer2 === 'not_configured') {
    return { verdict: 'allow', layer: 'policy', reasons: [], details: [] };
  }
  if (layer2.kind === 'absent') {
    return {
      verdict: 'escalate',
      layer: 'intent_verifier',
      reasons: [],
      details: [`intent-verifier absent: ${layer2.reason} — held for a human, never allowed`],
    };
  }
  const { recommendation, reasons, summary } = layer2;
  // Self-consistency: the applier trusts only explanations that agree with
  // themselves. An allow that lists drift, or a block that cannot say why,
  // is a hold — not a decision.
  if (recommendation === 'allow' && reasons.length === 0) {
    return { verdict: 'allow', layer: 'intent_verifier', reasons: [], details: [], summary };
  }
  if (recommendation === 'block' && reasons.length > 0) {
    return {
      verdict: 'block',
      layer: 'intent_verifier',
      reasons: [...reasons],
      details: reasons.map((r) => `${r}: ${summary}`),
      summary,
    };
  }
  const why =
    recommendation === 'escalate'
      ? 'verifier recommends a human decision'
      : recommendation === 'allow'
        ? 'verifier said allow but listed drift reasons (inconsistent)'
        : 'verifier said block without a reason (inconsistent)';
  return {
    verdict: 'escalate',
    layer: 'intent_verifier',
    reasons: [...reasons],
    details: [why],
    summary,
  };
}

export interface OutboundKey {
  privateKey: string;
  publicKey: string;
}

/** Build, sequence and sign one outbound firewall message (any type). */
export function buildOutbound<T extends MessageType>(
  type: T,
  body: BodyOf<T>,
  opts: {
    sessionId: string;
    seq: number;
    agentId: string;
    key: OutboundKey;
    now: () => Date;
    inReplyTo?: string;
  },
): Message<T> {
  const unsigned = {
    protocol: 'ACNP' as const,
    version: '0.1',
    type,
    message_id: randomUUID(),
    session_id: opts.sessionId,
    seq: opts.seq,
    ...(opts.inReplyTo ? { in_reply_to: opts.inReplyTo } : {}),
    sender: { agent_id: opts.agentId, role: 'firewall' as const },
    timestamp: opts.now().toISOString(),
    body,
  };
  return signObject(unsigned, opts.key.privateKey, opts.key.publicKey) as unknown as Message<T>;
}
