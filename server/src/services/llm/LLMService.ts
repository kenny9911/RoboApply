import { Message, LLMOptions, LLMProvider, LLMResponse } from '../../types/index.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { OpenRouterProvider } from './OpenRouterProvider.js';
import { GoogleProvider } from './GoogleProvider.js';
import { KimiProvider } from './KimiProvider.js';
import { DeepSeekProvider } from './DeepSeekProvider.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { generateRequestId, logger } from '../LoggerService.js';
import { getCurrentUserId, getCurrentRequestId, setByokInRequest } from '../../lib/requestContext.js';
import {
  isByokAllowedForBrand,
  resolveByok,
  touchByok,
  type ByokProvider,
  type ResolvedByok,
} from '../../lib/byokService.js';
import { resolveProviderCredential, type ProviderTuning } from '../../lib/llm/systemCredentials.js';
import {
  getFallbackModelSetting,
  getLlmRoutingDefaults,
  getRetryAttempts,
  getRetryBaseMs,
  getRetryMaxMs,
  resolveModelKey,
  type LlmSettingSource,
} from '../../lib/llm/llmModels.js';
import { contextlessLlmBrand, llmCallBrand, requireLlmCallBrand } from '../../lib/llm/llmBrand.js';
import { getTaskModel, getTaskModelOrDefault, type LlmTask } from '../../lib/llm/llmTaskSettings.js';
import { isTransientLLMError } from './withRetry.js';
import { normalizeProviderType, resolveSelectorRoute, splitSelectorPrefix, stripProviderPrefix } from './providerPrefixes.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { allowedBrands } from '../../platform/brand/runtime.js';
import { LlmBrandPolicyError, llmDomesticOnlyApplies } from '../../platform/llm/brandPolicy.js';
import { checkLlmEgress, type LlmEgressDecision } from '../../platform/llm/egressPolicy.js';
import {
  ContentBlockedError,
  checkInput as contentSafetyCheckInput,
  checkOutput as contentSafetyCheckOutput,
  contentSafetyApplies,
  createOutputStreamGuard,
  type ContentSafetyContext,
  type OutputStreamGuard,
} from '../../platform/llm/contentSafety/index.js';
import { AiUnavailableError, LlmStreamInterruptedError, ToolsUnsupportedError } from './errors.js';
import { DOMESTIC_VENDORS, isDomesticVendor } from './domesticVendors.js';
import { estimatePromptTokens, estimateTokensFromText } from './tokenEstimate.js';
import {
  buildStreamParams,
  createStreamingClient,
  runStreamRound,
  supportsToolStreaming,
  toLoggableMessages,
  toolMessageText,
  type ChatCompletionsClient,
  type LlmToolCall,
  type LlmToolDefinition,
  type StreamFinishReason,
  type StreamRoundResult,
  type ToolChatMessage,
  type ToolChoice,
} from './toolStreaming.js';
import {
  AUTO_FALLBACK_PREFERENCE,
  CIRCUIT_OPEN_MS,
  LLMUnavailableError,
  MISSING_CREDENTIAL_FLAG,
  classifyCredentialFailure,
  credentialFingerprint,
  errorHttpStatus,
  fallbackMaxTokens,
  getOpenCircuit,
  isAutoFallbackEnabled,
  markCircuitBypassLogged,
  noteAutoFallbackChoice,
  openCircuit,
  type CredentialFailureKind,
} from './fallbackRouting.js';
import type { LLMUsageInfo, ProviderExtra, ReasoningEffort } from '../../types/index.js';

/**
 * Options for one LLMService call: the provider-level LLMOptions plus the
 * per-brand routing inputs (WP-14).
 */
export interface LLMServiceOptions extends LLMOptions {
  /**
   * Pin the brand of this call. Default: the brand of the current unit of
   * work (request / runWithBrand). Crons and workers that process users of
   * both brands must pass it (or wrap the work in runWithBrand).
   */
  brand?: BrandId;
  /** LLM task, for content-safety events and logs ('copilot', 'tailor', …). */
  task?: LlmTask | string;
  /**
   * Whether the prompt carries user data (default true). Only a RoboApply
   * prompt with NO user data may reach a mainland-China endpoint. GoApply may
   * use mainland endpoints for any prompt, and only those when the
   * domestic-only wall is on (CN_LLM_DOMESTIC_ONLY).
   */
  carriesUserData?: boolean;
}

/** Options for streamChatWithTools (ARCHITECTURE.md §5.1). */
export interface StreamChatWithToolsOptions {
  tools: readonly LlmToolDefinition[];
  /** The task whose model to use (`copilot` for the Assistant). */
  task: LlmTask;
  signal?: AbortSignal;
  /** Answer budget per round (reasoning headroom is added for thinking modes). */
  maxTokens?: number;
  reasoningMaxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  thinkingMode?: 'enabled' | 'disabled';
  toolChoice?: ToolChoice;
  /** Explicit model selector (overrides the task model). */
  model?: string;
  brand?: BrandId;
  carriesUserData?: boolean;
  requestId?: string;
  /** Text as it streams (on GoApply only after the content-safety check passed it). */
  onDelta?: (text: string) => void;
  /** Each completed tool call, in order, when the round ends. */
  onToolCall?: (call: LlmToolCall) => void;
  /** Test seam: build the SDK client (default: the OpenAI SDK). */
  clientFactory?: (providerType: string, cred: { apiKey: string; baseUrl?: string | null; proxyKey?: string; timeoutMs?: number }) => ChatCompletionsClient;
}

export interface StreamChatWithToolsResult {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: StreamFinishReason;
  usage: LLMUsageInfo;
  model: string;
  provider: string;
  /**
   * The round's thinking text, when the provider streamed one. Never shown to
   * the user. When the round asked for tools, copy it onto the next
   * AssistantToolCallMessage (`reasoningContent`): DeepSeek and Kimi thinking
   * modes reject the following round without it.
   */
  reasoningContent?: string;
}

/** What a task resolves to for a brand, without calling anything (verify script, startup check). */
export interface LlmRouteExplanation {
  brand: BrandId;
  task: LlmTask | 'default' | 'fallback';
  /** The profile the brand runs on (`effectiveLlmProfile`): GoApply is `global` on the shared stack. */
  profile?: 'global' | 'domestic_cn';
  selector: string | null;
  /**
   * Where the selector comes from: the brand's own admin override or variable
   * (`override`, `env`), or the shared stack GoApply falls back to (`shared`).
   */
  source?: LlmSettingSource;
  /**
   * The shared selector of this task that the domestic-only wall set aside
   * for the brand (it names no mainland vendor). It is not used: the task
   * runs on the brand's own default model, or has none.
   */
  sharedWalledOff?: string;
  /** True when the task has no model of its own and uses the brand default. */
  inheritsDefault: boolean;
  providerType: string | null;
  model: string | null;
  baseUrl: string | null;
  host: string | null;
  hasKey: boolean;
  allowed: boolean;
  policyCode?: string;
  reason?: string;
  toolsSupported: boolean;
}

/** chatWithUsage() result — content plus the billed token usage + resolved model. */
export interface LLMChatResult {
  content: string;
  usage: LLMResponse['usage'];
  model: string;
}


// Dedupe the "stripped redundant routing prefix" log. `normalizeModel` runs on
// EVERY chat() call (config is resolved fresh per call for hot-reload), so a
// statically-configured model like `openrouter/anthropic/claude-opus-4-8` while
// LLM_PROVIDER=openrouter would otherwise emit an identical line on every call
// AND every retry — noise that reads like the router fumbling/​retrying when it
// is just quietly normalizing. Log each unique (model → provider) once.
const loggedPrefixStrips = new Set<string>();

let warnedMissingBrand = false;

/** One resolved fallback hop. */
interface FallbackCandidate {
  providerType: string;
  model: string;
  /** The selector as configured, for logs. */
  selector: string;
  source: 'configured' | 'auto';
}

/** Why the call is being rerouted. */
type FallbackReason = CredentialFailureKind | 'circuit_open' | 'transient';

/**
 * Map an LLMService provider type ('kimi', 'openai', etc.) to the BYOK
 * provider key persisted in `UserLLMKey.provider`. The BYOK catalog
 * uses 'moonshot' (the company); the LLM stack still uses 'kimi'
 * historically. Identity for everything else.
 */
function llmProviderToByokProvider(providerType: string): ByokProvider | null {
  const lower = providerType.toLowerCase();
  if (lower === 'kimi' || lower === 'moonshot') return 'moonshot';
  if (
    lower === 'openai' ||
    lower === 'anthropic' ||
    lower === 'google' ||
    lower === 'deepseek' ||
    lower === 'minimax' ||
    lower === 'openrouter' ||
    lower === 'ollama' ||
    lower === 'newapi'
  ) {
    return lower as ByokProvider;
  }
  return null;
}

export class LLMService {
  // The default provider + model are resolved FRESH on every chat() call via
  // resolveDefaults() — NOT cached on the instance — so an admin changing the
  // DB-backed default takes effect within ~1s without a redeploy. See
  // docs/llm-settings-db/.
  /**
   * Resolve default routing for a brand (lib/llm/llmModels.ts
   * getLlmRoutingDefaults: DB override ?? env, per key, GoApply falling back
   * to the shared stack). Model selection never lives in code. On the global
   * profile (RoboApply, and GoApply with no provider of its own) the provider
   * mode falls back to the historical OpenRouter mode. On the domestic profile
   * there is no default provider: a bare model id with no provider of
   * GoApply's own cannot be routed and the call answers ai_unavailable.
   * Behind the domestic-only wall the shared stack is a fallback only for
   * values that name a mainland vendor, on either profile.
   */
  private resolveDefaults(brand: ProductBrand = this.callBrand()): { providerMode: string; model?: string } {
    const defaults = getLlmRoutingDefaults(brand.id);
    return { providerMode: defaults.providerMode, model: defaults.model };
  }

