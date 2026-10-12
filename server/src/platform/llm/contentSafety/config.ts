// server/src/platform/llm/contentSafety/config.ts
//
// Environment → content-safety provider (WP-24; D5, GOAPPLY_PARITY_PLAN.md §3.3).
//
//   CN_CONTENT_SAFETY_PROVIDER     keyword_only (default) | aliyun_green
//   CN_SAFETY_KEYWORDS_URL         private keyword list (https://, file:// or absolute path)
//   CN_CONTENT_SAFETY_TIMEOUT_MS   whole-check timeout (default 5000, 500–30000)
//   ALIYUN_GREEN_ACCESS_KEY_ID / ALIYUN_GREEN_ACCESS_KEY_SECRET   (vendor keys, unprefixed)
//   ALIYUN_GREEN_REGION            mainland region (default cn-shanghai)
//   ALIYUN_GREEN_ENDPOINT          optional green-cip endpoint override (mainland only)
//   ALIYUN_GREEN_INPUT_SERVICE / ALIYUN_GREEN_OUTPUT_SERVICE
//                                  default llm_query_moderation / llm_response_moderation
//
// The three GoApply-scoped names are GoApply's own (BRAND_OWN_ENV): they are
// read through brandEnv(goapply, …) and never from an unprefixed variable.
//
// The filter always runs on GoApply calls, on every route. A setting that
// cannot run as written never degrades to "no filter", and by default it does
// not turn GoApply AI off either: each bad value falls back to its safe
// default (an unknown provider or an unusable Aliyun Green → keyword_only; a
// bad timeout → the default; a bad keyword URL → the built-in list alone),
// the problems are logged once and reported by contentSafetyReadiness(), and
// `degraded` is true. Under CN_RESIDENCY_STRICT=true the old rule holds: a
// misconfiguration yields a provider that fails closed (GoApply AI answers
// 503 ai_unavailable).
//
// aliyun_green mode also runs the keyword list first (CN plan C-6: "Aliyun
// Green + keyword list"); a keyword block skips the Aliyun call.

import { brandEnv, cnResidencyStrict, type EnvSource } from '../../brand/brandEnv.js';
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
  /**
   * The provider that runs. 'invalid' only under CN_RESIDENCY_STRICT, for an
   * unknown value; otherwise an unknown value runs as keyword_only.
   */
  provider: ContentSafetyProviderKind | 'invalid';
  timeoutMs: number;
  keywordsUrl?: string;
  aliyun?: AliyunGreenConfig;
  /** Every reason the configuration cannot run as written; empty when it can. */
  problems: string[];
  /**
   * True when there are problems and the filter runs on the safe defaults
   * instead (the default posture). False with problems means fail closed
   * (CN_RESIDENCY_STRICT).
   */
  degraded: boolean;
}

function str(env: EnvSource, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function resolveContentSafetyConfig(env: EnvSource = process.env): ContentSafetyConfig {
  const problems: string[] = [];
  const strict = cnResidencyStrict(env);
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

  let keywordsUrl = brandEnv('goapply', 'SAFETY_KEYWORDS_URL', env);
  if (keywordsUrl) {
    const p = keywordUrlProblem(keywordsUrl);
    if (p) {
      problems.push(p);
      // Not strict: the built-in list alone. Strict keeps it (the config fails closed anyway).
      if (!strict) keywordsUrl = undefined;
    }
  }

  let aliyun: AliyunGreenConfig | undefined;
  if (provider === 'aliyun_green') {
    const before = problems.length;
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
    // Aliyun Green cannot run as written: the keyword list still does.
    if (!strict && problems.length > before) {
      provider = 'keyword_only';
      aliyun = undefined;
    }
  }
  if (!strict && provider === 'invalid') provider = 'keyword_only';

  return {
    provider,
    timeoutMs,
    ...(keywordsUrl ? { keywordsUrl } : {}),
    ...(aliyun ? { aliyun } : {}),
    problems,
    degraded: !strict && problems.length > 0,
  };
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
        const worse: boolean = worstVerdict(merged.verdict, r.verdict) !== merged.verdict;
        // The hit location travels as a pair (offset + slice) from one provider.
        const hitFromR: boolean = worse || merged.hitOffset === undefined;
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

/**
 * Build the provider the configuration resolves to. A degraded configuration
 * runs on its safe defaults (keyword list); one that is neither usable nor
 * degraded (CN_RESIDENCY_STRICT) fails closed.
 */
export function createContentSafetyProvider(
  config: ContentSafetyConfig,
  deps: ProviderFactoryDeps = {},
): ContentSafetyProvider {
  if (config.provider === 'invalid' || (config.problems.length && !config.degraded)) return misconfiguredProvider(config.problems);
  const keyword = createKeywordOnlyProvider(createKeywordSource({ ...deps.keyword, url: config.keywordsUrl }));
  if (config.provider === 'keyword_only') return keyword;
  return chainProviders([keyword, createAliyunGreenProvider(config.aliyun as AliyunGreenConfig, deps.aliyun)]);
}

export interface ContentSafetyReadiness {
  /** The provider that runs (keyword_only when a bad configuration was set aside). */
  provider: ContentSafetyConfig['provider'];
  /** True when checks can run (GoApply AI may be offered). */
  usable: boolean;
  /** True when checks run on the safe defaults because of `problems`. */
  degraded: boolean;
  /** CN-1 (mainland deploy) requires aliyun_green with credentials (CN plan §5.2). */
  cn1Ready: boolean;
  keywordList: 'builtin' | 'builtin+private';
  timeoutMs: number;
  problems: string[];
}

/**
 * For the CN-1 startup assertion (WP-15 / WP-76), the admin console and
 * `ai.text` gating: what runs and whether it can run. Never returns secrets.
 * By default a configuration with problems is still usable (it runs degraded,
 * so a typo never turns GoApply AI off); it is unusable only under
 * CN_RESIDENCY_STRICT. `cn1Ready` is never true for a degraded configuration.
 */
export function contentSafetyReadiness(env: EnvSource = process.env): ContentSafetyReadiness {
  const cfg = resolveContentSafetyConfig(env);
  const usable = cfg.provider !== 'invalid' && (cfg.problems.length === 0 || cfg.degraded);
  return {
    provider: cfg.provider,
    usable,
    degraded: cfg.degraded,
    cn1Ready: cfg.problems.length === 0 && cfg.provider === 'aliyun_green',
    keywordList: cfg.keywordsUrl ? 'builtin+private' : 'builtin',
    timeoutMs: cfg.timeoutMs,
    problems: cfg.problems,
  };
}
