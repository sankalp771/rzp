import { StubLlmAdapter, type LlmAdapter } from './adapter.js';
import { GeminiAdapter } from './gemini.js';
import { DEFAULT_BUDGET, type FetchBudget, type FetchDeps } from './http.js';
import { GROQ_BASE_URL, MISTRAL_BASE_URL, OpenAiCompatAdapter } from './openai-compat.js';

/**
 * Provider selection from the environment (D015):
 *   <SIDE>_LLM_PROVIDER unset or "stub" → deterministic stub (CI, key-less
 *   quickstart); "gemini" | "groq" | "mistral" → that adapter, and a MISSING
 *   KEY REFUSES TO BOOT. There is no silent downgrade from a named provider
 *   to the stub: a demo must never run on the stub without saying so, and
 *   /health reports the effective provider + model for the same reason.
 */
export type Provider = 'stub' | 'gemini' | 'groq' | 'mistral';
export const PROVIDERS: Provider[] = ['stub', 'gemini', 'groq', 'mistral'];

/**
 * Defaults verified live on 2026-08-25 (FEATURE-006). Groq's earlier
 * llama-3.3-70b-versatile returned 404 (retired); the account's current
 * list is gpt-oss-120b/20b and qwen3.6-27b. Override with <PROVIDER>_MODEL.
 */
export const DEFAULT_MODELS: Record<Exclude<Provider, 'stub'>, string> = {
  gemini: 'gemini-2.5-flash',
  groq: 'openai/gpt-oss-120b',
  mistral: 'mistral-small-latest',
};

export type Side = 'BUYER' | 'SELLER' | 'FIREWALL';

export interface FactoryOptions {
  env?: Record<string, string | undefined>;
  deps?: FetchDeps;
}

export function budgetFromEnv(env: Record<string, string | undefined>): FetchBudget {
  return {
    attemptTimeoutMs: Number(env['LLM_CALL_TIMEOUT_MS'] ?? DEFAULT_BUDGET.attemptTimeoutMs),
    totalBudgetMs: Number(env['LLM_TOTAL_BUDGET_MS'] ?? DEFAULT_BUDGET.totalBudgetMs),
    maxAttempts: Number(env['LLM_MAX_ATTEMPTS'] ?? DEFAULT_BUDGET.maxAttempts),
  };
}

export function createAdapterFromEnv(side: Side, opts: FactoryOptions = {}): LlmAdapter {
  const env = opts.env ?? process.env;
  const raw = (env[`${side}_LLM_PROVIDER`] ?? 'stub').toLowerCase();
  if (!PROVIDERS.includes(raw as Provider)) {
    throw new Error(
      `refusing to start: ${side}_LLM_PROVIDER="${raw}" is not one of ${PROVIDERS.join('|')}`,
    );
  }
  const provider = raw as Provider;
  if (provider === 'stub') return new StubLlmAdapter('');

  const keyVar = `${provider.toUpperCase()}_API_KEY`;
  const apiKey = env[keyVar];
  if (!apiKey) {
    throw new Error(
      `refusing to start: ${side}_LLM_PROVIDER=${provider} but ${keyVar} is not set (no silent stub downgrade — set the key or choose "stub")`,
    );
  }
  const model = env[`${provider.toUpperCase()}_MODEL`] ?? DEFAULT_MODELS[provider];
  const budget = budgetFromEnv(env);
  const common = { apiKey, model, budget, ...(opts.deps ? { deps: opts.deps } : {}) };
  switch (provider) {
    case 'gemini':
      return new GeminiAdapter(common);
    case 'groq':
      return new OpenAiCompatAdapter({ provider, baseUrl: GROQ_BASE_URL, ...common });
    case 'mistral':
      return new OpenAiCompatAdapter({ provider, baseUrl: MISTRAL_BASE_URL, ...common });
  }
}
