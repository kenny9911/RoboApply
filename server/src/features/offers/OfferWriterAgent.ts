// server/src/features/offers/OfferWriterAgent.ts — the two AI texts of offer
// comparison (WP-64): a negotiation message the user edits and sends
// themselves, and a plain-language explanation of the trade-offs between
// offers.
//
// The prompt carries only the user's own offer figures, the totals computed
// from them, the posted-range quartiles with N (or the statement that there is
// not enough posted pay), and precomputed differences. No name, no contact
// details, no profile, no notes. The model is told to use no other number;
// numberGuard.ts checks that after the call (the service retries once, then
// refuses). Loaded only after aiAllowed(user) AND the brand's `ai.text`
// capability (zero LLMService calls otherwise).

import { BaseAgent } from '../../agents/BaseAgent.js';
import { getTaskModel, getTaskReasoningEffort } from '../../lib/llm/llmTaskSettings.js';
import { currentBrandPersona } from '../../platform/brand/persona.js';
import type { NegotiationFocus } from './contract.js';

export interface OfferWriterInput {
  mode: 'negotiation' | 'explain';
  locale: string;
  /** Facts block (JSON-ish lines) built by the service; every number allowed in the output is in it. */
  facts: string;
  focus?: NegotiationFocus;
  /** Second attempt: the numbers that were not allowed. */
  retryNote?: string;
}

export interface OfferWriterOutput {
  text: string;
  talkingPoints: string[];
}

function clip(s: unknown, max: number): string {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

export function parseOfferWriterOutput(response: string): OfferWriterOutput {
  if (!response || typeof response !== 'string') return { text: '', talkingPoints: [] };
  const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const candidate of [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate) as Record<string, unknown>;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const points = Array.isArray(v.talkingPoints) ? v.talkingPoints.map((p) => clip(p, 400)).filter(Boolean).slice(0, 6) : [];
      return { text: clip(v.text, 4_000), talkingPoints: points };
    } catch {
      /* next candidate */
    }
  }
  return { text: '', talkingPoints: [] };
}

const FOCUS_RULES: Record<NegotiationFocus, string> = {
  overall: 'Ask whether there is room to improve the overall package.',
  base: 'Ask about a higher base salary.',
  signing_bonus: 'Ask about a signing bonus (or a larger one).',
  start_date: 'Ask about a different start date.',
  equity: 'Ask for more detail on the equity, or more of it.',
};

export class OfferWriterAgent extends BaseAgent<OfferWriterInput, OfferWriterOutput> {
  constructor() {
    super('OfferWriterAgent');
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 2_500;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('writing');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  /** The message is the user's artifact: write it in the requested language. */
  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('offer helper')}. You help ONE job seeker think about job offers they received. You never contact anyone; the person reads, edits and sends anything you write themselves.

## Hard rules
1. Use ONLY the numbers in FACTS. Do not write any other number: no "typical" or "market" salary, no percentages you computed yourself, no ranges from memory, no multiples ("1.5x", "两倍"). Write every number in Arabic digits (0-9), never in words or Chinese numerals ("120,000", not "one hundred twenty thousand" or "十二万"). If FACTS says there is not enough posted pay data, do not mention market pay at all.
2. When you mention posted pay, say it comes from job postings and name how many postings (the N in FACTS).
3. Never claim the person has another offer unless FACTS lists it. Never invent a deadline, a recruiter name, a company policy or a benefit.
4. Plain, polite, specific. No threats, no pressure tactics, no exclamation marks.
5. No name, email address or phone number; no signature line (the person adds their own).
6. Totals in FACTS are before tax and exclude what FACTS marks "not counted" (equity is never valued).

## Output (strict JSON only, no prose, no code fences)
For a negotiation message:
{ "text": "<the message, 90–180 words (Chinese: 150–300 characters), greeting to closing>", "talkingPoints": ["<short point>", "..."] }
For an explanation:
{ "text": "<3–6 short paragraphs comparing the offers: what each offers more of, what is not counted, what the person may want to ask>", "talkingPoints": [] }`;
  }

  protected formatInput(input: OfferWriterInput, locale?: string): string {
    const blocks: string[] = [];
    const reminder = this.outputLanguageReminder(locale ?? input.locale);
    if (reminder) blocks.push(reminder);
    blocks.push(`## FACTS\n${input.facts.slice(0, 8_000)}`);
    if (input.mode === 'negotiation') {
      blocks.push(`## TASK\nWrite a short negotiation message to the employer of the FOCUS OFFER. ${FOCUS_RULES[input.focus ?? 'overall']} Thank them for the offer first. Add 2–4 talking points for a call.`);
    } else {
      blocks.push('## TASK\nExplain the trade-offs between the offers in FACTS. Do not pick a winner for the person; say what each one is stronger on.');
    }
    if (input.retryNote) blocks.push(input.retryNote);
    blocks.push('Output ONLY the JSON.');
    return blocks.join('\n\n');
  }

  protected parseOutput(response: string): OfferWriterOutput {
    return parseOfferWriterOutput(response);
  }

  async run(input: OfferWriterInput, options: { requestId?: string; signal?: AbortSignal } = {}): Promise<OfferWriterOutput> {
    return this.execute(input, undefined, options.requestId, input.locale, getTaskModel('writing'), options.signal);
  }
}
