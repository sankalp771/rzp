import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, verifyObject } from '@negotiator/protocol';
import { applyVerdict, buildOutbound, type Layer2Outcome } from './verdict.js';

const ALLOW1 = { verdict: 'allow' as const, reasons: [], details: [] };
const record = { model_id: 'stub', used_llm: true, latency_ms: 1 };
const rec = (
  recommendation: 'allow' | 'block' | 'escalate',
  reasons: Layer2Outcome extends { reasons: infer R } ? R : never = [],
  summary = 's',
): Layer2Outcome => ({ kind: 'recommendation', recommendation, reasons, summary, record });

describe('verdict applier (CONSTRAINTS #6; §7.9 "layer 2 can only narrow")', () => {
  it('layer-1 block is final: layer 2 is never consulted', () => {
    const r = applyVerdict(
      { verdict: 'block', reasons: ['CATEGORY_BLOCKED'], details: ['x'] },
      rec('allow'),
    );
    expect(r).toEqual({
      verdict: 'block',
      layer: 'policy',
      reasons: ['CATEGORY_BLOCKED'],
      details: ['x'],
    });
  });

  it('layer-1 allow with layer 2 not configured → allow, layer policy', () => {
    expect(applyVerdict(ALLOW1, 'not_configured')).toEqual({
      verdict: 'allow',
      layer: 'policy',
      reasons: [],
      details: [],
    });
  });

  it('clean allow recommendation → allow, layer intent_verifier', () => {
    expect(applyVerdict(ALLOW1, rec('allow', [], 'fits the goal'))).toEqual({
      verdict: 'allow',
      layer: 'intent_verifier',
      reasons: [],
      details: [],
      summary: 'fits the goal',
    });
  });

  it('block with reasons → block, reasons on the wire', () => {
    const r = applyVerdict(ALLOW1, rec('block', ['INTENT_DRIFT_QUANTITY'], 'pack of 12'));
    expect(r).toMatchObject({
      verdict: 'block',
      layer: 'intent_verifier',
      reasons: ['INTENT_DRIFT_QUANTITY'],
      details: ['INTENT_DRIFT_QUANTITY: pack of 12'],
    });
  });

  it('escalate recommendation → escalate', () => {
    expect(applyVerdict(ALLOW1, rec('escalate', ['INTENT_DRIFT_CATEGORY']))).toMatchObject({
      verdict: 'escalate',
      layer: 'intent_verifier',
      reasons: ['INTENT_DRIFT_CATEGORY'],
    });
  });

  it('absent verifier → escalate, NEVER allow', () => {
    const r = applyVerdict(ALLOW1, {
      kind: 'absent',
      reason: 'timeout: budget exhausted',
      record: { ...record, used_llm: false },
    });
    expect(r.verdict).toBe('escalate');
    expect(r.layer).toBe('intent_verifier');
    expect(r.details[0]).toMatch(/absent: timeout/);
  });

  it('self-inconsistent: allow WITH reasons → escalate', () => {
    expect(applyVerdict(ALLOW1, rec('allow', ['INTENT_DRIFT_BUDGET'])).verdict).toBe('escalate');
  });

  it('self-inconsistent: block WITHOUT reasons → escalate', () => {
    expect(applyVerdict(ALLOW1, rec('block', [])).verdict).toBe('escalate');
  });

  it('exhaustive: no layer-2 input yields allow unless it is a clean allow', () => {
    const inputs: Layer2Outcome[] = [
      rec('allow', ['INTENT_DRIFT_QUANTITY']),
      rec('block', []),
      rec('block', ['INTENT_DRIFT_CATEGORY']),
      rec('escalate', []),
      { kind: 'absent', reason: 'x', record },
    ];
    for (const i of inputs) expect(applyVerdict(ALLOW1, i).verdict).not.toBe('allow');
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
 * the intent-verifier module; the applier/policy modules never mention an
 * adapter; and the verifier module itself cannot reach storage, the
 * network, or the dispatch path — it can only return data.
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

  it('intent.ts cannot touch storage, the wire, or settlement', () => {
    const src = readFileSync(join(dir, 'intent.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/(db|app)\.js'/);
    expect(src).not.toMatch(
      /better-sqlite3|fastify|fetch\(|dispatchSettlement|settlementUrl|\/acnp|signObject|buildOutbound/,
    );
  });
});
