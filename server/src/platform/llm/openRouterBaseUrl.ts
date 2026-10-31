// server/src/platform/llm/openRouterBaseUrl.ts
//
// The endpoint the OpenRouter client calls, read in one place so the client,
// the env credential and the egress checks agree on the host.
//
//   OPENROUTER_BASE_URL      the API root as OpenRouter publishes it
//                            (`https://openrouter.ai/api`); may point at any
//                            other OpenAI-compatible provider. The client gets
//                            the root with `/v1` added (see below).
//   OPENROUTER_API_BASE_URL  the older variable: the full endpoint, used as
//                            given. OPENROUTER_BASE_URL wins when both are set.

import type { EnvLike } from './brandPolicy.js';

/** Endpoint when neither variable (nor a credential base URL) is set. */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** A path segment that names an API version: v1, v4, v1beta, v2alpha1. */
const VERSION_SEGMENT = /^v\d+[a-z]*\d*$/i;

/**
 * The OpenAI-compatible endpoint for an API root: `/v1` is added unless the
 * path already names a version (`/api/v1`, `/compatible-mode/v1`,
 * `/v1beta/openai`), and the bare openrouter.ai host gets `/api/v1`. A value
 * that does not parse as a URL is returned trimmed.
 */
export function openAICompatibleBaseUrl(root: string): string {
  const trimmed = root.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.some((s) => VERSION_SEGMENT.test(s))) return trimmed;
  if (segments.length === 0 && url.hostname.toLowerCase() === 'openrouter.ai') segments.push('api');
  url.pathname = `/${[...segments, 'v1'].join('/')}`;
  return url.toString();
}

/**
 * The OpenRouter endpoint configured in env, or undefined when neither
 * variable is set.
 */
export function openRouterBaseUrlFromEnv(env: EnvLike = process.env): string | undefined {
  const root = (env.OPENROUTER_BASE_URL || '').trim();
  if (root) return openAICompatibleBaseUrl(root);
  return (env.OPENROUTER_API_BASE_URL || '').trim() || undefined;
}
