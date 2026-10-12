// @vitest-environment node
//
// WP-24: environment → provider, readiness for the CN-1 assertion, and the
// provider chain used in aliyun_green mode. D5: a setting that cannot run as
// written degrades to the keyword list (GoApply AI stays on); it fails closed
// only under CN_RESIDENCY_STRICT.

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTENT_SAFETY_TIMEOUT_MS,
  chainProviders,
  contentSafetyReadiness,
  createContentSafetyProvider,
  misconfiguredProvider,
  resolveContentSafetyConfig,
} from './config.js';
import { ContentSafetyProviderError, type ContentSafetyProvider, type ContentSafetyResult } from './types.js';
import { BUILTIN_KEYWORD_LIST } from './builtinKeywords.js';
import { PRIVATE_LIST, goapplyCtx } from './__tests__/fixtures.js';

const aliyunEnv = {
  CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green',
  ALIYUN_GREEN_ACCESS_KEY_ID: 'ak',
  ALIYUN_GREEN_ACCESS_KEY_SECRET: 'sk',
};
const STRICT = { CN_RESIDENCY_STRICT: 'true' };
/** Every way the three GoApply settings and Aliyun Green can be wrong at once. */
const everythingWrong = {
  CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green',
  ALIYUN_GREEN_REGION: 'ap-southeast-1',
  ALIYUN_GREEN_ENDPOINT: 'https://green-cip.ap-southeast-1.aliyuncs.com',
  CN_CONTENT_SAFETY_TIMEOUT_MS: '5',
  CN_SAFETY_KEYWORDS_URL: 'http://plain.example/list',
};

