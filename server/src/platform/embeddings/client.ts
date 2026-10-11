// server/src/platform/embeddings/client.ts
//
// The one embeddings client (MARKET_STRATEGY 2.3 step 6 and its stack
// constraints, 2.5 row "Embedding"; SM-7, SM-11). `LLMService` has no
// embeddings call: this module is it, on the OpenAI-compatible
// `POST <baseUrl>/embeddings` endpoint.
//
//   const res = await embedTexts(brand, texts, { purpose: 'job', carriesUserData: false });
//   if ('unavailable' in res) { /* run without the dense leg */ } else { res.vectors }
//
// Rules, each of them a test:
//   - No key means the dense leg is off: `{ unavailable: 'no_key' }`, no
//     request, never an error and never a made-up vector (D3).
//   - Settings are per brand through `brandEnv` (D5): GoApply reads
//     `CN_EMBED_*` when set and the shared `EMBED_*` otherwise. A key is never
//     sent to an endpoint it was not configured for (see `resolveEmbeddingConfig`).
//   - Every vector is requested at 1024 dimensions, the size of the
//     `halfvec(1024)` columns. A response with any other length, or a value
//     that is not a finite number, fails the whole call. Nothing is padded,
//     cut or filled with zeros.
//   - The brand's LLM route policy (platform/llm) decides on the endpoint host
//     exactly as it does for a chat call: behind GoApply's domestic-only wall
//     (CN_LLM_DOMESTIC_ONLY or CN_RESIDENCY_STRICT) a non-mainland endpoint is
//     refused, and a RoboApply call that carries user data never reaches a
//     mainland endpoint. Refused → `{ unavailable: 'policy' }`, no request.
//   - A daily token budget per brand on `RARateCounter`
//     (`budget:embed:<brand>`, EMBED_DAILY_TOKENS). Spent → `{ unavailable: 'budget' }`.
//     A counter that cannot be READ is not a spent budget: the call fails
//     (`EmbeddingsError` code 'budget_unreadable') and the queue retries it.
//   - An endpoint that refuses a request of several inputs with 400 (a vendor
//     with a lower limit of inputs per request than EMBED_BATCH_SIZE) is asked
//     again with half as many, and the size that worked is remembered for the
//     process. A 400 for one input is the caller's failure.
//   - Tokens the endpoint reports are written once per call to the usage log
//     (`UsageDeductionLog`, SKU `ra_embed`, units = tokens) under the brand's
//     system user, with the cost only when the model has a price read from its
//     vendor (lib/modelPricing.ts) AND the call went to that vendor's own host;
//     otherwise the cost is recorded as unknown (a gateway sets its own price).
//   - Consent is the CALLER's gate (`aiAllowed`, the 个性化推荐 grant): this
//     client knows endpoints and budgets, not people.
//
// `embeddingAvailability(brand, { carriesUserData })` answers the same three
// refusals WITHOUT a request to the endpoint, so a producer (the retrieval
// sweep) does not queue work whose vectors cannot be written.
//
// `setEmbeddingsClientForTests(fake)` is the only test seam for callers.

import { brandEnv, brandEnvSource, type EnvSource } from '../brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.js';
import { PROVIDER_DEFAULT_HOSTS, hostOf } from '../llm/brandPolicy.js';
import { checkLlmEgress } from '../llm/egressPolicy.js';
import { resolveProviderPrefix } from '../../services/llm/providerPrefixes.js';
import { logger } from '../../services/LoggerService.js';
import { defaultEmbeddingBudget, type EmbeddingBudget } from './budget.js';
import { defaultEmbeddingUsageLog, type EmbeddingUsageEntry } from './usage.js';

/** The size of every vector this client returns: the `halfvec(1024)` columns. Never change it here; a new size needs a new column. */
export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-small';
export const DEFAULT_EMBED_BASE_URL = 'https://api.openai.com/v1';
/** Inputs per request: the default and the ceiling of EMBED_BATCH_SIZE. */
export const MAX_EMBED_BATCH_SIZE = 96;
/** One request may take this long. */
export const EMBED_TIMEOUT_MS = 20_000;
/** A Retry-After longer than this is not waited for inside one call. */
export const EMBED_MAX_RETRY_DELAY_MS = 10_000;
/** Delay before the one retry when the endpoint names none. */
export const EMBED_DEFAULT_RETRY_DELAY_MS = 1_000;

