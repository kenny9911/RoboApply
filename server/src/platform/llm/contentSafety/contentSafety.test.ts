// @vitest-environment node
//
// WP-24: the content-safety engine behind the FND-5 interface — GoApply
// only, block → 422, fail-closed → 503, and the event / excerpt policy.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapError } from '../../http.js';
import {
  BUILTIN_KEYWORD_LIST,
  ContentBlockedError,
  ContentSafetyUnavailableError,
  checkInput,
  checkOutput,
  contentSafetyApplies,
  getContentSafetyProvider,
  noopContentSafetyProvider,
  reloadContentSafetyFromEnv,
  setContentSafetyEventWriter,
  setContentSafetyProvider,
  type ContentSafetyEventRow,
  type ContentSafetyProvider,
} from './index.js';
import { createKeywordOnlyProvider } from './keywordOnly.js';
import { compileKeywordLists, createKeywordSource } from './keywordList.js';
import {
  BLOCKED_INPUT,
  BLOCKED_OUTPUT,
  CLEAN_INPUT,
  PRIVATE_LIST,
  REVIEW_OUTPUT,
  goapplyCtx,
  roboapplyCtx,
} from './__tests__/fixtures.js';

let events: ContentSafetyEventRow[] = [];

const keywordProviderWithPrivateList = (): ContentSafetyProvider => {
  const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST, PRIVATE_LIST]);
  return createKeywordOnlyProvider({ kind: 'builtin+private', get: async () => compiled });
};

beforeEach(() => {
  events = [];
  setContentSafetyEventWriter(async (row) => {
    events.push(row);
  });
});