  /**
   * A call with no model or no route is "AI unavailable" (503), not an
   * internal error, when that is the state an operator chose: GoApply runs on
   * a provider of its own (the domestic profile), or the domestic-only wall
   * holds and GoApply has no mainland model for the call (the shared model is
   * not a fallback behind the wall).
   */
  private missingModelIsUnavailable(brand: ProductBrand): boolean {
    return brand.llmProfile === 'domestic_cn' || llmDomesticOnlyApplies(brand);
  }

  /** Operator-facing detail for a missing model or route (logs only). */
  private missingModelDetail(brand: ProductBrand, what: string): string {
    return llmDomesticOnlyApplies(brand)
      ? `${brand.name}: ${what}. The domestic-only wall is on (CN_LLM_DOMESTIC_ONLY), so the shared model is not used; set CN_LLM_MODEL (and CN_LLM_PROVIDER) or the task's CN_LLM_<TASK>_MODEL to a mainland model.`
      : `${brand.name}: ${what}.`;
  }

  /**
   * The brand of a call: the explicit option, else the current unit of work,
   * else this deployment's single brand (BRAND_LOCK / ALLOWED_BRANDS), else
   * the default (RoboApply; legacy crons and scripts). The default is logged
   * once: a call made for a GoApply user must run in that user's brand (pass
   * `brand` or use runWithBrand), or its prompt skips the content-safety
   * filter. With `sending` (a prompt is about to leave), production refuses
   * the default (BrandContextMissingError) only when a wrong guess could cross
   * a wall an operator chose: GoApply has an LLM stack of its own, or
   * CN_LLM_DOMESTIC_ONLY is on (lib/llm/llmBrand.ts requireLlmCallBrand).
   *
   * The entry returned is the LLM layer's view of the brand (llmCallBrand):
   * `llmProfile` is the EFFECTIVE profile, so GoApply with no domestic
   * provider is `global` and every profile check below treats it as RoboApply
   * is treated (same default provider, selector dialect and fallback chain),
   * and `llmEnvPrefix` is '' then. The id stays the brand's own, so the route
   * policy, content safety and logs still see GoApply.
   */
  private callBrand(explicit?: BrandId, sending = false): ProductBrand {
    if (explicit) return llmCallBrand(explicit);
    const resolved = sending ? requireLlmCallBrand() : contextlessLlmBrand();
    if (resolved.source === 'default' && !warnedMissingBrand) {
      warnedMissingBrand = true;
      logger.warn('LLM_POLICY', 'LLM call without a brand context; routing as the default brand. Pass `brand` or wrap the work in runWithBrand().');
    }
    return llmCallBrand(resolved.brandId);
  }

  private getConfiguredFallbackModel(primaryModel: string, brand: ProductBrand): string | null {
    // DB override (admin) wins, then env LLM_FALLBACK_MODEL. GoApply reads its
    // own override (CN_LLM_FALLBACK_MODEL) first and otherwise the shared one.
    // There is no source-level model substitution: operators own both model
    // choices.
    const configured = (getFallbackModelSetting(brand.id) || '').trim();
    if (configured && configured !== primaryModel) {
      return configured;
    }
    return null;
  }

  private shouldTryFallback(error: unknown): boolean {
    // Auth/billing failures (401/402/403, "User not found.", "invalid api key",
    // "insufficient credits", an empty Anthropic balance reported as 400...)
    // can never succeed on a retry of the same key, so they always reroute.
    // Matched on the provider's status where it exposes one, not only on text.
    if (classifyCredentialFailure(error)) return true;

    const message = String(
      (error && typeof error === 'object' && 'message' in error)
        ? (error as { message?: string }).message
        : error
    ).toLowerCase();

    return (
      message.includes('503') ||
      message.includes('service unavailable') ||
      message.includes('high demand') ||
      message.includes('fetch failed') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('429') ||
      message.includes('too many requests') ||
      message.includes('quota exceeded') ||
      message.includes('rate limit') ||
      // OpenRouter returns 200 with no content when the model is invalid,
      // overloaded, or content-filtered. Treat as transient → try fallback.
      message.includes('no content')
    );
  }

  /**
   * Strip a leading provider-routing prefix from the model ID when it matches
   * the active provider.
   *
   *   "google/gemini-3-flash-preview"           + provider=google     → "gemini-3-flash-preview"
   *   "openrouter/deepseek/deepseek-v4-pro"     + provider=openrouter → "deepseek/deepseek-v4-pro"
   *   "google/gemini-3-flash-preview"           + provider=openrouter → unchanged (real OpenRouter model id)
   *
   * The first segment is treated as a routing hint; everything after the first
   * slash is the model id the upstream provider actually expects.
   */
  private normalizeModel(model: string, provider: string): string {
    const modelName = stripProviderPrefix(model, provider);
    if (modelName !== model) this.noteStrippedPrefix(model, modelName, provider);
    return modelName;
  }

  /**
   * Expected + benign: the model id carries an explicit `<provider>/…` routing
   * hint that matches the provider we're already calling, so the redundant
   * prefix is stripped to the id the upstream API expects. Not an error and
   * not a retry — logged once per unique (model → provider) to keep it out of
   * the per-call/per-retry stream.
   */
  private noteStrippedPrefix(model: string, modelName: string, provider: string): void {
    const key = `${model}=>${provider.toLowerCase()}`;
    if (loggedPrefixStrips.has(key)) return;
    loggedPrefixStrips.add(key);
    logger.debug('LLM_SERVICE', `Stripped redundant "${model.substring(0, model.indexOf('/'))}/" routing prefix: "${model}" → "${modelName}" (provider already "${provider}")`);
  }

  /**
   * In 'direct' mode, parse "provider/model" to resolve which provider to use.
   * Returns null if the prefix is not a known direct provider.
   */
  private resolveDirectModel(
    rawModel: string,
    brand: ProductBrand = this.callBrand(),
  ): { providerType: string; model: string } | null {
    return splitSelectorPrefix(rawModel, brand.llmProfile);
  }

  /** Resolve a configured selector with the same rules for primary and fallback
   * calls (providerPrefixes.ts resolveSelectorRoute, the one copy of the rule).
   * Recognized provider prefixes always pin the native provider; an explicit
   * openrouter/ prefix keeps the vendor slug behind OpenRouter. */
  private resolvePlatformRoute(
    rawModel: string,
    providerMode: string,
    defaultModel?: string,
    explicitProvider?: string,
    brand: ProductBrand = this.callBrand(),
  ): { providerType: string; model: string } {
    if (explicitProvider) {
      const providerType = normalizeProviderType(explicitProvider);
      return {
        providerType,
        model: this.normalizeModel(this.normalizeModel(rawModel, explicitProvider), providerType),
      };
    }

    // A recognized outer prefix is an explicit route, including openrouter/...;
    // it wins even when LLM_PROVIDER names a different single provider. With no
    // provider mode at all (the domestic profile without a provider of its
    // own) a bare model id has no route: the empty provider type is refused as
    // missing_route.
    const route = resolveSelectorRoute(rawModel, providerMode, defaultModel, brand.llmProfile);
    if (route.providerType && route.providerType === providerMode && route.model !== rawModel && !this.resolveDirectModel(rawModel, brand)) {
      this.noteStrippedPrefix(rawModel, route.model, providerMode);
    }
    return route;
  }

  /* ── Per-brand policy (D5; platform/llm/brandPolicy.ts) ────────────────── */

  /** Credential base URL of a provider (system DB / env), without throwing. */
  private credentialBaseUrl(providerType: string): string | null {
    if (!providerType) return null;
    try {
      return resolveProviderCredential(providerType).baseUrl ?? null;
    } catch {
      return null;
    }
  }

  /** Decide one route (primary or fallback) on its real endpoint host. */
  private routeDecision(
    brand: ProductBrand,
    providerType: string,
    opts: { carriesUserData?: boolean; byok?: boolean; baseUrl?: string | null; model?: string } = {},
  ): LlmEgressDecision {
    return checkLlmEgress({
      brand,
      provider: providerType,
      credentialBaseUrl: opts.baseUrl !== undefined ? opts.baseUrl : this.credentialBaseUrl(providerType),
      model: opts.model ?? null,
      byok: opts.byok,
      carriesUserData: opts.carriesUserData,
    });
  }

  /**
   * Refuse the primary route when the brand may not use it. On the domestic
   * profile (GoApply with a stack of its own), and behind the domestic-only
   * wall, a call with no route at all is "AI unavailable" (503); any other
   * refusal is a configuration error (LlmBrandPolicyError, 500) that is logged
   * and NEVER re-routed to another provider.
   */
  private assertPrimaryRoute(
    brand: ProductBrand,
    route: { providerType: string; model: string },
    carriesUserData: boolean | undefined,
    requestId: string,
  ): void {
    if (!route.providerType && this.missingModelIsUnavailable(brand)) {
      throw new AiUnavailableError(
        'no_model',
        this.missingModelDetail(brand, `no provider of its own is set (CN_LLM_PROVIDER) and "${route.model}" has no provider prefix`),
      );
    }
    const decision = this.routeDecision(brand, route.providerType, { carriesUserData, model: route.model });
    if (decision.allowed) return;
    const error = new LlmBrandPolicyError(decision.code ?? 'missing_route', decision.reason ?? 'Route refused.', decision.host);
    logger.error('LLM_POLICY', `Refused LLM route for ${brand.id}: ${route.providerType || '(none)'}/${route.model}`, {
      brand: brand.id,
      provider: route.providerType || null,
      model: route.model,
      host: decision.host,
      policyCode: error.policyCode,
      reason: error.reason,
    }, requestId);
    throw error;
  }

