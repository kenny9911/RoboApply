// Leaf module (no imports, no side effects) holding the provider-routing
// prefixes a model id may carry. LLMService uses them to strip the routing hint
// before calling upstream; tooling that has to predict which id a selector will
// actually be BILLED under needs the same knowledge, and importing LLMService
// for it would drag in the whole provider stack and the log-file initialiser.

/** Provider types a `<provider>/<model>` routing hint may name (after aliasing). */
export const DIRECT_PROVIDER_PREFIXES = new Set([
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
  // Domestic (mainland-China) OpenAI-compatible vendors, WP-14 (TASK_PLAN R-13).
  'qwen',
  'glm',
  'doubao',
]);

// Provider-prefix aliases: the model-id prefix a caller may use differs from the
// internal provider key. Google's native SDK is Gemini-branded, so `gemini/…` is
// accepted as a synonym for the `google` provider (e.g. `gemini/gemini-3-flash-preview`
// → Google direct). Normalized in resolveDirectModel before the prefix is matched.
// The domestic vendors answer to their platform names too: Alibaba Model Studio
// (`dashscope/` → qwen), Zhipu (`zhipu/` → glm) and Volcano Engine Ark
// (`ark/` → doubao).
export const PROVIDER_PREFIX_ALIASES: Record<string, string> = {
  gemini: 'google',
  dashscope: 'qwen',
  zhipu: 'glm',
  ark: 'doubao',
};

/**
 * Prefixes that are ALSO an OpenRouter vendor namespace and therefore only
 * pin the native provider on the domestic profile (GoApply with its own
 * provider). On the global profile `qwen/qwen3.8-flash` keeps meaning the
 * OpenRouter slug it always meant; `dashscope/…` is the unambiguous native
 * spelling.
 */
export const DOMESTIC_ONLY_PREFIXES = new Set(['qwen']);

/** The spelling of a domestic-only prefix that names the native provider on every profile. */
const UNAMBIGUOUS_PREFIX: Record<string, string> = { qwen: 'dashscope' };

/** The provider mode used when neither the admin override nor LLM_PROVIDER names one. */
export const DEFAULT_PROVIDER_MODE = 'openrouter';

export type LlmSelectorProfile = 'global' | 'domestic_cn';

/**
 * Resolve the first segment of a selector to a provider type, or null when it
 * is not a routing hint for this profile.
 *   resolveProviderPrefix('gemini')             → 'google'
 *   resolveProviderPrefix('qwen')               → null        (global profile)
 *   resolveProviderPrefix('qwen', 'domestic_cn') → 'qwen'
 */
export function resolveProviderPrefix(prefix: string, profile: LlmSelectorProfile = 'global'): string | null {
  const lower = (prefix || '').trim().toLowerCase();
  if (!lower) return null;
  if (DOMESTIC_ONLY_PREFIXES.has(lower) && profile !== 'domestic_cn') return null;
  const providerType = PROVIDER_PREFIX_ALIASES[lower] ?? lower;
  return DIRECT_PROVIDER_PREFIXES.has(providerType) ? providerType : null;
}

/** Normalize a configured provider name (`LLM_PROVIDER`, `CN_LLM_PROVIDER`) to its provider type. */
export function normalizeProviderType(provider: string): string {
  const lower = (provider || '').trim().toLowerCase();
  return PROVIDER_PREFIX_ALIASES[lower] ?? lower;
}

/* ── Selector → route (one rule; LLMService and the tooling both use it) ──── */

export interface SelectorRoute {
  /** Provider type, or '' when the selector has no route (bare id, no provider mode). */
  providerType: string;
  /** The model id the upstream provider expects. */
  model: string;
}

/**
 * Drop a leading `<provider>/` when it names the provider being called:
 *   "google/gemini-3-flash-preview" + google     → "gemini-3-flash-preview"
 *   "google/gemini-3-flash-preview" + openrouter → unchanged (a real OpenRouter id)
 */
export function stripProviderPrefix(model: string, provider: string): string {
  const slash = model.indexOf('/');
  if (slash < 0) return model;
  return model.substring(0, slash).toLowerCase() === provider.toLowerCase() ? model.substring(slash + 1) : model;
}

