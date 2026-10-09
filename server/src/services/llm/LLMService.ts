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
import { resolveProviderCredential, type ProviderTuning } from '../../lib/llm/systemCredentials.js';
import { getProviderSetting, getDefaultModel, getFallbackModelSetting } from '../../lib/llm/llmModels.js';
import { isTransientLLMError } from './withRetry.js';
import { DIRECT_PROVIDER_PREFIXES, PROVIDER_PREFIX_ALIASES } from './providerPrefixes.js';
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
import type { ProviderExtra } from '../../types/index.js';

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
  private static readonly DEFAULT_PROVIDER = 'openrouter';

  /** Resolve default routing: DB override ?? env. Model selection never lives in code. */
  private resolveDefaults(): { providerMode: string; model?: string } {
    return {
      providerMode: (getProviderSetting() || LLMService.DEFAULT_PROVIDER).toLowerCase(),
      model: getDefaultModel(),
    };
  }

  private getConfiguredFallbackModel(primaryModel: string): string | null {
    // DB override (admin) wins, then env LLM_FALLBACK_MODEL. There is no
    // source-level model substitution: operators own both model choices.
    const configured = (getFallbackModelSetting() || '').trim();
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

  /** Resolve a configured selector with the same rules for primary and fallback
   * calls. Recognized provider prefixes always pin the native provider; an
   * explicit openrouter/ prefix keeps the vendor slug behind OpenRouter. */
  private resolvePlatformRoute(
    rawModel: string,
    providerMode: string,
    defaultModel?: string,
    explicitProvider?: string,
  ): { providerType: string; model: string } {
    if (explicitProvider) {
      return {
        providerType: explicitProvider,
        model: this.normalizeModel(rawModel, explicitProvider),
      };
    }

    const direct = this.resolveDirectModel(rawModel);
    // Every recognized outer prefix is an explicit route, including
    // openrouter/...; it must win even when legacy LLM_PROVIDER names a
    // different single provider.
    if (direct) return direct;

    if (providerMode === 'direct') {
      if (rawModel.includes('/')) {
        return { providerType: 'openrouter', model: rawModel };
      }
      return {
        providerType: this.resolveDirectModel(defaultModel || '')?.providerType ?? 'openrouter',
        model: rawModel,
      };
    }

    return {
      providerType: providerMode,
      model: this.normalizeModel(rawModel, providerMode),
    };
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
  }): FallbackCandidate[] {
    const primaryType = input.primaryProviderType.toLowerCase();
    const out: FallbackCandidate[] = [];
    const seen = new Set<string>([`${primaryType}::${input.primaryModel}`]);
    const usable = (providerType: string): boolean => {
      const lower = providerType.toLowerCase();
      if (input.credentialFailure && lower === primaryType) return false;
      const cred = this.platformCredential(lower);
      if (!cred.hasKey) return false;
      return !getOpenCircuit(lower, cred.fingerprint);
    };

    const configured = this.getConfiguredFallbackModel(input.primaryModel);
    if (configured) {
      const route = this.resolvePlatformRoute(configured, input.providerMode, input.defaultModel);
      const key = `${route.providerType.toLowerCase()}::${route.model}`;
      if (!seen.has(key) && usable(route.providerType)) {
        seen.add(key);
        out.push({ ...route, selector: configured, source: 'configured' });
      }
    }

    if (input.credentialFailure && isAutoFallbackEnabled()) {
      const auto: FallbackCandidate[] = [];
      for (const selector of AUTO_FALLBACK_PREFERENCE) {
        const route = this.resolveDirectModel(selector);
        // Auto-selection is direct-provider only: never openrouter.
        if (!route || route.providerType === 'openrouter') continue;
        const key = `${route.providerType}::${route.model}`;
        if (seen.has(key) || !usable(route.providerType)) continue;
        seen.add(key);
        auto.push({ ...route, selector, source: 'auto' });
      }
      const summary = auto.map((c) => c.selector).join(' → ') || '(none)';
      if (noteAutoFallbackChoice(summary)) {
        logger.warn('LLM_SERVICE', `Auto-selected LLM fallback route: ${summary}`, {
          primaryProvider: primaryType,
          configuredFallback: configured ?? null,
          candidates: auto.map((c) => `${c.providerType}/${c.model}`),
        });
      }
      out.push(...auto);
    }
    return out;
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
  }): LLMUnavailableError {
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
      : ' No fallback route is available: set LLM_FALLBACK_MODEL (or the admin fallback model) ' +
        `or configure an API key for one of: ${AUTO_FALLBACK_PREFERENCE.map((s) => s.split('/')[0]).join(', ')}.`;
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
    // default model are resolved FRESH here (DB override ?? env) so
    // admin changes apply within ~1s with no redeploy.
    const defaults = this.resolveDefaults();
    const providerMode = defaults.providerMode;
    // 'default' is the sentinel some resolvers (e.g. resolveEvaluationModel)
    // emit when neither a DB override nor an env var configures a model. It
    // means "use the stack default" — without this guard the literal string
    // would be shipped to the provider as a model id.
    const explicitModel = options?.visionModel || options?.model;
    const rawModel = (explicitModel && explicitModel !== 'default' ? explicitModel : undefined) || defaults.model;
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
    );
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
    };
    const candidatesFor = (credentialFailure: boolean): FallbackCandidate[] =>
      this.buildFallbackCandidates({
        primaryModel: model,
        primaryProviderType: providerNamePreByok,
        providerMode,
        defaultModel: defaults.model,
        credentialFailure,
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
        providerType = this.resolveDirectModel(defaults.model || '')?.providerType
          ?? (defaults.providerMode === 'direct' ? 'openrouter' : defaults.providerMode);
        model = modelId;
      }
      const provider = this.createProvider(providerType, model); // system → env, NO byok
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

  /** The resolved default model (DB override ?? env). */
  getModel(): string {
    const model = this.resolveDefaults().model;
    if (!model) throw new Error('No default LLM model is configured. Set LLM_MODEL.');
    return model;
  }

  /** The resolved provider mode ('direct' | 'openrouter' | ...). */
  getProvider(): string {
    return this.resolveDefaults().providerMode;
  }
}

export const llmService = new LLMService();