  /** Text a content-safety input check covers: user turns first, then the rest. */
  private safetyInputText(messages: ReadonlyArray<Message | ToolChatMessage>): string {
    const parts = (role: string) =>
      messages.filter((m) => (role === 'user' ? m.role === 'user' : m.role !== 'user')).map((m) => toolMessageText(m as ToolChatMessage));
    return [...parts('user'), ...parts('other')].filter(Boolean).join('\n');
  }

  /**
   * Run one content-safety check (GoApply only; RoboApply is never checked).
   * A block propagates as ContentBlockedError (422). Any other failure of the
   * checker fails CLOSED as ai_unavailable (503): GoApply never returns
   * unchecked output.
   */
  private async contentSafety(
    stage: 'input' | 'output',
    text: string,
    ctx: { brand: ProductBrand; task?: string; requestId: string; callId: string },
  ): Promise<void> {
    if (!contentSafetyApplies(ctx.brand.id)) return;
    const safetyCtx = this.safetyContext(ctx);
    await this.safetyVerdict(stage, ctx, () =>
      stage === 'input' ? contentSafetyCheckInput(text, safetyCtx) : contentSafetyCheckOutput(text, safetyCtx),
    );
  }

  private safetyContext(ctx: { brand: ProductBrand; task?: string; callId: string }): ContentSafetyContext {
    return { brand: ctx.brand.id, task: ctx.task || 'unspecified', userId: getCurrentUserId() ?? null, callId: ctx.callId };
  }

