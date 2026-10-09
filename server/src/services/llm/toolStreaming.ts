/**
 * Streaming chat with tool calls over the OpenAI chat-completions protocol
 * (WP-14; ARCHITECTURE.md §5.1, F-ORION-01/04 plumbing).
 *
 * One call = one model ROUND: text deltas stream through `onText`, tool calls
 * are assembled from their streamed fragments and returned (and announced)
 * when the round finishes. The Assistant loop (CopilotService) runs the
 * tools, appends an assistant message with `toolCalls` plus one `tool`
 * message per result, and calls again.
 *
 * Every provider here speaks the OpenAI protocol (OpenRouter, OpenAI,
 * DeepSeek, Kimi, MiniMax, Ollama, new-api, Qwen, GLM, Doubao). Google and
 * Anthropic run on their own SDKs and are refused with ToolsUnsupportedError.
 *
 * LLMService.streamChatWithTools owns routing, brand policy, retries (only
 * before the first delta), content safety and logging; this module only
 * builds the request and parses the stream, so it can be tested against a
 * fake OpenAI-compatible server.
 */

import OpenAI from 'openai';
import type { LLMUsageInfo, Message, MessageContent, ReasoningEffort } from '../../types/index.js';
import { effectiveLlmBaseUrl, openRouterProviderPreferences } from '../../platform/llm/egressPolicy.js';
import { openRouterBrandHeaders } from './OpenRouterProvider.js';
import { resolveDeepSeekThinking, resolveReasoningHeadroomTokens } from './DeepSeekProvider.js';
import { isK2Model } from './KimiProvider.js';
import { LLM_SDK_MAX_RETRIES, resolveLlmRequestTimeoutMs } from './providerTuning.js';
import {
  isDomesticVendor,
  maxTokensWithThinking,
  resolveThinkingMode,
  thinkingParams,
  type ThinkingMode,
} from './domesticVendors.js';

/* ── Wire types ─────────────────────────────────────────────────────────── */

/** A tool the model may call. `parameters` is a JSON Schema object (z.toJSONSchema output). */
export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** One tool call the model made in a round. */
export interface LlmToolCall {
  id: string;
  name: string;
  /** The raw JSON argument string, exactly as streamed. */
  arguments: string;
  /** `arguments` parsed (`{}` for an empty string); undefined when it is not valid JSON. */
  parsedArguments?: unknown;
  /** Set when `arguments` is not valid JSON (the caller should answer the tool with an error). */
  argumentsError?: string;
}

/** The previous assistant turn that requested tools. */
export interface AssistantToolCallMessage {
  role: 'assistant';
  content: string | null;
  toolCalls: LlmToolCall[];
  /**
   * The round's `reasoningContent`, passed back unchanged. DeepSeek and Kimi
   * thinking modes reject the next round of a tool turn without it; other
   * providers never receive it.
   */
  reasoningContent?: string;
}

/** A tool result fed back to the model (data only; see ARCHITECTURE §5.5). */
export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  content: string;
}

export type ToolChatMessage = Message | AssistantToolCallMessage | ToolResultMessage;

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export type StreamFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | (string & {}) | null;

export interface StreamRoundResult {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: StreamFinishReason;
  /** Null when the provider sent no usage block (the caller estimates). */
  usage: LLMUsageInfo | null;
  /** The model id the provider reported (falls back to the requested one). */
  model: string;
  /**
   * The thinking text (`delta.reasoning_content`) when the provider streamed
   * any. Never shown to the user; put it on the AssistantToolCallMessage of
   * this round so the next round can send it back.
   */
  reasoningContent?: string;
}

/* ── Provider capability ────────────────────────────────────────────────── */

/** Provider types whose tool calls stream over the OpenAI protocol. */
export const TOOL_STREAMING_PROVIDERS: ReadonlySet<string> = new Set([
  'openrouter',
  'openai',
  'deepseek',
  'kimi',
  'moonshot',
  'minimax',
  'ollama',
  'newapi',
  'qwen',
  'glm',
  'doubao',
]);

export function supportsToolStreaming(providerType: string): boolean {
  return TOOL_STREAMING_PROVIDERS.has((providerType || '').toLowerCase());
}

/* ── Message conversion ─────────────────────────────────────────────────── */

function contentForWire(content: MessageContent): unknown {
  return content;
}

/**
 * Providers whose thinking mode needs the assistant turn's `reasoning_content`
 * sent back within a tool turn (DeepSeek thinking-mode tool calls, Kimi K2
 * thinking). Others would reject or ignore the unknown field, so it is never
 * sent to them.
 */
const REASONING_ECHO_PROVIDERS: ReadonlySet<string> = new Set(['deepseek', 'kimi', 'moonshot']);