export type EmbeddingPurpose = 'job' | 'user' | 'query' | 'skill';

export interface EmbedOptions {
  purpose: EmbeddingPurpose;
  /** True when a text holds a person's own data (a resume, a profile, a typed query, a private import). */
  carriesUserData: boolean;
  userId?: string | null;
  requestId?: string | null;
}

export interface EmbeddingConfig {
  /** The configured model, as written (may carry a provider prefix such as `openai/`). */
  model: string;
  /** Null when no key is set for this brand: the client is unavailable. */
  apiKey: string | null;
  baseUrl: string;
  batchSize: number;
  dimensions: typeof EMBEDDING_DIMENSIONS;
  /** `<model>@1024`, the value stored in `RAJobEmbedding.model`; null when no key is set. */
  modelTag: string | null;
}

export type EmbeddingUnavailableReason = 'no_key' | 'policy' | 'budget';

export interface EmbeddingVectors {
  /** One vector per input, in input order, each exactly 1024 finite numbers. */
  vectors: number[][];
  /** The model tag the vectors belong to (`<model>@1024`). */
  model: string;
  /** Tokens the endpoint reported for the call (0 when it reported none). */
  tokens: number;
}

export type EmbedResult = EmbeddingVectors | { unavailable: EmbeddingUnavailableReason };

/** 'ok', or why no vector can be written for the brand right now. */
export type EmbeddingAvailability = 'ok' | EmbeddingUnavailableReason;

/**
 * A failed call (HTTP error, timeout, a malformed or wrong-sized response, a
 * budget counter that could not be read). Queue workers retry it.
 */
export class EmbeddingsError extends Error {
  readonly code: 'http' | 'timeout' | 'bad_response' | 'bad_input' | 'budget_unreadable';
  readonly status: number | null;
  constructor(code: EmbeddingsError['code'], message: string, status: number | null = null) {
    super(message);
    this.name = 'EmbeddingsError';
    this.code = code;
    this.status = status;
  }
}

export interface EmbeddingsClient {
  embedTexts(brand: BrandId | ProductBrand, texts: readonly string[], options: EmbedOptions): Promise<EmbedResult>;
  /** May a vector be written for the brand now? No request to the endpoint. A client without it counts as 'ok'. */
  availability?(brand: BrandId | ProductBrand, options: Pick<EmbedOptions, 'carriesUserData'>): Promise<EmbeddingAvailability>;
}

const toBrand = (brand: BrandId | ProductBrand): ProductBrand => (typeof brand === 'string' ? getBrand(brand) : brand);

