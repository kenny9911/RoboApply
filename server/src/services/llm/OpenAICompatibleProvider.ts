/**
 * Generic OpenAI-compatible provider. Used by RoboHire to talk to:
 *
 *   - MiniMax  (https://api.minimax.chat or region-specific endpoint)
 *   - Ollama   (http://localhost:11434/v1, local Qwen / Llama / etc.)
 *   - new-api  (QuantumNous/new-api self-hosted gateway)
 *
 * For OpenAI / OpenRouter / Kimi / DeepSeek we keep the dedicated
 * provider classes — they have provider-specific quirks (DeepSeek
 * thinking mode strips temperature, Kimi K2 forces fixed temperature,
 * etc.). This class is the "no quirks" path.
 *
 * Both the platform-default config (env vars at boot) and the BYOK
 * path (per-call user key from byokService) construct this with
 * concrete `apiKey` + `baseURL` + `providerName`.
 */

import OpenAI from 'openai';
import { Message, LLMOptions, LLMProvider, LLMResponse, ProviderExtra } from '../../types/index.js';
import { resolveLlmRequestTimeoutMs, LLM_SDK_MAX_RETRIES, buildSdkRequestOptions } from './providerTuning.js';
import { shouldUseJsonObject } from './jsonMode.js';
import { estimatePromptTokens, estimateTokensFromText } from './tokenEstimate.js';
import { logger } from '../LoggerService.js';

export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  private defaultModel: string;
  private providerName: string;
  // Retained for the model-aware per-request timeout (see chat()). Only the
  // configured timeoutMs is meaningful here; base URL/proxy are baked into the client.
  private readonly extra?: ProviderExtra;

  constructor(args: {
    apiKey: string;
    baseURL: string;
    defaultModel: string;
    providerName: string;
    proxyKey?: string;
    timeoutMs?: number;
  }) {
    this.extra = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : undefined;
    const proxyKey = args.proxyKey ?? process.env.LLM_PROXY_KEY;
    this.client = new OpenAI({
      // Ollama doesn't require a real key but the SDK throws on empty —
      // use a placeholder. Anything works.
      apiKey: args.apiKey || 'placeholder',
      baseURL: args.baseURL,
      ...(proxyKey ? { defaultHeaders: { 'X-Proxy-Key': proxyKey } } : {}),
      // Reasoning-friendly timeout + SDK retries off (withLLMRetry is the single
      // retry layer). MiniMax / new-api / local Ollama can all serve slow
      // reasoning models. See providerTuning.ts.
      timeout: resolveLlmRequestTimeoutMs(
        args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : undefined,
      ),
      maxRetries: LLM_SDK_MAX_RETRIES,
    });
    this.defaultModel = args.defaultModel;
    this.providerName = args.providerName;
  }

  getProviderName(): string {
    return this.providerName;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model || this.defaultModel;

    const params: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (typeof options?.temperature === 'number' && Number.isFinite(options.temperature)) {
      params.temperature = options.temperature;
    } else if (options?.temperature === undefined) {
      params.temperature = 0.7;
    }

    if (typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens)) {
      params.max_tokens = options.maxTokens;
    }

    // API-level JSON mode (minimax / new-api / Ollama all speak OpenAI's
    // response_format). Guarded on the "prompt mentions json" precondition.
    if (shouldUseJsonObject(options, messages)) {
      params.response_format = { type: 'json_object' };
    }

    const response = await (this.client.chat.completions.create as Function)(
      params,
      buildSdkRequestOptions(options, this.extra),
    );

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`No content in ${this.providerName} response`);
    }

    const reportedPrompt = response.usage?.prompt_tokens || 0;
    const reportedCompletion = response.usage?.completion_tokens || 0;
    const reportedTotal = response.usage?.total_tokens || 0;

    // Self-hosted Ollama and some NewAPI / MiniMax gateways return no usage block
    // at all. Recording 0 tokens zeroes the cost and hides real LLM spend from the
    // usage ledgers + billing statements. When the provider gives us nothing
    // usable, estimate from text (~4 chars/token) and flag the row so unmetered
    // calls stay visible in cost analytics.
    if (reportedPrompt <= 0 && reportedCompletion <= 0 && reportedTotal <= 0) {
      const promptTokens = estimatePromptTokens(messages);
      const completionTokens = estimateTokensFromText(content);
      logger.warn(
        'LLM',
        `${this.providerName} returned no token usage — estimated from text`,
        {
          provider: this.providerName,
          model,
          estimatedPromptTokens: promptTokens,
          estimatedCompletionTokens: completionTokens,
        },
      );
      return {
        content,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          estimated: true,
        },
        model,
      };
    }

    return {
      content,
      usage: {
        promptTokens: reportedPrompt,
        completionTokens: reportedCompletion,
        // Some gateways report only a total — fall back to the sum of the parts.
        totalTokens: reportedTotal || reportedPrompt + reportedCompletion,
      },
      model,
    };
  }
}
