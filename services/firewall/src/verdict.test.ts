import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, verifyObject } from '@negotiator/protocol';
import { applyVerdict, buildOutbound } from './verdict.js';

describe('verdict applier (CONSTRAINTS #6)', () => {
  it('layer-1 block is final: layer 2 is never consulted', () => {
    const r = applyVerdict(
      { verdict: 'block', reasons: ['CATEGORY_BLOCKED'], details: ['x'] },
      'not_configured',
    );
    expect(r).toEqual({
      verdict: 'block',
      layer: 'policy',
      reasons: ['CATEGORY_BLOCKED'],
      details: ['x'],
    });
  });

  it('layer-1 allow with layer 2 not configured → allow, layer policy', () => {
    expect(applyVerdict({ verdict: 'allow', reasons: [], details: [] }, 'not_configured')).toEqual({
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
      details: [],
    });
  });

  it('signs outbound messages with the firewall role and the given key', () => {
    const key = generateKeyPair();
    const msg = buildOutbound(
      'mandate_ack',
      { intent_mandate_ref: 'a'.repeat(64) },
      {
        sessionId: '2f3c1c6e-1a4f-4a3e-9d0c-0d3f7b3f2e11',
        seq: 1,
        agentId: 'fw',
        key,
        now: () => new Date(0),
      },
    );
    expect(msg.sender).toEqual({ agent_id: 'fw', role: 'firewall' });
    expect(verifyObject(msg, key.publicKey).ok).toBe(true);
    expect(verifyObject(msg, generateKeyPair().publicKey).ok).toBe(false);
  });
});

/**
 * Gate 3 item 5 — "no direct LLM trigger path exists", verified by code
 * search, not vibes: nothing in the firewall imports the LLM layer except
 * the (Day 9) intent-verifier module, and the applier/policy modules never
 * mention an adapter at all.
 */
describe('no LLM path into the verdict (source search)', () => {
  const dir = join(import.meta.dirname);
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('only intent.ts may import @negotiator/llm', () => {
    for (const f of sources) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (f !== 'intent.ts') expect(src, f).not.toMatch(/@negotiator\/llm/);
    }
  });

  it('policy.ts and verdict.ts do not know what an LlmAdapter is', () => {
    for (const f of ['policy.ts', 'verdict.ts']) {
      expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/LlmAdapter|proposeMove|fetch\(/);
    }
  });
});
