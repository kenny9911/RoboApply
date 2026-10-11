// @vitest-environment node
//
// The embeddings client (MKT-2H item 1). Every request goes to a mocked fetch:
// nothing here reaches a network, a database or a provider.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddingBudget, embedBudgetKey, embedDailyTokens, DEFAULT_EMBED_DAILY_TOKENS } from './budget.js';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingsError,
  createEmbeddingsClient,
  embedTexts,
  embeddingAvailability,
  embeddingEnvProblems,
  embeddingRoute,
  resetEmbeddingEnvReportForTests,
  resolveEmbeddingConfig,
  setEmbeddingsClientForTests,
  type EmbeddingsClientDeps,
} from './client.js';
import { logger } from '../../services/LoggerService.js';
import { EMBED_COST_SKU, createEmbeddingUsageLog, embeddingUsageRow, resetMissingEmbeddingCostUsersForTests, type EmbeddingUsageEntry } from './usage.js';
import { getBrand } from '../brand/registry.js';

const vec = (seed: number, length = EMBEDDING_DIMENSIONS): number[] => Array.from({ length }, (_, i) => ((seed + i) % 7) / 10);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string[]; dimensions: number };
}

/** A fetch double that answers one vector per input (or what `respond` says). */
function fakeFetch(respond?: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    if (respond) return respond(call, calls.length);
    return ok(call.body.input.map((_, i) => vec(i)), call.body.input.length * 5);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function ok(vectors: unknown[], totalTokens: number | null = 10): Response {
  return new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })), ...(totalTokens === null ? {} : { usage: { total_tokens: totalTokens } }) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function kit(env: Record<string, string | undefined>, over: Partial<EmbeddingsClientDeps> = {}) {
  const usage: EmbeddingUsageEntry[] = [];
  const charged: number[] = [];
  const slept: number[] = [];
  const f = fakeFetch();
  const client = createEmbeddingsClient({
    env,
    fetch: f.fetch,
    budget: { hasRoom: async () => true, charge: async (_b, tokens) => void charged.push(tokens) },
    logUsage: async (entry) => void usage.push(entry),
    sleep: async (ms) => void slept.push(ms),
    now: () => new Date('2026-10-11T08:00:00Z'),
    ...over,
  });
  return { client, usage, charged, slept, calls: f.calls, fetch: f.fetch };
}

const JOB = { purpose: 'job', carriesUserData: false } as const;
const USER = { purpose: 'user', carriesUserData: true, userId: 'u1' } as const;

afterEach(() => {
  setEmbeddingsClientForTests(null);
  resetMissingEmbeddingCostUsersForTests();
  resetEmbeddingEnvReportForTests();
  vi.restoreAllMocks();
});