  /**
   * Run a content-safety step and map its failures: a block propagates as
   * ContentBlockedError (422); anything else fails CLOSED as ai_unavailable
   * (503 `content_safety_unavailable`).
   */
  private async safetyVerdict<T>(
    stage: 'input' | 'output',
    ctx: { brand: ProductBrand; task?: string; requestId: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const task = ctx.task || 'unspecified';
    try {
      return await run();
    } catch (err) {
      if (err instanceof ContentBlockedError) {
        logger.warn('LLM_SAFETY', `Content safety blocked the ${stage} of a ${ctx.brand.id} ${task} call`, {
          brand: ctx.brand.id,
          task,
          stage,
          labels: err.details.labels,
        }, ctx.requestId);
        throw err;
      }
      logger.error('LLM_SAFETY', `Content-safety check failed (${stage}); failing closed`, {
        brand: ctx.brand.id,
        task,
        error: err instanceof Error ? err.message : String(err),
      }, ctx.requestId);
      throw new AiUnavailableError('content_safety_unavailable', undefined, { cause: err });
    }
  }

  /** Platform (system DB → env) credential presence + fingerprint for one provider type. */
  private platformCredential(providerType: string): { hasKey: boolean; fingerprint: string } {
    const lower = providerType.toLowerCase();
    let apiKey = '';
    try {
      apiKey = resolveProviderCredential(lower).apiKey || '';
    } catch {
      apiKey = '';
    }
    return {
      hasKey: lower === 'ollama' || !!apiKey.trim(),
      fingerprint: credentialFingerprint(apiKey),
    };
  }

  /**
   * The ordered fallback hops for one failed (or circuit-open) primary call.
   *
   * 1. The configured fallback (admin DB override ?? LLM_FALLBACK_MODEL), for
   *    every fallback-worthy failure, exactly as before.
   * 2. On a CREDENTIAL failure only (auth, billing, missing key, open
   *    circuit), the auto-selected direct routes from AUTO_FALLBACK_PREFERENCE.
   *    A transient blip (429/5xx/timeout) without a configured fallback still
   *    goes back to withLLMRetry on the primary, so a rate-limit hiccup never
   *    silently switches model.
   *
   * Hops are skipped when their provider has no key, has an open circuit, or
   * is the provider whose credentials just failed.
   */
  private buildFallbackCandidates(input: {
    primaryModel: string;
    primaryProviderType: string;
    providerMode: string;
    defaultModel?: string;
    credentialFailure: boolean;
    brand: ProductBrand;
    carriesUserData?: boolean;
    /** Keep only hops whose provider can stream tool calls. */
    requireTools?: boolean;
  }): FallbackCandidate[] {
    const primaryType = input.primaryProviderType.toLowerCase();
    const out: FallbackCandidate[] = [];
    const seen = new Set<string>([`${primaryType}::${input.primaryModel}`]);
    const usable = (providerType: string): boolean => {
      const lower = providerType.toLowerCase();
      if (input.credentialFailure && lower === primaryType) return false;
      if (input.requireTools && !supportsToolStreaming(lower)) return false;
      // The brand policy filters the chain: a RoboApply prompt with user data
      // drops mainland endpoints (Wave 0's auto list includes
      // deepseek-v4-flash); GoApply keeps every hop, and only the domestic ones
      // behind the domestic-only wall.
      if (!this.routeDecision(input.brand, lower, { carriesUserData: input.carriesUserData }).allowed) return false;
      const cred = this.platformCredential(lower);
      if (!cred.hasKey) return false;
      return !getOpenCircuit(lower, cred.fingerprint);
    };

    const configured = this.getConfiguredFallbackModel(input.primaryModel, input.brand);
    if (configured) {
      const route = this.resolvePlatformRoute(configured, input.providerMode, input.defaultModel, undefined, input.brand);
      const key = `${route.providerType.toLowerCase()}::${route.model}`;
      if (route.providerType && !seen.has(key) && usable(route.providerType)) {
        seen.add(key);
        out.push({ ...route, selector: configured, source: 'configured' });
      }
    }

    if (input.credentialFailure && isAutoFallbackEnabled()) {
      const auto: FallbackCandidate[] = [];
      for (const selector of AUTO_FALLBACK_PREFERENCE) {
        const route = this.resolveDirectModel(selector, input.brand);
        // Auto-selection is direct-provider only: never openrouter.
        if (!route || route.providerType === 'openrouter') continue;
        const key = `${route.providerType}::${route.model}`;
        if (seen.has(key) || !usable(route.providerType)) continue;
        seen.add(key);
        auto.push({ ...route, selector, source: 'auto' });
      }
      const summary = auto.map((c) => c.selector).join(' → ') || '(none)';
      if (noteAutoFallbackChoice(`${input.brand.id}:${summary}`)) {
        logger.warn('LLM_SERVICE', `Auto-selected LLM fallback route: ${summary}`, {
          brand: input.brand.id,
          primaryProvider: primaryType,
          configuredFallback: configured ?? null,
          candidates: auto.map((c) => `${c.providerType}/${c.model}`),
        });
      }
      out.push(...auto);
    }
    return out;
  }

  /** The auto-fallback providers this brand may use (for error messages). */
  private autoFallbackProvidersFor(brand: ProductBrand): string[] {
    return AUTO_FALLBACK_PREFERENCE
      .map((selector) => this.resolveDirectModel(selector, brand)?.providerType ?? selector.split('/')[0])
      .filter((provider) => this.routeDecision(brand, provider).allowed);
  }

  /**
   * Run the fallback hops in order. A hop that fails on its own credentials
   * opens that provider's circuit and moves to the next hop; any other failure
   * ends the chain (it is not a "dead key" problem, and timing out on several
   * providers in a row would multiply latency).
   */
  private async runFallbackChain(input: {
    candidates: FallbackCandidate[];
    messages: Message[];
    options: LLMOptions | undefined;
    requestOptions: Record<string, unknown>;
    requestId: string;
    primaryModel: string;
    primaryProviderType: string;
    reason: FallbackReason;
    primaryError: unknown;
    brand: ProductBrand;
  }): Promise<LLMChatResult> {
    const attempted: string[] = [];
    let lastError: unknown = input.primaryError;

    for (const candidate of input.candidates) {
      const label = `${candidate.providerType}/${candidate.model}`;
      attempted.push(label);
      let fallbackProvider: LLMProvider;
      try {
        fallbackProvider = this.createProvider(candidate.providerType, candidate.model);
      } catch (createErr) {
        lastError = createErr;
        continue;
      }

      const fallbackOptions: LLMOptions = {
        ...input.options,
        model: candidate.model,
        // The explicit per-call provider / vision override named the PRIMARY
        // route; the hop carries its own.
        provider: undefined,
        visionModel: undefined,
        maxTokens: fallbackMaxTokens(
          candidate.providerType,
          input.options?.maxTokens,
          input.options?.reasoningMaxTokens,
        ),
      };
      const logOptions = {
        ...input.requestOptions,
        model: candidate.model,
        maxTokens: fallbackOptions.maxTokens,
        fallbackFrom: input.primaryModel,
        fallbackFromProvider: input.primaryProviderType,
        fallbackReason: input.reason,
        fallbackSource: candidate.source,
      };

      const fallbackStart = Date.now();
      logger.warn('LLM', 'Retrying with fallback model', {
        model: input.primaryModel,
        provider: input.primaryProviderType,
        fallbackModel: candidate.model,
        fallbackProvider: fallbackProvider.getProviderName(),
        fallbackSource: candidate.source,
        reason: input.reason,
      }, input.requestId);

      try {
        const fallbackResponse = await fallbackProvider.chat(input.messages, fallbackOptions);
        logger.logLLMCall({
          requestId: input.requestId,
          model: fallbackResponse.model || candidate.model,
          provider: fallbackProvider.getProviderName(),
          promptTokens: fallbackResponse.usage.promptTokens,
          completionTokens: fallbackResponse.usage.completionTokens,
          duration: Date.now() - fallbackStart,
          status: 'success',
          messages: input.messages,
          options: logOptions,
          responseText: fallbackResponse.content,
        });
        return {
          content: fallbackResponse.content,
          usage: fallbackResponse.usage,
          model: fallbackResponse.model || candidate.model,
        };
      } catch (fallbackError) {
        const fallbackDuration = Date.now() - fallbackStart;
        const fallbackErrorUsage = (fallbackError as { usage?: { promptTokens?: number; completionTokens?: number } })?.usage;
        logger.logLLMCall({
          requestId: input.requestId,
          model: candidate.model,
          provider: fallbackProvider.getProviderName(),
          promptTokens: fallbackErrorUsage?.promptTokens ?? 0,
          completionTokens: fallbackErrorUsage?.completionTokens ?? 0,
          duration: fallbackDuration,
          status: 'error',
          messages: input.messages,
          options: logOptions,
          errorMessage: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
          transient: isTransientLLMError(fallbackError),
        });
        logger.error('LLM', `Fallback LLM call failed`, {
          model: candidate.model,
          provider: fallbackProvider.getProviderName(),
          error: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
          duration: `${fallbackDuration}ms`,
        }, input.requestId);

        lastError = fallbackError;
        const kind = classifyCredentialFailure(fallbackError);
        if (kind === 'auth' || kind === 'billing') {
          this.tripCircuit(candidate.providerType, kind, fallbackError, input.requestId);
          continue;
        }
        throw fallbackError;
      }
    }

    // Every hop was a dead key (or none could be built). For a transient
    // primary failure, hand back the last error so withLLMRetry keeps its
    // semantics; for a credential failure, say clearly that nothing is left.
    if (input.reason === 'transient') throw lastError;
    throw this.unavailableError({
      reason: input.reason,
      providerType: input.primaryProviderType,
      model: input.primaryModel,
      primaryError: input.primaryError,
      attempted,
      lastError,
      brand: input.brand,
    });
  }

  /** Open (or extend) the circuit for a provider whose platform key failed. */
  private tripCircuit(providerType: string, kind: 'auth' | 'billing', error: unknown, requestId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const { opened, until } = openCircuit(
      providerType,
      this.platformCredential(providerType).fingerprint,
      kind,
      message,
    );
    if (opened) {
      logger.error('LLM_SERVICE', `LLM provider "${providerType}" rejected its platform credentials (${kind}); routing around it for ${Math.round(CIRCUIT_OPEN_MS / 60000)} min`, {
        provider: providerType,
        kind,
        status: errorHttpStatus(error) ?? null,
        error: message.slice(0, 300),
        until: new Date(until).toISOString(),
      }, requestId);
    }
  }

  private unavailableError(input: {
    reason: FallbackReason;
    providerType: string;
    model: string;
    primaryError: unknown;
    attempted: string[];
    lastError?: unknown;
    brand?: ProductBrand;
  }): LLMUnavailableError {
    const brand = input.brand ?? this.callBrand();
    const fallbackEnv = `${brand.llmEnvPrefix}LLM_FALLBACK_MODEL`;
    const autoProviders = this.autoFallbackProvidersFor(brand);
    const primaryKind: CredentialFailureKind =
      classifyCredentialFailure(input.primaryError) ??
      (input.reason === 'billing' || input.reason === 'missing_key' ? input.reason : 'auth');
    const primaryMsg = input.primaryError instanceof Error
      ? input.primaryError.message
      : String(input.primaryError ?? 'circuit open');
    const what =
      primaryKind === 'missing_key'
        ? `has no API key configured (${primaryMsg.slice(0, 240)})`
        : primaryKind === 'billing'
          ? `rejected the request for billing/credit reasons (${primaryMsg.slice(0, 200)})`
          : `rejected its API key (${primaryMsg.slice(0, 200)})`;
    const tail = input.attempted.length
      ? ` Fallback routes also failed: ${input.attempted.join(', ')}` +
        (input.lastError instanceof Error ? ` (last error: ${input.lastError.message.slice(0, 200)}).` : '.')
      : ` No fallback route is available: set ${fallbackEnv} (or the admin fallback model)` +
        (autoProviders.length ? ` or configure an API key for one of: ${autoProviders.join(', ')}.` : '.');
    return new LLMUnavailableError({
      message: `LLM provider "${input.providerType}" ${what} for model "${input.model}".${tail}`,
      reason: primaryKind,
      provider: input.providerType,
      model: input.model,
      upstreamStatus: errorHttpStatus(input.primaryError),
      attemptedFallbacks: input.attempted,
      cause: input.lastError ?? input.primaryError,
    });
  }

  /** Build the per-construction ProviderExtra (base URL + proxy key + tuning)
   *  from a resolved credential, omitting undefined fields so providers fall
   *  back to their own env reads when nothing was configured. */
  private buildExtra(tuning: ProviderTuning, baseUrl?: string): ProviderExtra {
    return {
      ...(baseUrl ? { baseUrl } : {}),
      ...(tuning.proxyKey ? { proxyKey: tuning.proxyKey } : {}),
      ...(tuning.timeoutMs !== undefined ? { timeoutMs: tuning.timeoutMs } : {}),
      ...(tuning.thinkingMode ? { thinkingMode: tuning.thinkingMode } : {}),
      ...(tuning.reasoningEffort ? { reasoningEffort: tuning.reasoningEffort } : {}),
    };
  }

  /**
   * Construct a platform-default provider. Credentials (apiKey + baseUrl +
   * tuning) come from the 3-tier resolver: SYSTEM DB key -> env. The user-BYOK
   * tier sits ABOVE this in chat(). A fresh instance is built per call (cheap SDK
   * client) so admin key/model changes apply without restart — never cached.
   */
  private createProvider(providerType: string, selectedModel?: string): LLMProvider {
    const cred = resolveProviderCredential(providerType);
    const model = selectedModel || this.resolveDefaults().model;
    if (!model) {
      throw new Error(
        'No LLM model is configured. Set the task-specific LLM_*_MODEL variable ' +
          'or configure LLM_MODEL in the LLM stack.',
      );
    }
    const extra = this.buildExtra(cred.tuning, cred.baseUrl);
    // Fail loudly on a missing credential. Every provider below except ollama
    // requires a key; without this guard an empty string flows into the SDK
    // client, which sends `Authorization: Bearer ` (empty token) — the upstream
    // 401 then surfaces as a misleading downstream error (e.g. resume-upload
    // `parse_failed`). Seen in practice when the SystemLLMKey DB row can't be
    // decrypted (FIELD_ENCRYPTION_KEY mismatch after a DB migration) AND the
    // provider's env fallback var is unset.
    if (!cred.apiKey?.trim() && providerType.toLowerCase() !== 'ollama') {
      // Flagged so chat() can treat it as a credential failure and reroute.
      throw Object.assign(
        new Error(
          `No API key resolved for LLM provider "${providerType}" ` +
            `(system DB key absent or undecryptable — check FIELD_ENCRYPTION_KEY — ` +
            `and the provider's env fallback key is unset). ` +
            `Re-save the key in admin LLM settings or set the env var.`,
        ),
        { [MISSING_CREDENTIAL_FLAG]: true, nonRetryable: true },
      );
    }
    switch (providerType.toLowerCase()) {
      case 'openai':
        return new OpenAIProvider(cred.apiKey, model, extra);
      case 'openrouter':
        return new OpenRouterProvider(cred.apiKey, model, extra);
      case 'google':
        return new GoogleProvider(cred.apiKey, model, extra);
      case 'kimi':
      case 'moonshot':
        return new KimiProvider(cred.apiKey, model, extra);
      case 'deepseek':
        return new DeepSeekProvider(cred.apiKey, model, extra);
      case 'anthropic':
        return new AnthropicProvider(cred.apiKey, model, cred.baseUrl, extra);
      case 'minimax':
        return new OpenAICompatibleProvider({
          apiKey: cred.apiKey,
          baseURL: cred.baseUrl || 'https://api.minimax.chat',
          defaultModel: model,
          providerName: 'minimax',
          proxyKey: extra.proxyKey,
          timeoutMs: extra.timeoutMs,
        });
      case 'ollama':
        return new OpenAICompatibleProvider({
          apiKey: cred.apiKey || 'ollama',
          baseURL: cred.baseUrl || 'http://localhost:11434',
          defaultModel: model,
          providerName: 'ollama',
          proxyKey: extra.proxyKey,
          timeoutMs: extra.timeoutMs,
        });
      case 'newapi':
        return new OpenAICompatibleProvider({
          apiKey: cred.apiKey,
          baseURL: cred.baseUrl || '',
          defaultModel: model,
          providerName: 'newapi',
          proxyKey: extra.proxyKey,
          timeoutMs: extra.timeoutMs,
        });
      case 'qwen':
      case 'dashscope':
      case 'glm':
      case 'zhipu':
      case 'doubao':
      case 'ark':
        return this.createDomesticProvider(normalizeProviderType(providerType), cred.apiKey, cred.baseUrl, model, extra);
      default: {
        logger.warn('LLM_SERVICE', `Unknown provider "${providerType}", falling back to OpenRouter`);
        const orCred = resolveProviderCredential('openrouter');
        return new OpenRouterProvider(orCred.apiKey, model, this.buildExtra(orCred.tuning, orCred.baseUrl));
      }
    }
  }

  /** Qwen / GLM / Doubao on the OpenAI-compatible path with their thinking switch. */
  private createDomesticProvider(
    providerType: string,
    apiKey: string,
    baseUrl: string | undefined | null,
    model: string,
    extra: ProviderExtra,
  ): LLMProvider {
    if (!isDomesticVendor(providerType)) throw new Error(`Not a domestic vendor: ${providerType}`);
    return new OpenAICompatibleProvider({
      apiKey,
      baseURL: baseUrl || DOMESTIC_VENDORS[providerType].baseURL,
      defaultModel: model,
      providerName: providerType,
      timeoutMs: extra.timeoutMs,
      thinkingVendor: providerType,
      noProxyKey: true,
    });
  }

  /**
   * Construct a provider with the user's BYOK credentials. Mirrors the
   * platform-default switch above, but pulls apiKey/baseURL from the
   * caller (not env). Used inside `chat()` after a successful BYOK
   * resolve.
   */
  private createProviderWithByok(
    providerType: string,
    byok: ResolvedByok,
    model: string,
  ): LLMProvider {
    const lower = providerType.toLowerCase();
    // Behavioural tuning (DeepSeek thinking, proxy key, timeout) is INDEPENDENT
    // of which key is used — a BYOK user still gets the system/env tuning. The
    // base URL, however, follows the user's own BYOK row.
    const tuning = resolveProviderCredential(providerType).tuning;
    const extra = this.buildExtra(tuning, byok.baseUrl ?? undefined);
    switch (lower) {
      case 'openai':
        return new OpenAIProvider(byok.apiKey, model, extra);
      case 'openrouter':
        return new OpenRouterProvider(byok.apiKey, model, extra);
      case 'google':
        return new GoogleProvider(byok.apiKey, model, extra);
      case 'kimi':
      case 'moonshot':
        return new KimiProvider(byok.apiKey, model, extra);
      case 'deepseek':
        return new DeepSeekProvider(byok.apiKey, model, extra);
      case 'anthropic':
        return new AnthropicProvider(byok.apiKey, model, byok.baseUrl ?? undefined, extra);
      case 'minimax':
        return new OpenAICompatibleProvider({
          apiKey: byok.apiKey,
          baseURL: byok.baseUrl || 'https://api.minimax.chat',
          defaultModel: model,
          providerName: 'minimax',
          proxyKey: extra.proxyKey,
          timeoutMs: extra.timeoutMs,
        });
      case 'ollama':
        return new OpenAICompatibleProvider({
          apiKey: byok.apiKey || 'ollama',
          baseURL: byok.baseUrl || 'http://localhost:11434',
          defaultModel: model,
          providerName: 'ollama',
          proxyKey: extra.proxyKey,
          timeoutMs: extra.timeoutMs,
        });
      case 'newapi':
        return new OpenAICompatibleProvider({
          apiKey: byok.apiKey,
          baseURL: byok.baseUrl || '',
          defaultModel: model,
          providerName: 'newapi',
          proxyKey: extra.proxyKey,
          timeoutMs: extra.timeoutMs,
        });
      default:
        // Unknown provider with BYOK shouldn't happen — byokProviderFor
        // returned a known key. Fall back to platform path.
        return this.createProvider(providerType);
    }
  }

  async chat(messages: Message[], options?: LLMServiceOptions): Promise<string> {
    return (await this.chatWithUsage(messages, options)).content;
  }

  /**
   * Same as chat() but returns the response usage + resolved model alongside
   * the content — for callers that surface token counts to their own clients
   * (e.g. the candidate-chat NDJSON `done` event). Logging/cost tracking is
   * identical to chat() (handled internally via logger.logLLMCall).
   */
  async chatWithUsage(messages: Message[], options?: LLMServiceOptions): Promise<LLMChatResult> {
    // ── MOCK_LLM short-circuit (test plan R-09) ───────────────────────────
    // When `MOCK_LLM=true` is set in the environment, every LLM call returns
    // a deterministic canned response without touching any provider. This is
    // the seam Playwright e2e tests rely on so the suite runs without an
    // Anthropic / OpenAI / Gemini key and without paying for each test run.
    // The canned shape is deliberately minimal — JSON-callers (agents using
    // `chatWithJsonResponse`) get an empty object, plain callers get a
    // short echo. Agents that need richer fixtures should mock at the agent
    // level instead. See docs/job-seeker/07-test-plan.md §11 R-09.
    if (process.env.MOCK_LLM === 'true') {
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      const tail = last && typeof last.content === 'string'
        ? last.content.slice(0, 80)
        : '';
      // Return a string that satisfies both plain and JSON callers: a
      // permissive JSON object wrapped in a code fence. `chatWithJsonResponse`
      // extracts it; plain callers see the fenced string.
      return {
        content: '```json\n{"_mock": true, "echo": ' + JSON.stringify(tail) + '}\n```',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'mock',
      };
    }

    const startTime = Date.now();
    // Prefer the explicit per-call requestId. Otherwise inherit from
    // AsyncLocalStorage so calls made inside an Express handler or an
    // audit-context wrapper (startMatchingAudit / withRequestContext) attribute
    // to that snapshot — `recordJobResumeMatch` and `finalizeMatchingAudit`
    // read the per-request snapshot, so an orphan requestId here means tokens
    // / cost / model never reach the admin telemetry panel. generateRequestId
    // is the last-resort fallback for genuinely context-less callers.
    const requestId = options?.requestId || getCurrentRequestId() || generateRequestId();

    // Per-brand routing. GoApply calls pass the content-safety check on the
    // way in and on the way out, on whichever route they take: its own
    // domestic provider or the shared one (WP-24 provider; fail closed).
    const brand = this.callBrand(options?.brand, true);
    const callId = `${requestId}:${Math.random().toString(36).slice(2, 10)}`;
    const safetyCtx = { brand, task: options?.task, requestId, callId };
    // The input check runs once the route is known to be allowed (so a call
    // that cannot be routed never pays for a check).
    const result = await this.routeAndCall(messages, options, brand, requestId, startTime, () =>
      this.contentSafety('input', this.safetyInputText(messages), safetyCtx),
    );
    await this.contentSafety('output', result.content, safetyCtx);
    return result;
  }

  /** Resolve the brand's route (policy-checked), call it, reroute on failure. */
  private async routeAndCall(
    messages: Message[],
    callOptions: LLMServiceOptions | undefined,
    brand: ProductBrand,
    requestId: string,
    startTime: number,
    beforeProviderCall: () => Promise<void>,
  ): Promise<LLMChatResult> {
    // The routing inputs stay out of what providers receive.
    const { brand: _brand, task: _task, carriesUserData, ...options } = callOptions ?? {};
    void _brand;
    void _task;
    // Resolve provider + model depending on mode. Both the provider mode and the
    // default model are resolved FRESH here (DB override ?? env) so
    // admin changes apply within ~1s with no redeploy.
    const defaults = this.resolveDefaults(brand);
    const providerMode = defaults.providerMode;
    // 'default' is the sentinel some resolvers (e.g. resolveEvaluationModel)
    // emit when neither a DB override nor an env var configures a model. It
    // means "use the stack default" — without this guard the literal string
    // would be shipped to the provider as a model id.
    const explicitModel = options?.visionModel || options?.model;
    const rawModel = (explicitModel && explicitModel !== 'default' ? explicitModel : undefined) || defaults.model;
    if (!rawModel && this.missingModelIsUnavailable(brand)) {
      // GoApply with a provider of its own and no model anywhere (neither its
      // own nor the shared one), or behind the wall with no mainland model:
      // AI is unavailable, not an internal error.
      throw new AiUnavailableError('no_model', this.missingModelDetail(brand, 'no CN_LLM_MODEL, LLM_MODEL or task model is configured'));
    }
    if (!rawModel) {
      throw new Error(
        'No LLM model is configured for this call. Set its task-specific ' +
          'LLM_*_MODEL variable or configure LLM_MODEL in the LLM stack.',
      );
    }
    // A recognized provider prefix pins the call natively regardless of
    // LLM_PROVIDER. The explicit per-call provider remains highest precedence.
    const primaryRoute = this.resolvePlatformRoute(
      rawModel,
      providerMode,
      defaults.model,
      options?.provider,
      brand,
    );
    // Brand policy on the endpoint host: refused → logged, thrown, never re-routed.
    this.assertPrimaryRoute(brand, primaryRoute, carriesUserData, requestId);
    await beforeProviderCall();
    const model = primaryRoute.model;
    // A missing platform key is a credential failure like any other: keep it
    // so BYOK can still serve the call, else reroute to a fallback below.
    let activeProvider: LLMProvider | null = null;
    let primaryCreateError: unknown = null;
    try {
      activeProvider = this.createProvider(primaryRoute.providerType, primaryRoute.model);
    } catch (createErr) {
      if (classifyCredentialFailure(createErr) !== 'missing_key') throw createErr;
      primaryCreateError = createErr;
    }

    // ── BYOK resolution ──────────────────────────────────────────────────
    // If the current request's user has an active BYOK key for the
    // resolved provider, swap in a fresh provider instance constructed
    // with their credentials. We don't fall back to platform on BYOK
    // failure — the user expects errors to surface, and silently using
    // the platform key would re-introduce the billing surprise we set
    // out to eliminate. See docs/prd-byok.md.
    const userId = getCurrentUserId();
    const providerNamePreByok = activeProvider?.getProviderName() ?? primaryRoute.providerType.toLowerCase();
    // BYOK follows RoboApply on both brands; it is off for GoApply only behind
    // the domestic-only wall (a user key could point anywhere).
    const byokProviderKey = isByokAllowedForBrand(brand.id) ? llmProviderToByokProvider(providerNamePreByok) : null;
    let byokRow: ResolvedByok | null = null;
    let byokActive = false;
    if (userId && byokProviderKey) {
      try {
        byokRow = await resolveByok(userId, byokProviderKey);
      } catch (resolveErr) {
        // Decryption failure surfaces here. Don't fall back — let it
        // bubble. User sees the error and can clear/replace the key.
        throw resolveErr;
      }
      // A user key whose own base URL is a refused endpoint (e.g. a RoboApply
      // user's gateway on a mainland host) is not used; the already-checked
      // platform route serves the call instead. The re-check runs for both
      // brands.
      if (byokRow && !this.routeDecision(brand, providerNamePreByok, { carriesUserData, byok: true, baseUrl: byokRow.baseUrl }).allowed) {
        logger.warn('LLM_POLICY', `Skipping a personal ${providerNamePreByok} key: its endpoint is not allowed for ${brand.id}`, {
          brand: brand.id,
          provider: providerNamePreByok,
        }, requestId);
        byokRow = null;
      }
      if (byokRow) {
        activeProvider = this.createProviderWithByok(providerNamePreByok, byokRow, model);
        byokActive = true;
        primaryCreateError = null;
      }
    }

    const requestOptions = {
      ...options,
      model,
    };
    const fallbackContext = {
      messages,
      options,
      requestOptions,
      requestId,
      primaryModel: model,
      primaryProviderType: providerNamePreByok,
      brand,
    };
    const candidatesFor = (credentialFailure: boolean): FallbackCandidate[] =>
      this.buildFallbackCandidates({
        primaryModel: model,
        primaryProviderType: providerNamePreByok,
        providerMode,
        defaultModel: defaults.model,
        credentialFailure,
        brand,
        carriesUserData,
      });

    // No platform key and no BYOK: go straight to a fallback, or fail clearly.
    if (!activeProvider) {
      const candidates = candidatesFor(true);
      if (candidates.length === 0) {
        throw this.unavailableError({
          reason: 'missing_key',
          providerType: providerNamePreByok,
          model,
          primaryError: primaryCreateError,
          attempted: [],
          brand,
        });
      }
      return this.runFallbackChain({
        ...fallbackContext,
        candidates,
        reason: 'missing_key',
        primaryError: primaryCreateError,
      });
    }

    // Circuit breaker: the platform key for this provider failed auth/billing
    // in the last 10 minutes, so skip the doomed round-trip. BYOK calls use the
    // user's own key and are never short-circuited. With no fallback left, the
    // primary is tried anyway (the key may have been fixed upstream).
    if (!byokActive) {
      const circuit = getOpenCircuit(
        providerNamePreByok,
        this.platformCredential(providerNamePreByok).fingerprint,
      );
      if (circuit) {
        const candidates = candidatesFor(true);
        if (candidates.length > 0) {
          if (markCircuitBypassLogged(providerNamePreByok)) {
            logger.warn('LLM_SERVICE', `Circuit open for "${providerNamePreByok}"; routing calls to ${candidates[0].providerType}/${candidates[0].model} until ${new Date(circuit.until).toISOString()}`, {
              provider: providerNamePreByok,
              kind: circuit.kind,
              reason: circuit.reason,
            }, requestId);
          }
          return this.runFallbackChain({
            ...fallbackContext,
            candidates,
            reason: 'circuit_open',
            primaryError: new Error(circuit.reason),
          });
        }
      }
    }

    const providerName = activeProvider.getProviderName();
    logger.info('LLM', `→ ${providerName}/${model}${byokActive ? ' [byok]' : ''}`, {
      provider: providerName,
      model,
      messages: messages.length,
      ...(byokActive ? { byok: true } : {}),
    }, requestId);

    try {
      const response = await activeProvider.chat(messages, {
        ...options,
        model,
      });

      const duration = Date.now() - startTime;

      if (byokActive) {
        setByokInRequest();
        if (byokRow) void touchByok(byokRow.rowId);
      }

      logger.logLLMCall({
        requestId,
        model: response.model || model,
        provider: activeProvider.getProviderName(),
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        duration,
        status: 'success',
        messages,
        options: requestOptions,
        responseText: response.content,
        byok: byokActive,
      });

      return {
        content: response.content,
        usage: response.usage,
        model: response.model || model,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      // Providers may attach the response usage to the error (e.g. OpenRouter
      // empty-content failures still bill prompt + reasoning tokens) — log the
      // real burn so cost tracking doesn't show $0 for multi-minute calls.
      const errorUsage = (error as { usage?: { promptTokens?: number; completionTokens?: number } })?.usage;
      // A transient/retryable failure (connection blip, 5xx, rate limit) that
      // `withLLMRetry` will re-run is a hiccup, not an error — log it at WARN so
      // a recovered blip doesn't surface as ERROR. The LLMCallLog row + cost are
      // written identically; only console severity changes.
      const transient = isTransientLLMError(error);
      logger.logLLMCall({
        requestId,
        model,
        provider: providerName,
        promptTokens: errorUsage?.promptTokens ?? 0,
        completionTokens: errorUsage?.completionTokens ?? 0,
        duration,
        status: 'error',
        messages,
        options: requestOptions,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        byok: byokActive,
        transient,
      });

      const failLog = transient ? logger.warn.bind(logger) : logger.error.bind(logger);
      failLog('LLM', `✗ ${providerName}/${model}${byokActive ? ' [byok]' : ''} ${transient ? 'transient failure (will retry)' : 'failed'}`, {
        provider: providerName,
        model,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: `${duration}ms`,
        ...(transient ? { transient: true } : {}),
        ...(byokActive ? { byok: true } : {}),
      }, requestId);

      // BYOK failures must NOT silently fall back to the platform
      // (would surprise-bill the user). Surface the error verbatim.
      if (byokActive) {
        throw error;
      }

      // A credential failure (401/402/403, dead or out-of-credit key) opens
      // this provider's circuit and reroutes through the configured fallback,
      // then the auto-selected direct routes. Anything else keeps the
      // historical rule: configured fallback only, on fallback-worthy errors.
      const credentialKind = classifyCredentialFailure(error);
      if (credentialKind === 'auth' || credentialKind === 'billing') {
        this.tripCircuit(providerName, credentialKind, error, requestId);
      }
      if (credentialKind) {
        const candidates = candidatesFor(true);
        if (candidates.length === 0) {
          throw this.unavailableError({
            reason: credentialKind,
            providerType: providerName,
            model,
            primaryError: error,
            attempted: [],
            brand,
          });
        }
        return this.runFallbackChain({
          ...fallbackContext,
          candidates,
          reason: credentialKind,
          primaryError: error,
        });
      }

      if (this.shouldTryFallback(error)) {
        // Resolved as its own selector, independent of the global provider
        // mode: a native task selector may fall back through an explicit
        // openrouter/... selector (or vice versa).
        const candidates = candidatesFor(false);
        if (candidates.length > 0) {
          return this.runFallbackChain({
            ...fallbackContext,
            candidates,
            reason: 'transient',
            primaryError: error,
          });
        }
      }

      throw error;
    }
  }

  async chatWithJsonResponse<T>(messages: Message[], options?: LLMServiceOptions): Promise<T> {
    const response = await this.chat(messages, options);
    
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
                      response.match(/```\s*([\s\S]*?)\s*```/) ||
                      response.match(/(\{[\s\S]*\})/);
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        return JSON.parse(jsonMatch[1].trim()) as T;
      } catch {
        // If parsing fails, try to parse the entire response
      }
    }
    
    try {
      return JSON.parse(response) as T;
    } catch {
      logger.error('LLM', `Failed to parse JSON response`, {
        responsePreview: response.substring(0, 200),
      }, options?.requestId);
      throw new Error(`Failed to parse LLM response as JSON: ${response.substring(0, 200)}...`);
    }
  }

