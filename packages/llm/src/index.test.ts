import { describe, expect, it } from 'vitest';
import { StubLlmAdapter } from './index.js';

describe('StubLlmAdapter', () => {
  it('returns its configured reply deterministically', async () => {
    const llm = new StubLlmAdapter('hello');
    expect(await llm.complete('anything')).toBe('hello');
    expect(llm.modelId).toBe('stub/deterministic');
  });
});
