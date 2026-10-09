// server/src/platform/llm/index.ts — public surface of the per-brand LLM layer (WP-14).
//
// New code (server/src/features/**) imports LLM routing, policy, streaming and
// the content-safety seam from here:
//
//   import { llmService, AiUnavailableError, type LlmToolDefinition } from '../../platform/llm/index.js';
//
//   const round = await llmService.streamChatWithTools(messages, {
//     task: 'copilot', tools, signal, maxTokens: 900, onDelta, onToolCall,
//   });
//
// Every call is routed for the brand of the current unit of work (request,
// or runWithBrand in crons/workers) — pass `brand` explicitly when one job
// handles users of both brands:
//   - GoApply: CN_LLM_* only, domestic vendors only, no BYOK, content safety
//     on input and output (fail closed); no model configured → 503
//     ai_unavailable.
//   - RoboApply: unprefixed LLM_*; a prompt with user data never reaches a
//     mainland-China endpoint (primary or fallback), and OpenRouter is told
//     to skip its mainland upstreams.
// A call with no brand at all routes as this deployment's single brand
// (BRAND_LOCK / ALLOWED_BRANDS); in production on a deployment that also
// serves GoApply it throws BrandContextMissingError instead of guessing.
//
// Tool loops: after a round that asked for tools, append
//   { role: 'assistant', content: round.content || null,
//     toolCalls: round.toolCalls, reasoningContent: round.reasoningContent }
// then one { role: 'tool', toolCallId, content } per result. DeepSeek and
// Kimi thinking modes reject the next round without `reasoningContent`.
// On GoApply, streamed text and tool-call arguments both pass the
// content-safety check before they reach onDelta / onToolCall.
// Callers still gate on `aiAllowed(user)` (platform/consent) before calling.

export {
  GOAPPLY_DIRECT_PROVIDERS,
  LlmBrandPolicyError,
  MAINLAND_LLM_HOST_SUFFIXES,
  PROVIDER_DEFAULT_HOSTS,
  assertLlmRoute,
  checkLlmRoute,
  extraDomesticHosts,
  filterLlmChain,
  hostOf,
  isGoApplyDirectProvider,
  isMainlandLlmHost,
  routeHost,
} from './brandPolicy.js';
export type { EnvLike, LlmPolicyCode, LlmPolicyDecision, LlmPolicyInput, LlmRoute } from './brandPolicy.js';

export {
  OPENROUTER_MAINLAND_UPSTREAMS,
  PROVIDER_DEFAULT_BASE_URLS,
  assertLlmEgress,
  checkLlmEgress,
  effectiveLlmBaseUrl,
  openRouterIgnoredUpstreams,
  openRouterProviderPreferences,
} from './egressPolicy.js';
export type { LlmEgressDecision, LlmEgressInput } from './egressPolicy.js';

export {
  ContentBlockedError,
  checkInput,
  checkOutput,
  contentSafetyApplies,
  getContentSafetyProvider,
  setContentSafetyProvider,
} from './contentSafety/index.js';
export type {
  ContentSafetyContext,
  ContentSafetyProvider,
  ContentSafetyResult,
  ContentSafetyVerdict,
} from './contentSafety/index.js';

export {
  AiUnavailableError,
  LlmStreamInterruptedError,
  ToolsUnsupportedError,
  isAiUnavailableError,
} from '../../services/llm/errors.js';
export type { AiUnavailableReason } from '../../services/llm/errors.js';

export { LLMService, assertCopilotModelSupportsTools, llmService } from '../../services/llm/LLMService.js';
export type {
  CopilotToolsCheck,
  LLMChatResult,
  LLMServiceOptions,
  LlmRouteExplanation,
  StreamChatWithToolsOptions,
  StreamChatWithToolsResult,
} from '../../services/llm/LLMService.js';

export { TOOL_STREAMING_PROVIDERS, supportsToolStreaming } from '../../services/llm/toolStreaming.js';
export type {
  AssistantToolCallMessage,
  LlmToolCall,
  LlmToolDefinition,
  StreamFinishReason,
  ToolChatMessage,
  ToolChoice,
  ToolResultMessage,
} from '../../services/llm/toolStreaming.js';

export { contextlessLlmBrand, requireLlmCallBrand } from '../../lib/llm/llmBrand.js';
export type { ContextlessLlmBrand } from '../../lib/llm/llmBrand.js';
export { LLM_TASKS, getTaskModel, getTaskModelOrDefault, isLlmTask } from '../../lib/llm/llmTaskSettings.js';
export type { LlmTask } from '../../lib/llm/llmTaskSettings.js';
export { defaultPromptLocale, resolvePromptLocale } from '../../lib/llm/promptLocale.js';
export {
  isOffPeak,
  nextOffPeakStart,
  offPeakConfig,
  offPeakDecision,
  parseOffPeakWindows,
} from '../../lib/llm/offPeak.js';
export type { OffPeakDecision, OffPeakWindow } from '../../lib/llm/offPeak.js';
