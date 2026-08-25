/**
 * Adapter contract (ARCHITECTURE §4, CONSTRAINTS #8). Services depend on
 * this interface only; the concrete adapters in this package are the ONLY
 * place vendor HTTP calls exist. Everything an adapter returns is untrusted
 * text — the proposal parser (propose.ts) and the services' clamps decide
 * what, if anything, becomes a number on the wire.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Hint only; adapters may ignore. Kept low for reproducible-ish numbers. */
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  /** provider/model, recorded per session and per move (D008 pinning). */
  modelId: string;
  latency_ms: number;
}

export interface LlmAdapter {
  readonly provider: string;
  readonly modelId: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind = 'timeout' | 'rate_limited' | 'http' | 'network' | 'malformed';

/** Every adapter failure is one of these; callers never see raw errors. */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Deterministic adapter for tests/CI and the key-less quickstart. `reply`
 * may be a function so tests can script adversarial or chaotic output
 * per request (the Gate 2 chaos E2E).
 */
export class StubLlmAdapter implements LlmAdapter {
  readonly provider = 'stub';
  readonly modelId = 'stub/deterministic';
  private calls = 0;
  constructor(private readonly reply: string | ((req: LlmRequest, call: number) => string) = '') {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
    const text = typeof this.reply === 'function' ? this.reply(req, this.calls) : this.reply;
    return { text, modelId: this.modelId, latency_ms: 0 };
  }
}
