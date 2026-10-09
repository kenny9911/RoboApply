// server/src/platform/llm/egressPolicy.ts
//
// Where an LLM call would actually SEND the prompt, and whether the brand may
// send it there (TASK_PLAN.md R-13, ARCHITECTURE.md §1.8, WP-14).
//
// brandPolicy.ts decides on a (provider, base URL) pair. This file supplies the
// base URL the provider client really uses — the configured credential base
// URL, else the provider's env override, else its built-in default — so the
// decision is made on the endpoint host the request will hit, never on a
// provider name. Both directions are enforced here:
//
//   GoApply   only the domestic allowlist (deepseek, qwen, kimi, glm, doubao,
//             minimax; newapi only on an allowlisted host); no BYOK.
//   RoboApply a prompt that carries user data never reaches a mainland-China
//             endpoint (api.deepseek.com, api.moonshot.cn, MiniMax China,
//             DashScope, open.bigmodel.cn, volces.com, or a newapi gateway on
//             any of them), as primary or as fallback.
//
// A refused route throws LlmBrandPolicyError (500 brand_policy). LLMService
// logs it and never re-routes the primary call; fallback hops that the policy
// refuses are simply dropped from the chain.

import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.js';
import {
  LlmBrandPolicyError,
  checkLlmRoute,
  hostOf,
  type EnvLike,
  type LlmPolicyDecision,
} from './brandPolicy.js';

/**
 * Built-in base URL of each provider client when neither the credential nor
 * the env names one. Mirrors the provider classes in services/llm/ (kept here
 * so the policy has no SDK import). `null` = the SDK's own default host.
 */
export const PROVIDER_DEFAULT_BASE_URLS: Record<string, string | null> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com',
  gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  kimi: 'https://api.moonshot.cn/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com',
  minimax: 'https://api.minimax.chat',
  ollama: 'http://localhost:11434',
  newapi: null,
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
};

/** Env overrides each provider client reads when no credential base URL is set. */
const PROVIDER_BASE_URL_ENV: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_API_BASE_URL',
  google: 'GEMINI_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  kimi: 'KIMI_API_BASE_URL',
  moonshot: 'KIMI_API_BASE_URL',
  deepseek: 'DEEPSEEK_API_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  newapi: 'NEWAPI_BASE_URL',
  qwen: 'DASHSCOPE_BASE_URL',
  dashscope: 'DASHSCOPE_BASE_URL',
  glm: 'GLM_API_BASE_URL',
  zhipu: 'GLM_API_BASE_URL',
  doubao: 'ARK_BASE_URL',
  ark: 'ARK_BASE_URL',
};

/**
 * The base URL a provider client will call: credential (system DB / BYOK)
 * base URL ?? the provider's env override ?? its built-in default.
 */
export function effectiveLlmBaseUrl(
  provider: string,
  credentialBaseUrl?: string | null,
  env: EnvLike = process.env,
): string | null {
  const explicit = (credentialBaseUrl || '').trim();
  if (explicit) return explicit;
  const p = (provider || '').trim().toLowerCase();
  const envName = PROVIDER_BASE_URL_ENV[p];
  const fromEnv = envName ? (env[envName] || '').trim() : '';
  if (fromEnv) return fromEnv;
  return PROVIDER_DEFAULT_BASE_URLS[p] ?? null;
}

export interface LlmEgressInput {
  brand: BrandId | Pick<ProductBrand, 'id' | 'llmProfile'>;
  /** Provider type as LLMService knows it ('deepseek', 'openrouter', 'qwen', …). */
  provider: string;
  /** The credential's base URL (system DB / BYOK row), when one is configured. */
  credentialBaseUrl?: string | null;
  model?: string | null;
  /** The call uses the user's own key. */
  byok?: boolean;
  /** Whether the prompt carries user data (default true: assume it does). */
  carriesUserData?: boolean;
  env?: EnvLike;
}

export interface LlmEgressDecision {
  allowed: boolean;
  /** The endpoint host the call would reach (null when unknown). */
  host: string | null;
  baseUrl: string | null;
  code?: Exclude<LlmPolicyDecision, { allowed: true }>['code'];
  reason?: string;
}

function brandOf(brand: LlmEgressInput['brand']): Pick<ProductBrand, 'id' | 'llmProfile'> {
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

/** Decide one route on its real endpoint host (primary or fallback). */
export function checkLlmEgress(input: LlmEgressInput): LlmEgressDecision {
  const env = input.env ?? process.env;
  const baseUrl = effectiveLlmBaseUrl(input.provider, input.credentialBaseUrl, env);
  const decision = checkLlmRoute({
    brand: brandOf(input.brand),
    provider: input.provider,
    baseUrl,
    model: input.model ?? null,
    byok: input.byok,
    carriesUserData: input.carriesUserData,
    env,
  });
  if (decision.allowed) return { allowed: true, host: decision.host ?? hostOf(baseUrl), baseUrl };
  return { allowed: false, host: decision.host, baseUrl, code: decision.code, reason: decision.reason };
}

/** Throwing form: LlmBrandPolicyError when the route is refused. */
export function assertLlmEgress(input: LlmEgressInput): LlmEgressDecision {
  const decision = checkLlmEgress(input);
  if (!decision.allowed) {
    throw new LlmBrandPolicyError(decision.code ?? 'missing_route', decision.reason ?? 'Route refused.', decision.host);
  }
  return decision;
}

/* ── OpenRouter upstreams (RoboApply) ─────────────────────────────────────── */

/**
 * OpenRouter upstream providers that serve from mainland China. The first-hop
 * host check above only sees `openrouter.ai`; OpenRouter may then forward the
 * prompt to the vendor's own API. These slugs are sent as
 * `provider.ignore` on every OpenRouter request, so a RoboApply prompt never
 * reaches a mainland endpoint through OpenRouter either.
 *
 * Source: OpenRouter `GET /api/v1/providers`, read 2026-10-10. Listed: every
 * provider whose `datacenters` include CN (alibaba), or whose headquarters is
 * CN with no datacenter listed (deepseek, baidu, streamlake). CN-headquartered
 * providers that list only offshore datacenters (tencent: SG; xiaomi: SG, NL;
 * nex-agi: SG) are not excluded. Re-check this list with the providers
 * endpoint when the quarterly `verify:llm` check runs.
 */
export const OPENROUTER_MAINLAND_UPSTREAMS: readonly string[] = ['deepseek', 'alibaba', 'baidu', 'streamlake'];

/**
 * The `provider.ignore` list for an OpenRouter request: the mainland
 * upstreams above plus any extra slugs in OPENROUTER_IGNORE_PROVIDERS (comma
 * list). The env can only add to the list, never remove from it.
 */
export function openRouterIgnoredUpstreams(env: EnvLike = process.env): string[] {
  const extra = (env.OPENROUTER_IGNORE_PROVIDERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...OPENROUTER_MAINLAND_UPSTREAMS, ...extra])];
}

/** The `provider` preferences object for an OpenRouter chat-completions body. */
export function openRouterProviderPreferences(env: EnvLike = process.env): { ignore: string[] } {
  return { ignore: openRouterIgnoredUpstreams(env) };
}
