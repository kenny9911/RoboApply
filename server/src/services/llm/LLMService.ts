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
  resolveByok,
  touchByok,
  type ByokProvider,
  type ResolvedByok,
} from '../../lib/byokService.js';
import { resolveProviderCredential } from '../../lib/llm/systemCredentials.js';
import { getProviderSetting, getDefaultModel, getFallbackModelSetting } from '../../lib/llm/llmModels.js';
import { isTransientLLMError } from './withRetry.js';
import type { ProviderExtra } from '../../types/index.js';

/** chatWithUsage() result — content plus the billed token usage + resolved model. */
export interface LLMChatResult {
  content: string;
  usage: LLMResponse['usage'];
  model: string;
}

const DIRECT_PROVIDER_PREFIXES = new Set([
  'openai',
  'google',
  'kimi',
  'moonshot',
  'deepseek',
  'openrouter',
  'anthropic',
  'minimax',
  'ollama',
  'newapi',
]);

// Provider-prefix aliases: the model-id prefix a caller may use differs from the
// internal provider key. Google's native SDK is Gemini-branded, so `gemini/…` is
// accepted as a synonym for the `google` provider (e.g. `gemini/gemini-3-flash-preview`
// → Google direct). Normalized in resolveDirectModel before the prefix is matched.
const PROVIDER_PREFIX_ALIASES: Record<string, string> = {
  gemini: 'google',
};

