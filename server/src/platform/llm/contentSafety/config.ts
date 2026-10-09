// server/src/platform/llm/contentSafety/config.ts
//
// Environment → content-safety provider (WP-24).
//
//   CN_CONTENT_SAFETY_PROVIDER     keyword_only (default) | aliyun_green
//   CN_SAFETY_KEYWORDS_URL         private keyword list (https://, file:// or absolute path)
//   CN_CONTENT_SAFETY_TIMEOUT_MS   whole-check timeout (default 5000, 500–30000)
//   ALIYUN_GREEN_ACCESS_KEY_ID / ALIYUN_GREEN_ACCESS_KEY_SECRET   (vendor keys, unprefixed per R-03)
//   ALIYUN_GREEN_REGION            mainland region (default cn-shanghai)
//   ALIYUN_GREEN_ENDPOINT          optional green-cip endpoint override (mainland only)
//   ALIYUN_GREEN_INPUT_SERVICE / ALIYUN_GREEN_OUTPUT_SERVICE
//                                  default llm_query_moderation / llm_response_moderation
//
// The GoApply-scoped names are read through brandEnv(goapply, …), so there
// is no fallback to unprefixed variables. A misconfiguration never degrades
// to "no filter": it yields a provider that fails closed (GoApply AI answers
// 503 ai_unavailable) and is reported by contentSafetyReadiness().
//
// aliyun_green mode also runs the keyword list first (CN plan C-6: "Aliyun
// Green + keyword list"); a keyword block skips the Aliyun call.

import { brandEnv, type EnvSource } from '../../brand/brandEnv.js';
import {
  ALIYUN_DEFAULT_INPUT_SERVICE,
  ALIYUN_DEFAULT_OUTPUT_SERVICE,
  ALIYUN_DEFAULT_REGION,
  aliyunEndpointProblem,
  createAliyunGreenProvider,
  defaultAliyunEndpoint,
  isMainlandRegion,
  type AliyunGreenConfig,
  type AliyunGreenDeps,
} from './aliyunGreen.js';
import { createKeywordSource, keywordUrlProblem, type KeywordSourceOptions } from './keywordList.js';
import { createKeywordOnlyProvider } from './keywordOnly.js';
import {
  ContentSafetyProviderError,
  worstVerdict,
  type ContentSafetyProvider,
  type ContentSafetyResult,
} from './types.js';

export type ContentSafetyProviderKind = 'keyword_only' | 'aliyun_green';

export const DEFAULT_CONTENT_SAFETY_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;

export interface ContentSafetyConfig {
  /** The configured kind, or 'invalid' for an unknown value. */
  provider: ContentSafetyProviderKind | 'invalid';
  timeoutMs: number;
  keywordsUrl?: string;
  aliyun?: AliyunGreenConfig;
  /** Every reason the configuration cannot run; empty when usable. */
  problems: string[];
}

function str(env: EnvSource, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function resolveContentSafetyConfig(env: EnvSource = process.env): ContentSafetyConfig {
  const problems: string[] = [];
  const rawKind = brandEnv('goapply', 'CONTENT_SAFETY_PROVIDER', env)?.toLowerCase() ?? 'keyword_only';
  let provider: ContentSafetyConfig['provider'];
  if (rawKind === 'keyword_only' || rawKind === 'aliyun_green') {
    provider = rawKind;
  } else {
    provider = 'invalid';
    problems.push(`CN_CONTENT_SAFETY_PROVIDER must be keyword_only or aliyun_green (got "${rawKind}")`);
  }

  let timeoutMs = DEFAULT_CONTENT_SAFETY_TIMEOUT_MS;
  const rawTimeout = brandEnv('goapply', 'CONTENT_SAFETY_TIMEOUT_MS', env);
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (Number.isFinite(n) && n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS) timeoutMs = Math.round(n);
    else problems.push(`CN_CONTENT_SAFETY_TIMEOUT_MS must be ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}`);
  }

  const keywordsUrl = brandEnv('goapply', 'SAFETY_KEYWORDS_URL', env);
  if (keywordsUrl) {
    const p = keywordUrlProblem(keywordsUrl);
    if (p) problems.push(p);
  }

  let aliyun: AliyunGreenConfig | undefined;
  if (provider === 'aliyun_green') {
    const accessKeyId = str(env, 'ALIYUN_GREEN_ACCESS_KEY_ID');
    const accessKeySecret = str(env, 'ALIYUN_GREEN_ACCESS_KEY_SECRET');
    if (!accessKeyId || !accessKeySecret) {
      problems.push('aliyun_green needs ALIYUN_GREEN_ACCESS_KEY_ID and ALIYUN_GREEN_ACCESS_KEY_SECRET');
    }
    const region = str(env, 'ALIYUN_GREEN_REGION') ?? ALIYUN_DEFAULT_REGION;
    if (!isMainlandRegion(region)) problems.push(`ALIYUN_GREEN_REGION ${region} is outside mainland China`);
    const endpoint = str(env, 'ALIYUN_GREEN_ENDPOINT') ?? defaultAliyunEndpoint(region);
    const endpointProblem = aliyunEndpointProblem(endpoint);
    if (endpointProblem) problems.push(endpointProblem);
    aliyun = {
      accessKeyId: accessKeyId ?? '',
      accessKeySecret: accessKeySecret ?? '',
      endpoint,
      inputService: str(env, 'ALIYUN_GREEN_INPUT_SERVICE') ?? ALIYUN_DEFAULT_INPUT_SERVICE,
      outputService: str(env, 'ALIYUN_GREEN_OUTPUT_SERVICE') ?? ALIYUN_DEFAULT_OUTPUT_SERVICE,
    };
  }

  return { provider, timeoutMs, ...(keywordsUrl ? { keywordsUrl } : {}), ...(aliyun ? { aliyun } : {}), problems };
}