afterEach(() => {
  setContentSafetyProvider(null);
  setContentSafetyEventWriter(null);
  reloadContentSafetyFromEnv();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('provider selection', () => {
  it('defaults to the keyword_only provider (no longer the FND-5 no-op)', async () => {
    vi.stubEnv('CN_CONTENT_SAFETY_PROVIDER', '');
    reloadContentSafetyFromEnv();
    expect(getContentSafetyProvider()).not.toBe(noopContentSafetyProvider);
    expect(getContentSafetyProvider().id).toBe('keyword_only');
    await expect(checkInput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({ verdict: 'pass', provider: 'keyword_only' });
  });

  it('a misconfigured provider degrades to the keyword list with ONE warning: GoApply AI keeps running, filtered', async () => {
    vi.stubEnv('CN_RESIDENCY_STRICT', '');
    vi.stubEnv('CN_CONTENT_SAFETY_PROVIDER', 'aliyun_green'); // no ALIYUN_GREEN_* keys
    vi.stubEnv('ALIYUN_GREEN_ACCESS_KEY_ID', '');
    vi.stubEnv('ALIYUN_GREEN_ACCESS_KEY_SECRET', '');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reloadContentSafetyFromEnv();
    await expect(checkInput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({ verdict: 'pass', provider: 'keyword_only' });
    await expect(checkOutput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({ verdict: 'pass', provider: 'keyword_only' });
    const blocked = BUILTIN_KEYWORD_LIST.entries.find((e) => e.action === 'block')!;
    await expect(checkInput(`please: ${blocked.term}`, goapplyCtx())).rejects.toBeInstanceOf(ContentBlockedError);
    // Said once, with the reason; never silent, never repeated per check.
    const degradedWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('configuration problems'));
    expect(degradedWarnings).toHaveLength(1);
    expect(String(degradedWarnings[0]![1])).toMatch(/ACCESS_KEY/);
    expect(errSpy).not.toHaveBeenCalled();

    // The same for a typo in the provider name.
    vi.stubEnv('CN_CONTENT_SAFETY_PROVIDER', 'aliyun-green');
    reloadContentSafetyFromEnv();
    await expect(checkInput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({ verdict: 'pass', provider: 'keyword_only' });
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('under CN_RESIDENCY_STRICT a misconfigured provider fails closed with 503 ai_unavailable', async () => {
    vi.stubEnv('CN_RESIDENCY_STRICT', 'true');
    vi.stubEnv('CN_CONTENT_SAFETY_PROVIDER', 'aliyun_green'); // no ALIYUN_GREEN_* keys
    vi.stubEnv('ALIYUN_GREEN_ACCESS_KEY_ID', '');
    vi.stubEnv('ALIYUN_GREEN_ACCESS_KEY_SECRET', '');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reloadContentSafetyFromEnv();
    const err = await checkInput(CLEAN_INPUT, goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(mapError(err)).toMatchObject({
      status: 503,
      body: { code: 'ai_unavailable', details: { reason: 'content_safety_unavailable', stage: 'input', cause: 'misconfigured' } },
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('CN_RESIDENCY_STRICT'), expect.any(String));
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('brand scope', () => {
  it('applies to GoApply only; RoboApply never reaches the provider and writes no event', async () => {
    const provider: ContentSafetyProvider = {
      id: 'fake',
      checkInput: vi.fn(async () => ({ verdict: 'block' as const, labels: ['x'], provider: 'fake' })),
      checkOutput: vi.fn(async () => ({ verdict: 'block' as const, labels: ['x'], provider: 'fake' })),
    };
    setContentSafetyProvider(provider);
    expect(contentSafetyApplies('roboapply')).toBe(false);
    expect(contentSafetyApplies('goapply')).toBe(true);
    await expect(checkInput(BLOCKED_INPUT, roboapplyCtx())).resolves.toMatchObject({ verdict: 'pass', provider: 'not_applicable' });
    await expect(checkOutput(BLOCKED_OUTPUT, roboapplyCtx())).resolves.toMatchObject({ verdict: 'pass', provider: 'not_applicable' });
    expect(provider.checkInput).not.toHaveBeenCalled();
    expect(provider.checkOutput).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('blocked fixtures (keyword_only)', () => {
  beforeEach(() => setContentSafetyProvider(keywordProviderWithPrivateList()));

  it('blocked-input fixture → ContentBlockedError → 422 content_blocked, said plainly', async () => {
    const err = await checkInput(BLOCKED_INPUT, goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(err.message).toMatch(/content-safety filter blocked this request/);
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body).toMatchObject({
      code: 'content_blocked',
      details: { stage: 'input', labels: ['keyword:forged_documents'] },
    });
  });

  it('blocked-output fixture → 422 content_blocked with stage output', async () => {
    const err = await checkOutput(BLOCKED_OUTPUT, goapplyCtx({ task: 'cover_letter' })).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(err.message).toMatch(/blocked the AI reply/);
    expect(mapError(err).body).toMatchObject({ code: 'content_blocked', details: { stage: 'output', labels: ['keyword:gambling'] } });
  });

  it('a clean request passes and the public result carries no internal offsets', async () => {
    const r = await checkInput(CLEAN_INPUT, goapplyCtx());
    expect(r).toMatchObject({ verdict: 'pass', labels: [], provider: 'keyword_only', reason: 'clean' });
    expect(r).not.toHaveProperty('hitOffset');
  });

  it('review passes through (nothing is rewritten) and is logged with an excerpt', async () => {
    const r = await checkOutput(REVIEW_OUTPUT, goapplyCtx());
    expect(r).toMatchObject({ verdict: 'review', labels: ['keyword:labour_risk'], ruleIds: ['1:p-1'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'review', direction: 'output' });
    expect(events[0].matched.excerpt).toContain('高强度加班');
  });

  it('scope: an input-only term does not block output', async () => {
    await expect(checkInput('这里有仅输入词', goapplyCtx())).rejects.toBeInstanceOf(ContentBlockedError);
    await expect(checkOutput('这里有仅输入词', goapplyCtx())).resolves.toMatchObject({ verdict: 'pass' });
  });
});

describe('events: brand, task and reason; hash + 200 characters at most', () => {
  beforeEach(() => setContentSafetyProvider(keywordProviderWithPrivateList()));

  it('a blocked input writes one row with brand, task, reason, rule ids, hash and a ≤200-char excerpt', async () => {
    await checkInput(BLOCKED_INPUT, goapplyCtx({ task: 'tailor', userId: 'u42', callId: 'c9' })).catch(() => undefined);
    expect(events).toHaveLength(1);
    const row = events[0];
    expect(row).toMatchObject({
      brand: 'goapply',
      userId: 'u42',
      surface: 'tailor',
      direction: 'input',
      verdict: 'block',
      provider: 'keyword_only',
    });
    expect(row.matched).toMatchObject({
      reason: 'keyword',
      labels: ['keyword:forged_documents'],
      ruleIds: ['b-frd-01'],
      callId: 'c9',
      listVersion: `${BUILTIN_KEYWORD_LIST.version}+${PRIVATE_LIST.version}`,
      textLength: Array.from(BLOCKED_INPUT).length,
    });
    expect(row.matched.textSha256).toMatch(/^[0-9a-f]{64}$/);
    const excerpt = row.matched.excerpt as string;
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(200);
    // Centred on the hit, not the first 200 characters of padding.
    expect(excerpt).toContain('办 理-假 证');
    // The full text is never stored.
    expect(JSON.stringify(row)).not.toContain(BLOCKED_INPUT);
  });

  it('a pass row stores the hash and length only — no excerpt', async () => {
    await checkInput(CLEAN_INPUT, goapplyCtx());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'pass', matched: { reason: 'clean', labels: [] } });
    expect(events[0].matched).not.toHaveProperty('excerpt');
    expect(JSON.stringify(events[0])).not.toContain('电商公司');
  });

  it('a failing event writer never changes the verdict', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setContentSafetyEventWriter(async () => {
      throw new Error('db down');
    });
    await expect(checkInput(BLOCKED_INPUT, goapplyCtx())).rejects.toBeInstanceOf(ContentBlockedError);
    await expect(checkInput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({ verdict: 'pass' });
    errSpy.mockRestore();
  });
});

describe('fail-closed', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('a provider error → 503 ai_unavailable, an error row without excerpt, never the output', async () => {
    setContentSafetyProvider({
      id: 'down',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'down' }),
      checkOutput: async () => {
        throw new Error('provider exploded');
      },
    });
    const err = await checkOutput('任何模型输出', goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(mapError(err)).toMatchObject({
      status: 503,
      body: { code: 'ai_unavailable', details: { stage: 'output', cause: 'provider_error' } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: 'error', provider: 'down', matched: { reason: 'provider_error' } });
    expect(events[0].matched).not.toHaveProperty('excerpt');
  });

  it('a provider that hangs past the timeout → 503 with cause timeout, and its signal is aborted', async () => {
    let seen: AbortSignal | undefined;
    setContentSafetyProvider(
      {
        id: 'slow',
        checkInput: (_t, _c, opts) =>
          new Promise((resolve) => {
            seen = opts?.signal;
            setTimeout(() => resolve({ verdict: 'pass', labels: [], provider: 'slow' }), 10_000);
          }),
        checkOutput: async () => ({ verdict: 'pass', labels: [], provider: 'slow' }),
      },
      { timeoutMs: 20 },
    );
    const err = await checkInput('hello', goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(err.details.cause).toBe('timeout');
    expect(seen?.aborted).toBe(true);
    expect(events[0]).toMatchObject({ verdict: 'error', matched: { reason: 'timeout' } });
  });

  it('a malformed provider result fails closed', async () => {
    setContentSafetyProvider({
      id: 'weird',
      checkInput: async () => ({ verdict: 'maybe', labels: [], provider: 'weird' }) as never,
      checkOutput: async () => ({ verdict: 'pass', labels: [], provider: 'weird' }),
    });
    const err = await checkInput('hello', goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(err.details.cause).toBe('invalid_result');
  });

  it('a hanging private-list refresh does not fail checks: the last good copy serves at once', async () => {
    let t = 0;
    let hang = false;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      hang
        ? new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
          )
        : Promise.resolve(new Response(JSON.stringify(PRIVATE_LIST))),
    );
    setContentSafetyProvider(
      createKeywordOnlyProvider(
        createKeywordSource({
          url: 'https://lists.example.cn/kw.json',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          now: () => t,
          refreshMs: 1000,
          fetchTimeoutMs: 150,
        }),
      ),
      { timeoutMs: 100 },
    );
    await expect(checkInput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({ verdict: 'pass' });
    t = 5000;
    hang = true;
    // The list is stale and its host hangs past the 100 ms check timeout; checks still run on the cached copy.
    await expect(checkInput(CLEAN_INPUT, goapplyCtx())).resolves.toMatchObject({
      verdict: 'pass',
      listVersion: `${BUILTIN_KEYWORD_LIST.version}+${PRIVATE_LIST.version}`,
    });
    await expect(checkInput('这里有仅输入词', goapplyCtx())).rejects.toBeInstanceOf(ContentBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.verdict)).toEqual(['pass', 'pass', 'block']);
    // The hung refresh is aborted by its own fetch timeout and only logged.
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refresh failed'), expect.anything()));
  });

  it('a configured private list that never loaded fails closed', async () => {
    setContentSafetyProvider(
      createKeywordOnlyProvider(
        createKeywordSource({ url: 'https://lists.example.cn/kw.json', fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch }),
      ),
    );
    const err = await checkInput(CLEAN_INPUT, goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(err.details.cause).toBe('provider_error');
  });
});
