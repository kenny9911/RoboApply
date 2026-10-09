// server/src/platform/llm/brandPolicy.ts
//
// Pure LLM routing policy per brand (TASK_PLAN.md R-13, CN_TW_LAUNCH_PLAN.md
// L-3). No I/O; WP-14 wires it into LLMService (primary and every fallback).
//
// GoApply (`llmProfile: 'domestic_cn'`):
//   - may call only the domestic vendors deepseek, qwen/DashScope, kimi
//     (Moonshot), glm (Zhipu), doubao (Volcano Ark) and minimax (China);
//   - `newapi` (an OpenAI-compatible gateway) only when its base host is on
//     the domestic allowlist (the vendor hosts above plus
//     `CN_LLM_DOMESTIC_HOSTS`, for a self-hosted mainland gateway);
//   - an explicit base URL must itself be domestic (e.g. MiniMax's
//     international host `api.minimax.io` is refused);
//   - no fallback to international models, no BYOK.
//
// RoboApply (`llmProfile: 'global'`), the reverse rule: a prompt that carries
// user data never resolves to a mainland-China endpoint, as primary or as a
// fallback. Matching is by endpoint host, not provider name, so OpenRouter
// serving a DeepSeek model (host openrouter.ai) is allowed while the direct
// DeepSeek API (api.deepseek.com) is not.

import type { ProductBrand } from '../brand/registry.js';

export type EnvLike = Record<string, string | undefined>;

/** Provider ids GoApply may name directly (aliases map to the same vendor). */
export const GOAPPLY_DIRECT_PROVIDERS = [
  'deepseek',
  'qwen',
  'dashscope',
  'kimi',
  'moonshot',
  'glm',
  'zhipu',
  'doubao',
  'ark',
  'minimax',
] as const;

/** Default API host per provider id (used when no base URL is configured). */
export const PROVIDER_DEFAULT_HOSTS: Record<string, string> = {
  deepseek: 'api.deepseek.com',
  qwen: 'dashscope.aliyuncs.com',
  dashscope: 'dashscope.aliyuncs.com',
  kimi: 'api.moonshot.cn',
  moonshot: 'api.moonshot.cn',
  glm: 'open.bigmodel.cn',
  zhipu: 'open.bigmodel.cn',
  doubao: 'ark.cn-beijing.volces.com',
  ark: 'ark.cn-beijing.volces.com',
  minimax: 'api.minimaxi.com',
  openrouter: 'openrouter.ai',
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
};

/**
 * Mainland-China model endpoints (exact host or any subdomain). Used both as
 * GoApply's domestic allowlist and as RoboApply's egress denylist.
 */
export const MAINLAND_LLM_HOST_SUFFIXES = [
  'api.deepseek.com',
  'deepseek.com',
  // Only the mainland DashScope host: `dashscope-intl.aliyuncs.com` is Singapore.
  'dashscope.aliyuncs.com',
  'api.moonshot.cn',
  'moonshot.cn',
  'open.bigmodel.cn',
  'bigmodel.cn',
  'volces.com',
  'volcengineapi.com',
  'api.minimaxi.com',
  'minimaxi.com',
  'api.minimax.chat',
  'minimax.chat',
] as const;

export type LlmPolicyCode =
  | 'provider_not_domestic'
  | 'host_not_domestic'
  | 'newapi_host_not_allowlisted'
  | 'mainland_endpoint_for_intl'
  | 'byok_not_allowed'
  | 'missing_route';

export type LlmPolicyDecision =
  | { allowed: true; host: string | null }
  | { allowed: false; code: LlmPolicyCode; reason: string; host: string | null };

export interface LlmRoute {
  /** Provider id as LLMService knows it ('deepseek', 'openrouter', 'newapi', …). */
  provider: string;
  /** Explicit base URL when configured; otherwise the provider's default host applies. */
  baseUrl?: string | null;
  model?: string | null;
  /** True when the call uses the user's own key (BYOK). */
  byok?: boolean;
}

export interface LlmPolicyInput extends LlmRoute {
  brand: Pick<ProductBrand, 'id' | 'llmProfile'>;
  /**
   * Whether the prompt carries user data (default true). RoboApply's egress
   * rule applies only to prompts with user data; GoApply's rule always applies.
   */
  carriesUserData?: boolean;
  env?: EnvLike;
}

export class LlmBrandPolicyError extends Error {
  readonly code = 'brand_policy' as const;
  readonly policyCode: LlmPolicyCode;
  readonly host: string | null;
  constructor(policyCode: LlmPolicyCode, reason: string, host: string | null) {
    super(reason);
    this.name = 'LlmBrandPolicyError';
    this.policyCode = policyCode;
    this.host = host;
  }
}

