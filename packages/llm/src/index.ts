/**
 * LLM adapter layer — placeholder for Day 6 (FEATURE-006).
 * Invariant (CONSTRAINTS #8): no vendor SDK import and no direct provider
 * HTTP call may exist outside this package. Services depend on the
 * `LlmAdapter` interface only; concrete adapters (Gemini, Groq, Mistral —
 * see D008) are selected by configuration.
 */
export interface LlmAdapter {
  /** Provider + model identifier recorded in every session for version pinning. */
  readonly modelId: string;
  complete(prompt: string): Promise<string>;
}

/** Deterministic adapter used by tests and CI (Gate 2 reproducibility). */
export class StubLlmAdapter implements LlmAdapter {
  readonly modelId = 'stub/deterministic';
  constructor(private readonly reply: string = '') {}
  async complete(): Promise<string> {
    return this.reply;
  }
}
