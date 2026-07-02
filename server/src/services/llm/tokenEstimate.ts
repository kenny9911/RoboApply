/**
 * Token-count estimation fallback.
 *
 * Some OpenAI-compatible endpoints omit the `usage` block entirely — notably
 * self-hosted Ollama and some NewAPI / MiniMax gateways. When that happens the
 * real token spend would otherwise be recorded as 0, zeroing the per-call cost
 * and hiding genuine LLM spend from the usage ledgers / billing statements.
 *
 * These helpers approximate the counts from raw text using the industry-standard
 * ~4-characters-per-token heuristic. They are a FALLBACK ONLY — accurate metering
 * always prefers the provider's reported counts. Estimated usage is flagged
 * (`LLMUsageInfo.estimated`) so it stays visible downstream.
 */

import type { Message, MessageContent } from '../../types/index.js';

const CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}

/** Rough token estimate for a single string (~4 chars/token). */
export function estimateTokensFromText(text: string | null | undefined): number {
  return estimateTokensFromChars(text ? text.length : 0);
}

function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  // Text parts only — image parts carry no text tokens and are rare on the
  // self-hosted providers this fallback serves.
  return content
    .map((part) => (part.type === 'text' ? part.text || '' : ''))
    .join('\n');
}

/** Sum of estimated tokens across every message's text (prompt side). */
export function estimatePromptTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += messageContentToText(m.content).length;
  }
  return estimateTokensFromChars(chars);
}