/** Lowercase host of a URL or bare host; null when unparseable. */
export function hostOf(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  const raw = urlOrHost.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return host || null;
  } catch {
    return null;
  }
}

function matchesSuffix(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase().replace(/^\./, '');
  return host === s || host.endsWith(`.${s}`);
}

/** Extra domestic hosts for a self-hosted mainland gateway (`CN_LLM_DOMESTIC_HOSTS`, comma list). */
export function extraDomesticHosts(env: EnvLike = process.env): string[] {
  return (env.CN_LLM_DOMESTIC_HOSTS || '')
    .split(',')
    .map((h) => hostOf(h))
    .filter((h): h is string => Boolean(h));
}

export function isMainlandLlmHost(host: string | null | undefined, env: EnvLike = process.env): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return (
    MAINLAND_LLM_HOST_SUFFIXES.some((s) => matchesSuffix(h, s)) || extraDomesticHosts(env).some((s) => matchesSuffix(h, s))
  );
}

/** The host a route resolves to: the explicit base URL, else the provider default. */
export function routeHost(route: LlmRoute): string | null {
  const explicit = hostOf(route.baseUrl ?? null);
  if (explicit) return explicit;
  return PROVIDER_DEFAULT_HOSTS[route.provider.trim().toLowerCase()] ?? null;
}

export function isGoApplyDirectProvider(provider: string): boolean {
  return (GOAPPLY_DIRECT_PROVIDERS as readonly string[]).includes(provider.trim().toLowerCase());
}

/** Decide whether one route (primary or fallback) is allowed for the brand. */
export function checkLlmRoute(input: LlmPolicyInput): LlmPolicyDecision {
  const env = input.env ?? process.env;
  const provider = (input.provider || '').trim().toLowerCase();
  const host = provider ? routeHost({ ...input, provider }) : hostOf(input.baseUrl ?? null);

  if (input.brand.llmProfile === 'domestic_cn') {
    if (!provider) return deny('missing_route', 'No provider configured for this brand.', host);
    if (input.byok) return deny('byok_not_allowed', 'Personal API keys are not used on this brand.', host);
    if (provider === 'newapi') {
      if (!host || !isMainlandLlmHost(host, env)) {
        return deny('newapi_host_not_allowlisted', `Gateway host ${host ?? '(none)'} is not on the domestic allowlist.`, host);
      }
      return { allowed: true, host };
    }
    if (!isGoApplyDirectProvider(provider)) {
      return deny('provider_not_domestic', `Provider ${provider} is not allowed for this brand.`, host);
    }
    if (!host || !isMainlandLlmHost(host, env)) {
      return deny('host_not_domestic', `Endpoint ${host ?? '(none)'} is not a domestic endpoint.`, host);
    }
    return { allowed: true, host };
  }

  // Global profile (RoboApply).
  if (input.carriesUserData === false) return { allowed: true, host };
  if (host && isMainlandLlmHost(host, env)) {
    return deny('mainland_endpoint_for_intl', `Endpoint ${host} is in mainland China; user data may not go there.`, host);
  }
  return { allowed: true, host };
}

function deny(code: LlmPolicyCode, reason: string, host: string | null): LlmPolicyDecision {
  return { allowed: false, code, reason, host };
}

/** Throwing form for the primary route. */
export function assertLlmRoute(input: LlmPolicyInput): void {
  const decision = checkLlmRoute(input);
  if (!decision.allowed) throw new LlmBrandPolicyError(decision.code, decision.reason, decision.host);
}

/**
 * Filter a fallback chain to the routes the brand may use, keeping order.
 * Wave 0's chain can include `deepseek-v4-flash`; for RoboApply prompts with
 * user data a direct DeepSeek route is dropped, for GoApply every
 * international route is dropped.
 */
export function filterLlmChain<R extends LlmRoute>(
  brand: LlmPolicyInput['brand'],
  chain: readonly R[],
  options: { carriesUserData?: boolean; env?: EnvLike } = {},
): { allowed: R[]; rejected: Array<{ route: R; code: LlmPolicyCode; reason: string }> } {
  const allowed: R[] = [];
  const rejected: Array<{ route: R; code: LlmPolicyCode; reason: string }> = [];
  for (const route of chain) {
    const d = checkLlmRoute({ ...route, brand, carriesUserData: options.carriesUserData, env: options.env });
    if (d.allowed) allowed.push(route);
    else rejected.push({ route, code: d.code, reason: d.reason });
  }
  return { allowed, rejected };
}
