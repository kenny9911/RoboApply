import OpenAI from 'openai';
import { Message, LLMOptions, LLMProvider, LLMResponse, ProviderExtra } from '../../types/index.js';
import { resolveLlmRequestTimeoutMs, LLM_SDK_MAX_RETRIES, buildSdkRequestOptions } from './providerTuning.js';
import { shouldUseJsonObject } from './jsonMode.js';

const K2_MODELS = [
  'kimi-k2.5',
  'kimi-k2-0905-preview',
  'kimi-k2-turbo-preview',
  'kimi-k2-thinking',
  'kimi-k2-thinking-turbo',
];

function isK2Model(model: string): boolean {
  return K2_MODELS.some((m) => model.toLowerCase() === m.toLowerCase());
}

export class KimiProvider implements LLMProvider {
  private client: OpenAI;
  private defaultModel: string;
  // Retained for the model-aware per-request timeout (see chat()).
  private readonly extra?: ProviderExtra;

  constructor(apiKey: string, defaultModel: string, extra?: ProviderExtra) {
    this.extra = extra;
    // DB/system base URL wins, else env, else default. No X-Proxy-Key header —
    // Kimi never had one; the proxy key stays with custom-proxy providers only.
    const baseURL = extra?.baseUrl || process.env.KIMI_API_BASE_URL || 'https://api.moonshot.cn/v1';
    // Kimi k2-thinking is a reasoning model (60s+/call). Reasoning-friendly
    // timeout + SDK retries off (withLLMRetry is the single retry layer).
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: resolveLlmRequestTimeoutMs(extra, 'KIMI_LLM_TIMEOUT_MS'),
      maxRetries: LLM_SDK_MAX_RETRIES,
    });
    this.defaultModel = defaultModel;
  }

  getProviderName(): string {
    return 'kimi';
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model || this.defaultModel;
    const k2 = isK2Model(model);

    const params: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (k2) {
      // K2.5 enforces fixed values; any deviation causes an API error.
      // Thinking mode (default): temperature=1.0
      // Non-thinking mode: temperature=0.6
      params.temperature = 1;
      params.thinking = { type: 'enabled' };
    } else {
      params.temperature = options?.temperature ?? 0.7;
    }

    if (options?.maxTokens) {
      params.max_tokens = options.maxTokens;
    }

    // API-level JSON mode (Moonshot supports OpenAI's response_format). Guarded
    // on the "prompt mentions json" precondition.
    if (shouldUseJsonObject(options, messages)) {
      params.response_format = { type: 'json_object' };
    }

    const response = await (this.client.chat.completions.create as Function)(
      params,
      buildSdkRequestOptions(options, this.extra, 'KIMI_LLM_TIMEOUT_MS'),
    );

    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new Error('No content in Kimi response');
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
