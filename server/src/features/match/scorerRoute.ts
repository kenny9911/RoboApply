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
// Pure: the provider is read from the model id's routing prefix — resolved
// for the brand's LLM profile exactly as LLMService resolves it
// (`resolveProviderPrefix`: on RoboApply `qwen/…` is an OpenRouter vendor
// slug, on GoApply the native DashScope provider) — else the configured
// default provider; the endpoint is the provider's env base URL (the same
// variables lib/llm/systemCredentials.ts reads), else its default host.

import { checkLlmRoute, type EnvLike, type LlmRoute } from '../../platform/llm/brandPolicy.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { resolveProviderPrefix } from '../../services/llm/providerPrefixes.js';

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
  // Domestic vendors (WP-14); aliases resolve to these keys first.
  qwen: 'DASHSCOPE_BASE_URL',
  dashscope: 'DASHSCOPE_BASE_URL',
  glm: 'GLM_API_BASE_URL',
  zhipu: 'GLM_API_BASE_URL',
  doubao: 'ARK_BASE_URL',
  ark: 'ARK_BASE_URL',
};

type LlmProfile = Pick<ProductBrand, 'llmProfile'>['llmProfile'];

/**
 * The provider named by the model id's routing prefix (`openrouter/…`,
 * `deepseek/…`) for this LLM profile, or null. A prefix that is only an
 * OpenRouter vendor namespace on the global profile (`qwen/…`) names no
 * provider there, as in LLMService.
 */
export function prefixedProvider(model: string, profile: LlmProfile = 'global'): string | null {
  const head = model.includes('/') ? model.slice(0, model.indexOf('/')).trim().toLowerCase() : '';
  return head ? resolveProviderPrefix(head, profile) : null;
}

/** The provider and endpoint a scorer model id resolves to. */
export function scorerRoute(
  model: string,
  defaultProvider: string | null | undefined,
  env: EnvLike = process.env,
  profile: LlmProfile = 'global',
): LlmRoute {
  let provider = prefixedProvider(model, profile) ?? (defaultProvider || 'openrouter').trim().toLowerCase();
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
  return checkLlmRoute({ ...scorerRoute(model, defaultProvider, env, brand.llmProfile), brand, carriesUserData: true, env }).allowed;
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

/**
 * The default provider for an unprefixed model id on this brand. RoboApply:
 * the configured `LLM_PROVIDER` (DB override first). GoApply: its own
 * `CN_LLM_PROVIDER` only (R-03 brandEnv, no fallback to the global setting);
 * unset → null, which resolves to OpenRouter and is refused (fails closed).
 */
export async function defaultProviderFor(brand: Pick<ProductBrand, 'id' | 'llmProfile'>, env: EnvLike = process.env): Promise<string | null> {
  if (brand.llmProfile === 'domestic_cn') return env.CN_LLM_PROVIDER?.trim().toLowerCase() || null;
  return configuredDefaultProvider();
}

/** The production check: reads the brand's default provider only when the model id names none. Fails closed. */
export async function defaultScorerRouteAllowed(brand: Pick<ProductBrand, 'id' | 'llmProfile'>, model: string, env: EnvLike = process.env): Promise<boolean> {
  try {
    const fallback = prefixedProvider(model, brand.llmProfile) ? null : await defaultProviderFor(brand, env);
    return scorerRouteAllowed(brand, model, fallback, env);
  } catch {
    return false;
  }
}
