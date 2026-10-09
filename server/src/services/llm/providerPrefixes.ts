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
 * pin the native provider on the domestic profile (GoApply), where OpenRouter
 * is never used. On RoboApply `qwen/qwen3.8-flash` keeps meaning the OpenRouter
 * slug it always meant; `dashscope/…` is the unambiguous native spelling.
 */
export const DOMESTIC_ONLY_PREFIXES = new Set(['qwen']);

/**
 * Resolve the first segment of a selector to a provider type, or null when it
 * is not a routing hint for this profile.
 *   resolveProviderPrefix('gemini')             → 'google'
 *   resolveProviderPrefix('qwen')               → null        (global profile)
 *   resolveProviderPrefix('qwen', 'domestic_cn') → 'qwen'
 */
export function resolveProviderPrefix(prefix: string, profile: 'global' | 'domestic_cn' = 'global'): string | null {
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
