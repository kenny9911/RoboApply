// server/src/platform/llm/contentSafety/index.ts — the content-safety surface.
//
// GoApply generative-AI content safety (TASK_PLAN.md WP-24; CN-L-05; CN plan
// C-6). FND-5 created this interface; WP-24 fills it; WP-14's LLMService
// calls it.
//
// Contract for callers (WP-14 and anything else that sends user text to a model):
//   - `checkInput(text, ctx)` before every GoApply LLM call and
//     `checkOutput(text, ctx)` after it (non-streamed), or
//     `createOutputStreamGuard(ctx)` for streamed replies, so no unchecked
//     delta ever reaches the user. RoboApply (`brand: 'roboapply'`) is never
//     checked and never reaches a provider.
//   - `block` → ContentBlockedError → 422 `content_blocked`
//     (`details: { stage, labels }`). The message says plainly that the
//     filter blocked it. Nothing is ever rewritten or masked.
//   - provider error, timeout or misconfiguration → ContentSafetyUnavailableError
//     → 503 `ai_unavailable` (`details.reason = 'content_safety_unavailable'`).
//     Fail closed: never unfiltered output.
//   - `review` passes and is logged.
//   - Every check writes an RAContentSafetyEvent (brand, task, direction,
//     verdict, provider, reason, labels, rule ids, text hash and length; a
//     ≤200-character excerpt only on block/review, with `excerptAnchor`
//     saying whether it is placed on the hit or only on the flagged slice).
//   - The private keyword list refreshes in the background: a slow list
//     host never delays or fails a check once a copy has loaded.
//
// Providers (CN_CONTENT_SAFETY_PROVIDER): `keyword_only` (default; versioned
// built-in list + the private list at CN_SAFETY_KEYWORDS_URL) or
// `aliyun_green` (keyword list first, then Alibaba Cloud Content Moderation
// in a mainland region). CN-1 requires `aliyun_green` — see
// contentSafetyReadiness().

export {
  ContentBlockedError,
  ContentSafetyProviderError,
  ContentSafetyUnavailableError,
  type ContentSafetyCheckOptions,
  type ContentSafetyContext,
  type ContentSafetyEventVerdict,
  type ContentSafetyFailureCause,
  type ContentSafetyHitSlice,
  type ContentSafetyProvider,
  type ContentSafetyResult,
  type ContentSafetyStage,
  type ContentSafetyVerdict,
} from './types.js';

export {
  contentSafetyApplies,
  getContentSafetyProvider,
  noopContentSafetyProvider,
  reloadContentSafetyFromEnv,
  setContentSafetyProvider,
} from './engine.js';

export {
  contentSafetyReadiness,
  resolveContentSafetyConfig,
  type ContentSafetyConfig,
  type ContentSafetyProviderKind,
  type ContentSafetyReadiness,
} from './config.js';

export {
  setContentSafetyEventWriter,
  type ContentSafetyEventRow,
  type ContentSafetyEventWriter,
} from './events.js';

export { createOutputStreamGuard, type OutputStreamGuard, type OutputStreamGuardOptions } from './streamGuard.js';

export { BUILTIN_KEYWORD_LIST } from './builtinKeywords.js';

import { check } from './engine.js';
import type { ContentSafetyContext, ContentSafetyResult } from './types.js';

/** Check a prompt before the LLM call. Throws ContentBlockedError on `block`, ContentSafetyUnavailableError when the check cannot run. */
export function checkInput(text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult> {
  return check('input', text, ctx);
}

/** Check model output before it reaches the user. Throws ContentBlockedError on `block`, ContentSafetyUnavailableError when the check cannot run. */
export function checkOutput(text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult> {
  return check('output', text, ctx);
}