describe('resolveContentSafetyConfig', () => {
  it('defaults to keyword_only with the default timeout', () => {
    expect(resolveContentSafetyConfig({})).toEqual({ provider: 'keyword_only', timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS, problems: [], degraded: false });
  });

  it('reads only the CN_-prefixed names: the three settings are GoApply\'s own and never come from an unprefixed variable', () => {
    const cfg = resolveContentSafetyConfig({ CONTENT_SAFETY_PROVIDER: 'nonsense', SAFETY_KEYWORDS_URL: 'http://x', CONTENT_SAFETY_TIMEOUT_MS: '1' });
    expect(cfg).toEqual({ provider: 'keyword_only', timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS, problems: [], degraded: false });
  });

  it('aliyun_green with keys resolves the mainland endpoint and LLM services', () => {
    const cfg = resolveContentSafetyConfig(aliyunEnv);
    expect(cfg.problems).toEqual([]);
    expect(cfg.aliyun).toEqual({
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      endpoint: 'https://green-cip.cn-shanghai.aliyuncs.com',
      inputService: 'llm_query_moderation',
      outputService: 'llm_response_moderation',
    });
    const custom = resolveContentSafetyConfig({
      ...aliyunEnv,
      ALIYUN_GREEN_REGION: 'cn-beijing',
      ALIYUN_GREEN_INPUT_SERVICE: 'chat_detection_pro',
      ALIYUN_GREEN_OUTPUT_SERVICE: 'comment_detection_pro',
      CN_CONTENT_SAFETY_TIMEOUT_MS: '2500',
    });
    expect(custom.aliyun?.endpoint).toBe('https://green-cip.cn-beijing.aliyuncs.com');
    expect(custom.aliyun?.inputService).toBe('chat_detection_pro');
    expect(custom.timeoutMs).toBe(2500);
  });

  it('collects every problem, and by default runs on the safe defaults instead of failing (degraded)', () => {
    const cfg = resolveContentSafetyConfig(everythingWrong);
    expect(cfg.problems).toHaveLength(5);
    expect(cfg.problems.join(' | ')).toMatch(/TIMEOUT.*https.*ACCESS_KEY.*outside mainland.*outside mainland/);
    // Each bad value fell back to its default: keyword list, built-in only, default timeout, no Aliyun call.
    expect(cfg).toMatchObject({ provider: 'keyword_only', timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS, degraded: true });
    expect(cfg.keywordsUrl).toBeUndefined();
    expect(cfg.aliyun).toBeUndefined();

    expect(resolveContentSafetyConfig({ CN_CONTENT_SAFETY_PROVIDER: 'openai_moderation' })).toEqual({
      provider: 'keyword_only',
      timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS,
      problems: [expect.stringMatching(/keyword_only or aliyun_green/)],
      degraded: true,
    });
  });

  it('each bad value degrades on its own: the rest of the configuration is kept', () => {
    // A bad timeout does not cost a working Aliyun Green its place.
    expect(resolveContentSafetyConfig({ ...aliyunEnv, CN_CONTENT_SAFETY_TIMEOUT_MS: 'soon' })).toMatchObject({
      provider: 'aliyun_green',
      timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS,
      degraded: true,
      aliyun: { accessKeyId: 'ak' },
    });
    // A bad keyword URL: the built-in list alone, Aliyun Green still on.
    const badUrl = resolveContentSafetyConfig({ ...aliyunEnv, CN_SAFETY_KEYWORDS_URL: 'http://plain.example/list' });
    expect(badUrl).toMatchObject({ provider: 'aliyun_green', degraded: true });
    expect(badUrl.keywordsUrl).toBeUndefined();
    // Aliyun Green without keys: the keyword list, and the private list stays.
    const noKeys = resolveContentSafetyConfig({ CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green', CN_SAFETY_KEYWORDS_URL: 'https://l.cn/k.json', CN_CONTENT_SAFETY_TIMEOUT_MS: '2500' });
    expect(noKeys).toMatchObject({ provider: 'keyword_only', keywordsUrl: 'https://l.cn/k.json', timeoutMs: 2500, degraded: true });
    expect(noKeys.aliyun).toBeUndefined();
  });

  it('under CN_RESIDENCY_STRICT a problem is not set aside: the configuration is kept as written and is not degraded', () => {
    const cfg = resolveContentSafetyConfig({ ...everythingWrong, ...STRICT });
    expect(cfg.problems).toHaveLength(5);
    expect(cfg).toMatchObject({ provider: 'aliyun_green', degraded: false, keywordsUrl: 'http://plain.example/list' });
    expect(resolveContentSafetyConfig({ CN_CONTENT_SAFETY_PROVIDER: 'openai_moderation', ...STRICT })).toMatchObject({
      provider: 'invalid',
      degraded: false,
      problems: [expect.stringMatching(/keyword_only or aliyun_green/)],
    });
    // A clean configuration is the same with or without the switch.
    expect(resolveContentSafetyConfig({ ...aliyunEnv, ...STRICT })).toEqual(resolveContentSafetyConfig(aliyunEnv));
  });
});

describe('contentSafetyReadiness', () => {
  it('keyword_only is usable but not CN-1 ready', () => {
    expect(contentSafetyReadiness({})).toEqual({
      provider: 'keyword_only',
      usable: true,
      degraded: false,
      cn1Ready: false,
      keywordList: 'builtin',
      timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS,
      problems: [],
    });
  });

  it('aliyun_green with keys is CN-1 ready; without keys it runs as the keyword list (usable, never CN-1 ready)', () => {
    expect(contentSafetyReadiness({ ...aliyunEnv, CN_SAFETY_KEYWORDS_URL: 'https://l.cn/k.json' })).toMatchObject({
      usable: true,
      degraded: false,
      cn1Ready: true,
      keywordList: 'builtin+private',
    });
    expect(contentSafetyReadiness({ CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' })).toMatchObject({
      provider: 'keyword_only',
      usable: true,
      degraded: true,
      cn1Ready: false,
      problems: [expect.stringMatching(/ACCESS_KEY/)],
    });
    // A working Aliyun Green with one bad side setting is not CN-1 ready either: the operator has something to fix.
    expect(contentSafetyReadiness({ ...aliyunEnv, CN_CONTENT_SAFETY_TIMEOUT_MS: '5' })).toMatchObject({ provider: 'aliyun_green', usable: true, degraded: true, cn1Ready: false });
  });

  it('a typo in a CN_CONTENT_SAFETY_* value never turns GoApply AI off: usable stays true and the problem is reported', () => {
    for (const env of [
      { CN_CONTENT_SAFETY_PROVIDER: 'nonsense' },
      { CN_CONTENT_SAFETY_TIMEOUT_MS: '5' },
      { CN_SAFETY_KEYWORDS_URL: 'http://plain.example/list' },
      everythingWrong,
    ]) {
      const r = contentSafetyReadiness(env);
      expect(r, JSON.stringify(env)).toMatchObject({ usable: true, degraded: true, keywordList: 'builtin', timeoutMs: DEFAULT_CONTENT_SAFETY_TIMEOUT_MS });
      expect(r.problems.length).toBeGreaterThan(0);
    }
    expect(contentSafetyReadiness({ CN_CONTENT_SAFETY_PROVIDER: 'nonsense' }).provider).toBe('keyword_only');
  });

  it('fails closed only under CN_RESIDENCY_STRICT', () => {
    for (const env of [
      { CN_CONTENT_SAFETY_PROVIDER: 'nonsense' },
      { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' },
      { CN_CONTENT_SAFETY_TIMEOUT_MS: '5' },
      { CN_SAFETY_KEYWORDS_URL: 'http://plain.example/list' },
    ]) {
      expect(contentSafetyReadiness({ ...env, ...STRICT }), JSON.stringify(env)).toMatchObject({ usable: false, degraded: false, cn1Ready: false });
    }
    expect(contentSafetyReadiness({ CN_CONTENT_SAFETY_PROVIDER: 'nonsense', ...STRICT }).provider).toBe('invalid');
    // The LLM wall alone is not the residency switch: content safety still degrades.
    expect(contentSafetyReadiness({ CN_CONTENT_SAFETY_PROVIDER: 'nonsense', CN_LLM_DOMESTIC_ONLY: 'true' })).toMatchObject({ usable: true, degraded: true });
    // A clean configuration is usable under the switch.
    expect(contentSafetyReadiness(STRICT)).toMatchObject({ usable: true, degraded: false });
    expect(contentSafetyReadiness({ ...aliyunEnv, ...STRICT })).toMatchObject({ usable: true, cn1Ready: true });
  });

  it('never returns secrets', () => {
    expect(JSON.stringify(contentSafetyReadiness(aliyunEnv))).not.toContain('sk');
  });
});

describe('createContentSafetyProvider', () => {
  it('builds keyword_only, the keyword+aliyun chain, or a fail-closed provider', async () => {
    expect(createContentSafetyProvider(resolveContentSafetyConfig({})).id).toBe('keyword_only');
    expect(createContentSafetyProvider(resolveContentSafetyConfig(aliyunEnv)).id).toBe('keyword_only+aliyun_green');
    // Both expose their keyword part for the stream guard's final scan; the misconfigured one has none.
    const kw = createContentSafetyProvider(resolveContentSafetyConfig({}));
    expect(kw.keywordProvider).toBe(kw);
    expect(createContentSafetyProvider(resolveContentSafetyConfig(aliyunEnv)).keywordProvider?.id).toBe('keyword_only');
    // Under CN_RESIDENCY_STRICT a bad configuration is a provider that refuses every check.
    for (const env of [{ CN_CONTENT_SAFETY_PROVIDER: 'bogus' }, { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' }, { CN_CONTENT_SAFETY_TIMEOUT_MS: '5' }]) {
      const broken = createContentSafetyProvider(resolveContentSafetyConfig({ ...env, ...STRICT }));
      expect(broken.id).toBe('misconfigured');
      const err = await broken.checkOutput('x', goapplyCtx()).catch((e) => e);
      expect(err).toBeInstanceOf(ContentSafetyProviderError);
      expect(err.cause_).toBe('misconfigured');
    }
  });

  it('a degraded configuration still filters: the built-in keyword list runs, it is never "no filter"', async () => {
    for (const env of [{ CN_CONTENT_SAFETY_PROVIDER: 'bogus' }, { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' }, everythingWrong]) {
      const p = createContentSafetyProvider(resolveContentSafetyConfig(env));
      expect(p.id, JSON.stringify(env)).toBe('keyword_only');
      const blocked = BUILTIN_KEYWORD_LIST.entries.find((e) => e.action === 'block')!;
      await expect(p.checkInput(`please: ${blocked.term}`, goapplyCtx())).resolves.toMatchObject({ verdict: 'block' });
      await expect(p.checkOutput('An ordinary answer about a resume.', goapplyCtx())).resolves.toMatchObject({ verdict: 'pass' });
    }
    // One bad side setting keeps the stronger filter.
    expect(createContentSafetyProvider(resolveContentSafetyConfig({ ...aliyunEnv, CN_CONTENT_SAFETY_TIMEOUT_MS: '5' })).id).toBe('keyword_only+aliyun_green');
  });

  it('wires the private list URL into the keyword provider', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PRIVATE_LIST)));
    const p = createContentSafetyProvider(resolveContentSafetyConfig({ CN_SAFETY_KEYWORDS_URL: 'https://l.cn/k.json' }), {
      keyword: { fetchImpl: fetchImpl as typeof fetch },
    });
    await expect(p.checkInput('a forbidden phrase', goapplyCtx())).resolves.toMatchObject({ verdict: 'block', ruleIds: ['1:p-2'] });
    expect(fetchImpl).toHaveBeenCalledWith('https://l.cn/k.json', expect.anything());
  });

  it('misconfiguredProvider names the problems', async () => {
    await expect(misconfiguredProvider(['a', 'b']).checkInput('x', goapplyCtx())).rejects.toThrow('a; b');
  });
});

describe('chainProviders', () => {
  const fixed = (id: string, r: Partial<ContentSafetyResult>): ContentSafetyProvider & { calls: number } => {
    const p = {
      id,
      calls: 0,
      async checkInput() {
        p.calls++;
        return { verdict: 'pass' as const, labels: [], provider: id, ...r };
      },
      async checkOutput() {
        p.calls++;
        return { verdict: 'pass' as const, labels: [], provider: id, ...r };
      },
    };
    return p;
  };

  it('a block from the first provider skips the second', async () => {
    const a = fixed('a', { verdict: 'block', labels: ['k'], ruleIds: ['r1'], reason: 'keyword', hitOffset: 3 });
    const b = fixed('b', {});
    const r = await chainProviders([a, b]).checkInput('x', goapplyCtx());
    expect(r).toEqual({ verdict: 'block', labels: ['k'], ruleIds: ['r1'], reason: 'keyword', hitOffset: 3, provider: 'a+b' });
    expect(b.calls).toBe(0);
  });

  it('the stricter verdict wins and its reason and offset are kept', async () => {
    const a = fixed('a', { verdict: 'review', labels: ['k'], reason: 'keyword', hitOffset: 1, listVersion: 'v1' });
    const b = fixed('b', { verdict: 'block', labels: ['p'], reason: 'provider_label', hitOffset: 9 });
    const r = await chainProviders([a, b]).checkOutput('x', goapplyCtx());
    expect(r).toEqual({ verdict: 'block', labels: ['k', 'p'], reason: 'provider_label', hitOffset: 9, listVersion: 'v1', provider: 'a+b' });
  });

  it('the hit offset and slice travel together from the provider that decided', async () => {
    const a = fixed('a', { verdict: 'review', labels: ['k'], reason: 'keyword', hitOffset: 1 });
    const b = fixed('b', { verdict: 'block', labels: ['p'], reason: 'provider_label', hitOffset: 2000, hitSlice: { index: 1, start: 2000, length: 2000 } });
    expect(await chainProviders([a, b]).checkOutput('x', goapplyCtx())).toMatchObject({ hitOffset: 2000, hitSlice: { index: 1 } });
    const c = fixed('c', { verdict: 'review', labels: ['p'], hitOffset: 5, hitSlice: { index: 0, start: 0, length: 9 } });
    const r = await chainProviders([a, c]).checkOutput('x', goapplyCtx());
    expect(r.hitOffset).toBe(1);
    expect(r).not.toHaveProperty('hitSlice');
  });

  it('two passes stay a pass without empty extras', async () => {
    const r = await chainProviders([fixed('a', { reason: 'clean' }), fixed('b', { reason: 'clean' })]).checkInput('x', goapplyCtx());
    expect(r).toEqual({ verdict: 'pass', labels: [], reason: 'clean', provider: 'a+b' });
  });

  it('an error in any provider propagates (the engine fails closed)', async () => {
    const boom: ContentSafetyProvider = {
      id: 'boom',
      checkInput: async () => {
        throw new Error('down');
      },
      checkOutput: async () => {
        throw new Error('down');
      },
    };
    await expect(chainProviders([fixed('a', {}), boom]).checkInput('x', goapplyCtx())).rejects.toThrow('down');
    expect(await chainProviders([]).checkInput('x', goapplyCtx())).toEqual({ verdict: 'pass', labels: [], provider: '' });
  });
});