describe('resolveEmbeddingConfig', () => {
  it('has no model tag and no key when neither EMBED_API_KEY nor OPENAI_API_KEY is set', () => {
    const cfg = resolveEmbeddingConfig('roboapply', {});
    expect(cfg).toMatchObject({ model: 'openai/text-embedding-3-small', apiKey: null, modelTag: null, dimensions: 1024, batchSize: 96, baseUrl: 'https://api.openai.com/v1' });
    expect(resolveEmbeddingConfig('goapply', {}).modelTag).toBeNull();
  });

  it('falls back to OPENAI_API_KEY and OPENAI_BASE_URL, and prefers EMBED_API_KEY', () => {
    expect(resolveEmbeddingConfig('roboapply', { OPENAI_API_KEY: 'sk-open' })).toMatchObject({ apiKey: 'sk-open', modelTag: 'openai/text-embedding-3-small@1024' });
    expect(resolveEmbeddingConfig('roboapply', { OPENAI_API_KEY: 'sk-open', OPENAI_BASE_URL: 'https://proxy.example/v1/' }).baseUrl).toBe('https://proxy.example/v1');
    expect(resolveEmbeddingConfig('roboapply', { OPENAI_API_KEY: 'sk-open', EMBED_API_KEY: 'sk-embed' }).apiKey).toBe('sk-embed');
  });

  it('GoApply runs on the shared values by default (D5) and on CN_EMBED_* when set; RoboApply never reads them', () => {
    const shared = { OPENAI_API_KEY: 'sk-open', EMBED_MODEL: 'openai/text-embedding-3-large' };
    expect(resolveEmbeddingConfig('goapply', shared)).toMatchObject({ model: 'openai/text-embedding-3-large', apiKey: 'sk-open' });

    const env = { ...shared, CN_EMBED_MODEL: 'text-embedding-v4', CN_EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', CN_EMBED_API_KEY: 'sk-cn', CN_EMBED_BATCH_SIZE: '10' };
    expect(resolveEmbeddingConfig('goapply', env)).toEqual({
      model: 'text-embedding-v4',
      apiKey: 'sk-cn',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      batchSize: 10,
      dimensions: 1024,
      modelTag: 'text-embedding-v4@1024',
    });
    expect(resolveEmbeddingConfig('roboapply', env)).toMatchObject({ model: 'openai/text-embedding-3-large', apiKey: 'sk-open', baseUrl: 'https://api.openai.com/v1', batchSize: 96 });
  });

  it('CN_EMBED_MODEL alone changes the model for GoApply only', () => {
    const env = { OPENAI_API_KEY: 'sk-open', CN_EMBED_MODEL: 'openai/text-embedding-3-large' };
    expect(resolveEmbeddingConfig('goapply', env).modelTag).toBe('openai/text-embedding-3-large@1024');
    expect(resolveEmbeddingConfig('roboapply', env).modelTag).toBe('openai/text-embedding-3-small@1024');
  });

  it('never pairs a key with an endpoint it was not configured for', () => {
    // The OpenAI key is not sent to another endpoint.
    expect(resolveEmbeddingConfig('roboapply', { OPENAI_API_KEY: 'sk-open', EMBED_BASE_URL: 'https://api.voyageai.com/v1' }).apiKey).toBeNull();
    // The shared embed key is not sent to GoApply's own endpoint.
    expect(resolveEmbeddingConfig('goapply', { EMBED_API_KEY: 'sk-embed', CN_EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toMatchObject({ apiKey: null, modelTag: null });
  });

  it("GoApply's own URL and own key are one pair: with only one of them set GoApply has no key", () => {
    const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    // The mainland vendor's key is never sent to the shared endpoint (the URL was forgotten).
    for (const shared of [{ OPENAI_API_KEY: 'sk-open' }, { EMBED_BASE_URL: 'https://api.voyageai.com/v1', EMBED_API_KEY: 'sk-embed' }, {}]) {
      const cfg = resolveEmbeddingConfig('goapply', { ...shared, CN_EMBED_MODEL: 'text-embedding-v4', CN_EMBED_API_KEY: 'sk-cn' });
      expect(cfg).toMatchObject({ apiKey: null, modelTag: null });
      // RoboApply is untouched by GoApply's half-set pair.
      expect(resolveEmbeddingConfig('roboapply', { ...shared, CN_EMBED_API_KEY: 'sk-cn' }).apiKey).toBe((shared as Record<string, string>).EMBED_API_KEY ?? (shared as Record<string, string>).OPENAI_API_KEY ?? null);
    }
    // The shared key is never sent to GoApply's own endpoint (the key was forgotten).
    expect(resolveEmbeddingConfig('goapply', { OPENAI_API_KEY: 'sk-open', EMBED_API_KEY: 'sk-embed', CN_EMBED_BASE_URL: dashscope })).toMatchObject({ apiKey: null, modelTag: null, baseUrl: dashscope });
    // Both set: the pair is used. A separate GoApply account on the shared endpoint names that URL as its own.
    expect(resolveEmbeddingConfig('goapply', { OPENAI_API_KEY: 'sk-open', CN_EMBED_BASE_URL: 'https://api.openai.com/v1', CN_EMBED_API_KEY: 'sk-cn' })).toMatchObject({ apiKey: 'sk-cn', baseUrl: 'https://api.openai.com/v1' });
  });

  it('names a half-set GoApply pair (names only), and nothing when the pair is whole or absent', () => {
    expect(embeddingEnvProblems({ CN_EMBED_API_KEY: 'sk-cn' })).toMatchObject([{ code: 'own_key_without_own_url', set: 'CN_EMBED_API_KEY', missing: 'CN_EMBED_BASE_URL' }]);
    expect(embeddingEnvProblems({ CN_EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toMatchObject([{ code: 'own_url_without_own_key', set: 'CN_EMBED_BASE_URL', missing: 'CN_EMBED_API_KEY' }]);
    expect(embeddingEnvProblems({ CN_EMBED_BASE_URL: 'https://x.example/v1', CN_EMBED_API_KEY: 'sk-cn' })).toEqual([]);
    expect(embeddingEnvProblems({ OPENAI_API_KEY: 'sk-open', CN_EMBED_MODEL: 'text-embedding-v4' })).toEqual([]);
    // Never a value.
    expect(JSON.stringify(embeddingEnvProblems({ CN_EMBED_API_KEY: 'sk-cn-secret' }))).not.toContain('sk-cn-secret');
  });

  it('caps the batch size at 96 and ignores a bad value', () => {
    expect(resolveEmbeddingConfig('roboapply', { EMBED_BATCH_SIZE: '500' }).batchSize).toBe(96);
    expect(resolveEmbeddingConfig('roboapply', { EMBED_BATCH_SIZE: '0' }).batchSize).toBe(96);
    expect(resolveEmbeddingConfig('roboapply', { EMBED_BATCH_SIZE: 'abc' }).batchSize).toBe(96);
    expect(resolveEmbeddingConfig('roboapply', { EMBED_BATCH_SIZE: '32' }).batchSize).toBe(32);
  });
});

describe('embeddingRoute', () => {
  it('strips the provider prefix for a direct endpoint and keeps the vendor namespace on OpenRouter', () => {
    expect(embeddingRoute({ model: 'openai/text-embedding-3-small', baseUrl: 'https://api.openai.com/v1' })).toEqual({ provider: 'openai', wireModel: 'text-embedding-3-small' });
    expect(embeddingRoute({ model: 'openai/text-embedding-3-small', baseUrl: 'https://openrouter.ai/api/v1' })).toEqual({ provider: 'openrouter', wireModel: 'openai/text-embedding-3-small' });
    expect(embeddingRoute({ model: 'openrouter/openai/text-embedding-3-small', baseUrl: 'https://openrouter.ai/api/v1' }).wireModel).toBe('openai/text-embedding-3-small');
    expect(embeddingRoute({ model: 'text-embedding-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toEqual({ provider: 'qwen', wireModel: 'text-embedding-v4' });
    expect(embeddingRoute({ model: 'dashscope/text-embedding-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }).wireModel).toBe('text-embedding-v4');
    // An unknown host is an OpenAI-compatible gateway; a namespace that is not a provider stays.
    expect(embeddingRoute({ model: 'BAAI/bge-m3', baseUrl: 'https://gateway.example/v1' })).toEqual({ provider: 'newapi', wireModel: 'BAAI/bge-m3' });
    // The host decides the provider the policy judges, not the prefix of the model id.
    expect(embeddingRoute({ model: 'openai/text-embedding-3-small', baseUrl: 'https://gateway.example/v1' })).toEqual({ provider: 'newapi', wireModel: 'text-embedding-3-small' });
  });
});

describe('embedTexts', () => {
  it('with no key answers unavailable (no_key) and makes no request', async () => {
    const k = kit({});
    await expect(k.client.embedTexts('roboapply', ['a'], JOB)).resolves.toEqual({ unavailable: 'no_key' });
    await expect(k.client.embedTexts('goapply', ['a'], USER)).resolves.toEqual({ unavailable: 'no_key' });
    expect(k.calls).toHaveLength(0);
    expect(k.usage).toHaveLength(0);
  });

  it('a half-set GoApply pair answers no_key, makes no request and is reported once', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const k = kit({ OPENAI_API_KEY: 'sk-open', CN_EMBED_MODEL: 'text-embedding-v4', CN_EMBED_API_KEY: 'sk-cn' });
    await expect(k.client.embedTexts('goapply', ['公开职位'], JOB)).resolves.toEqual({ unavailable: 'no_key' });
    await expect(k.client.embedTexts('goapply', ['公开职位'], JOB)).resolves.toEqual({ unavailable: 'no_key' });
    await expect(k.client.availability!('goapply', { carriesUserData: false })).resolves.toBe('no_key');
    expect(k.calls).toHaveLength(0);
    const reports = warn.mock.calls.filter((c) => String(c[1]).includes('CN_EMBED_API_KEY is set without CN_EMBED_BASE_URL'));
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('sk-cn');
    // RoboApply keeps working on the shared stack.
    expect('vectors' in (await k.client.embedTexts('roboapply', ['a'], JOB))).toBe(true);
  });

  it('sends 200 inputs as 96 + 96 + 8, each request at 1024 dimensions, and keeps the input order', async () => {
    const k = kit({ OPENAI_API_KEY: 'sk-open' });
    const texts = Array.from({ length: 200 }, (_, i) => `text ${i}`);
    const out = await k.client.embedTexts('roboapply', texts, JOB);
    expect(k.calls.map((c) => c.body.input.length)).toEqual([96, 96, 8]);
    for (const c of k.calls) {
      expect(c.url).toBe('https://api.openai.com/v1/embeddings');
      expect(c.body.dimensions).toBe(1024);
      expect(c.body.model).toBe('text-embedding-3-small');
      expect(c.headers.Authorization).toBe('Bearer sk-open');
    }
    expect(k.calls[2]!.body.input[0]).toBe('text 192');
    if ('unavailable' in out) throw new Error('expected vectors');
    expect(out.vectors).toHaveLength(200);
    expect(out.vectors.every((v) => v.length === 1024)).toBe(true);
    expect(out.model).toBe('openai/text-embedding-3-small@1024');
    expect(out.tokens).toBe(1000);
  });

  it('writes the token count to the usage log once per call and charges the budget with it', async () => {
    const k = kit({ OPENAI_API_KEY: 'sk-open' });
    await k.client.embedTexts('roboapply', Array.from({ length: 100 }, (_, i) => `t${i}`), { ...JOB, requestId: 'req-1' });
    expect(k.usage).toHaveLength(1);
    expect(k.usage[0]).toMatchObject({ brand: 'roboapply', market: 'intl', modelTag: 'openai/text-embedding-3-small@1024', purpose: 'job', tokens: 500, usageReported: true, inputs: 100, requests: 2, requestId: 'req-1' });
    expect(k.charged).toEqual([500]);
  });

  it('places the vectors by their index, whatever order the endpoint returns', async () => {
    const f = fakeFetch((call) =>
      new Response(JSON.stringify({ data: call.body.input.map((_, i) => ({ index: i, embedding: vec(i) })).reverse(), usage: { prompt_tokens: 3 } }), { status: 200 }),
    );
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
    const out = await k.client.embedTexts('roboapply', ['a', 'b', 'c'], JOB);
    if ('unavailable' in out) throw new Error('expected vectors');
    expect(out.vectors).toEqual([vec(0), vec(1), vec(2)]);
    expect(out.tokens).toBe(3);
  });

  it('fails the whole call for a vector of another size: never padded, cut or zero-filled', async () => {
    const f = fakeFetch((call) => ok(call.body.input.map((_, i) => (i === 1 ? vec(i, 1536) : vec(i)))));
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
    await expect(k.client.embedTexts('roboapply', ['a', 'b', 'c'], JOB)).rejects.toMatchObject({ name: 'EmbeddingsError', code: 'bad_response' });
    await expect(k.client.embedTexts('roboapply', ['a', 'b', 'c'], JOB)).rejects.toThrow(/1536 values; 1024/);
  });

  it('fails for a short vector, a non-finite value, a missing vector or a duplicated index', async () => {
    const cases: Array<(n: number) => unknown[]> = [
      (n) => Array.from({ length: n }, (_, i) => vec(i, 512)),
      (n) => Array.from({ length: n }, (_, i) => (i === 0 ? [...vec(0).slice(0, 1023), null] : vec(i))),
      (n) => Array.from({ length: n - 1 }, (_, i) => vec(i)),
    ];
    for (const make of cases) {
      const f = fakeFetch((call) => ok(make(call.body.input.length)));
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
      await expect(k.client.embedTexts('roboapply', ['a', 'b'], JOB)).rejects.toBeInstanceOf(EmbeddingsError);
    }
    const dup = fakeFetch(() => new Response(JSON.stringify({ data: [{ index: 0, embedding: vec(0) }, { index: 0, embedding: vec(1) }] }), { status: 200 }));
    await expect(kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: dup.fetch }).client.embedTexts('roboapply', ['a', 'b'], JOB)).rejects.toMatchObject({ code: 'bad_response' });
  });

  // M2 gate: some compatible gateways answer a filtered or failed input with zeros. Its cosine distance to anything is NaN.
  it('fails the whole call for a vector of zeros: it is a malformed answer, never an embedding', async () => {
    const zeros = Array.from({ length: 1024 }, () => 0);
    const f = fakeFetch((call) => ok(call.body.input.map((_, i) => (i === 1 ? zeros : vec(i)))));
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
    await expect(k.client.embedTexts('roboapply', ['a', 'b', 'c'], JOB)).rejects.toMatchObject({ name: 'EmbeddingsError', code: 'bad_response' });
    // One component that is not zero is a direction, so it is a vector.
    const almost = [...zeros.slice(0, 1023), 0.5];
    const g = fakeFetch((call) => ok(call.body.input.map(() => almost)));
    const out = await kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: g.fetch }).client.embedTexts('roboapply', ['a'], JOB);
    expect('vectors' in out && out.vectors[0]).toEqual(almost);
  });

  it('retries once on 429 after the Retry-After delay, and once on a 5xx', async () => {
    const f = fakeFetch((call, n) => (n === 1 ? new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }) : ok(call.body.input.map((_, i) => vec(i)))));
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
    const out = await k.client.embedTexts('roboapply', ['a'], JOB);
    expect('vectors' in out).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(k.slept).toEqual([2000]);

    const g = fakeFetch((call, n) => (n === 1 ? new Response('oops', { status: 503 }) : ok(call.body.input.map((_, i) => vec(i)))));
    const k2 = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: g.fetch });
    await k2.client.embedTexts('roboapply', ['a'], JOB);
    expect(g.calls).toHaveLength(2);
    expect(k2.slept).toEqual([1000]);
  });

  it('gives up after the one retry, bounds a long Retry-After and does not retry a 4xx', async () => {
    const f = fakeFetch(() => new Response('busy', { status: 429, headers: { 'Retry-After': '600' } }));
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
    await expect(k.client.embedTexts('roboapply', ['a'], JOB)).rejects.toMatchObject({ code: 'http', status: 429 });
    expect(f.calls).toHaveLength(2);
    expect(k.slept).toEqual([10_000]);
    expect(k.usage).toHaveLength(0);

    const g = fakeFetch(() => new Response('bad key', { status: 401 }));
    const k2 = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: g.fetch });
    await expect(k2.client.embedTexts('roboapply', ['a'], JOB)).rejects.toMatchObject({ code: 'http', status: 401 });
    expect(g.calls).toHaveLength(1);
  });

  it('counts and logs the tokens already spent when a later batch fails', async () => {
    const f = fakeFetch((call, n) => (n === 1 ? ok(call.body.input.map((_, i) => vec(i)), 480) : new Response('bad', { status: 400 })));
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
    await expect(k.client.embedTexts('roboapply', Array.from({ length: 100 }, (_, i) => `t${i}`), JOB)).rejects.toBeInstanceOf(EmbeddingsError);
    expect(k.charged).toEqual([480]);
    expect(k.usage).toHaveLength(1);
    expect(k.usage[0]).toMatchObject({ tokens: 480, requests: 1, inputs: 96 });
  });

  describe('an endpoint that accepts fewer inputs per request than the batch size', () => {
    /** Refuses more than `limit` inputs with 400, as a vendor with a lower limit does. */
    const limited = (limit: number) => fakeFetch((call) => (call.body.input.length > limit ? new Response('too many inputs', { status: 400 }) : ok(call.body.input.map((t) => vec(Number(t.slice(1)))), call.body.input.length)));

    it('halves a refused batch until the endpoint accepts it, keeps the order and counts every token', async () => {
      const f = limited(10);
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
      const texts = Array.from({ length: 96 }, (_, i) => `t${i}`);
      const out = await k.client.embedTexts('roboapply', texts, JOB);
      if ('unavailable' in out) throw new Error('expected vectors');
      expect(out.vectors).toEqual(texts.map((_, i) => vec(i)));
      // 96 → 48 → 24 → 12 → 6: every accepted request carries 6 inputs.
      const accepted = f.calls.filter((c) => c.body.input.length <= 10);
      expect(accepted.map((c) => c.body.input.length)).toEqual(Array(16).fill(6));
      expect(out.tokens).toBe(96);
      expect(k.charged).toEqual([96]);
      expect(k.usage[0]).toMatchObject({ inputs: 96, requests: 16, tokens: 96 });
    });

    it('remembers the size that worked for later calls of the same client', async () => {
      const f = limited(10);
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
      await k.client.embedTexts('roboapply', Array.from({ length: 96 }, (_, i) => `t${i}`), JOB);
      const before = f.calls.length;
      await k.client.embedTexts('roboapply', Array.from({ length: 30 }, (_, i) => `t${i}`), JOB);
      // No refused request this time: 30 inputs go as 5 requests of 6.
      expect(f.calls.slice(before).map((c) => c.body.input.length)).toEqual([6, 6, 6, 6, 6]);
    });

    it('a 400 for one input is the failure of the call, and other errors are never split', async () => {
      const always = fakeFetch(() => new Response('bad model', { status: 400 }));
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: always.fetch });
      await expect(k.client.embedTexts('roboapply', ['a', 'b', 'c', 'd'], JOB)).rejects.toMatchObject({ code: 'http', status: 400 });
      // 4 → 2 → 1: three requests, then the single input fails the call.
      expect(always.calls.map((c) => c.body.input.length)).toEqual([4, 2, 1]);
      const unauthorised = fakeFetch(() => new Response('bad key', { status: 401 }));
      await expect(kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: unauthorised.fetch }).client.embedTexts('roboapply', ['a', 'b'], JOB)).rejects.toMatchObject({ status: 401 });
      expect(unauthorised.calls).toHaveLength(1);
    });
  });

  it('maps a timeout to an EmbeddingsError and passes a 20 s signal', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: fetchFn });
    await expect(k.client.embedTexts('roboapply', ['a'], JOB)).rejects.toMatchObject({ code: 'timeout' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an empty text before any request and answers an empty list without one', async () => {
    const k = kit({ OPENAI_API_KEY: 'sk-open' });
    await expect(k.client.embedTexts('roboapply', ['a', '  '], JOB)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(k.client.embedTexts('roboapply', [], JOB)).resolves.toEqual({ vectors: [], model: 'openai/text-embedding-3-small@1024', tokens: 0 });
    expect(k.calls).toHaveLength(0);
  });

  describe('route policy', () => {
    it('GoApply behind the domestic-only wall sends nothing to the shared endpoint', async () => {
      for (const wall of [{ CN_LLM_DOMESTIC_ONLY: 'true' }, { CN_RESIDENCY_STRICT: 'true' }]) {
        const k = kit({ OPENAI_API_KEY: 'sk-open', ...wall });
        await expect(k.client.embedTexts('goapply', ['简历文本'], USER)).resolves.toEqual({ unavailable: 'policy' });
        await expect(k.client.embedTexts('goapply', ['公开职位'], JOB)).resolves.toEqual({ unavailable: 'policy' });
        expect(k.calls).toHaveLength(0);
        expect(k.usage).toHaveLength(0);
      }
    });

    it('GoApply behind the wall may use a mainland endpoint of its own', async () => {
      const k = kit({
        OPENAI_API_KEY: 'sk-open',
        CN_LLM_DOMESTIC_ONLY: 'true',
        CN_EMBED_MODEL: 'text-embedding-v4',
        CN_EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        CN_EMBED_API_KEY: 'sk-cn',
      });
      const out = await k.client.embedTexts('goapply', ['简历文本'], USER);
      expect('vectors' in out && out.model).toBe('text-embedding-v4@1024');
      expect(k.calls[0]!.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
      expect(k.calls[0]!.headers.Authorization).toBe('Bearer sk-cn');
      expect(k.calls[0]!.body).toMatchObject({ model: 'text-embedding-v4', dimensions: 1024 });
    });

    it('GoApply behind the wall may use a gateway only on an allowlisted mainland host, whatever the model id says', async () => {
      const base = { CN_LLM_DOMESTIC_ONLY: 'true', CN_EMBED_MODEL: 'openai/text-embedding-3-small', CN_EMBED_BASE_URL: 'https://llm.internal.example.cn/v1', CN_EMBED_API_KEY: 'sk-gw' };
      const refused = kit(base);
      await expect(refused.client.embedTexts('goapply', ['简历文本'], USER)).resolves.toEqual({ unavailable: 'policy' });
      expect(refused.calls).toHaveLength(0);
      const allowed = kit({ ...base, CN_LLM_DOMESTIC_HOSTS: 'llm.internal.example.cn' });
      expect('vectors' in (await allowed.client.embedTexts('goapply', ['简历文本'], USER))).toBe(true);
      expect(allowed.calls[0]!.body.model).toBe('text-embedding-3-small');
    });

    it('GoApply without the wall uses the shared endpoint (D5)', async () => {
      const k = kit({ OPENAI_API_KEY: 'sk-open' });
      const out = await k.client.embedTexts('goapply', ['简历文本'], USER);
      expect('vectors' in out).toBe(true);
      expect(k.calls).toHaveLength(1);
    });

    it('RoboApply never sends user data to a mainland endpoint, and may send public job text there', async () => {
      const env = { EMBED_MODEL: 'text-embedding-v4', EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', EMBED_API_KEY: 'sk-ds' };
      const k = kit(env);
      await expect(k.client.embedTexts('roboapply', ['my resume'], USER)).resolves.toEqual({ unavailable: 'policy' });
      expect(k.calls).toHaveLength(0);
      const out = await k.client.embedTexts('roboapply', ['a public posting'], JOB);
      expect('vectors' in out).toBe(true);
    });
  });

  describe('daily budget', () => {
    it('answers unavailable (budget) without a request when the budget is spent', async () => {
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { budget: { hasRoom: async () => false, charge: async () => undefined } });
      await expect(k.client.embedTexts('roboapply', ['a'], JOB)).resolves.toEqual({ unavailable: 'budget' });
      expect(k.calls).toHaveLength(0);
    });

    it('reads the counter without spending, charges what the call used, per brand', async () => {
      const seen: Array<{ key: string; limit: number; cost: number }> = [];
      const budget = createEmbeddingBudget(async (input) => {
        seen.push({ key: input.key, limit: input.windows[0]!.limit, cost: input.cost });
        return { remaining: 100 };
      });
      const k = kit({ OPENAI_API_KEY: 'sk-open', CN_EMBED_DAILY_TOKENS: '5000' }, { budget });
      await k.client.embedTexts('goapply', ['a', 'b'], JOB);
      expect(seen).toEqual([
        { key: 'budget:embed:goapply', limit: 5000, cost: 0 },
        { key: 'budget:embed:goapply', limit: 5000, cost: 10 },
      ]);
      expect(embedBudgetKey('roboapply')).toBe('budget:embed:roboapply');
    });

    it('an unreadable counter is not a spent budget: the call fails so the queue retries it, and no request is made', async () => {
      const broken = createEmbeddingBudget(async () => {
        throw new Error('db down');
      });
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { budget: broken });
      await expect(k.client.embedTexts('roboapply', ['a'], JOB)).rejects.toMatchObject({ name: 'EmbeddingsError', code: 'budget_unreadable' });
      await expect(k.client.availability!('roboapply', { carriesUserData: false })).rejects.toMatchObject({ code: 'budget_unreadable' });
      expect(k.calls).toHaveLength(0);
      expect(k.usage).toHaveLength(0);
    });

    it('is 20,000,000 tokens by default, 0 switches embedding off, and an unreadable counter throws', async () => {
      expect(embedDailyTokens(getBrand('roboapply'), {})).toBe(DEFAULT_EMBED_DAILY_TOKENS);
      expect(DEFAULT_EMBED_DAILY_TOKENS).toBe(20_000_000);
      expect(embedDailyTokens(getBrand('goapply'), { EMBED_DAILY_TOKENS: '7', CN_EMBED_DAILY_TOKENS: '9' })).toBe(9);
      expect(embedDailyTokens(getBrand('roboapply'), { EMBED_DAILY_TOKENS: '7', CN_EMBED_DAILY_TOKENS: '9' })).toBe(7);
      const consume = vi.fn(async () => ({ remaining: 5 }));
      const off = createEmbeddingBudget(consume);
      await expect(off.hasRoom(getBrand('roboapply'), { EMBED_DAILY_TOKENS: '0' }, new Date())).resolves.toBe(false);
      expect(consume).not.toHaveBeenCalled();
      const spent = createEmbeddingBudget(async () => ({ remaining: 0 }));
      await expect(spent.hasRoom(getBrand('roboapply'), {}, new Date())).resolves.toBe(false);
      const broken = createEmbeddingBudget(async () => {
        throw new Error('db down');
      });
      await expect(broken.hasRoom(getBrand('roboapply'), {}, new Date())).rejects.toThrow('db down');
      await expect(broken.charge(getBrand('roboapply'), 5, {}, new Date())).resolves.toBeUndefined();
    });

    it('counts an estimate against the budget when the endpoint reports no usage, and logs zero reported tokens', async () => {
      const f = fakeFetch((call) => ok(call.body.input.map((_, i) => vec(i)), null));
      const k = kit({ OPENAI_API_KEY: 'sk-open' }, { fetch: f.fetch });
      const out = await k.client.embedTexts('roboapply', ['abcdefgh'], JOB);
      expect('vectors' in out && out.tokens).toBe(0);
      expect(k.charged).toEqual([2]);
      expect(k.usage[0]).toMatchObject({ tokens: 0, usageReported: false });
    });
  });
});

