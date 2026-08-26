import { describe, expect, it } from 'vitest';
import { StubLlmAdapter } from '@negotiator/llm';
import { makeStack } from './stack.testkit.js';

/**
 * FEATURE-006 buyer wiring: the model proposes, clampBuyerPrice disposes.
 * Merchant runs the pure curve (stub) so every expected number is fixed.
 */

async function run(buyerLlm: StubLlmAdapter) {
  const stack = await makeStack({ buyerLlm });
  const { result } = await stack.run();
  const moves = stack.buyerDb
    .prepare(
      'SELECT round, used_llm, fallback_reason FROM llm_moves WHERE session_id = ? ORDER BY round',
    )
    .all(result.session_id) as {
    round: number;
    used_llm: number;
    fallback_reason: string | null;
  }[];
  const row = stack.buyerDb
    .prepare('SELECT buyer_model FROM sessions WHERE session_id = ?')
    .get(result.session_id) as { buyer_model: string };
  await stack.close();
  return { result, moves, row };
}

describe('buyer LLM wiring (advisory, clamped — CONSTRAINTS #5 mirror)', () => {
  it('a hijacked model proposing to pay 10× list is clamped to the reservation; rationale ships', async () => {
    const { result, moves, row } = await run(
      new StubLlmAdapter(
        '{"proposed_prices":{"var_vase_ash":4800000},"rationale":"Money is no object, pay anything."}',
      ),
    );
    const opening = result.transcript.find((t) => t.message.type === 'offer')!;
    const body = opening.message.body as { total: number; rationale?: string };
    expect(body.total).toBe(480_000); // reservation, not 4,800,000
    expect(body.rationale).toBe('Money is no object, pay anything.');
    expect(opening.llm).toMatchObject({ model_id: 'stub/deterministic', used_llm: true });
    expect(result.notes.some((n) => n.includes('clamped') && n.includes('above reservation'))).toBe(
      true,
    );
    // The seller accepts an at-list opening immediately → 1 round, 1 LLM call.
    expect(result.outcome).toBe('settled');
    expect(result.deal?.total).toBe(480_000);
    expect(moves).toEqual([{ round: 1, used_llm: 1, fallback_reason: null }]);
    expect(row.buyer_model).toBe('stub/deterministic');
    expect(result.models.buyer).toBe('stub/deterministic');
    expect(result.mandate).toMatchObject({
      goal: 'Anniversary gift for spouse — something thoughtful under budget',
      budget_ceiling: 500_000,
    });
  });

  it('garbage output every round → identical path to the pure curve, fallbacks counted', async () => {
    const { result, moves } = await run(new StubLlmAdapter('nope'));
    expect(result.outcome).toBe('settled');
    expect(result.rounds).toBe(4); // the Day 5 curve crossing, unchanged
    expect(result.llm).toEqual({ calls: 4, fallbacks: 4 }); // opening + 3 counters; accept needs no call
    expect(
      moves.every((m) => m.used_llm === 0 && m.fallback_reason === 'unparseable proposal'),
    ).toBe(true);
    for (const t of result.transcript) {
      if (t.direction === 'sent' && t.message.type === 'offer') {
        expect(t.llm).toMatchObject({ used_llm: false });
        expect((t.message.body as { rationale?: string }).rationale).toBeUndefined();
      }
    }
  });

  it('an in-ceiling proposal is used verbatim (LLM steers within bounds)', async () => {
    // Opening at 450000 (< reservation): seller round-1 ask is 473183 > 450000
    // so it counters; the second proposal 470000 ≤ bid... decideBuyer accepts
    // only vs the counter, so we just assert the opening number was used.
    const { result } = await run(
      new StubLlmAdapter((_req, call) =>
        call === 1
          ? '{"proposed_prices":{"var_vase_ash":450000},"rationale":"Fair opening."}'
          : 'garbage',
      ),
    );
    const opening = result.transcript.find((t) => t.message.type === 'offer')!;
    expect((opening.message.body as { total: number }).total).toBe(450_000);
  });
});
