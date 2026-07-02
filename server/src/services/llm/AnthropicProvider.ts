/**
 * AnthropicProvider — talks to api.anthropic.com (or a compatible proxy)
 * via the @anthropic-ai/sdk. Used by:
 *
 *   1. The platform-default direct mode when LLM_MODEL has an
 *      `anthropic/` prefix.
 *   2. BYOK paths where the user has supplied an Anthropic key — the
 *      provider is constructed per-call with the user's key.
 *
 * Note: Agent Alex's text path has its own Claude integration in
 * `services/ClaudeAgentService.ts` (different model selection logic +
 * tool-use loop). This provider exists for plain `LLMService.chat`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Message, MessageContent, LLMOptions, LLMProvider, LLMResponse, ProviderExtra } from '../../types/index.js';
import { resolveLlmRequestTimeoutMs, LLM_SDK_MAX_RETRIES, buildSdkRequestOptions } from './providerTuning.js';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private defaultModel: string;
  // Retained for the model-aware per-request timeout (see chat()).
  private readonly extra?: ProviderExtra;

  constructor(apiKey: string, defaultModel: string, baseURL?: string, extra?: ProviderExtra) {
    this.extra = extra;
    const proxyKey = extra?.proxyKey ?? process.env.LLM_PROXY_KEY;
    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(baseURL && proxyKey ? { defaultHeaders: { 'X-Proxy-Key': proxyKey } } : {}),
      // Reasoning-friendly timeout + SDK retries off (withLLMRetry is the single
      // retry layer). The Anthropic SDK otherwise auto-scales timeout to
      // max_tokens and retries twice. See providerTuning.ts.
      timeout: resolveLlmRequestTimeoutMs(extra, 'ANTHROPIC_LLM_TIMEOUT_MS'),
      maxRetries: LLM_SDK_MAX_RETRIES,
    });
    this.defaultModel = defaultModel;
  }

  getProviderName(): string {
    return 'anthropic';
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model || this.defaultModel;

    // Anthropic separates `system` from `messages`. Concatenate any
    // system messages we receive (BaseAgent only emits one, but be safe).
    const systemParts: string[] = [];
    const userMessages: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(typeof msg.content === 'string' ? msg.content : flattenContent(msg.content));
        continue;
      }
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      userMessages.push({ role, content: convertContent(msg.content) });
    }

    // NB: LLMOptions.responseFormat ('json_object') is intentionally ignored
    // here — the Anthropic Messages API has no OpenAI-style response_format mode;
    // forcing JSON with Claude is done via tool_use / assistant prefill / prompt
    // instruction. Agents that need guaranteed JSON on Claude must not rely on
    // this flag. Sending an unknown param would 400, so we simply omit it.
    const response = await this.client.messages.create(
      {
        model,
        max_tokens: options?.maxTokens ?? 24000,
        ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
        ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
        messages: userMessages as Anthropic.MessageParam[],
      },
      buildSdkRequestOptions(options, this.extra, 'ANTHROPIC_LLM_TIMEOUT_MS'),
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (!text) {
      throw new Error('No content in Anthropic response');
    }

    return {
      content: text,
      usage: {
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
        totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      },
      model: response.model || model,
    };
  }
}

function flattenContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text || '' : ''))
    .filter(Boolean)
    .join('\n');
}

function convertContent(content: MessageContent): string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } }> {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text || '' };
    }
    // OpenAI-style image_url → Anthropic image source.
    const url = part.image_url?.url || '';
    if (url.startsWith('data:')) {
      // data:[<mediatype>][;base64],<data>
      const match = url.match(/^data:([^;,]+);base64,(.+)$/);
      if (match) {
        return {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: match[1], data: match[2] },
        };
      }
    }
    return {
      type: 'image' as const,
      source: { type: 'url' as const, url },
    };
  });
}