/** Our message shapes → OpenAI chat-completions messages for `providerType`. */
export function toOpenAIMessages(
  messages: readonly ToolChatMessage[],
  providerType = '',
): Array<Record<string, unknown>> {
  const echoReasoning = REASONING_ECHO_PROVIDERS.has(providerType.toLowerCase());
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && 'toolCalls' in m) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(echoReasoning && m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      };
    }
    return { role: m.role, content: contentForWire(m.content) };
  });
}

export function toOpenAITools(tools: readonly LlmToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters,
    },
  }));
}

function toolChoiceParam(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

/** Plain-text view of any message (logging, token estimates, content safety). */
export function toolMessageText(m: ToolChatMessage): string {
  if (m.role === 'tool') return m.content;
  if (m.role === 'assistant' && 'toolCalls' in m) {
    return [m.content ?? '', ...m.toolCalls.map((c) => `${c.name}(${c.arguments})`)].filter(Boolean).join('\n');
  }
  const content = (m as Message).content;
  if (typeof content === 'string') return content;
  return content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Flatten for LoggerService (which takes the plain Message shape). */
export function toLoggableMessages(messages: readonly ToolChatMessage[]): Message[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'user' as const, content: `[tool ${m.toolCallId}] ${m.content}` };
    if (m.role === 'assistant' && 'toolCalls' in m) return { role: 'assistant' as const, content: toolMessageText(m) };
    return m as Message;
  });
}

/* ── Client + request building ──────────────────────────────────────────── */

export interface StreamingCredential {
  apiKey: string;
  baseUrl?: string | null;
  proxyKey?: string;
  timeoutMs?: number;
  thinkingMode?: 'enabled' | 'disabled';
}

/** Minimal surface of the OpenAI SDK this module needs (lets tests inject a fake). */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create: (params: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

const PROXY_HEADER_PROVIDERS = new Set(['minimax', 'ollama', 'newapi', 'openai']);

/** An OpenAI SDK client pointed at the provider's real endpoint. */
export function createStreamingClient(providerType: string, cred: StreamingCredential): ChatCompletionsClient {
  const provider = providerType.toLowerCase();
  const baseURL = effectiveLlmBaseUrl(provider, cred.baseUrl) ?? undefined;
  const headers: Record<string, string> = {};
  if (provider === 'openrouter') Object.assign(headers, openRouterBrandHeaders());
  const proxyKey = cred.proxyKey ?? process.env.LLM_PROXY_KEY;
  // The proxy key goes only to custom gateways (and OpenAI behind a custom base),
  // never to a vendor's own host.
  if (proxyKey && PROXY_HEADER_PROVIDERS.has(provider) && (provider !== 'openai' || cred.baseUrl)) {
    headers['X-Proxy-Key'] = proxyKey;
  }
  return new OpenAI({
    apiKey: cred.apiKey || (provider === 'ollama' ? 'ollama' : 'placeholder'),
    ...(baseURL ? { baseURL } : {}),
    ...(Object.keys(headers).length ? { defaultHeaders: headers } : {}),
    timeout: resolveLlmRequestTimeoutMs(cred.timeoutMs !== undefined ? { timeoutMs: cred.timeoutMs } : undefined),
    maxRetries: LLM_SDK_MAX_RETRIES,
  }) as unknown as ChatCompletionsClient;
}

export interface BuildStreamParamsInput {
  providerType: string;
  model: string;
  messages: readonly ToolChatMessage[];
  tools: readonly LlmToolDefinition[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  reasoningMaxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  thinkingMode?: ThinkingMode;
  /** DeepSeek tuning from the credential (system DB / env). */
  tunedThinkingMode?: ThinkingMode;
}

/** The chat-completions body for one streamed round, with each vendor's quirks. */
export function buildStreamParams(input: BuildStreamParamsInput): Record<string, unknown> {
  const provider = input.providerType.toLowerCase();
  const params: Record<string, unknown> = {
    model: input.model,
    messages: toOpenAIMessages(input.messages, provider),
    stream: true,
  };
  // Never let OpenRouter forward the prompt to a mainland-China upstream.
  if (provider === 'openrouter') params.provider = openRouterProviderPreferences();
  if (input.tools.length > 0) {
    params.tools = toOpenAITools(input.tools);
    const choice = toolChoiceParam(input.toolChoice);
    if (choice !== undefined) params.tool_choice = choice;
  }
  // Usage arrives in a final chunk with empty choices. Local Ollama builds
  // reject unknown stream options, so it is left to the token estimate.
  if (provider !== 'ollama') params.stream_options = { include_usage: true };

  let maxTokens = input.maxTokens;
  let temperature = input.temperature;

  if (provider === 'deepseek') {
    const thinking = resolveDeepSeekThinking(input.model, input.thinkingMode, input.tunedThinkingMode);
    if (thinking === true) {
      params.thinking = { type: 'enabled' };
      // Thinking ignores temperature; reasoning tokens count against max_tokens.
      temperature = undefined;
      if (maxTokens !== undefined) maxTokens += resolveReasoningHeadroomTokens(input.reasoningMaxTokens);
    } else if (thinking === false) {
      params.thinking = { type: 'disabled' };
    }
  } else if (isDomesticVendor(provider)) {
    const mode = resolveThinkingMode(provider, input.thinkingMode);
    Object.assign(params, thinkingParams(provider, mode));
    maxTokens = maxTokensWithThinking(maxTokens, mode, input.reasoningMaxTokens);
  } else if ((provider === 'kimi' || provider === 'moonshot') && isK2Model(input.model)) {
    // Kimi K2 enforces fixed values; anything else is an API error.
    temperature = 1;
    params.thinking = { type: 'enabled' };
  }

  if (input.reasoningEffort) {
    if (provider === 'openrouter') params.reasoning = { effort: input.reasoningEffort };
    else if (provider === 'openai') params.reasoning_effort = input.reasoningEffort;
  }
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) params.max_tokens = maxTokens;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) params.temperature = temperature;
  return params;
}

