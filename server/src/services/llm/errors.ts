/**
 * Errors LLMService raises for the per-brand routing rules (WP-14). Each
 * carries a `code` that server/src/platform/http.ts `mapError` turns into the
 * matching HTTP status:
 *
 *   AiUnavailableError         → 503 ai_unavailable (GoApply runs on a
 *                                provider of its own, or behind the
 *                                domestic-only wall, and the call has no
 *                                model or no route; or its content-safety
 *                                check could not run: fail closed). GoApply
 *                                on the shared stack without the wall never
 *                                raises `no_model`: it uses the shared model
 *                                as RoboApply does.
 *   ToolsUnsupportedError      → 500 internal (a configuration error: the
 *                                copilot model's provider cannot stream tools)
 *   LlmStreamInterruptedError  → the stream failed after text was emitted; the
 *                                caller ends the turn with an `error` event
 *                                and offers a retry (no silent re-run)
 *
 * LlmBrandPolicyError (500 brand_policy) lives in platform/llm/brandPolicy.ts.
 * Leaf module: no imports.
 */

export type AiUnavailableReason =
  /** GoApply on its own (domestic) stack or behind the domestic-only wall: no usable model, or a bare model id and no provider of its own. */
  | 'no_model'
  /** GoApply: the content-safety provider errored or timed out (fail closed). */
  | 'content_safety_unavailable';

export class AiUnavailableError extends Error {
  readonly code = 'ai_unavailable' as const;
  readonly status = 503;
  readonly reason: AiUnavailableReason;
  /** Never retry: configuration does not change between attempts. */
  readonly nonRetryable = true;
  constructor(reason: AiUnavailableReason, detail?: string, options?: { cause?: unknown }) {
    // The message is what an API client sees (mapError uses it); keep it plain.
    super('This AI feature is not available right now.');
    this.name = 'AiUnavailableError';
    this.reason = reason;
    if (detail) this.detail = detail;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
  /** Operator-facing detail for logs (never sent to the client). */
  detail?: string;
}

export function isAiUnavailableError(error: unknown): error is AiUnavailableError {
  return error instanceof AiUnavailableError || (!!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ai_unavailable');
}

export class ToolsUnsupportedError extends Error {
  readonly code = 'tools_unsupported' as const;
  readonly provider: string;
  readonly model: string;
  readonly nonRetryable = true;
  constructor(provider: string, model: string, message?: string) {
    super(
      message ??
        `LLM provider "${provider}" (model "${model}") cannot stream tool calls. ` +
          'Configure an OpenAI-compatible provider for this task (OpenRouter, OpenAI, DeepSeek, Kimi, ' +
          'Qwen, GLM, Doubao, MiniMax or a new-api gateway).',
    );
    this.name = 'ToolsUnsupportedError';
    this.provider = provider;
    this.model = model;
  }
}

export class LlmStreamInterruptedError extends Error {
  readonly code = 'stream_interrupted' as const;
  readonly nonRetryable = true;
  /** Text already delivered through onDelta before the failure. */
  readonly partialContent: string;
  constructor(cause: unknown, partialContent: string) {
    super(`The model stream ended early: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'LlmStreamInterruptedError';
    this.partialContent = partialContent;
    (this as { cause?: unknown }).cause = cause;
  }
}
