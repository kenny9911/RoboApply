// server/src/platform/llm/contentSafety/aliyunGreen.ts
//
// The `aliyun_green` provider (WP-24): Alibaba Cloud Content Moderation 2.0
// (内容安全, "green-cip"), action TextModerationPlus, version 2022-03-02,
// with the large-model services `llm_query_moderation` (input) and
// `llm_response_moderation` (output). No SDK (no new dependency): an RPC
// request signed with HMAC-SHA1 (signature version 1.0) over fetch.
//
// Mapping: RiskLevel high → block, medium → review, low/none → pass. Labels
// are the provider's `Label` values (`nonLabel` dropped). RiskWords (pieces
// of the user's text) are never stored or returned: they are only searched
// for in the flagged slice to place the event excerpt on the hit. When none
// is found, the result carries `hitSlice` and the event row marks its
// excerpt as the slice start (approximate). Advice (suggested replacement
// answers) is never used — nothing is silently rewritten.
//
// Residency: only mainland-China regions are accepted (cn-*, not
// cn-hongkong); an endpoint override must be a green-cip host in such a
// region. Text is sent in slices of at most 2,000 characters; any slice
// that blocks blocks the whole text. Any HTTP, API or parse error throws, and
// the engine fails closed.

import { createHmac, randomUUID } from 'node:crypto';
import { chunkByCodePoints, codePointLength } from './normalize.js';
import {
  ContentSafetyProviderError,
  worstVerdict,
  type ContentSafetyCheckOptions,
  type ContentSafetyHitSlice,
  type ContentSafetyProvider,
  type ContentSafetyResult,
  type ContentSafetyVerdict,
} from './types.js';

export const ALIYUN_PROVIDER_ID = 'aliyun_green';
export const ALIYUN_API_VERSION = '2022-03-02';
export const ALIYUN_ACTION = 'TextModerationPlus';
export const ALIYUN_DEFAULT_REGION = 'cn-shanghai';
export const ALIYUN_DEFAULT_INPUT_SERVICE = 'llm_query_moderation';
export const ALIYUN_DEFAULT_OUTPUT_SERVICE = 'llm_response_moderation';
/** Per-request content limit of the LLM moderation services. */
export const ALIYUN_MAX_CHUNK_CHARS = 2000;
const CHUNK_CONCURRENCY = 4;

export interface AliyunGreenConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** https://green-cip.<region>.aliyuncs.com */
  endpoint: string;
  inputService: string;
  outputService: string;
  chunkChars?: number;
}

export interface AliyunGreenDeps {
  fetchImpl?: typeof fetch;
  /** Timestamp source (tests). */
  now?: () => Date;
  /** SignatureNonce source (tests). */
  nonce?: () => string;
}

/** A mainland-China Alibaba Cloud region id (cn-hongkong is outside the mainland). */
export function isMainlandRegion(region: string): boolean {
  return /^cn-[a-z0-9-]+$/.test(region) && region !== 'cn-hongkong';
}

export function defaultAliyunEndpoint(region: string): string {
  return `https://green-cip.${region}.aliyuncs.com`;
}

/** Problem string for an endpoint override, or null when acceptable. */
export function aliyunEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'ALIYUN_GREEN_ENDPOINT is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'ALIYUN_GREEN_ENDPOINT must use https://';
  const m = /^green-cip(?:-vpc)?\.([a-z0-9-]+)\.aliyuncs\.com$/.exec(url.hostname);
  if (!m) return 'ALIYUN_GREEN_ENDPOINT must be a green-cip.<region>.aliyuncs.com host';
  if (!isMainlandRegion(m[1])) return `ALIYUN_GREEN_ENDPOINT region ${m[1]} is outside mainland China`;
  return null;
}