  /**
   * Admin diagnostic: run a 1-token chat against `modelId` using the resolved
   * SYSTEM/env credentials (the platform path). Deliberately bypasses the user
   * BYOK swap in chat() — the admin is testing the system config, not their own
   * key. Never throws; returns a structured result for the UI. The probe
   * carries no user data, but the brand policy still applies (behind the
   * domestic-only wall GoApply only ever reaches domestic endpoints).
   */
  async probeModel(
    modelId: string,
    brandId?: BrandId,
  ): Promise<{ ok: boolean; latencyMs: number; provider: string; sample?: string; error?: string }> {
    const start = Date.now();
    const brand = this.callBrand(brandId);
    let providerType = brand.llmProfile === 'domestic_cn' ? '' : 'openrouter';
    try {
      const defaults = this.resolveDefaults(brand);
      const route = this.resolvePlatformRoute(modelId, defaults.providerMode, defaults.model, undefined, brand);
      providerType = route.providerType;
      const decision = this.routeDecision(brand, route.providerType, { carriesUserData: false, model: route.model });
      if (!route.providerType || !decision.allowed) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          provider: providerType,
          error: decision.reason ?? `No provider for "${modelId}" on ${brand.id}.`,
        };
      }
      const provider = this.createProvider(route.providerType, route.model); // system → env, NO byok
      const resp = await provider.chat(
        [{ role: 'user', content: 'Reply with exactly: ok' }],
        { model: route.model, maxTokens: 16, temperature: 0 },
      );
      return { ok: true, latencyMs: Date.now() - start, provider: providerType, sample: (resp.content || '').slice(0, 120) };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        provider: providerType,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** The resolved default model (DB override ?? env) of the current brand. */
  getModel(): string {
    const brand = this.callBrand();
    const model = this.resolveDefaults(brand).model;
    if (!model) throw new Error(`No default LLM model is configured. Set ${brand.llmEnvPrefix}LLM_MODEL.`);
    return model;
  }

