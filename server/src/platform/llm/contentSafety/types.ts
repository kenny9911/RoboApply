// server/src/platform/llm/contentSafety/types.ts
//
// Types and errors of the GoApply content-safety filter (WP-24, CN-L-05).
// Kept apart from index.ts so the provider modules can import them without
// an import cycle; index.ts re-exports everything here.

import type { BrandId } from '../../brand/registry.js';

/** The provider's decision. Only `block` stops the call; `review` is logged and passes. */
export type ContentSafetyVerdict = 'pass' | 'review' | 'block';

/** What an event row records: a verdict, or `error` when the check itself failed (fail-closed). */
export type ContentSafetyEventVerdict = ContentSafetyVerdict | 'error';

export type ContentSafetyStage = 'input' | 'output';

export interface ContentSafetyContext {
  brand: BrandId;
  /** LLM task (copilot, tailor, cover_letter, practice, enrich, …). Stored as the event's `surface`. */
  task: string;
  userId?: string | null;
  /** Correlates the input and output checks of one call. */
  callId?: string;
}

export interface ContentSafetyResult {
  verdict: ContentSafetyVerdict;
  /** Provider labels / rule categories (no raw user text). */
  labels: string[];
  /** Which provider decided ('noop', 'keyword_only', 'aliyun_green', 'keyword_only+aliyun_green', …). */
  provider: string;
  /** Rule ids from the keyword list that matched (ids only, never the terms). */
  ruleIds?: string[];
  /** Why the verdict was reached: 'clean' | 'keyword' | 'provider_label'. */
  reason?: string;
  /** Version of the keyword list that was applied. */
  listVersion?: string;
  /**
   * UTF-16 offset in the checked text of the first hit that decided the
   * verdict. Used only to centre the 200-character event excerpt; never stored.
   */
  hitOffset?: number;
  /**
   * Set when the provider only knows which slice of the text it flagged, not
   * where in the slice (Aliyun on long text without usable RiskWords). Then
   * `hitOffset` is the slice start (UTF-16) and the excerpt starts there, so
   * the event row says the excerpt is approximate. Internal; never returned.
   */
  hitSlice?: ContentSafetyHitSlice;
}

export interface ContentSafetyHitSlice {
  /** 0-based slice number. */
  index: number;
  /** UTF-16 offset of the slice in the checked text. */
  start: number;
  /** Slice length in characters (code points). */
  length: number;
}

/** Per-call options the engine passes to a provider. */
export interface ContentSafetyCheckOptions {
  /** Aborted when the engine's timeout fires; providers pass it to fetch. */
  signal?: AbortSignal;
}

export interface ContentSafetyProvider {
  id: string;
  checkInput(text: string, ctx: ContentSafetyContext, opts?: ContentSafetyCheckOptions): Promise<ContentSafetyResult>;
  checkOutput(text: string, ctx: ContentSafetyContext, opts?: ContentSafetyCheckOptions): Promise<ContentSafetyResult>;
  /**
   * The keyword-list part of this provider, when it has one (keyword_only is
   * its own; aliyun_green mode chains one). The stream guard runs it over the
   * whole released text in finish() as a cheap last check.
   */
  readonly keywordProvider?: ContentSafetyProvider;
}

/**
 * Thrown on a `block` verdict; maps to 422 `content_blocked` through
 * platform/http mapError. The message says plainly what happened: the filter
 * blocked the text, nothing was rewritten.
 */
export class ContentBlockedError extends Error {
  readonly code = 'content_blocked' as const;
  readonly status = 422;
  readonly details: { stage: ContentSafetyStage; labels: string[] };
  constructor(stage: ContentSafetyStage, labels: string[] = []) {
    super(
      stage === 'input'
        ? 'The content-safety filter blocked this request, so it was not sent to the AI.'
        : 'The content-safety filter blocked the AI reply, so it is not shown.',
    );
    this.name = 'ContentBlockedError';
    this.details = { stage, labels };
  }
}

/** Why a check could not produce a verdict. */
export type ContentSafetyFailureCause = 'timeout' | 'provider_error' | 'misconfigured' | 'invalid_result';

/**
 * Fail-closed error: the filter could not decide (provider down, timeout,
 * misconfiguration). Maps to 503 `ai_unavailable` — the AI feature answers
 * "not available right now" and never returns unfiltered output.
 */
export class ContentSafetyUnavailableError extends Error {
  readonly code = 'ai_unavailable' as const;
  readonly status = 503;
  readonly details: { reason: 'content_safety_unavailable'; stage: ContentSafetyStage; cause: ContentSafetyFailureCause };
  constructor(stage: ContentSafetyStage, cause: ContentSafetyFailureCause) {
    super('This AI feature is not available right now because the content-safety check could not run.');
    this.name = 'ContentSafetyUnavailableError';
    this.details = { reason: 'content_safety_unavailable', stage, cause };
  }
}

/** Raised inside providers; the engine turns it into ContentSafetyUnavailableError. */
export class ContentSafetyProviderError extends Error {
  readonly cause_: ContentSafetyFailureCause;
  constructor(message: string, cause: ContentSafetyFailureCause = 'provider_error') {
    super(message);
    this.name = 'ContentSafetyProviderError';
    this.cause_ = cause;
  }
}

const VERDICT_RANK: Record<ContentSafetyVerdict, number> = { pass: 0, review: 1, block: 2 };

/** The stricter of two verdicts. */
export function worstVerdict(a: ContentSafetyVerdict, b: ContentSafetyVerdict): ContentSafetyVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export function isVerdict(value: unknown): value is ContentSafetyVerdict {
  return value === 'pass' || value === 'review' || value === 'block';
}
