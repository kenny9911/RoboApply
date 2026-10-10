// Live-turn LLM backend switch (WP-63b, CN-E-06).
//
//   LLM_BACKEND=gateway (default)   LiveKit Inference, model from the dispatch
//                                   metadata (contract C12). RoboApply's worker:
//                                   behaviour identical to before this switch.
//   LLM_BACKEND=openai_compatible   An OpenAI-compatible chat endpoint with a
//                                   custom base URL (the LiveKit Agents OpenAI
//                                   plugin). GoApply's worker: the control
//                                   plane sends a raw domestic model id such as
//                                   `deepseek/deepseek-chat` or `qwen/qwen-plus`
//                                   (CN_LLM_INTERVIEW_LIVE_MODEL, else the
//                                   GoApply interview task model).
//
// openai_compatible resolution:
//   model     metadata liveLlm.model / llm.model, else LLM_MODEL. A leading
//             known provider id (`deepseek/`, `qwen/`, `kimi/`, `glm/`,
//             `doubao/`, `minimax/` and their aliases) names the vendor and is
//             stripped before the request; any other id is sent as-is.
//   base URL  LLM_BASE_URL, else the vendor's env override (DASHSCOPE_BASE_URL,
//             …), else the vendor's mainland default.
//   API key   LLM_API_KEY, else the vendor's key (DEEPSEEK_API_KEY, …). When
//             LLM_BASE_URL points somewhere else (a self-hosted gateway),
//             LLM_API_KEY is required: a vendor key is only ever sent to that
//             vendor's own endpoint.
//   endpoint  must be a mainland host (config.ts) or listed in DOMESTIC_HOSTS;
//             anything else is refused (R-13: no international fallback).
// reasoning_effort is never sent on this backend (the domestic vendors do not
// accept the OpenAI parameter).

