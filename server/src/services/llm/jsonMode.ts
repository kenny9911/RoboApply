import type { Message, MessageContent, LLMOptions } from '../../types/index.js';

/**
 * Shared helpers for translating the provider-neutral `LLMOptions.responseFormat`
 * flag into each provider's API-level "JSON mode" parameter.
 *
 * Why a guard helper instead of attaching the param unconditionally: OpenAI (and
 * OpenAI-compatible gateways) REJECT `response_format: { type: 'json_object' }`
 * with a 400 unless the request messages mention the word "json" somewhere
 * ("'messages' must contain the word 'json' in some form"). Every RoboHire agent
 * that opts into JSON mode already prints a `json` schema block, so in practice
 * the guard is always satisfied — it exists purely so a future agent that opts
 * in without the word can't turn a parse_failed into a hard 400. Gemini's
 * responseMimeType has no such requirement, but the guard is harmless there.
 */

function flatten(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text || '' : '')).join(' ');
}

/** True when any message contains the literal substring "json" (case-insensitive). */
export function messagesMentionJson(messages: Message[]): boolean {
  return messages.some((m) => flatten(m.content).toLowerCase().includes('json'));
}

/**
 * Should this call attach an OpenAI-style `response_format: { type: 'json_object' }`?
 * True only when the caller asked for json_object AND the OpenAI "must mention
 * json" precondition is met.
 */
export function shouldUseJsonObject(options: LLMOptions | undefined, messages: Message[]): boolean {
  return options?.responseFormat === 'json_object' && messagesMentionJson(messages);
}

/** The OpenAI-compatible response_format body fragment, or empty when not applicable. */
export function openAIJsonResponseFormat(
  options: LLMOptions | undefined,
  messages: Message[],
): { response_format: { type: 'json_object' } } | Record<string, never> {
  return shouldUseJsonObject(options, messages) ? { response_format: { type: 'json_object' } } : {};
}