// Dedupe the "stripped redundant routing prefix" log. `normalizeModel` runs on
// EVERY chat() call (config is resolved fresh per call for hot-reload), so a
// statically-configured model like `openrouter/anthropic/claude-opus-4-8` while
// LLM_PROVIDER=openrouter would otherwise emit an identical line on every call
// AND every retry — noise that reads like the router fumbling/​retrying when it
// is just quietly normalizing. Log each unique (model → provider) once.
const loggedPrefixStrips = new Set<string>();

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
  // Hardcoded last-resort defaults (matching the historical env defaults). The
  // default provider + model are resolved FRESH on every chat() call via
  // resolveDefaults() — NOT cached on the instance — so an admin changing the
  // DB-backed default takes effect within ~1s without a redeploy. See
  // docs/llm-settings-db/.
  private static readonly DEFAULT_PROVIDER = 'openrouter';
  // Last-resort default model when EVERY config layer (DB defaultModel + env
  // LLM_MODEL) is empty. MUST be `openrouter/`-prefixed (not bare `google/…`):
  // a `google/` prefix is a recognized DIRECT-provider prefix that pins the call
  // to Google's NATIVE API regardless of providerMode (see resolveDirectModel /
  // chatWithUsage). With a `google/` default, a fully-cleared config silently
  // re-pinned the parse path to Google-direct — unreachable from the China
  // deploy and a contributor to the 2026-06-24 parse-resume outage. The
  // `openrouter/` prefix routes the same Gemini model THROUGH OpenRouter, which
  // is reachable and honors LLM_PROVIDER. The prefix is stripped to
  // `google/gemini-3-flash-preview` (OpenRouter's real model id) before dispatch.
  private static readonly DEFAULT_MODEL = 'openrouter/google/gemini-3-flash-preview';

  /** Resolve the default provider mode + model: DB override ?? env ?? hardcoded. */
  private resolveDefaults(): { providerMode: string; model: string } {
    return {
      providerMode: (getProviderSetting() || LLMService.DEFAULT_PROVIDER).toLowerCase(),
      model: getDefaultModel() || LLMService.DEFAULT_MODEL,
    };
  }

  private getConfiguredFallbackModel(primaryModel: string): string | null {
    // DB override (admin) wins, then env LLM_FALLBACK_MODEL, then the heuristic.
    const configured = (getFallbackModelSetting() || '').trim();
    if (configured && configured !== primaryModel) {
      return configured;
    }

    const normalized = primaryModel.toLowerCase();
    const providerPrefix = primaryModel.includes('/') ? `${primaryModel.split('/')[0]}/` : '';

    if (normalized.includes('gemini-3.1-pro-preview')) {
      return `${providerPrefix}gemini-3-flash-preview`;
    }

    return null;
  }

  private shouldTryFallback(error: unknown): boolean {
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
    if (!model.includes('/')) return model;
    const slashIdx = model.indexOf('/');
    const modelProvider = model.substring(0, slashIdx);
    const modelName = model.substring(slashIdx + 1);
    if (modelProvider.toLowerCase() === provider.toLowerCase()) {
      // Expected + benign: the model id carries an explicit `<provider>/…`
      // routing hint that matches the provider we're already calling, so we
      // strip the redundant prefix to the id the upstream API expects. Not an
      // error and not a retry — log once per unique (model → provider) to keep
      // it out of the per-call/per-retry stream.
      const key = `${model}=>${provider.toLowerCase()}`;
      if (!loggedPrefixStrips.has(key)) {
        loggedPrefixStrips.add(key);
        logger.debug('LLM_SERVICE', `Stripped redundant "${modelProvider}/" routing prefix: "${model}" → "${modelName}" (provider already "${provider}")`);
      }
      return modelName;
    }
    return model;
  }

  /**
   * In 'direct' mode, parse "provider/model" to resolve which provider to use.
   * Returns null if the prefix is not a known direct provider.
   */
  private resolveDirectModel(rawModel: string): { providerType: string; model: string } | null {
    if (!rawModel.includes('/')) return null;
    const slashIdx = rawModel.indexOf('/');
    const prefix = rawModel.substring(0, slashIdx).toLowerCase();
    const providerType = PROVIDER_PREFIX_ALIASES[prefix] ?? prefix;
    if (!DIRECT_PROVIDER_PREFIXES.has(providerType)) return null;
    return { providerType, model: rawModel.substring(slashIdx + 1) };
  }

  /** Build the per-construction ProviderExtra (base URL + proxy key + tuning)
   *  from a resolved credential, omitting undefined fields so providers fall
   *  back to their own env reads when nothing was configured. */
  private buildExtra(tuning: { proxyKey?: string; timeoutMs?: number; thinkingMode?: 'enabled' | 'disabled'; reasoningEffort?: 'high' | 'max' }, baseUrl?: string): ProviderExtra {
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
  private createProvider(providerType: string): LLMProvider {
    const cred = resolveProviderCredential(providerType);
    const model = this.resolveDefaults().model;
    const extra = this.buildExtra(cred.tuning, cred.baseUrl);
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
      default: {
        logger.warn('LLM_SERVICE', `Unknown provider "${providerType}", falling back to OpenRouter`);
        const orCred = resolveProviderCredential('openrouter');
        return new OpenRouterProvider(orCred.apiKey, model, this.buildExtra(orCred.tuning, orCred.baseUrl));
      }
    }
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

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    return (await this.chatWithUsage(messages, options)).content;
  }

  /**
   * Same as chat() but returns the response usage + resolved model alongside
   * the content — for callers that surface token counts to their own clients
   * (e.g. the candidate-chat NDJSON `done` event). Logging/cost tracking is
   * identical to chat() (handled internally via logger.logLLMCall).
   */
  async chatWithUsage(messages: Message[], options?: LLMOptions): Promise<LLMChatResult> {
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

    // Resolve provider + model depending on mode. Both the provider mode and the
    // default model are resolved FRESH here (DB override ?? env ?? hardcoded) so
    // admin changes apply within ~1s with no redeploy.
    const defaults = this.resolveDefaults();
    const providerMode = defaults.providerMode;
    // 'default' is the sentinel some resolvers (e.g. resolveEvaluationModel)
    // emit when neither a DB override nor an env var configures a model. It
    // means "use the stack default" — without this guard the literal string
    // would be shipped to the provider as a model id.
    const explicitModel = options?.visionModel || options?.model;
    const rawModel = (explicitModel && explicitModel !== 'default' ? explicitModel : undefined) || defaults.model;
    let activeProvider: LLMProvider;
    let model: string;

    if (options?.provider) {
      // Explicit per-call provider override — highest precedence.
      activeProvider = this.createProvider(options.provider);
      model = this.normalizeModel(rawModel, options.provider);
    } else {
      // A recognized DIRECT-provider prefix on the model id pins the call to that
      // provider's NATIVE API, bypassing OpenRouter — REGARDLESS of providerMode
      // (LLM_PROVIDER). Examples:
      //   gemini/gemini-3-flash-preview  → Google direct   (gemini = google alias)
      //   openai/gpt-5.4-mini            → OpenAI direct
      //   deepseek/deepseek-v4-pro       → DeepSeek direct
      // To route a vendor model THROUGH OpenRouter, use the `openrouter/…` prefix
      // (or a bare model id while in openrouter mode). The `openrouter/` prefix is
      // intentionally excluded here so it falls through to the OpenRouter path.
      const direct = this.resolveDirectModel(rawModel);
      if (direct && direct.providerType !== 'openrouter') {
        activeProvider = this.createProvider(direct.providerType);
        model = direct.model;
      } else if (providerMode === 'direct') {
        if (direct) {
          // `openrouter/…` prefix → OpenRouter with the routing hint stripped.
          activeProvider = this.createProvider('openrouter');
          model = direct.model;
        } else if (rawModel.includes('/')) {
          // Has a prefix but not a recognized provider — pass through OpenRouter unchanged.
          activeProvider = this.createProvider('openrouter');
          model = rawModel;
        } else {
          // No prefix at all — use the DEFAULT model's provider (the historical
          // `defaultProviderType`), derived from the resolved default model prefix.
          const defType = this.resolveDirectModel(defaults.model)?.providerType ?? 'openrouter';
          activeProvider = this.createProvider(defType);
          model = rawModel;
        }
      } else {
        // Legacy single-provider mode (openrouter, google, openai, kimi) — applies
        // to bare / openrouter-prefixed / unrecognized-prefix ids only.
        activeProvider = this.createProvider(providerMode);
        model = this.normalizeModel(rawModel, providerMode);
      }
    }

    // ── BYOK resolution ──────────────────────────────────────────────────
    // If the current request's user has an active BYOK key for the
    // resolved provider, swap in a fresh provider instance constructed
    // with their credentials. We don't fall back to platform on BYOK
    // failure — the user expects errors to surface, and silently using
    // the platform key would re-introduce the billing surprise we set
    // out to eliminate. See docs/prd-byok.md.
    const userId = getCurrentUserId();
    const providerNamePreByok = activeProvider.getProviderName();
    const byokProviderKey = llmProviderToByokProvider(providerNamePreByok);
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
      if (byokRow) {
        activeProvider = this.createProviderWithByok(providerNamePreByok, byokRow, model);
        byokActive = true;
      }
    }

    const providerName = activeProvider.getProviderName();
    const requestOptions = {
      ...options,
      model,
    };
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

      const rawFallbackModel = this.getConfiguredFallbackModel(model);
      if (rawFallbackModel && rawFallbackModel !== model && this.shouldTryFallback(error)) {
        // In direct mode, the fallback model may have a provider prefix that needs resolving
        let fallbackProvider = activeProvider;
        let fallbackModel = rawFallbackModel;
        if (providerMode === 'direct') {
          const resolved = this.resolveDirectModel(rawFallbackModel);
          if (resolved) {
            fallbackModel = resolved.model;
            if (resolved.providerType !== activeProvider.getProviderName().toLowerCase()) {
              fallbackProvider = this.createProvider(resolved.providerType);
            }
          }
        }

        const fallbackStart = Date.now();
        logger.warn('LLM', 'Retrying with fallback model', {
          model,
          fallbackModel,
          fallbackProvider: fallbackProvider.getProviderName(),
        }, requestId);

        try {
          const fallbackResponse = await fallbackProvider.chat(messages, {
            ...options,
            model: fallbackModel,
          });

          const fallbackDuration = Date.now() - fallbackStart;
          logger.logLLMCall({
            requestId,
            model: fallbackResponse.model || fallbackModel,
            provider: fallbackProvider.getProviderName(),
            promptTokens: fallbackResponse.usage.promptTokens,
            completionTokens: fallbackResponse.usage.completionTokens,
            duration: fallbackDuration,
            status: 'success',
            messages,
            options: {
              ...requestOptions,
              model: fallbackModel,
              fallbackFrom: model,
            },
            responseText: fallbackResponse.content,
          });

          return {
            content: fallbackResponse.content,
            usage: fallbackResponse.usage,
            model: fallbackResponse.model || fallbackModel,
          };
        } catch (fallbackError) {
          const fallbackDuration = Date.now() - fallbackStart;
          const fallbackErrorUsage = (fallbackError as { usage?: { promptTokens?: number; completionTokens?: number } })?.usage;
          logger.logLLMCall({
            requestId,
            model: fallbackModel,
            provider: fallbackProvider.getProviderName(),
            promptTokens: fallbackErrorUsage?.promptTokens ?? 0,
            completionTokens: fallbackErrorUsage?.completionTokens ?? 0,
            duration: fallbackDuration,
            status: 'error',
            messages,
            options: {
              ...requestOptions,
              model: fallbackModel,
              fallbackFrom: model,
            },
            errorMessage: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
          });
          logger.error('LLM', `Fallback LLM call failed`, {
            model: fallbackModel,
            error: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
            duration: `${fallbackDuration}ms`,
          }, requestId);
          throw fallbackError;
        }
      }

      throw error;
    }
  }

  async chatWithJsonResponse<T>(messages: Message[], options?: LLMOptions): Promise<T> {
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
   * key. Never throws; returns a structured result for the UI.
   */
  async probeModel(modelId: string): Promise<{ ok: boolean; latencyMs: number; provider: string; sample?: string; error?: string }> {
    const start = Date.now();
    let providerType = 'openrouter';
    try {
      let model = modelId;
      const resolved = this.resolveDirectModel(modelId);
      if (resolved) {
        providerType = resolved.providerType;
        model = resolved.model;
      } else if (modelId.includes('/')) {
        providerType = 'openrouter';
        model = modelId;
      } else {
        const defaults = this.resolveDefaults();
        providerType = this.resolveDirectModel(defaults.model)?.providerType
          ?? (defaults.providerMode === 'direct' ? 'openrouter' : defaults.providerMode);
        model = modelId;
      }
      const provider = this.createProvider(providerType); // system → env, NO byok
      const resp = await provider.chat(
        [{ role: 'user', content: 'Reply with exactly: ok' }],
        { model, maxTokens: 16, temperature: 0 },
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

  /** The resolved default model (DB override ?? env ?? hardcoded). Used for
   *  telemetry labels and as the fallback model for callers that omit one. */
  getModel(): string {
    return this.resolveDefaults().model;
  }

  /** The resolved provider mode ('direct' | 'openrouter' | ...). */
  getProvider(): string {
    return this.resolveDefaults().providerMode;
  }
}

export const llmService = new LLMService();
