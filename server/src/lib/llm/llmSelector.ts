/**
 * Parse a caller-supplied `llm` selector string into an explicit
 * `{ provider, model }` pair for a single LLM call.
 *
 * The selector is the public, routing-aware way to pin ONE agent call to a
 * specific provider + model without touching the DB/env LLM settings. It is the
 * value behind the optional `llm` parameter on ResumeMatchAgent.match(),
 * MatchAgent.match(), and UnifiedEvaluationAgent (via UnifiedExecuteOptions.llm).
 * When no selector is supplied, callers fall back to their normal
 * DB-override ?? env resolution (`getModelSetting(...)`), so behaviour is
 * unchanged.
 *
 * Format: the FIRST path segment is a routing hint; everything after the first
 * slash is the model id the upstream provider actually expects.
 *
 *   "deepseek/deepseek-v4-pro"                → DeepSeek DIRECT, model "deepseek-v4-pro"
 *   "google/gemini-3-flash-preview"           → Google DIRECT,   model "gemini-3-flash-preview"
 *   "openrouter/deepseek/deepseek-v4-pro"     → OpenRouter,       model "deepseek/deepseek-v4-pro"
 *   "openrouter/google/gemini-3-flash-preview"→ OpenRouter,       model "google/gemini-3-flash-preview"
 *
 * We return an EXPLICIT `provider` (rather than leaving the routing implicit in
 * the model prefix) so the call routes identically regardless of the deploy's
 * `LLM_PROVIDER` mode — the explicit-provider branch in
 * `LLMService.chatWithUsage` is the highest-precedence path.
 *
 * Mirrors LLMService's own `DIRECT_PROVIDER_PREFIXES` + `PROVIDER_PREFIX_ALIASES`
 * (kept in lock-step — if you add a provider there, add it here).
 */

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

// `gemini/…` is accepted as a synonym for the `google` provider (Google's native
// SDK is Gemini-branded) — same alias LLMService applies in resolveDirectModel.
const PROVIDER_PREFIX_ALIASES: Record<string, string> = {
  gemini: 'google',
};

export interface LlmSelector {
  /** The model id the upstream provider expects (routing prefix stripped). */
  model: string;
  /** Explicit provider to construct, or undefined to let default routing decide
   *  (when the selector had no recognized provider prefix). */
  provider?: string;
}

/**
 * Parse an `llm` selector. Returns `null` for empty/blank input so callers can
 * cleanly fall through to their DB/env model resolution.
 *
 *   parseLlmSelector('deepseek/deepseek-v4-pro')
 *     → { provider: 'deepseek', model: 'deepseek-v4-pro' }
 *   parseLlmSelector('openrouter/google/gemini-3-flash-preview')
 *     → { provider: 'openrouter', model: 'google/gemini-3-flash-preview' }
 *   parseLlmSelector('gpt-5.4-mini')        // no provider prefix
 *     → { model: 'gpt-5.4-mini' }           // provider left to default routing
 *   parseLlmSelector('')                    → null
 */
export function parseLlmSelector(llm?: string | null): LlmSelector | null {
  const raw = (llm ?? '').trim();
  if (raw.length === 0) return null;

  const slashIdx = raw.indexOf('/');
  if (slashIdx < 0) {
    // Bare model id, no routing prefix — pass through as a model-only override.
    return { model: raw };
  }

  const head = raw.substring(0, slashIdx).toLowerCase();
  const rest = raw.substring(slashIdx + 1);
  if (rest.length === 0) return { model: raw };

  const provider = PROVIDER_PREFIX_ALIASES[head] ?? head;
  if (!DIRECT_PROVIDER_PREFIXES.has(provider)) {
    // Unrecognized prefix (e.g. a bare "vendor/model" OpenRouter slug) — keep
    // the whole string as the model and let default routing handle it.
    return { model: raw };
  }

  // Recognized provider prefix (incl. 'openrouter'): route explicitly to that
  // provider, with the routing hint stripped from the model id.
  return { provider, model: rest };
}
