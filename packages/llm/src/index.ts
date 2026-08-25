/**
 * @negotiator/llm — model-agnostic LLM adapter layer (ARCHITECTURE §4).
 * Invariant (CONSTRAINTS #8): no vendor SDK import and no direct provider
 * HTTP call may exist outside this package. Services depend on `LlmAdapter`
 * and `proposeMove` only; concrete adapters are selected by configuration
 * (`createAdapterFromEnv`). The model is advisory: `proposeMove` returns
 * `null` on any failure and the services fall back to their deterministic
 * curves (D015).
 */
export { LlmError, StubLlmAdapter } from './adapter.js';
export type { LlmAdapter, LlmErrorKind, LlmRequest, LlmResponse } from './adapter.js';
export { DEFAULT_BUDGET, fetchWithBudget } from './http.js';
export type { FetchBudget, FetchDeps, FetchLike } from './http.js';
export { GeminiAdapter } from './gemini.js';
export type { GeminiOptions } from './gemini.js';
export { GROQ_BASE_URL, MISTRAL_BASE_URL, OpenAiCompatAdapter } from './openai-compat.js';
export type { OpenAiCompatOptions } from './openai-compat.js';
export { Proposal, RATIONALE_MAX, buildPrompt, parseProposal, proposeMove } from './propose.js';
export type { MoveRecord, NegotiationContext, ProposalLine, ProposeOutcome } from './propose.js';
export { DEFAULT_MODELS, PROVIDERS, budgetFromEnv, createAdapterFromEnv } from './factory.js';
export type { FactoryOptions, Provider, Side } from './factory.js';