function batchSizeOf(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 1) return MAX_EMBED_BATCH_SIZE;
  return Math.min(MAX_EMBED_BATCH_SIZE, Math.floor(n));
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * The brand's embedding settings. Each name is read through `brandEnv`
 * (GoApply: `CN_<NAME>` when set, else the shared value).
 *
 * The key follows the endpoint, so a key never reaches another vendor:
 *   - no EMBED_BASE_URL for the brand → the OpenAI endpoint (OPENAI_BASE_URL,
 *     else api.openai.com) with EMBED_API_KEY, else OPENAI_API_KEY;
 *   - an EMBED_BASE_URL → EMBED_API_KEY only (OPENAI_API_KEY is OpenAI's);
 *   - GoApply's CN_EMBED_BASE_URL and CN_EMBED_API_KEY are ONE PAIR: both set
 *     (its own endpoint with its own key) or neither (the shared endpoint with
 *     the shared key). With only one of them set GoApply has no key: the
 *     shared key is never sent to GoApply's own endpoint, and GoApply's own
 *     key is never sent to the shared endpoint. `embeddingEnvProblems` names
 *     the half-set pair. (A separate GoApply account on the shared endpoint:
 *     set CN_EMBED_BASE_URL to that same URL.)
 * With no usable key `apiKey` and `modelTag` are null and the client is unavailable.
 */
export function resolveEmbeddingConfig(brandInput: BrandId | ProductBrand, env: EnvSource = process.env): EmbeddingConfig {
  const brand = toBrand(brandInput);
  const model = brandEnv(brand, 'EMBED_MODEL', env) ?? DEFAULT_EMBED_MODEL;
  const ownUrl = brandEnv(brand, 'EMBED_BASE_URL', env);
  const key = brandEnv(brand, 'EMBED_API_KEY', env);
  let apiKey: string | null;
  let baseUrl: string;
  if (ownUrl) {
    baseUrl = trimSlash(ownUrl);
    apiKey = key ?? null;
  } else {
    baseUrl = trimSlash(env.OPENAI_BASE_URL?.trim() || DEFAULT_EMBED_BASE_URL);
    apiKey = key ?? (env.OPENAI_API_KEY?.trim() || null);
  }
  if (brand.market === 'cn') {
    const urlIsBrandOwn = brandEnvSource(brand, 'EMBED_BASE_URL', env) === 'own';
    const keyIsBrandOwn = brandEnvSource(brand, 'EMBED_API_KEY', env) === 'own';
    if (urlIsBrandOwn !== keyIsBrandOwn) apiKey = null;
  }
  return {
    model,
    apiKey,
    baseUrl,
    batchSize: batchSizeOf(brandEnv(brand, 'EMBED_BATCH_SIZE', env)),
    dimensions: EMBEDDING_DIMENSIONS,
    modelTag: apiKey ? `${model}@${EMBEDDING_DIMENSIONS}` : null,
  };
}

/** A half-set GoApply endpoint pair (names only, never values). */
export interface EmbeddingEnvProblem {
  code: 'own_key_without_own_url' | 'own_url_without_own_key';
  /** The variable that is set. */
  set: string;
  /** The variable that must be set with it. */
  missing: string;
  message: string;
}

/**
 * GoApply's CN_EMBED_BASE_URL and CN_EMBED_API_KEY set one without the other.
 * GoApply then embeds nothing (see `resolveEmbeddingConfig`); start-up reports
 * it next to `brandEnvGroupProblems`, and the client logs it once.
 */
export function embeddingEnvProblems(env: EnvSource = process.env): EmbeddingEnvProblem[] {
  const url = env.CN_EMBED_BASE_URL?.trim();
  const key = env.CN_EMBED_API_KEY?.trim();
  if (key && !url) {
    return [
      {
        code: 'own_key_without_own_url',
        set: 'CN_EMBED_API_KEY',
        missing: 'CN_EMBED_BASE_URL',
        message: 'CN_EMBED_API_KEY is set without CN_EMBED_BASE_URL: GoApply embeds nothing, because its own key is never sent to the shared endpoint. Set CN_EMBED_BASE_URL to the endpoint the key belongs to, or remove the key to use the shared endpoint.',
      },
    ];
  }
  if (url && !key) {
    return [
      {
        code: 'own_url_without_own_key',
        set: 'CN_EMBED_BASE_URL',
        missing: 'CN_EMBED_API_KEY',
        message: 'CN_EMBED_BASE_URL is set without CN_EMBED_API_KEY: GoApply embeds nothing, because the shared key is never sent to GoApply\'s own endpoint. Set CN_EMBED_API_KEY, or remove the URL to use the shared endpoint.',
      },
    ];
  }
  return [];
}

let halfSetReported = false;

/** Tests only. */
export function resetEmbeddingEnvReportForTests(): void {
  halfSetReported = false;
}

/** Say once per process why GoApply has no key although one of its own variables is set. */
function reportHalfSetPair(brand: ProductBrand, env: EnvSource): void {
  if (brand.market !== 'cn' || halfSetReported) return;
  const problems = embeddingEnvProblems(env);
  if (!problems.length) return;
  halfSetReported = true;
  for (const p of problems) logger.warn('EMBEDDINGS', p.message, { brand: brand.id, set: p.set, missing: p.missing });
}

/** The provider type a host belongs to, when it is one of the known vendor hosts. */
function providerOfHost(host: string | null): string | null {
  if (!host) return null;
  for (const [provider, known] of Object.entries(PROVIDER_DEFAULT_HOSTS)) {
    if (host === known || host.endsWith(`.${known}`)) return provider;
  }
  return null;
}

/**
 * How a configured model is called: the provider the route policy judges
 * (always the one the endpoint HOST belongs to) and the model id the endpoint
 * expects. A leading provider prefix (`openai/`, `dashscope/`, …) is a routing
 * hint and is stripped for a direct endpoint, the rule the chat providers
 * apply. OpenRouter is the exception: its ids are `vendor/model`, so only a
 * leading `openrouter/` is dropped there.
 */
export function embeddingRoute(config: Pick<EmbeddingConfig, 'model' | 'baseUrl'>): { provider: string; wireModel: string } {
  const host = hostOf(config.baseUrl);
  const model = config.model.trim();
  const slash = model.indexOf('/');
  const prefix = slash > 0 ? resolveProviderPrefix(model.slice(0, slash), 'domestic_cn') : null;
  const hostProvider = providerOfHost(host);
  if (hostProvider === 'openrouter') {
    return { provider: 'openrouter', wireModel: prefix === 'openrouter' ? model.slice(slash + 1) : model };
  }
  // The HOST decides which provider the policy judges: an endpoint that is not a known vendor host is an
  // OpenAI-compatible gateway (`newapi`), whatever the model id is prefixed with.
  return { provider: hostProvider ?? 'newapi', wireModel: prefix ? model.slice(slash + 1) : model };
}

export interface EmbeddingsClientDeps {
  env?: EnvSource;
  /** Default: the global `fetch`, read at call time. */
  fetch?: typeof fetch;
  budget?: EmbeddingBudget;
  logUsage?: (entry: EmbeddingUsageEntry) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface EmbeddingsResponseBody {
  data?: Array<{ index?: number; embedding?: unknown }>;
  usage?: { total_tokens?: unknown; prompt_tokens?: unknown };
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === EMBEDDING_DIMENSIONS && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Seconds or an HTTP date → ms, bounded; the default when the header is absent or unreadable. */
function retryDelayMs(header: string | null, now: Date): number {
  if (!header) return EMBED_DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now.getTime();
  if (!Number.isFinite(ms) || ms < 0) return EMBED_DEFAULT_RETRY_DELAY_MS;
  return Math.min(EMBED_MAX_RETRY_DELAY_MS, Math.ceil(ms));
}

const retryable = (status: number): boolean => status === 429 || status >= 500;

export function createEmbeddingsClient(deps: EmbeddingsClientDeps = {}): EmbeddingsClient {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const budget = deps.budget ?? defaultEmbeddingBudget;
  const logUsage = deps.logUsage ?? defaultEmbeddingUsageLog;
  /** Inputs per request an endpoint accepted after it refused more, by endpoint and model (this process only). */
  const acceptedBatchSize = new Map<string, number>();

  /** One request for one batch, with at most one retry on 429 or 5xx. */
  async function requestBatch(config: EmbeddingConfig, wireModel: string, batch: readonly string[]): Promise<{ vectors: number[][]; tokens: number | null }> {
    const doFetch = deps.fetch ?? globalThis.fetch;
    const send = async (): Promise<Response> => {
      try {
        return await doFetch(`${config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: wireModel, input: batch, dimensions: EMBEDDING_DIMENSIONS }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') throw new EmbeddingsError('timeout', `The embeddings request took longer than ${EMBED_TIMEOUT_MS / 1000} s.`);
        throw new EmbeddingsError('http', `The embeddings request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    let res = await send();
    if (!res.ok && retryable(res.status)) {
      await sleep(retryDelayMs(res.headers.get('retry-after'), now()));
      res = await send();
    }
    if (!res.ok) throw new EmbeddingsError('http', `The embeddings endpoint answered ${res.status}.`, res.status);

    let body: EmbeddingsResponseBody;
    try {
      body = (await res.json()) as EmbeddingsResponseBody;
    } catch {
      throw new EmbeddingsError('bad_response', 'The embeddings endpoint did not answer with JSON.');
    }
    const data = Array.isArray(body?.data) ? body.data : [];
    if (data.length !== batch.length) {
      throw new EmbeddingsError('bad_response', `The embeddings endpoint returned ${data.length} vectors for ${batch.length} inputs.`);
    }
    const vectors: number[][] = new Array(batch.length);
    data.forEach((row, i) => {
      const index = typeof row?.index === 'number' ? row.index : i;
      if (!Number.isInteger(index) || index < 0 || index >= batch.length || vectors[index] !== undefined) {
        throw new EmbeddingsError('bad_response', 'The embeddings endpoint returned vectors that do not line up with the inputs.');
      }
      // Never padded, cut or zero-filled: a vector of another size is another model's vector.
      if (!isVector(row.embedding)) {
        const length = Array.isArray(row?.embedding) ? row.embedding.length : 0;
        throw new EmbeddingsError('bad_response', `The embeddings endpoint returned a vector of ${length} values; ${EMBEDDING_DIMENSIONS} finite numbers are required.`);
      }
      vectors[index] = row.embedding;
    });
    const reported = Number(body.usage?.total_tokens ?? body.usage?.prompt_tokens);
    return { vectors, tokens: Number.isFinite(reported) && reported >= 0 ? Math.floor(reported) : null };
  }

  /**
   * The checks every call passes before a request, in order: a key, the
   * brand's route policy, the daily budget. Throws `EmbeddingsError` when the
   * budget counter cannot be read (that is not a spent budget).
   */
  async function gate(
    brand: ProductBrand,
    env: EnvSource,
    options: Pick<EmbedOptions, 'carriesUserData'> & { purpose?: EmbeddingPurpose },
    /** False for the availability read: a producer asks every few minutes and must not fill the log with the same refusal. */
    report = true,
  ): Promise<{ unavailable: EmbeddingUnavailableReason } | { config: EmbeddingConfig & { apiKey: string; modelTag: string }; route: { provider: string; wireModel: string } }> {
    const config = resolveEmbeddingConfig(brand, env);
    if (!config.apiKey || !config.modelTag) {
      reportHalfSetPair(brand, env);
      return { unavailable: 'no_key' };
    }
    const route = embeddingRoute(config);
    const egress = checkLlmEgress({
      brand,
      provider: route.provider,
      credentialBaseUrl: config.baseUrl,
      model: route.wireModel,
      carriesUserData: options.carriesUserData,
      env,
    });
    if (!egress.allowed) {
      if (report) logger.warn('EMBEDDINGS', 'endpoint refused by the brand route policy; running without vectors', {
          brand: brand.id,
          purpose: options.purpose ?? null,
          host: egress.host,
          code: egress.code,
        });
      return { unavailable: 'policy' };
    }
    let room: boolean;
    try {
      room = await budget.hasRoom(brand, env, now());
    } catch (err) {
      throw new EmbeddingsError('budget_unreadable', `The embedding budget of ${brand.id} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!room) return { unavailable: 'budget' };
    return { config: { ...config, apiKey: config.apiKey, modelTag: config.modelTag }, route };
  }

  return {
    async availability(brandInput, options) {
      const g = await gate(toBrand(brandInput), deps.env ?? process.env, options, false);
      return 'unavailable' in g ? g.unavailable : 'ok';
    },

    async embedTexts(brandInput, texts, options) {
      const brand = toBrand(brandInput);
      const env = deps.env ?? process.env;
      // No key: the dense leg is off, whatever the input is.
      const settings = resolveEmbeddingConfig(brand, env);
      if (!settings.apiKey || !settings.modelTag) {
        reportHalfSetPair(brand, env);
        return { unavailable: 'no_key' };
      }
      if (texts.some((t) => typeof t !== 'string' || !t.trim())) throw new EmbeddingsError('bad_input', 'Every text to embed must be a non-empty string.');
      if (texts.length === 0) return { vectors: [], model: settings.modelTag, tokens: 0 };

      const g = await gate(brand, env, options);
      if ('unavailable' in g) return g;
      const { config, route } = g;
      const sizeKey = `${config.baseUrl}|${route.wireModel}`;

      const vectors: number[][] = [];
      let reportedTokens = 0;
      let usageReported = true;
      let charged = 0;
      let requests = 0;

      /**
       * One batch, in input order. An endpoint that answers 400 to several
       * inputs accepts fewer per request than the batch size: the batch is
       * halved until a request passes, and that size is kept for later calls.
       */
      const embedBatch = async (batch: readonly string[], afterRefusal: boolean): Promise<void> => {
        let out: { vectors: number[][]; tokens: number | null };
        try {
          out = await requestBatch(config, route.wireModel, batch);
        } catch (err) {
          if (!(err instanceof EmbeddingsError) || err.status !== 400 || batch.length < 2) throw err;
          const half = Math.ceil(batch.length / 2);
          await embedBatch(batch.slice(0, half), true);
          await embedBatch(batch.slice(half), true);
          return;
        }
        if (afterRefusal && batch.length < (acceptedBatchSize.get(sizeKey) ?? Infinity)) {
          acceptedBatchSize.set(sizeKey, batch.length);
          logger.warn('EMBEDDINGS', 'the endpoint refused the configured batch size; using a smaller one. Set EMBED_BATCH_SIZE (CN_EMBED_BATCH_SIZE for GoApply) to the limit of the vendor', {
            brand: brand.id,
            host: hostOf(config.baseUrl),
            configured: config.batchSize,
            accepted: batch.length,
          });
        }
        requests += 1;
        vectors.push(...out.vectors);
        if (out.tokens === null) usageReported = false;
        else reportedTokens += out.tokens;
        // The budget is a guard, not a published number: when the endpoint reports no usage it counts an estimate.
        charged += out.tokens ?? Math.ceil(batch.reduce((n, t) => n + t.length, 0) / 4);
      };

      try {
        const size = Math.min(config.batchSize, acceptedBatchSize.get(sizeKey) ?? config.batchSize);
        for (let i = 0; i < texts.length; i += size) await embedBatch(texts.slice(i, i + size), false);
      } finally {
        // Tokens already spent are counted and logged even when a later batch failed.
        if (requests > 0) {
          await budget.charge(brand, charged, env, now());
          await logUsage({
            brand: brand.id,
            market: brand.market,
            modelTag: config.modelTag,
            wireModel: route.wireModel,
            host: hostOf(config.baseUrl),
            purpose: options.purpose,
            tokens: reportedTokens,
            usageReported,
            inputs: vectors.length,
            requests,
            userId: options.userId ?? null,
            requestId: options.requestId ?? null,
            env,
          });
        }
      }
      return { vectors, model: config.modelTag, tokens: reportedTokens };
    },
  };
}

const defaultClient = createEmbeddingsClient();
let override: EmbeddingsClient | null = null;

/** The only test seam for callers: replace the client (null restores the real one). */
export function setEmbeddingsClientForTests(fake: EmbeddingsClient | null): void {
  override = fake;
}

/**
 * Embed `texts` for a brand. `{ unavailable }` when no key is set, the brand's
 * route policy refuses the endpoint or the daily budget is spent: the caller
 * then runs without the dense leg. Throws `EmbeddingsError` when the call
 * itself fails, or when the budget counter cannot be read.
 */
export function embedTexts(brand: BrandId | ProductBrand, texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
  return (override ?? defaultClient).embedTexts(brand, texts, options);
}

/**
 * May a vector be written for the brand right now? 'ok', or the reason
 * `embedTexts` would answer (`no_key`, `policy`, `budget`), found WITHOUT a
 * request to the endpoint. Throws `EmbeddingsError` when the budget counter
 * cannot be read.
 */
export async function embeddingAvailability(brand: BrandId | ProductBrand, options: Pick<EmbedOptions, 'carriesUserData'>): Promise<EmbeddingAvailability> {
  const client = override ?? defaultClient;
  return client.availability ? client.availability(brand, options) : 'ok';
}
