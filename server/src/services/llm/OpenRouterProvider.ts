import OpenAI from 'openai';
import { Message, LLMOptions, LLMProvider, LLMResponse, ProviderExtra } from '../../types/index.js';
import { resolveLlmRequestTimeoutMs, LLM_SDK_MAX_RETRIES, buildSdkRequestOptions } from './providerTuning.js';
import { openAIJsonResponseFormat } from './jsonMode.js';

export class OpenRouterProvider implements LLMProvider {
  private client: OpenAI;
  private defaultModel: string;
  // Retained so chat() can resolve a MODEL-AWARE per-request timeout — the client
  // is constructed with the stack default model, not the per-call model.
  private readonly extra?: ProviderExtra;

  constructor(apiKey: string, defaultModel: string, extra?: ProviderExtra) {
    this.extra = extra;
    // A DB/system-configured base URL wins; else env; else the public default.
    // NB: OpenRouter intentionally has NO X-Proxy-Key header (it never did) — the
    // proxy key stays with custom-proxy providers only. Preserves env behaviour.
    const baseURL = extra?.baseUrl || process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api/v1';
    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://robohire.io',
        'X-Title': 'RoboHire API',
      },
      // OpenRouter can route to reasoning models (incl. deepseek-v4-pro).
      // Reasoning-friendly timeout + SDK retries off (withLLMRetry is the
      // single retry layer). See providerTuning.ts.
      timeout: resolveLlmRequestTimeoutMs(extra, 'OPENROUTER_LLM_TIMEOUT_MS'),
      maxRetries: LLM_SDK_MAX_RETRIES,
    });
    this.defaultModel = defaultModel;
  }

  getProviderName(): string {
    return 'openrouter';
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model || this.defaultModel;
    
    const response = await this.client.chat.completions.create(
      {
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content as any,
        })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
        // OpenRouter's unified reasoning control — bounds a thinking model's
        // reasoning budget so it cannot consume the whole max_tokens and
        // return empty content. OpenRouter drops the param for models
        // without reasoning support. (Not in the OpenAI SDK types; the SDK
        // passes unknown body fields through.)
        ...(options?.reasoningMaxTokens
          ? { reasoning: { max_tokens: options.reasoningMaxTokens } }
          : {}),
        // API-level JSON mode. OpenRouter forwards response_format to upstream
        // providers that support it (incl. Google Gemini, the prod match model)
        // and silently drops it for those that don't — so it never errors here.
        // Constrains the model to a single JSON object, killing the prose-
        // wrapped / preamble parse_failed seen in MATCHING_ORCHESTRATOR.
        ...openAIJsonResponseFormat(options, messages),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      // Per-request AbortSignal + model-aware timeout (overrides the client
      // default). Reasoning models (e.g. deepseek-v4-pro routed via OpenRouter)
      // keep the long ceiling; fast models fail fast at 90s. See providerTuning.ts.
      buildSdkRequestOptions(options, this.extra, 'OPENROUTER_LLM_TIMEOUT_MS'),
    );

    const choice = response?.choices?.[0] as
      | ((typeof response.choices)[0] & {
          error?: { message?: string; code?: number | string };
          native_finish_reason?: string;
        })
      | undefined;
    const content = choice?.message?.content;
    if (!content) {
      // OpenRouter returns 200 with empty content when the upstream model
      // errors mid-generation, content-filters, or burns the whole max_tokens
      // budget on reasoning (observed: gemini-3.1-pro-preview thinking for
      // 141s → empty content). Surface every diagnostic the response carries —
      // an opaque "no content" leaves log inspections with nothing to act on.
      const usage = response?.usage as
        | (NonNullable<typeof response.usage> & {
            completion_tokens_details?: { reasoning_tokens?: number };
          })
        | undefined;
      const lead =
        (response as { error?: { message?: string } })?.error?.message ||
        'No content in OpenRouter response';
      const details: string[] = [];
      if (choice?.error?.message) details.push(`choice error: ${choice.error.message}`);
      if (choice?.finish_reason) details.push(`finish_reason=${choice.finish_reason}`);
      if (choice?.native_finish_reason && choice.native_finish_reason !== choice.finish_reason) {
        details.push(`native_finish_reason=${choice.native_finish_reason}`);
      }
      if (usage) {
        const reasoning = usage.completion_tokens_details?.reasoning_tokens;
        details.push(
          `tokens=${usage.prompt_tokens}/${usage.completion_tokens}` +
            (reasoning != null ? ` (reasoning=${reasoning})` : ''),
        );
      }
      const err = new Error(details.length ? `${lead} — ${details.join(' | ')}` : lead) as Error & {
        usage?: LLMResponse['usage'];
        nonRetryable?: boolean;
        finishReason?: string;
      };
      // finish_reason=length means the model burned the entire max_tokens
      // budget (typically on reasoning) before emitting any content. That is
      // deterministic for a given prompt + params — a retry reproduces the
      // same multi-minute burn and bills it again — so mark it for
      // withLLMRetry to fail fast. Upstream provider errors and content
      // filters stay retryable.
      const nativeFinish = (choice?.native_finish_reason || '').toLowerCase();
      if (choice?.finish_reason === 'length' || nativeFinish === 'length' || nativeFinish === 'max_tokens') {
        err.nonRetryable = true;
        err.finishReason = choice?.finish_reason || choice?.native_finish_reason;
      }
      // Carry real usage to the error-path logger: OpenRouter bills these
      // tokens (reasoning burn especially) even when content comes back
      // empty, so logging 0/0/0 hides real spend from cost tracking.
      if (usage) {
        err.usage = {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        };
      }
      throw err;
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