  /** The resolved provider mode ('direct' | 'openrouter' | ...) of the current brand. */
  getProvider(): string {
    return this.resolveDefaults(this.callBrand()).providerMode;
  }

  /* ── Route explanation (verify script, startup checks) ─────────────────── */

  /**
   * What a task (or the default / fallback model) resolves to for a brand,
   * WITHOUT calling anything: selector, provider, endpoint host, whether a key
   * exists, whether the brand policy allows it, and whether it can stream tool
   * calls.
   */
  explainRoute(task: LlmTask | 'default' | 'fallback', brandId?: BrandId): LlmRouteExplanation {
    const brand = this.callBrand(brandId);
    const defaults = this.resolveDefaults(brand);
    const own =
      task === 'default'
        ? defaults.model
        : task === 'fallback'
          ? getFallbackModelSetting(brand.id)
          : getTaskModel(task, brand.id);
    const inheritsDefault = !own && task !== 'default' && task !== 'fallback' && !!defaults.model;
    const selector = own ?? (inheritsDefault ? defaults.model ?? null : null);
    const key = inheritsDefault || task === 'default' ? 'defaultModel' : task === 'fallback' ? 'fallbackModel' : task;
    const taskKey = task === 'default' ? 'defaultModel' : task === 'fallback' ? 'fallbackModel' : task;
    const walledOff = resolveModelKey(taskKey, brand.id).sharedWalledOff;
    const base: LlmRouteExplanation = {
      brand: brand.id,
      task,
      profile: brand.llmProfile,
      selector,
      source: resolveModelKey(key, brand.id).source,
      ...(walledOff ? { sharedWalledOff: walledOff } : {}),
      inheritsDefault,
      providerType: null,
      model: null,
      baseUrl: null,
      host: null,
      hasKey: false,
      allowed: false,
      toolsSupported: false,
    };
    if (!selector) {
      const reason = llmDomesticOnlyApplies(brand)
        ? 'No mainland model configured behind the domestic-only wall (set CN_LLM_MODEL or the task\'s CN_LLM_<TASK>_MODEL; the shared model is not used).'
        : `No model configured (${brand.llmEnvPrefix}LLM_MODEL).`;
      return { ...base, policyCode: 'missing_route', reason };
    }
    const route = this.resolvePlatformRoute(selector, defaults.providerMode, defaults.model, undefined, brand);
    const decision = this.routeDecision(brand, route.providerType, { model: route.model });
    return {
      ...base,
      providerType: route.providerType || null,
      model: route.model,
      baseUrl: decision.baseUrl,
      host: decision.host,
      hasKey: route.providerType ? this.platformCredential(route.providerType).hasKey : false,
      allowed: !!route.providerType && decision.allowed,
      ...(decision.allowed && route.providerType
        ? {}
        : { policyCode: decision.code ?? 'missing_route', reason: decision.reason ?? `No provider for "${selector}".` }),
      toolsSupported: !!route.providerType && supportsToolStreaming(route.providerType),
    };
  }