/* ── Stream parsing ─────────────────────────────────────────────────────── */

interface StreamChunk {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export interface RunStreamRoundInput {
  client: ChatCompletionsClient;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  /** Called for every non-empty text delta, in order. May be async (back-pressure). */
  onText: (delta: string) => void | Promise<void>;
}

function parseArguments(raw: string): Pick<LlmToolCall, 'parsedArguments' | 'argumentsError'> {
  const trimmed = raw.trim();
  if (!trimmed) return { parsedArguments: {} };
  try {
    return { parsedArguments: JSON.parse(trimmed) };
  } catch (err) {
    return { argumentsError: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

/** Send one streamed request and assemble its text and tool calls. */
export async function runStreamRound(input: RunStreamRoundInput): Promise<StreamRoundResult> {
  const requestOptions: Record<string, unknown> = {};
  if (input.signal) requestOptions.signal = input.signal;
  const stream = (await input.client.chat.completions.create(input.params, requestOptions)) as AsyncIterable<StreamChunk>;

  let content = '';
  let reasoningContent = '';
  let finishReason: StreamFinishReason = null;
  let usage: LLMUsageInfo | null = null;
  let model = String(input.params.model ?? '');
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      const completionTokens = chunk.usage.completion_tokens ?? 0;
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: chunk.usage.total_tokens || promptTokens + completionTokens,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      await input.onText(delta.content);
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = typeof fragment.index === 'number' ? fragment.index : 0;
      const acc = calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (fragment.id && !acc.id) acc.id = fragment.id;
      const name = fragment.function?.name;
      // Most vendors send the name once; a few repeat it whole on every chunk.
      if (name && name !== acc.name) acc.name = acc.name ? acc.name + name : name;
      if (fragment.function?.arguments) acc.arguments += fragment.function.arguments;
      calls.set(index, acc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls: LlmToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, c]) => c.name)
    .map(([index, c]) => ({
      id: c.id || `call_${index}`,
      name: c.name,
      arguments: c.arguments,
      ...parseArguments(c.arguments),
    }));

  return { content, toolCalls, finishReason, usage, model, ...(reasoningContent ? { reasoningContent } : {}) };
}

/* ── Content-safety gate for streamed output (GoApply) ───────────────────── */

/**
 * Holds streamed text back until the content-safety check has passed it
 * (GoApply only; R-13 / WP-24). Text is released in chunks of about
 * `chunkChars`, at a sentence end when possible; each check covers the
 * pending chunk plus the tail of what was already released, so a blocked
 * term split across two chunks is still caught. Nothing reaches `emit`
 * before its check passes; a block or a checker failure throws.
 */
export class StreamOutputGate {
  private pending = '';
  private releasedTail = '';

  constructor(
    private readonly check: (text: string) => Promise<void>,
    private readonly emit: (text: string) => void,
    private readonly chunkChars = 160,
    private readonly tailChars = 40,
  ) {}

  async push(delta: string): Promise<void> {
    this.pending += delta;
    if (this.pending.length >= this.chunkChars || (this.pending.length >= this.chunkChars / 2 && /[.!?。！？\n]\s*$/.test(this.pending))) {
      await this.release();
    }
  }

  async flush(): Promise<void> {
    if (this.pending) await this.release();
  }

  /**
   * Drop held-back text before a retry or the next fallback hop. Only valid
   * while nothing has been released (the caller never retries after that),
   * so the discarded text was never shown.
   */
  reset(): void {
    this.pending = '';
    this.releasedTail = '';
  }

  private async release(): Promise<void> {
    const chunk = this.pending;
    this.pending = '';
    await this.check(this.releasedTail + chunk);
    this.releasedTail = (this.releasedTail + chunk).slice(-this.tailChars);
    this.emit(chunk);
  }
}