/** `<provider>/<model>` when the first segment is a routing hint for this profile, else null. */
export function splitSelectorPrefix(rawModel: string, profile: LlmSelectorProfile = 'global'): SelectorRoute | null {
  const slash = rawModel.indexOf('/');
  if (slash < 0) return null;
  const providerType = resolveProviderPrefix(rawModel.substring(0, slash), profile);
  return providerType ? { providerType, model: rawModel.substring(slash + 1) } : null;
}

/**
 * Where a configured selector goes, with no explicit per-call provider:
 *   1. a recognised prefix pins its provider (`openrouter/…` included),
 *      whatever the provider mode says;
 *   2. mode `direct`: `vendor/model` → OpenRouter; a bare id → the provider of
 *      the default model's prefix, else OpenRouter;
 *   3. no provider mode: no route (providerType '');
 *   4. otherwise the provider mode.
 */
export function resolveSelectorRoute(
  rawModel: string,
  providerMode: string,
  defaultModel?: string | null,
  profile: LlmSelectorProfile = 'global',
): SelectorRoute {
  const direct = splitSelectorPrefix(rawModel, profile);
  if (direct) return direct;
  if (providerMode === 'direct') {
    if (rawModel.includes('/')) return { providerType: 'openrouter', model: rawModel };
    return { providerType: splitSelectorPrefix(defaultModel || '', profile)?.providerType ?? 'openrouter', model: rawModel };
  }
  if (!providerMode) return { providerType: '', model: rawModel };
  return { providerType: providerMode, model: stripProviderPrefix(rawModel, providerMode) };
}

/**
 * A selector of the SHARED stack, spelled so that it routes exactly as it does
 * there under any provider mode, default model and profile (plan §3.3, "mixed
 * case"). GoApply with its own provider reads a setting it has not overridden
 * from the shared stack; unqualified, `gpt-6-luna` would be sent to GoApply's
 * own provider and `qwen/qwen3.8-flash` (an OpenRouter id) to DashScope.
 *
 *   qualifySelector('gpt-6-luna', 'openrouter')              → 'openrouter/gpt-6-luna'
 *   qualifySelector('qwen/qwen3.8-flash', 'openrouter')      → 'openrouter/qwen/qwen3.8-flash'
 *   qualifySelector('google/gemini-3.8-flash', 'openrouter') → unchanged (already pinned)
 *   qualifySelector('gpt-6-luna', 'direct', 'openai/gpt-6')  → 'openai/gpt-6-luna'
 *
 * `sharedProviderMode` and `sharedDefaultModel` are the shared stack's own
 * values. A provider that is not a routing prefix cannot be pinned; the
 * selector is then returned as it is.
 */
export function qualifySelector(raw: string, sharedProviderMode?: string | null, sharedDefaultModel?: string | null): string {
  const selector = (raw || '').trim();
  if (!selector) return selector;
  const mode = normalizeProviderType(sharedProviderMode || '') || DEFAULT_PROVIDER_MODE;
  const route = resolveSelectorRoute(selector, mode, sharedDefaultModel, 'global');
  if (!route.providerType) return selector;
  const prefix = UNAMBIGUOUS_PREFIX[route.providerType] ?? route.providerType;
  if (resolveProviderPrefix(prefix, 'global') !== route.providerType) return selector;
  return `${prefix}/${route.model}`;
}

/**
 * A selector written for the domestic profile, spelled so that it keeps its
 * meaning on the global one: `qwen/qwen-plus` (DashScope on GoApply's own
 * stack) becomes `dashscope/qwen-plus`. Anything else is returned as it is.
 */
export function pinDomesticSelector(raw: string): string {
  const slash = raw.indexOf('/');
  if (slash <= 0) return raw;
  const unambiguous = UNAMBIGUOUS_PREFIX[raw.substring(0, slash).trim().toLowerCase()];
  return unambiguous ? `${unambiguous}/${raw.substring(slash + 1)}` : raw;
}