import { inference, type llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { resolveLiveLlm, type LiveLlmMeta } from '../live-model.js';
import { WorkerConfigError, envValue, hostOf, isDomesticHost, isGoApplyWorker, type Env } from './config.js';

export const LLM_BACKENDS = ['gateway', 'openai_compatible'] as const;
export type LlmBackend = (typeof LLM_BACKENDS)[number];

/**
 * The deployment's LLM backend. Unset means `gateway` on the RoboApply worker
 * and `openai_compatible` on the GoApply worker (isGoApplyWorker); a GoApply
 * worker that names `gateway` is refused, so a GoApply prompt, resume or
 * transcript can never reach LiveKit Inference (R-13), even when the worker
 * runs outside the deploy/cn image (dev supervisor, compose, a bare host).
 */
export function resolveLlmBackend(env: Env = process.env): LlmBackend {
  const raw = envValue(env, 'LLM_BACKEND').toLowerCase();
  const goapply = isGoApplyWorker(env);
  if (!raw) return goapply ? 'openai_compatible' : 'gateway';
  if (!(LLM_BACKENDS as readonly string[]).includes(raw)) {
    throw new WorkerConfigError(`LLM_BACKEND="${raw}" is not supported. Use gateway or openai_compatible.`);
  }
  if (goapply && raw === 'gateway') {
    throw new WorkerConfigError(
      'LLM_BACKEND=gateway is not allowed on the GoApply worker (GoApply-Interview); use openai_compatible',
    );
  }
  return raw as LlmBackend;
}

interface VendorDefaults {
  baseUrl: string;
  baseUrlEnv: string;
  keyEnv: string;
}

const DEEPSEEK: VendorDefaults = { baseUrl: 'https://api.deepseek.com/v1', baseUrlEnv: 'DEEPSEEK_API_BASE_URL', keyEnv: 'DEEPSEEK_API_KEY' };
const DASHSCOPE: VendorDefaults = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', baseUrlEnv: 'DASHSCOPE_BASE_URL', keyEnv: 'DASHSCOPE_API_KEY' };
const MOONSHOT: VendorDefaults = { baseUrl: 'https://api.moonshot.cn/v1', baseUrlEnv: 'KIMI_API_BASE_URL', keyEnv: 'KIMI_API_KEY' };
const ZHIPU: VendorDefaults = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', baseUrlEnv: 'GLM_API_BASE_URL', keyEnv: 'GLM_API_KEY' };
const ARK: VendorDefaults = { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', baseUrlEnv: 'ARK_BASE_URL', keyEnv: 'ARK_API_KEY' };
const MINIMAX: VendorDefaults = { baseUrl: 'https://api.minimaxi.com/v1', baseUrlEnv: 'MINIMAX_BASE_URL', keyEnv: 'MINIMAX_API_KEY' };

/**
 * Domestic vendors by the provider ids the control plane uses (same ids and
 * env names as server/src/platform/llm/{brandPolicy,egressPolicy}.ts).
 */
export const OPENAI_COMPATIBLE_VENDORS: Readonly<Record<string, VendorDefaults>> = {
  deepseek: DEEPSEEK,
  qwen: DASHSCOPE,
  dashscope: DASHSCOPE,
  kimi: MOONSHOT,
  moonshot: MOONSHOT,
  glm: ZHIPU,
  zhipu: ZHIPU,
  doubao: ARK,
  ark: ARK,
  minimax: MINIMAX,
};

export interface OpenAiCompatibleRoute {
  /** Model id sent to the endpoint (vendor prefix stripped). */
  model: string;
  /** Model id as the control plane (or LLM_MODEL) named it. */
  requestedModel: string;
  /** Vendor id from the prefix; null for an unprefixed id. */
  vendor: string | null;
  baseURL: string;
  apiKey: string;
  host: string;
  source: 'liveLlm' | 'llm' | 'env';
}

/** Split `vendor/model` when the prefix is a known domestic vendor. */
export function splitVendorModel(id: string): { vendor: string | null; model: string } {
  const trimmed = id.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    const vendor = trimmed.slice(0, slash).toLowerCase();
    if (OPENAI_COMPATIBLE_VENDORS[vendor]) return { vendor, model: trimmed.slice(slash + 1) };
  }
  return { vendor: null, model: trimmed };
}

export function resolveOpenAiCompatibleRoute(meta: LiveLlmMeta, env: Env = process.env): OpenAiCompatibleRoute {
  const live = resolveLiveLlm(meta);
  const envModel = envValue(env, 'LLM_MODEL');
  const requestedModel = live?.model || envModel;
  if (!requestedModel) {
    throw new WorkerConfigError(
      'interview room metadata is missing llm.model and LLM_MODEL is unset; configure CN_LLM_INTERVIEW_LIVE_MODEL ' +
      'or CN_LLM_INTERVIEW_MODEL on the control plane',
    );
  }
  const source: OpenAiCompatibleRoute['source'] = live ? live.source : 'env';
  const { vendor, model } = splitVendorModel(requestedModel);
  const defaults = vendor ? OPENAI_COMPATIBLE_VENDORS[vendor] : undefined;

  const customBase = envValue(env, 'LLM_BASE_URL');
  const baseURL = customBase ||
    (defaults ? envValue(env, defaults.baseUrlEnv) || defaults.baseUrl : '');
  if (!baseURL) {
    throw new WorkerConfigError(
      `LLM_BASE_URL is required for model "${requestedModel}" (no known vendor prefix to infer the endpoint from)`,
    );
  }
  const host = hostOf(baseURL);
  if (!isDomesticHost(host, env)) {
    throw new WorkerConfigError(
      `LLM endpoint ${host ?? baseURL} is not a mainland endpoint; the openai_compatible backend only calls ` +
      'domestic vendors (add a self-hosted mainland gateway to DOMESTIC_HOSTS)',
    );
  }
  // The vendor key goes only to the vendor's endpoint (its default or its own
  // *_BASE_URL override); LLM_BASE_URL needs its own LLM_API_KEY.
  const vendorKey = defaults && !customBase ? envValue(env, defaults.keyEnv) : '';
  const apiKey = envValue(env, 'LLM_API_KEY') || vendorKey;
  if (!apiKey) {
    throw new WorkerConfigError(
      customBase
        ? `LLM_BASE_URL is set but LLM_API_KEY is not; vendor keys${defaults ? ` (${defaults.keyEnv})` : ''} are only sent to the vendor's own endpoint`
        : `no API key for model "${requestedModel}": set LLM_API_KEY${defaults ? ` or ${defaults.keyEnv}` : ''}`,
    );
  }
  return { model, requestedModel, vendor, baseURL, apiKey, host: host!, source };
}

/**
 * The OpenAI plugin reports the endpoint host as the provider; report the
 * vendor id instead so the session's usage callback names the model the way
 * the control plane's cost table does (`deepseek/deepseek-chat`).
 */
export class DomesticOpenAiLlm extends openai.LLM {
  constructor(opts: { model: string; baseURL: string; apiKey: string }, private readonly vendor: string | null) {
    super(opts);
  }

  override get provider(): string {
    return this.vendor ?? super.provider;
  }
}

/** Constructors, injectable so tests never build a real client. */
export interface LlmFactories {
  gateway: (opts: { model: string; modelOptions?: { reasoning_effort: string } }) => llm.LLM;
  openaiCompatible: (opts: { model: string; baseURL: string; apiKey: string }, vendor: string | null) => llm.LLM;
}

const DEFAULT_FACTORIES: LlmFactories = {
  gateway: (opts) => new inference.LLM(opts as ConstructorParameters<typeof inference.LLM>[0]),
  openaiCompatible: (opts, vendor) => new DomesticOpenAiLlm(opts, vendor),
};

export interface BuiltLlm {
  llm: llm.LLM;
  backend: LlmBackend;
  /** Model id actually requested from the provider. */
  model: string;
  /** Endpoint host (openai_compatible only). */
  host?: string;
}

export function buildLlm(meta: LiveLlmMeta, env: Env = process.env, factories: LlmFactories = DEFAULT_FACTORIES): BuiltLlm {
  const backend = resolveLlmBackend(env);
  if (backend === 'openai_compatible') {
    const route = resolveOpenAiCompatibleRoute(meta, env);
    return {
      llm: factories.openaiCompatible({ model: route.model, baseURL: route.baseURL, apiKey: route.apiKey }, route.vendor),
      backend,
      model: route.model,
      host: route.host,
    };
  }

  // Gateway: unchanged from the pre-switch worker (RoboApply regression path).
  const live = resolveLiveLlm(meta);
  if (!live) {
    throw new Error(
      'interview room metadata is missing llm.model; configure LLM_INTERVIEW_LIVE_MODEL or LLM_INTERVIEW_MODEL on the control plane',
    );
  }
  const { model, reasoningEffort } = live;
  return {
    llm: factories.gateway({
      model,
      ...(reasoningEffort
        ? { modelOptions: { reasoning_effort: reasoningEffort } }
        : {}),
    }),
    backend,
    model,
  };
}
