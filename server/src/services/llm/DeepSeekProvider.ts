import OpenAI from 'openai';
import { Message, LLMOptions, LLMProvider, LLMResponse, ProviderExtra } from '../../types/index.js';
import { resolveLlmRequestTimeoutMs, LLM_SDK_MAX_RETRIES, buildSdkRequestOptions } from './providerTuning.js';
import { shouldUseJsonObject } from './jsonMode.js';
import { DEEPSEEK_EFFORTS, resolveReasoningEffort, type ReasoningEffort } from './reasoningEffort.js';

// DeepSeek's API is OpenAI-compatible. Two production model families as of 2026:
//   deepseek-v4-pro    — reasoning-first, thinking mode always on
//   deepseek-v4-flash  — fast, thinking mode togglable (defaults on)
// The 2025 names (deepseek-chat / deepseek-reasoner) are deprecated 2026/07/24
// but still served — keep them in the lookup tables so callers don't break.
const REASONING_MODELS = [
  'deepseek-v4-pro',
  'deepseek-reasoner',
];

const THINKING_TOGGLE_MODELS = [
  'deepseek-v4-flash',
  'deepseek-chat',
];

function modelMatches(model: string, list: string[]): boolean {
  const normalized = model.toLowerCase();
  return list.some((m) => normalized === m.toLowerCase());
}

/**
 * Tokens reserved for `reasoning_content` ON TOP of the caller's answer budget
 * when thinking mode is enabled. Sized from the observed ceiling of the widest
 * structured-output agent on this path (RAJobMatchScorerAgent peaks at ~4.3k
 * reasoning tokens); 8k leaves room for longer prompts without capping a
 * legitimate think. Reasoning tokens are only billed if actually generated, so
 * an over-generous reserve costs nothing on prompts that think less.
 */
const DEFAULT_DEEPSEEK_REASONING_HEADROOM_TOKENS = 8_000;

/**
 * Reasoning headroom for one call: the agent's explicit
 * `reasoningMaxTokens` (BaseAgent.getReasoningMaxTokens) wins, else
 * DEEPSEEK_REASONING_MAX_TOKENS, else the default. Read at call time so an env
 * reload takes effect without a restart.
 */