describe('embeddingAvailability (no request)', () => {
  it("answers 'ok' or the reason embedTexts would give, per brand and kind of text", async () => {
    const open = kit({ OPENAI_API_KEY: 'sk-open' });
    await expect(open.client.availability!('roboapply', { carriesUserData: true })).resolves.toBe('ok');
    await expect(kit({}).client.availability!('roboapply', { carriesUserData: false })).resolves.toBe('no_key');
    // GoApply behind the domestic-only wall on the shared endpoint: no vector of any text.
    const walled = kit({ OPENAI_API_KEY: 'sk-open', CN_LLM_DOMESTIC_ONLY: 'true' });
    await expect(walled.client.availability!('goapply', { carriesUserData: false })).resolves.toBe('policy');
    await expect(walled.client.availability!('roboapply', { carriesUserData: false })).resolves.toBe('ok');
    // RoboApply on a mainland endpoint: public job text yes, user text no.
    const mainland = kit({ EMBED_MODEL: 'text-embedding-v4', EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', EMBED_API_KEY: 'sk-ds' });
    await expect(mainland.client.availability!('roboapply', { carriesUserData: false })).resolves.toBe('ok');
    await expect(mainland.client.availability!('roboapply', { carriesUserData: true })).resolves.toBe('policy');
    // A budget of 0, or a spent one.
    await expect(kit({ OPENAI_API_KEY: 'sk-open', EMBED_DAILY_TOKENS: '0' }, { budget: createEmbeddingBudget(async () => ({ remaining: 5 })) }).client.availability!('roboapply', { carriesUserData: false })).resolves.toBe('budget');
    await expect(kit({ OPENAI_API_KEY: 'sk-open' }, { budget: { hasRoom: async () => false, charge: async () => undefined } }).client.availability!('roboapply', { carriesUserData: false })).resolves.toBe('budget');
    for (const k of [open, walled, mainland]) expect(k.calls).toHaveLength(0);
  });

  it("goes through the test seam, and a fake without the method counts as 'ok'", async () => {
    setEmbeddingsClientForTests({ embedTexts: async () => ({ unavailable: 'budget' }), availability: async () => 'policy' });
    await expect(embeddingAvailability('goapply', { carriesUserData: true })).resolves.toBe('policy');
    setEmbeddingsClientForTests({ embedTexts: async () => ({ unavailable: 'budget' }) });
    await expect(embeddingAvailability('goapply', { carriesUserData: true })).resolves.toBe('ok');
  });
});

describe('usage row', () => {
  const entry: EmbeddingUsageEntry = {
    brand: 'roboapply',
    market: 'intl',
    modelTag: 'openai/text-embedding-3-small@1024',
    wireModel: 'text-embedding-3-small',
    host: 'api.openai.com',
    purpose: 'user',
    tokens: 1_000_000,
    usageReported: true,
    inputs: 2,
    requests: 1,
    userId: 'u1',
    requestId: 'r1',
    env: { RA_SYSTEM_USER_ID: 'sys-intl', CN_RA_SYSTEM_USER_ID: 'sys-cn' },
  };

  it('is one ra_embed row with units = tokens, under the brand system user, with the cost of a priced model', () => {
    const row = embeddingUsageRow(entry);
    expect(EMBED_COST_SKU).toBe('ra_embed');
    expect(row).toMatchObject({ userId: 'sys-intl', sku: 'ra_embed', source: 'free_tier', units: 1_000_000, requestId: 'r1', relatedEntityType: 'user', relatedEntityId: 'u1' });
    expect(row.platformCostUsd).toBeCloseTo(0.02, 10);
    expect(row.metadata).toMatchObject({ brand: 'roboapply', model: 'openai/text-embedding-3-small@1024', purpose: 'user', costSource: 'vendor_list_price' });
    expect(embeddingUsageRow({ ...entry, brand: 'goapply', market: 'cn' }).userId).toBe('sys-cn');
    expect(embeddingUsageRow({ ...entry, env: {} }).userId).toBe('system_cron_ra_v2');
  });

  it('records the cost as unknown for a model without a price on file, and when no usage was reported', () => {
    const unknown = embeddingUsageRow({ ...entry, modelTag: 'text-embedding-v4@1024' });
    expect(unknown.platformCostUsd).toBeNull();
    expect(unknown.units).toBe(1_000_000);
    expect(unknown.metadata.costSource).toBe('unknown');
    expect(embeddingUsageRow({ ...entry, tokens: 0, usageReported: false }).platformCostUsd).toBeNull();
  });

  it("writes OpenAI's list price only for a call to OpenAI's own host: a gateway sets its own price", () => {
    for (const host of ['openrouter.ai', 'proxy.example', null]) {
      const row = embeddingUsageRow({ ...entry, host });
      expect(row.platformCostUsd, String(host)).toBeNull();
      expect(row.metadata).toMatchObject({ costSource: 'unknown', host });
      expect(row.units).toBe(1_000_000);
    }
    expect(embeddingUsageRow({ ...entry, host: 'API.OpenAI.com' }).metadata.costSource).toBe('vendor_list_price');
  });

  it('the client reports the host the call went to', async () => {
    const direct = kit({ OPENAI_API_KEY: 'sk-open' });
    await direct.client.embedTexts('roboapply', ['a'], JOB);
    expect(direct.usage[0]!.host).toBe('api.openai.com');
    const gateway = kit({ EMBED_BASE_URL: 'https://openrouter.ai/api/v1', EMBED_API_KEY: 'sk-or' });
    await gateway.client.embedTexts('roboapply', ['a'], JOB);
    expect(gateway.usage[0]!.host).toBe('openrouter.ai');
    expect(embeddingUsageRow(gateway.usage[0]!).platformCostUsd).toBeNull();
  });

  it('never throws, and reports a system user that names no account once', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Foreign key constraint violated on the constraint: `UsageDeductionLog_userId_fkey`'), { code: 'P2003' });
    });
    const log = createEmbeddingUsageLog(async () => ({ usageDeductionLog: { create } }), () => 1_000);
    await expect(log(entry)).resolves.toBeUndefined();
    await expect(log(entry)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);

    resetMissingEmbeddingCostUsersForTests();
    const failing = createEmbeddingUsageLog(async () => {
      throw new Error('no database');
    });
    await expect(failing(entry)).resolves.toBeUndefined();
  });
});

describe('setEmbeddingsClientForTests', () => {
  it('replaces the client behind embedTexts and null restores the real one', async () => {
    const fake = { embedTexts: vi.fn(async () => ({ unavailable: 'budget' as const })) };
    setEmbeddingsClientForTests(fake);
    await expect(embedTexts('roboapply', ['a'], JOB)).resolves.toEqual({ unavailable: 'budget' });
    expect(fake.embedTexts).toHaveBeenCalledWith('roboapply', ['a'], JOB);
    setEmbeddingsClientForTests(null);
    const saved = { e: process.env.EMBED_API_KEY, o: process.env.OPENAI_API_KEY, b: process.env.EMBED_BASE_URL };
    delete process.env.EMBED_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBED_BASE_URL;
    try {
      // The real client with no key: unavailable, and no request is attempted.
      const spy = vi.spyOn(globalThis, 'fetch');
      await expect(embedTexts('roboapply', ['a'], JOB)).resolves.toEqual({ unavailable: 'no_key' });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      if (saved.e !== undefined) process.env.EMBED_API_KEY = saved.e;
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.b !== undefined) process.env.EMBED_BASE_URL = saved.b;
    }
  });
});