/** A provider that refuses every check (the engine turns that into 503 ai_unavailable). */
export function misconfiguredProvider(problems: string[]): ContentSafetyProvider {
  const fail = async (): Promise<ContentSafetyResult> => {
    throw new ContentSafetyProviderError(`content safety is misconfigured: ${problems.join('; ')}`, 'misconfigured');
  };
  return { id: 'misconfigured', checkInput: fail, checkOutput: fail };
}

/** Run providers in order; a `block` stops early; the stricter verdict wins; any error propagates. */
export function chainProviders(providers: ContentSafetyProvider[]): ContentSafetyProvider {
  const id = providers.map((p) => p.id).join('+');
  const run = async (stage: 'input' | 'output', ...args: Parameters<ContentSafetyProvider['checkInput']>) => {
    let merged: ContentSafetyResult | null = null;
    for (const p of providers) {
      const r = stage === 'input' ? await p.checkInput(...args) : await p.checkOutput(...args);
      if (!merged) {
        merged = { ...r };
      } else {
        const worse = worstVerdict(merged.verdict, r.verdict) !== merged.verdict;
        // The hit location travels as a pair (offset + slice) from one provider.
        const hitFromR = worse || merged.hitOffset === undefined;
        merged = {
          verdict: worstVerdict(merged.verdict, r.verdict),
          labels: [...new Set([...merged.labels, ...r.labels])],
          provider: id,
          ruleIds: [...new Set([...(merged.ruleIds ?? []), ...(r.ruleIds ?? [])])],
          reason: worse ? r.reason : merged.reason,
          listVersion: merged.listVersion ?? r.listVersion,
          hitOffset: hitFromR ? r.hitOffset : merged.hitOffset,
          hitSlice: hitFromR ? r.hitSlice : merged.hitSlice,
        };
      }
      if (merged.verdict === 'block') break;
    }
    const out = merged ?? { verdict: 'pass' as const, labels: [], provider: id };
    if (!out.ruleIds?.length) delete out.ruleIds;
    if (out.hitOffset === undefined) delete out.hitOffset;
    if (out.hitSlice === undefined) delete out.hitSlice;
    return { ...out, provider: id };
  };
  const keywordProvider = providers.find((p) => p.keywordProvider)?.keywordProvider;
  return {
    id,
    checkInput: (...args) => run('input', ...args),
    checkOutput: (...args) => run('output', ...args),
    ...(keywordProvider ? { keywordProvider } : {}),
  };
}

export interface ProviderFactoryDeps {
  keyword?: Omit<KeywordSourceOptions, 'url'>;
  aliyun?: AliyunGreenDeps;
}

/** Build the provider the configuration asks for (fail-closed when it cannot run). */
export function createContentSafetyProvider(
  config: ContentSafetyConfig,
  deps: ProviderFactoryDeps = {},
): ContentSafetyProvider {
  if (config.problems.length || config.provider === 'invalid') return misconfiguredProvider(config.problems);
  const keyword = createKeywordOnlyProvider(createKeywordSource({ ...deps.keyword, url: config.keywordsUrl }));
  if (config.provider === 'keyword_only') return keyword;
  return chainProviders([keyword, createAliyunGreenProvider(config.aliyun as AliyunGreenConfig, deps.aliyun)]);
}

export interface ContentSafetyReadiness {
  provider: ContentSafetyConfig['provider'];
  /** True when checks can run (GoApply AI may be offered). */
  usable: boolean;
  /** CN-1 (mainland deploy) requires aliyun_green with credentials (CN plan §5.2). */
  cn1Ready: boolean;
  keywordList: 'builtin' | 'builtin+private';
  timeoutMs: number;
  problems: string[];
}

/**
 * For the CN-1 startup assertion (WP-15 / WP-76), the admin console and
 * `ai.text` gating: what is configured and whether it can run. Never returns
 * secrets.
 */
export function contentSafetyReadiness(env: EnvSource = process.env): ContentSafetyReadiness {
  const cfg = resolveContentSafetyConfig(env);
  const usable = cfg.problems.length === 0 && cfg.provider !== 'invalid';
  return {
    provider: cfg.provider,
    usable,
    cn1Ready: usable && cfg.provider === 'aliyun_green',
    keywordList: cfg.keywordsUrl ? 'builtin+private' : 'builtin',
    timeoutMs: cfg.timeoutMs,
    problems: cfg.problems,
  };
}
