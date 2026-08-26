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
 * (CONSTRAINTS #6: deterministic code applies; the LLM, when it exists,
 * only recommends). Day 8 ships layer 1 only.
 *
 * Layer-2 slot (Day 9): `Layer2Input` is the literal 'not_configured' today
 * and becomes a union with an explicit recommendation object tomorrow. The
 * pre-commitment, written here so it cannot be forgotten: when layer 2 IS
 * configured, a missing, failed, malformed or timed-out recommendation maps
 * to `escalate` — NEVER to `allow`. This is the opposite of the agents'
 * D015 fallback-to-curve, on purpose: an agent that cannot think still
 * negotiates within deterministic bounds; a verifier that cannot think must
 * not wave money through.
 */
export type Layer2Input = 'not_configured';

export interface AppliedVerdict {
  verdict: FirewallVerdictBody['verdict'];
  layer: FirewallVerdictBody['layer'];
  reasons: string[];
  details: string[];
}

export function applyVerdict(layer1: Layer1Result, layer2: Layer2Input): AppliedVerdict {
  // Layer 1 blocks alone; layer 2 never sees a cart layer 1 rejected (§7.9).
  if (layer1.verdict === 'block') {
    return { verdict: 'block', layer: 'policy', reasons: layer1.reasons, details: layer1.details };
  }
  if (layer2 === 'not_configured') {
    return { verdict: 'allow', layer: 'policy', reasons: [], details: [] };
  }
  // Unreachable on Day 8; Day 9 adds the recommendation branch here with
  // the escalate-on-absence rule above. Typed as never so the compiler
  // fails the build if a new Layer2Input member is added without a branch.
  return layer2 satisfies never;
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
