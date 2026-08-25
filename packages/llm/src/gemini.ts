import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from './adapter.js';
import { DEFAULT_BUDGET, fetchWithBudget, type FetchBudget, type FetchDeps } from './http.js';

/**
 * Google Gemini via the generativelanguage REST API (D008 primary). Raw
 * fetch, no SDK. The key travels in a header, never in the URL, so it can
 * not leak through access logs or error messages.
 */
export interface GeminiOptions {
  apiKey: string;
  model: string;
  budget?: FetchBudget;
  baseUrl?: string;
  deps?: FetchDeps;
}

export class GeminiAdapter implements LlmAdapter {
  readonly provider = 'gemini';
  readonly modelId: string;
  constructor(private readonly opts: GeminiOptions) {
    this.modelId = `gemini/${opts.model}`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${base}/models/${encodeURIComponent(this.opts.model)}:generateContent`;
    const started = Date.now();
    const res = await fetchWithBudget(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            maxOutputTokens: req.maxTokens ?? 512,
            temperature: req.temperature ?? 0.2,
            responseMimeType: 'application/json',
            // Gemini 2.5 "thinking" tokens count against maxOutputTokens:
            // with a small budget the model returned finishReason
            // MAX_TOKENS and zero text (observed live, FEATURE-006). This
            // is a short structured task; thinking is switched off.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
      this.opts.budget ?? DEFAULT_BUDGET,
      this.opts.deps ?? {},
    );
    const json = (await res.json().catch(() => null)) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    } | null;
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new LlmError('malformed', 'gemini: no candidate text in response');
    return { text, modelId: this.modelId, latency_ms: Date.now() - started };
  }
}
