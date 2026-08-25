import { describe, expect, it } from 'vitest';
import { StubLlmAdapter } from './index.js';

describe('StubLlmAdapter', () => {
  it('returns its configured reply deterministically', async () => {
    const llm = new StubLlmAdapter('hello');
    expect((await llm.complete({ system: 's', user: 'u' })).text).toBe('hello');
    expect(llm.modelId).toBe('stub/deterministic');
  });

  it('can script a reply per call (chaos/adversarial tests)', async () => {
    const llm = new StubLlmAdapter((_req, call) => `reply ${call}`);
    expect((await llm.complete({ system: 's', user: 'u' })).text).toBe('reply 1');
    expect((await llm.complete({ system: 's', user: 'u' })).text).toBe('reply 2');
  });
});
