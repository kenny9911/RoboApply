// backend/src/lib/anthropicClientFactory.ts
//
// Shared Anthropic-SDK client builder for our two DIRECT-SDK Claude surfaces:
// Agent Alex's ClaudeAgentService and Alan's AlanService. (RoboApply V2,
// matching, market insights, etc. go through LLMService/OpenRouter — a
// different code path that does NOT use this builder.)
//
// Routing is selected by ANTHROPIC_BASE_URL:
//
//   • UNSET → direct api.anthropic.com. Auth = `x-api-key` (ANTHROPIC_API_KEY).
//     Models must be the BARE DASHED Anthropic ids, e.g. `claude-opus-4-8`.
//
//   • a URL containing `openrouter.ai` → OpenRouter's Anthropic-Messages-
//     compatible endpoint. OpenRouter authenticates with
//     `Authorization: Bearer <OPENROUTER_API_KEY>`, NOT the `x-api-key` header
//     the SDK derives from `apiKey`. So we pass the OpenRouter key as the SDK's
//     `authToken` (→ Bearer) and suppress `x-api-key` (`apiKey: null`). Models
//     must be the PREFIXED OpenRouter SLUGS, e.g. `anthropic/claude-opus-4.8`.
//     IMPORTANT: set ANTHROPIC_BASE_URL to the host root `https://openrouter.ai/api`
//     (NOT `.../api/v1`) — the SDK appends `/v1/messages` itself, so `.../api/v1`
//     would produce a doubled `/v1/v1/messages` and 404.
//
//   • ANY OTHER URL → a custom proxy. Auth = `x-api-key` plus the shared
//     `X-Proxy-Key: <LLM_PROXY_KEY>` header (symmetry with the Gemini proxy).
//
// modelPricing.ts already normalises the prefixed/dotted OpenRouter slugs back
// to their dashed lookup keys, so cost tracking works on either path.

import Anthropic from '@anthropic-ai/sdk';

const OPENROUTER_HOST = 'openrouter.ai';

/** True when the base URL points at OpenRouter (Bearer-auth, prefixed slugs). */
export function isOpenRouterBaseUrl(baseURL: string | undefined): boolean {
  return !!baseURL && baseURL.includes(OPENROUTER_HOST);
}

export interface AnthropicClientConfig {
  /** ANTHROPIC_API_KEY — used as `x-api-key` on the direct + custom-proxy paths. */
  apiKey: string;
  /** ANTHROPIC_BASE_URL — selects the routing (see file header). */
  baseURL?: string;
  /** LLM_PROXY_KEY → `X-Proxy-Key` header (custom-proxy path only). */
  proxyKey?: string;
  /**
   * OpenRouter Bearer key for the OpenRouter route. Callers should pass the
   * RESOLVED key (system DB key from the admin LLM settings → env, e.g. via
   * agentAlex/config getOpenRouterApiKey()) — the env read below is only the
   * last-resort fallback for callers that don't.
   */
  openRouterApiKey?: string;
}

export function buildAnthropicClient(cfg: AnthropicClientConfig): Anthropic {
  const { apiKey, baseURL, proxyKey } = cfg;

  if (isOpenRouterBaseUrl(baseURL)) {
    const orKey = cfg.openRouterApiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim();
    if (!orKey) {
      throw new Error(
        'ANTHROPIC_BASE_URL points at OpenRouter but no OpenRouter key is configured — ' +
          'OpenRouter authenticates with a Bearer OpenRouter key, not the Anthropic x-api-key. ' +
          'Set one on the admin LLM settings page or via OPENROUTER_API_KEY.',
      );
    }
    // authToken → `Authorization: Bearer <orKey>`; apiKey:null suppresses x-api-key.
    return new Anthropic({ baseURL, apiKey: null, authToken: orKey });
  }

  return new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(baseURL && proxyKey ? { defaultHeaders: { 'X-Proxy-Key': proxyKey } } : {}),
  });
}
