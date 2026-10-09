// server/src/platform/llm/contentSafety/index.ts — the content-safety interface (FND-5).
//
// GoApply generative-AI content safety (TASK_PLAN.md WP-24; CN-L-05).
// WP-14's LLMService calls `checkInput` before and `checkOutput` after every
// GoApply LLM call; RoboApply is never checked. WP-24 replaces the no-op
// provider with `keywordOnly` (versioned keyword list) and `aliyunGreen`
// (`CN_CONTENT_SAFETY_PROVIDER=aliyun_green|keyword_only`, `ALIYUN_GREEN_*`),
// writes `RAContentSafetyEvent`, throws `ContentBlockedError` (→ 422
// `content_blocked`) and FAILS CLOSED when the provider errors (GoApply AI
// answers 503 `ai_unavailable`, never unfiltered output).
//
// Until WP-24, the provider is a no-op that passes everything. That is safe
// only because GoApply AI is hidden unless a domestic model is configured
// (`ai.text`), and WP-24 lands in the same wave as WP-14's wiring.

import type { BrandId } from '../../brand/registry.js';

export type ContentSafetyVerdict = 'pass' | 'review' | 'block';

export interface ContentSafetyContext {
  brand: BrandId;
  /** LLM task (copilot, tailor, cover_letter, practice, enrich, …). */
  task: string;
  userId?: string | null;
  /** Correlates the input and output checks of one call. */
  callId?: string;
}

export interface ContentSafetyResult {
  verdict: ContentSafetyVerdict;
  /** Provider labels / rule ids (no raw user text). */
  labels: string[];
  /** Which provider decided ('noop' until WP-24). */
  provider: string;
}

export interface ContentSafetyProvider {
  id: string;
  checkInput(text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult>;
  checkOutput(text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult>;
}

/** Thrown on a `block` verdict; maps to 422 `content_blocked` through platform/http mapError. */
export class ContentBlockedError extends Error {
  readonly code = 'content_blocked' as const;
  readonly status = 422;
  readonly details: { stage: 'input' | 'output'; labels: string[] };
  constructor(stage: 'input' | 'output', labels: string[] = []) {
    super(stage === 'input' ? 'This request cannot be processed.' : 'This reply cannot be shown.');
    this.name = 'ContentBlockedError';
    this.details = { stage, labels };
  }
}

const PASS = (provider: string): ContentSafetyResult => ({ verdict: 'pass', labels: [], provider });

/** The FND-5 placeholder: passes everything. */
export const noopContentSafetyProvider: ContentSafetyProvider = {
  id: 'noop',
  async checkInput() {
    return PASS('noop');
  },
  async checkOutput() {
    return PASS('noop');
  },
};

let provider: ContentSafetyProvider = noopContentSafetyProvider;

/** WP-24 installs its provider here (and tests install fakes). Pass null to restore the no-op. */
export function setContentSafetyProvider(next: ContentSafetyProvider | null): void {
  provider = next ?? noopContentSafetyProvider;
}

export function getContentSafetyProvider(): ContentSafetyProvider {
  return provider;
}

/** Brands whose LLM calls are checked (R-13: GoApply only). */
export function contentSafetyApplies(brand: BrandId): boolean {
  return brand === 'goapply';
}

async function check(stage: 'input' | 'output', text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult> {
  if (!contentSafetyApplies(ctx.brand)) return PASS('not_applicable');
  const result = stage === 'input' ? await provider.checkInput(text, ctx) : await provider.checkOutput(text, ctx);
  if (result.verdict === 'block') throw new ContentBlockedError(stage, result.labels);
  return result;
}

/** Check a prompt before the LLM call. Throws ContentBlockedError on `block`. */
export function checkInput(text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult> {
  return check('input', text, ctx);
}

/** Check model output before it reaches the user. Throws ContentBlockedError on `block`. */
export function checkOutput(text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult> {
  return check('output', text, ctx);
}