/** RFC 3986 percent-encoding as Alibaba Cloud's POP signature expects. */
export function popEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonicalised query string: keys sorted, each key and value percent-encoded. */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${popEncode(k)}=${popEncode(params[k])}`)
    .join('&');
}

/** RPC signature v1.0: base64(HMAC-SHA1(secret + "&", METHOD&%2F&enc(canonical))). */
export function signRpc(method: 'GET' | 'POST', params: Record<string, string>, accessKeySecret: string): string {
  const stringToSign = `${method}&${popEncode('/')}&${popEncode(canonicalQuery(params))}`;
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
}

/** Alibaba Cloud's ISO-8601 UTC timestamp without milliseconds. */
export function popTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function mapRiskLevel(level: unknown): ContentSafetyVerdict {
  switch (typeof level === 'string' ? level.toLowerCase() : level) {
    case 'high':
      return 'block';
    case 'medium':
      return 'review';
    case 'low':
    case 'none':
      return 'pass';
    default:
      throw new ContentSafetyProviderError(`aliyun_green: unknown RiskLevel ${String(level)}`, 'invalid_result');
  }
}

interface AliyunResponse {
  Code?: number | string;
  Message?: string;
  RequestId?: string;
  Data?: { RiskLevel?: string; Result?: Array<{ Label?: string; RiskWords?: string }> };
}

/** UTF-16 offset in `slice` of the earliest RiskWords term found in it, if any. */
export function locateRiskWords(slice: string, riskWords: string[]): number | undefined {
  let best: number | undefined;
  for (const raw of riskWords) {
    for (const word of raw.split(/[,，、]/)) {
      const w = word.trim();
      if (!w) continue;
      const at = slice.indexOf(w);
      if (at >= 0 && (best === undefined || at < best)) best = at;
    }
  }
  return best;
}

export function createAliyunGreenProvider(cfg: AliyunGreenConfig, deps: AliyunGreenDeps = {}): ContentSafetyProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const nonce = deps.nonce ?? randomUUID;
  const chunkChars = Math.min(cfg.chunkChars ?? ALIYUN_MAX_CHUNK_CHARS, ALIYUN_MAX_CHUNK_CHARS);
  const url = `${cfg.endpoint.replace(/\/+$/, '')}/`;

  const moderate = async (service: string, content: string, signal?: AbortSignal) => {
    const params: Record<string, string> = {
      Format: 'JSON',
      Version: ALIYUN_API_VERSION,
      AccessKeyId: cfg.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: nonce(),
      Timestamp: popTimestamp(now()),
      Action: ALIYUN_ACTION,
      Service: service,
      ServiceParameters: JSON.stringify({ content }),
    };
    const body = `${canonicalQuery(params)}&Signature=${popEncode(signRpc('POST', params, cfg.accessKeySecret))}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' },
        body,
        signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new ContentSafetyProviderError(`aliyun_green: request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ContentSafetyProviderError(`aliyun_green: HTTP ${res.status}`);
    let json: AliyunResponse;
    try {
      json = (await res.json()) as AliyunResponse;
    } catch {
      throw new ContentSafetyProviderError('aliyun_green: response is not JSON', 'invalid_result');
    }
    if (Number(json.Code) !== 200 || !json.Data) {
      throw new ContentSafetyProviderError(`aliyun_green: API code ${String(json.Code)} (${json.Message ?? 'no message'})`);
    }
    const verdict = mapRiskLevel(json.Data.RiskLevel);
    const labels = (json.Data.Result ?? [])
      .map((r) => (typeof r?.Label === 'string' ? r.Label : ''))
      .filter((l) => l && l !== 'nonLabel');
    const riskWords = (json.Data.Result ?? [])
      .map((r) => (typeof r?.RiskWords === 'string' ? r.RiskWords : ''))
      .filter(Boolean);
    return { verdict, labels, riskWords };
  };

  const evaluate = async (service: string, text: string, opts?: ContentSafetyCheckOptions): Promise<ContentSafetyResult> => {
    const chunks = text.trim() ? chunkByCodePoints(text, chunkChars) : [];
    let verdict = 'pass' as ContentSafetyVerdict;
    const labels = new Set<string>();
    let hitOffset: number | undefined;
    let hitSlice: ContentSafetyHitSlice | undefined;
    // Chunk start offsets (UTF-16) for the excerpt window.
    const starts: number[] = [];
    let acc = 0;
    for (const c of chunks) {
      starts.push(acc);
      acc += c.length;
    }
    for (let i = 0; i < chunks.length && verdict !== 'block'; i += CHUNK_CONCURRENCY) {
      const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
      const results = await Promise.all(batch.map((c) => moderate(service, c, opts?.signal)));
      for (const [j, r] of results.entries()) {
        if (r.verdict !== 'pass' && (hitOffset === undefined || worstVerdict(verdict, r.verdict) !== verdict)) {
          const k = i + j;
          const inSlice = locateRiskWords(chunks[k], r.riskWords);
          if (inSlice !== undefined) {
            hitOffset = starts[k] + inSlice;
            hitSlice = undefined;
          } else {
            hitOffset = starts[k];
            hitSlice = { index: k, start: starts[k], length: codePointLength(chunks[k]) };
          }
        }
        verdict = worstVerdict(verdict, r.verdict);
        if (r.verdict !== 'pass') r.labels.forEach((l) => labels.add(l));
      }
    }
    return {
      verdict,
      labels: [...labels],
      provider: ALIYUN_PROVIDER_ID,
      reason: verdict === 'pass' ? 'clean' : 'provider_label',
      ...(hitOffset !== undefined ? { hitOffset } : {}),
      ...(hitSlice ? { hitSlice } : {}),
    };
  };

  return {
    id: ALIYUN_PROVIDER_ID,
    checkInput: (text, _ctx, opts) => evaluate(cfg.inputService, text, opts),
    checkOutput: (text, _ctx, opts) => evaluate(cfg.outputService, text, opts),
  };
}