  /* ── Streaming with tools (ARCHITECTURE.md §5.1; F-ORION-01/04) ────────── */

  /**
   * Stream one model round with tool definitions. Text deltas go to
   * `onDelta` as they arrive; completed tool calls go to `onToolCall` (and
   * the result) when the round ends. The caller runs the tools and calls
   * again with the assistant tool-call message and the tool results.
   *
   * - Only OpenAI-compatible providers stream tools; Google and Anthropic
   *   throw ToolsUnsupportedError.
   * - Brand policy as in chat(): RoboApply never reaches a mainland endpoint
   *   with user data; GoApply may use every route, and only domestic ones
   *   (no BYOK) behind the domestic-only wall.
   * - Retries (transient errors) and credential fallbacks happen ONLY before
   *   the first delta or tool call is emitted; afterwards a failure throws
   *   LlmStreamInterruptedError so the caller ends the turn with an error
   *   event and a retry button.
   * - An aborted `signal` stops the stream and throws an AbortError.
   * - GoApply: the input passes content safety first, and streamed text is
   *   released in checked segments by WP-24's createOutputStreamGuard (one
   *   guard per attempt: keyword-length overlap, partial-word holdback, a
   *   final whole-reply keyword scan and one event row per stream), so
   *   nothing unchecked reaches the user.
   */
  async streamChatWithTools(
    messages: readonly ToolChatMessage[],
    opts: StreamChatWithToolsOptions,
  ): Promise<StreamChatWithToolsResult> {
    const startTime = Date.now();
    const requestId = opts.requestId || getCurrentRequestId() || generateRequestId();
    const brand = this.callBrand(opts.brand, true);

    if (process.env.MOCK_LLM === 'true') {
      const content = 'Mock reply.';
      opts.onDelta?.(content);
      return {
        content,
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'mock',
        provider: 'mock',
      };
    }

    const defaults = this.resolveDefaults(brand);
    const rawModel = (opts.model && opts.model !== 'default' ? opts.model : undefined) ?? getTaskModelOrDefault(opts.task, brand.id);
    if (!rawModel) {
      if (this.missingModelIsUnavailable(brand)) {
        throw new AiUnavailableError(
          'no_model',
          this.missingModelDetail(brand, `no CN_LLM_${opts.task.toUpperCase()}_MODEL, CN_LLM_MODEL or shared model is configured`),
        );
      }
      throw new Error(`No LLM model is configured for task "${opts.task}". Set LLM_${opts.task.toUpperCase()}_MODEL or LLM_MODEL.`);
    }
    const primary = this.resolvePlatformRoute(rawModel, defaults.providerMode, defaults.model, undefined, brand);
    this.assertPrimaryRoute(brand, primary, opts.carriesUserData, requestId);
    if (!supportsToolStreaming(primary.providerType)) {
      throw new ToolsUnsupportedError(primary.providerType, primary.model);
    }

    const callId = `${requestId}:${Math.random().toString(36).slice(2, 10)}`;
    const safetyCtx = { brand, task: opts.task, requestId, callId };
    await this.contentSafety('input', this.safetyInputText(messages), safetyCtx);

    // Credentials: BYOK (both brands unless GoApply's wall is on; endpoint re-checked) → system/env.
    type Hop = { providerType: string; model: string; apiKey: string; baseUrl: string | null; byok: boolean; rowId?: string; source: 'primary' | 'configured' | 'auto' };
    const hops: Hop[] = [];
    const platformHop = (providerType: string, model: string, source: Hop['source']): Hop | null => {
      try {
        const cred = resolveProviderCredential(providerType);
        if (!cred.apiKey?.trim() && providerType !== 'ollama') return null;
        return { providerType, model, apiKey: cred.apiKey, baseUrl: cred.baseUrl ?? null, byok: false, source };
      } catch {
        return null;
      }
    };
    const userId = getCurrentUserId();
    const byokKey = isByokAllowedForBrand(brand.id) ? llmProviderToByokProvider(primary.providerType) : null;
    if (userId && byokKey) {
      const row = await resolveByok(userId, byokKey);
      if (row && this.routeDecision(brand, primary.providerType, { carriesUserData: opts.carriesUserData, byok: true, baseUrl: row.baseUrl }).allowed) {
        hops.push({ providerType: primary.providerType, model: primary.model, apiKey: row.apiKey, baseUrl: row.baseUrl, byok: true, rowId: row.rowId, source: 'primary' });
      }
    }
    const primaryCircuit = getOpenCircuit(primary.providerType, this.platformCredential(primary.providerType).fingerprint);
    if (hops.length === 0) {
      const hop = platformHop(primary.providerType, primary.model, 'primary');
      if (hop && !primaryCircuit) hops.push(hop);
    }
    const fallbacksFor = (credentialFailure: boolean): Hop[] =>
      this.buildFallbackCandidates({
        primaryModel: primary.model,
        primaryProviderType: primary.providerType,
        providerMode: defaults.providerMode,
        defaultModel: defaults.model,
        credentialFailure,
        brand,
        carriesUserData: opts.carriesUserData,
        requireTools: true,
      })
        .map((c) => platformHop(c.providerType, c.model, c.source))
        .filter((h): h is Hop => h !== null);
    // A user key never falls back to the platform (no surprise billing).
    if (hops.length === 0) hops.push(...fallbacksFor(true));
    // Circuit open and nothing else left: try the primary anyway (the key may
    // have been fixed upstream), as chat() does.
    if (hops.length === 0 && primaryCircuit) {
      const hop = platformHop(primary.providerType, primary.model, 'primary');
      if (hop) hops.push(hop);
    }
    if (hops.length === 0) {
      throw this.unavailableError({
        reason: primaryCircuit ? 'circuit_open' : 'missing_key',
        providerType: primary.providerType,
        model: primary.model,
        primaryError: primaryCircuit ? new Error(primaryCircuit.reason) : new Error(`No API key resolved for LLM provider "${primary.providerType}"`),
        attempted: [],
        brand,
      });
    }

    // Emission bookkeeping: once anything reached the caller, no retry.
    let emitted = false;
    let emittedText = '';
    const emit = (text: string) => {
      emitted = true;
      emittedText += text;
      opts.onDelta?.(text);
    };
    // GoApply: a fresh WP-24 stream guard per attempt (text a failed attempt
    // held back was never shown, so it is simply dropped with its guard).
    const guarded = contentSafetyApplies(brand.id);
    let guard: OutputStreamGuard | null = null;
    let guardSawText = false;
    const onText = async (delta: string) => {
      if (!guard) {
        emit(delta);
        return;
      }
      const active = guard;
      guardSawText = true;
      const cleared = await this.safetyVerdict('output', safetyCtx, () => active.push(delta));
      if (cleared) emit(cleared);
    };

    const attempts = Math.max(1, getRetryAttempts() ?? 3);
    const baseMs = getRetryBaseMs() ?? 800;
    const maxMs = getRetryMaxMs() ?? 6_000;
    const loggable = toLoggableMessages(messages);
    let lastError: unknown = null;
    const tried = new Set<string>();

    for (let hopIndex = 0; hopIndex < hops.length; hopIndex += 1) {
      const hop = hops[hopIndex];
      tried.add(`${hop.providerType}::${hop.model}`);
      const tuning = hop.byok ? undefined : resolveProviderCredential(hop.providerType).tuning;
      const client = (opts.clientFactory ?? createStreamingClient)(hop.providerType, {
        apiKey: hop.apiKey,
        baseUrl: hop.baseUrl,
        ...(tuning ? { proxyKey: tuning.proxyKey } : {}),
        ...(tuning?.timeoutMs !== undefined ? { timeoutMs: tuning.timeoutMs } : {}),
      });
      const params = buildStreamParams({
        providerType: hop.providerType,
        model: hop.model,
        messages,
        tools: opts.tools,
        toolChoice: opts.toolChoice,
        maxTokens: opts.maxTokens,
        reasoningMaxTokens: opts.reasoningMaxTokens,
        temperature: opts.temperature,
        reasoningEffort: opts.reasoningEffort,
        thinkingMode: opts.thinkingMode,
        tunedThinkingMode: tuning?.thinkingMode,
      });

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (opts.signal?.aborted) throw abortError();
        // Text the guard held back from a failed attempt (or hop) was never
        // shown; a new guard drops it so the next attempt's text is emitted
        // exactly once.
        guard = guarded ? createOutputStreamGuard(this.safetyContext(safetyCtx)) : null;
        guardSawText = false;
        const hopStart = Date.now();
        try {
          const round: StreamRoundResult = await runStreamRound({ client, params, signal: opts.signal, onText });
          // The SDK may end the iterator quietly on abort: a cut-short round is
          // never reported as a finished one.
          if (opts.signal?.aborted) throw abortError();
          if (guard) {
            // Release what is still held back after the last check and the
            // whole-reply keyword scan; this can still block (treated like a
            // mid-stream block). It records the stream's one event row.
            const active = guard;
            if (guardSawText) {
              const rest = await this.safetyVerdict('output', safetyCtx, () => active.finish());
              if (rest) emit(rest);
            }
            // Tool arguments carry model-written text the user can see
            // (drafts, proposals, echoed queries): check them before any
            // reaches the caller.
            if (round.toolCalls.length > 0) {
              await this.contentSafety(
                'output',
                round.toolCalls.map((c) => `${c.name} ${c.arguments}`).join('\n'),
                safetyCtx,
              );
            }
          }
          for (const call of round.toolCalls) {
            emitted = true;
            opts.onToolCall?.(call);
          }
          const usage: LLMUsageInfo = round.usage ?? {
            promptTokens: estimatePromptTokens(loggable),
            completionTokens: estimateTokensFromText(round.content),
            totalTokens: 0,
            estimated: true,
          };
          if (usage.estimated) usage.totalTokens = usage.promptTokens + usage.completionTokens;
          if (hop.byok) {
            setByokInRequest();
            if (hop.rowId) void touchByok(hop.rowId);
          }
          logger.logLLMCall({
            requestId,
            model: round.model || hop.model,
            provider: hop.providerType,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            duration: Date.now() - startTime,
            status: 'success',
            messages: loggable,
            options: {
              model: hop.model,
              task: opts.task,
              stream: true,
              tools: opts.tools.map((t) => t.name),
              ...(hop.source !== 'primary' ? { fallbackFrom: primary.model, fallbackSource: hop.source } : {}),
            },
            responseText: round.content + round.toolCalls.map((c) => `\n[tool_call ${c.name}] ${c.arguments}`).join(''),
            byok: hop.byok,
          });
          return {
            content: round.content,
            toolCalls: round.toolCalls,
            finishReason: round.finishReason,
            usage,
            model: round.model || hop.model,
            provider: hop.providerType,
            ...(round.reasoningContent ? { reasoningContent: round.reasoningContent } : {}),
          };
        } catch (error) {
          lastError = error;
          if (opts.signal?.aborted) throw abortError();
          // A content-safety verdict is never retried or rerouted.
          if (error instanceof ContentBlockedError || error instanceof AiUnavailableError) throw error;
          const transient = isTransientLLMError(error);
          logger.logLLMCall({
            requestId,
            model: hop.model,
            provider: hop.providerType,
            promptTokens: 0,
            completionTokens: 0,
            duration: Date.now() - hopStart,
            status: 'error',
            messages: loggable,
            options: { model: hop.model, task: opts.task, stream: true },
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            byok: hop.byok,
            transient,
          });
          if (emitted) throw new LlmStreamInterruptedError(error, emittedText);
          const credentialKind = classifyCredentialFailure(error);
          if (credentialKind) {
            if (!hop.byok && (credentialKind === 'auth' || credentialKind === 'billing')) {
              this.tripCircuit(hop.providerType, credentialKind, error, requestId);
            }
            if (hop.byok) throw error;
            // Next hop: add the brand-filtered, tool-capable fallbacks once.
            if (hopIndex === hops.length - 1) {
              for (const next of fallbacksFor(true)) {
                if (!tried.has(`${next.providerType}::${next.model}`)) hops.push(next);
              }
            }
            break;
          }
          if (transient && attempt < attempts) {
            const expDelay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
            await sleep(Math.round(expDelay / 2 + Math.random() * expDelay * 0.5), opts.signal);
            continue;
          }
          throw error;
        }
      }
    }
    throw this.unavailableError({
      reason: classifyCredentialFailure(lastError) ?? 'auth',
      providerType: primary.providerType,
      model: primary.model,
      primaryError: lastError,
      attempted: [...tried].map((k) => k.replace('::', '/')),
      lastError,
      brand,
    });
  }
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export const llmService = new LLMService();

