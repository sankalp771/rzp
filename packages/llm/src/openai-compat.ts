import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from './adapter.js';
import { DEFAULT_BUDGET, fetchWithBudget, type FetchBudget, type FetchDeps } from './http.js';

/**
 * One adapter for every provider that speaks the OpenAI chat-completions
 * shape — Groq and Mistral today (D008). Raw fetch, no SDK. `provider`
 * names the vendor for model attribution; `baseUrl` selects the endpoint.
 */
export interface OpenAiCompatOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  budget?: FetchBudget;
  deps?: FetchDeps;
}

export class OpenAiCompatAdapter implements LlmAdapter {
  readonly provider: string;
  readonly modelId: string;
  constructor(private readonly opts: OpenAiCompatOptions) {
    this.provider = opts.provider;
    this.modelId = `${opts.provider}/${opts.model}`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const res = await fetchWithBudget(
      `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.2,
          response_format: { type: 'json_object' },
        }),
      },
      this.opts.budget ?? DEFAULT_BUDGET,
      this.opts.deps ?? {},
    );
    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const text = json?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new LlmError('malformed', `${this.provider}: no message content in response`);
    return { text, modelId: this.modelId, latency_ms: Date.now() - started };
  }
}

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