function resolveReasoningHeadroomTokens(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const raw = parseInt((process.env.DEEPSEEK_REASONING_MAX_TOKENS || '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEEPSEEK_REASONING_HEADROOM_TOKENS;
}

function envThinkingMode(): boolean | undefined {
  const v = process.env.DEEPSEEK_THINKING_MODE;
  if (v === undefined) return undefined;
  const n = v.trim().toLowerCase();
  if (['1', 'true', 'enabled', 'on', 'yes'].includes(n)) return true;
  if (['0', 'false', 'disabled', 'off', 'no'].includes(n)) return false;
  return undefined;
}

export class DeepSeekProvider implements LLMProvider {
  private client: OpenAI;
  private defaultModel: string;
  // DB-resolved tuning (thinking mode / reasoning effort); each falls back to env.
  private readonly tunedThinkingMode?: 'enabled' | 'disabled';
  private readonly tunedReasoningEffort?: ReasoningEffort;
  // Retained for the model-aware per-request timeout (see chat()).
  private readonly extra?: ProviderExtra;

  constructor(apiKey: string, defaultModel: string, extra?: ProviderExtra) {
    this.extra = extra;
    const baseURL = extra?.baseUrl || process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com';
    // deepseek-v4-pro is a reasoning model (thinking mode always on, 60-150s/call).
    // Give it a reasoning-friendly timeout and disable SDK-internal retries so
    // withLLMRetry is the single retry layer (see providerTuning.ts).
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: resolveLlmRequestTimeoutMs(extra, 'DEEPSEEK_LLM_TIMEOUT_MS'),
      maxRetries: LLM_SDK_MAX_RETRIES,
    });
    this.defaultModel = defaultModel;
    this.tunedThinkingMode = extra?.thinkingMode;
    this.tunedReasoningEffort = extra?.reasoningEffort;
  }

  getProviderName(): string {
    return 'deepseek';
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model || this.defaultModel;

    // Resolve thinking mode:
    //  - Reasoning-only models (V4-Pro, reasoner): always enabled
    //  - Toggleable models (V4-Flash, chat): default enabled, env can override
    //  - Unknown future models: leave the field off so the API default applies
    // DB tuning wins; else env DEEPSEEK_THINKING_MODE (unchanged when unset).
    const tuningOverride = this.tunedThinkingMode !== undefined
      ? this.tunedThinkingMode === 'enabled'
      : envThinkingMode();
    // Per-CALL override (LLMOptions.thinkingMode) wins over DB/env tuning, so a
    // single call (e.g. the cheap match SCREEN) can force thinking OFF without
    // changing the global DEEPSEEK_THINKING_MODE other agents rely on.
    const callOverride = options?.thinkingMode !== undefined
      ? options.thinkingMode === 'enabled'
      : undefined;
    const effectiveOverride = callOverride ?? tuningOverride;
    let thinkingEnabled: boolean | undefined;
    if (modelMatches(model, REASONING_MODELS)) {
      thinkingEnabled = true; // reasoning-only models can't disable thinking
    } else if (modelMatches(model, THINKING_TOGGLE_MODELS)) {
      thinkingEnabled = effectiveOverride ?? true;
    } else {
      thinkingEnabled = effectiveOverride;
    }

    const params: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (thinkingEnabled === true) {
      // In thinking mode, DeepSeek silently ignores temperature/top_p/presence/frequency
      // penalties. Elide them to keep the request shape clean.
      params.thinking = { type: 'enabled' };
      // DeepSeek's ladder is high|max only — a global LLM_REASONING_EFFORT of
      // minimal/low/medium is therefore ignored here rather than sent and
      // rejected. DEEPSEEK_REASONING_EFFORT still wins over the global dial.
      const effort = resolveReasoningEffort({
        explicit: options?.reasoningEffort,
        tuned: this.tunedReasoningEffort,
        envVars: ['DEEPSEEK_REASONING_EFFORT'],
        allow: DEEPSEEK_EFFORTS,
      });
      if (effort) {
        params.reasoning_effort = effort;
      }
    } else {
      if (thinkingEnabled === false) {
        params.thinking = { type: 'disabled' };
      }
      params.temperature = options?.temperature ?? 0.7;
    }

    // DeepSeek counts reasoning_content tokens against `max_tokens`, so with
    // thinking ON a caller's small answer budget is spent entirely on the chain
    // of thought: the API returns finish_reason='length' with an EMPTY
    // message.content, the "No content" throw below fires, and withLLMRetry
    // burns all 3 attempts on a failure that can never succeed — surfacing to
    // the client as a 502. Measured on RAJobMatchScorerAgent (BE3 prompt):
    // max_tokens=1500 → reasoning_tokens=1500, content='' on 11 of 12 calls,
    // while the same prompt needs 2.1-4.3k reasoning tokens to emit its
    // ~275-token answer. So `maxTokens` keeps meaning "tokens of ANSWER" and
    // the thinking budget is added on top — the direct-provider counterpart of
    // OpenRouterProvider's `reasoning.max_tokens` (BaseAgent.getReasoningMaxTokens),
    // which until now was the ONLY provider honouring that reservation.
    if (options?.maxTokens) {
      params.max_tokens = thinkingEnabled === true
        ? options.maxTokens + resolveReasoningHeadroomTokens(options.reasoningMaxTokens)
        : options.maxTokens;
    }

    // API-level JSON mode. Per DeepSeek docs, JSON Output (response_format
    // json_object) is a SUPPORTED feature on BOTH the chat and the reasoning
    // (thinking) models — it is not in the reasoner's not-supported list — so we
    // attach it regardless of thinkingEnabled. On the reasoner the chain-of-
    // thought lands in a separate reasoning_content field; message.content (what
    // we read) stays pure JSON. DeepSeek's JSON mode also requires the prompt to
    // mention "json", which shouldUseJsonObject enforces. (Empty-content / mid-
    // JSON-truncation are documented DeepSeek edge cases — handled by the
    // existing "No content" throw + withLLMRetry and the generous max_tokens.)
    if (shouldUseJsonObject(options, messages)) {
      params.response_format = { type: 'json_object' };
    }

    const response = await (this.client.chat.completions.create as Function)(
      params,
      buildSdkRequestOptions(options, this.extra, 'DEEPSEEK_LLM_TIMEOUT_MS'),
    );

    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      const apiError = (response as { error?: { message?: string } })?.error?.message;
      // A thinking model that hits the token cap mid-thought comes back as
      // finish_reason='length' with empty content. Name that case explicitly:
      // it is deterministic for the given budget, NOT the transient provider
      // blip the bare "No content" message implied (and that withLLMRetry
      // would otherwise keep retrying to no effect).
      const reasoningTokens = (response as {
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
      })?.usage?.completion_tokens_details?.reasoning_tokens;
      const errorMessage = apiError
        || (choice?.finish_reason === 'length'
          ? `No content in DeepSeek response: the ${params.max_tokens ?? 'default'}-token budget was `
            + `exhausted by reasoning (${reasoningTokens ?? 'unknown'} reasoning tokens, finish_reason=length) `
            + 'before any answer was emitted. Raise the caller\'s maxTokens / DEEPSEEK_REASONING_MAX_TOKENS, '
            + 'or disable thinking mode for this call.'
          : 'No content in DeepSeek response');
      throw new Error(errorMessage);
    }

    return {
      content,
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      model,
    };
  }
}
