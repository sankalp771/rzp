import { describe, expect, it } from 'vitest';
import { createAdapterFromEnv } from './factory.js';

describe('createAdapterFromEnv (D015 boot rule: no silent stub downgrade)', () => {
  it('defaults to the stub when the provider is unset', () => {
    expect(createAdapterFromEnv('BUYER', { env: {} }).provider).toBe('stub');
  });

  it('builds the named provider when its key is present', () => {
    const a = createAdapterFromEnv('SELLER', {
      env: { SELLER_LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k', GROQ_MODEL: 'm' },
    });
    expect(a.provider).toBe('groq');
    expect(a.modelId).toBe('groq/m');
    expect(
      createAdapterFromEnv('BUYER', { env: { BUYER_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' } })
        .modelId,
    ).toBe('gemini/gemini-2.5-flash');
  });

  it('REFUSES to boot when a named provider has no key', () => {
    expect(() => createAdapterFromEnv('BUYER', { env: { BUYER_LLM_PROVIDER: 'gemini' } })).toThrow(
      /refusing to start.*GEMINI_API_KEY/,
    );
  });

  it('refuses an unknown provider name', () => {
    expect(() => createAdapterFromEnv('BUYER', { env: { BUYER_LLM_PROVIDER: 'openai' } })).toThrow(
      /refusing to start/,
    );
  });
});
