// server/src/features/match/scorerRoute.ts
//
// Brand LLM-route check for the fit scorer (TASK_PLAN.md R-13; CN_TW_LAUNCH
// L-3). The scorer model comes from `getTaskModel('matching')`, which is the
// same for both brands until WP-14 resolves it per brand. Before any scorer
// call MATCH asks whether that model's route is allowed for the current
// brand; when it is not (e.g. a GoApply user and an international model) the
// answer is "no model" — the pre-score labelled "Quick estimate"
// (`ai_unavailable`) and the precompute cron skips. WP-14's enforcement
// inside LLMService stays the authoritative check; this one keeps MATCH from
// sending a GoApply resume abroad even before that lands.
//
// Pure: the provider is read from the model id's routing prefix, else the
// configured default provider; the endpoint is the provider's env base URL,
// else its default host.

import { checkLlmRoute, type EnvLike, type LlmRoute } from '../../platform/llm/brandPolicy.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { DIRECT_PROVIDER_PREFIXES, PROVIDER_PREFIX_ALIASES } from '../../services/llm/providerPrefixes.js';

/** Env var holding each provider's base URL override (mirrors lib/llm/systemCredentials.ts). */
const BASE_URL_ENV: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_API_BASE_URL',
  google: 'GEMINI_BASE_URL',
  kimi: 'KIMI_API_BASE_URL',
  moonshot: 'KIMI_API_BASE_URL',
  deepseek: 'DEEPSEEK_API_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  newapi: 'NEWAPI_BASE_URL',
};

/** The provider named by the model id's routing prefix (`openrouter/…`, `deepseek/…`), or null. */
export function prefixedProvider(model: string): string | null {
  const head = model.includes('/') ? model.slice(0, model.indexOf('/')).trim().toLowerCase() : '';
  const p = PROVIDER_PREFIX_ALIASES[head] ?? head;
  return p && DIRECT_PROVIDER_PREFIXES.has(p) ? p : null;
}

/** The provider and endpoint a scorer model id resolves to. */
export function scorerRoute(model: string, defaultProvider: string | null | undefined, env: EnvLike = process.env): LlmRoute {
  let provider = prefixedProvider(model) ?? (defaultProvider || 'openrouter').trim().toLowerCase();
  // LLMService's 'direct' mode sends an unprefixed vendor/model id to OpenRouter.
  if (provider === 'direct') provider = 'openrouter';
  const envKey = BASE_URL_ENV[provider];
  const baseUrl = envKey ? env[envKey]?.trim() || null : null;
  return { provider, baseUrl, model };
}

/** May the scorer send this user's (PII-stripped) resume to `model` on `brand`? */
export function scorerRouteAllowed(
  brand: Pick<ProductBrand, 'id' | 'llmProfile'>,
  model: string,
  defaultProvider: string | null | undefined,
  env: EnvLike = process.env,
): boolean {
  return checkLlmRoute({ ...scorerRoute(model, defaultProvider, env), brand, carriesUserData: true, env }).allowed;
}

/** The configured default provider (LLM_PROVIDER, DB override first); null when unreadable. */
export async function configuredDefaultProvider(): Promise<string | null> {
  try {
    const { getProviderSetting } = await import('../../lib/llm/llmModels.js');
    return getProviderSetting() ?? null;
  } catch {
    return null;
  }
}

/** The production check: reads the default provider only when the model id names none. Fails closed. */
export async function defaultScorerRouteAllowed(brand: Pick<ProductBrand, 'id' | 'llmProfile'>, model: string): Promise<boolean> {
  try {
    const fallback = prefixedProvider(model) ? null : await configuredDefaultProvider();
    return scorerRouteAllowed(brand, model, fallback);
  } catch {
    return false;
  }
}
