// server/src/features/match/scorerRoute.ts
//
// Brand LLM-route check for the fit scorer (owner ruling D5;
// GOAPPLY_PARITY_PLAN.md §3.3). The scorer model comes from the per-brand
// resolver (`getTaskModel('matching')`, else the brand's default: GoApply's
// own CN_ value when set, else the shared one). Before any scorer call MATCH
// asks whether that model's route is allowed for the brand; when it is not
// the answer is "no model": the pre-score labelled "Quick estimate"
// (`ai_unavailable`), and the precompute cron skips. LLMService stays the
// authoritative check; this one keeps MATCH from queueing work it would
// refuse.
//
// What is refused: for RoboApply, a mainland-China endpoint (user data never
// goes there). For GoApply nothing by default (it may use every route
// RoboApply uses, plus its domestic vendors); behind the domestic-only wall
// (CN_LLM_DOMESTIC_ONLY) every route that is not a mainland one; and, on its
// own domestic stack, a bare model id with no provider of its own (no route).
//
// Pure: the provider is read from the model id's routing prefix — resolved
// for the brand's EFFECTIVE LLM profile exactly as LLMService resolves it
// (`resolveSelectorRoute`: on the global profile `qwen/…` is an OpenRouter
// vendor slug, on the domestic one the native DashScope provider) — else the
// brand's provider mode; the endpoint is the provider's env base URL (the same
// variables lib/llm/systemCredentials.ts reads), else its default host.

import { checkLlmRoute, type EnvLike, type LlmRoute } from '../../platform/llm/brandPolicy.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { DEFAULT_PROVIDER_MODE, resolveProviderPrefix, resolveSelectorRoute } from '../../services/llm/providerPrefixes.js';

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

/**
 * The provider and endpoint a scorer model id resolves to. `defaultProvider`
 * is the brand's provider mode for an id without a routing prefix; with none,
 * the global profile uses OpenRouter and the domestic one has no route
 * (provider '').
 */
export function scorerRoute(
  model: string,
  defaultProvider: string | null | undefined,
  env: EnvLike = process.env,
  profile: LlmProfile = 'global',
  defaultModel?: string | null,
): LlmRoute {
  const mode = (defaultProvider || '').trim().toLowerCase() || (profile === 'domestic_cn' ? '' : DEFAULT_PROVIDER_MODE);
  const provider = resolveSelectorRoute(model, mode, defaultModel, profile).providerType;
  const envKey = BASE_URL_ENV[provider];
  const baseUrl = envKey ? env[envKey]?.trim() || null : null;
  return { provider, baseUrl, model };
}

/**
 * May the scorer send this user's (PII-stripped) resume to `model` on `brand`?
 * `profile` is the brand's effective LLM profile (default: the registry one).
 */
export function scorerRouteAllowed(
  brand: Pick<ProductBrand, 'id' | 'llmProfile'>,
  model: string,
  defaultProvider: string | null | undefined,
  env: EnvLike = process.env,
  profile: LlmProfile = brand.llmProfile,
  defaultModel?: string | null,
): boolean {
  return checkLlmRoute({ ...scorerRoute(model, defaultProvider, env, profile, defaultModel), brand, carriesUserData: true, env }).allowed;
}

/** How an id without a routing prefix is routed for the brand (the rule LLMService uses). */
async function routingDefaultsFor(brand: Pick<ProductBrand, 'id'>, env: EnvLike) {
  const { getLlmRoutingDefaults } = await import('../../lib/llm/llmModels.js');
  return getLlmRoutingDefaults(brand.id, env);
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
 * The provider mode for an unprefixed model id on this brand, for both brands
 * from the same resolver (lib/llm getLlmRoutingDefaults): the brand's provider
 * setting (GoApply: its own CN_LLM_PROVIDER or admin override, else the shared
 * one), else OpenRouter. Null only for GoApply on its own domestic stack with
 * no provider of its own: a bare id then has no route and is refused.
 */
export async function defaultProviderFor(brand: Pick<ProductBrand, 'id' | 'llmProfile'>, env: EnvLike = process.env): Promise<string | null> {
  try {
    return (await routingDefaultsFor(brand, env)).providerMode || null;
  } catch {
    return null;
  }
}

/** The production check: the brand's effective profile, provider mode and default model. Fails closed. */
export async function defaultScorerRouteAllowed(brand: Pick<ProductBrand, 'id' | 'llmProfile'>, model: string, env: EnvLike = process.env): Promise<boolean> {
  try {
    const defaults = await routingDefaultsFor(brand, env);
    return scorerRouteAllowed(brand, model, defaults.providerMode || null, env, defaults.profile, defaults.model);
  } catch {
    return false;
  }
}