/* ── Startup check (ARCHITECTURE.md §5.1) ─────────────────────────────────── */

/** Brands already told (once per process) that the wall leaves them without a model. */
const warnedWalledNoModel = new Set<BrandId>();

export interface CopilotToolsCheck {
  brand: BrandId;
  ok: boolean;
  /**
   * Set (with `ok: true`) only for GoApply behind the domestic-only wall with
   * no mainland model: its Assistant answers 503 ai_unavailable, which is the
   * state the operator chose, not a broken model. No other case is skipped.
   */
  skipped?: string;
  route: LlmRouteExplanation;
  problem?: string;
}

/**
 * Fail loudly when the copilot task resolves to a model that cannot stream
 * tool calls (Google, Anthropic), that the brand policy refuses, or to no
 * model at all, for every brand this deployment serves. GoApply is checked
 * like RoboApply: with no domestic model of its own it resolves to the shared
 * copilot model and passes when that model is tool-capable. Behind the
 * domestic-only wall a shared copilot model that is not a mainland one is set
 * aside and GoApply's own default model is checked; with no mainland model at
 * all GoApply is skipped (its AI answers 503) and the other brands still
 * boot. Call at boot; pass `{ throwOnError: false }` to get the report only.
 */
export function assertCopilotModelSupportsTools(
  options: { brands?: BrandId[]; throwOnError?: boolean; service?: LLMService } = {},
): CopilotToolsCheck[] {
  const service = options.service ?? llmService;
  const brands = options.brands ?? allowedBrands();
  const results: CopilotToolsCheck[] = brands.map((brandId) => {
    const route = service.explainRoute('copilot', brandId);
    if (!route.selector && llmDomesticOnlyApplies(getBrand(brandId))) {
      if (!warnedWalledNoModel.has(brandId)) {
        warnedWalledNoModel.add(brandId);
        logger.warn('LLM_POLICY', `${brandId}: no mainland model behind the domestic-only wall; its AI features answer 503 ai_unavailable until CN_LLM_MODEL or CN_LLM_COPILOT_MODEL names one.`, {
          brand: brandId,
          ...(route.sharedWalledOff ? { sharedModelNotUsed: route.sharedWalledOff } : {}),
        });
      }
      return { brand: brandId, ok: true, skipped: 'no mainland model behind the domestic-only wall (AI unavailable)', route };
    }
    if (!route.selector) return { brand: brandId, ok: false, route, problem: 'no copilot or default model configured' };
    if (!route.allowed) return { brand: brandId, ok: false, route, problem: route.reason ?? 'route refused by the brand policy' };
    if (!route.toolsSupported) {
      return { brand: brandId, ok: false, route, problem: `provider "${route.providerType}" cannot stream tool calls` };
    }
    return { brand: brandId, ok: true, route };
  });
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0 && options.throwOnError !== false) {
    const lines = failures.map((f) => `${f.brand}: ${f.problem} (selector ${f.route.selector ?? '(none)'})`);
    throw new ToolsUnsupportedError(
      failures[0].route.providerType ?? '(none)',
      failures[0].route.model ?? '(none)',
      `The Assistant (copilot) model cannot be used: ${lines.join('; ')}. ` +
        'Set LLM_COPILOT_MODEL (or the GoApply override CN_LLM_COPILOT_MODEL) to a tool-capable, allowed model.',
    );
  }
  return results;
}
