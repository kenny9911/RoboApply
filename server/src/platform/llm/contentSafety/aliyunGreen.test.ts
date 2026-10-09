// @vitest-environment node
//
// WP-24: the aliyun_green provider — RPC signing, request shape, verdict
// mapping, chunking, residency, and fail-closed on every error. No network:
// fetch is a fake.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapError } from '../../http.js';
import {
  ALIYUN_MAX_CHUNK_CHARS,
  aliyunEndpointProblem,
  canonicalQuery,
  createAliyunGreenProvider,
  isMainlandRegion,
  locateRiskWords,
  mapRiskLevel,
  popEncode,
  popTimestamp,
  signRpc,
  type AliyunGreenConfig,
} from './aliyunGreen.js';
import { ContentBlockedError, ContentSafetyUnavailableError, checkInput, checkOutput, setContentSafetyEventWriter, setContentSafetyProvider } from './index.js';
import { goapplyCtx } from './__tests__/fixtures.js';

const cfg: AliyunGreenConfig = {
  accessKeyId: 'test-ak',
  accessKeySecret: 'test-secret',
  endpoint: 'https://green-cip.cn-shanghai.aliyuncs.com',
  inputService: 'llm_query_moderation',
  outputService: 'llm_response_moderation',
};

interface Captured {
  url: string;
  params: URLSearchParams;
  init: RequestInit;
}

function fakeFetch(respond: (content: string, service: string) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const params = new URLSearchParams(String(init.body));
    calls.push({ url, params, init });
    const content = JSON.parse(params.get('ServiceParameters') ?? '{}').content as string;
    return respond(content, params.get('Service') ?? '');
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const ok = (riskLevel: string, labels: string[] = [], riskWords = 'SECRET-WORDS') =>
  new Response(
    JSON.stringify({
      Code: 200,
      Message: 'OK',
      RequestId: 'req-1',
      Data: { RiskLevel: riskLevel, Result: labels.length ? labels.map((Label) => ({ Label, Confidence: 99, RiskWords: riskWords })) : [{ Label: 'nonLabel' }] },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('RPC signing', () => {
  it('matches Alibaba Cloud’s documented signature example', () => {
    // From the Alibaba Cloud RPC signature documentation (ECS DescribeRegions, GET, secret "testsecret").
    const params = {
      AccessKeyId: 'testid',
      Action: 'DescribeRegions',
      Format: 'XML',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
      SignatureVersion: '1.0',
      Timestamp: '2016-02-23T12:46:24Z',
      Version: '2014-05-26',
    };
    expect(signRpc('GET', params, 'testsecret')).toBe('OLeaidS1JvxuMvnyHOwuJ+uX5qY=');
  });

  it('percent-encodes per RFC 3986 and sorts keys', () => {
    expect(popEncode("a b*c~d!'()")).toBe('a%20b%2Ac~d%21%27%28%29');
    expect(popEncode('中')).toBe('%E4%B8%AD');
    expect(canonicalQuery({ b: '2', a: '1 1' })).toBe('a=1%201&b=2');
    expect(popTimestamp(new Date('2026-10-10T01:02:03.456Z'))).toBe('2026-10-10T01:02:03Z');
  });
});

describe('residency', () => {
  it('accepts mainland regions only', () => {
    expect(isMainlandRegion('cn-shanghai')).toBe(true);
    expect(isMainlandRegion('cn-beijing')).toBe(true);
    expect(isMainlandRegion('cn-hongkong')).toBe(false);
    expect(isMainlandRegion('ap-southeast-1')).toBe(false);
  });

  it('endpoint overrides must be https green-cip hosts in a mainland region', () => {
    expect(aliyunEndpointProblem('https://green-cip.cn-beijing.aliyuncs.com')).toBeNull();
    expect(aliyunEndpointProblem('https://green-cip-vpc.cn-shanghai.aliyuncs.com')).toBeNull();
    expect(aliyunEndpointProblem('http://green-cip.cn-shanghai.aliyuncs.com')).toMatch(/https/);
    expect(aliyunEndpointProblem('https://green-cip.ap-southeast-1.aliyuncs.com')).toMatch(/outside mainland/);
    expect(aliyunEndpointProblem('https://green-cip.cn-hongkong.aliyuncs.com')).toMatch(/outside mainland/);
    expect(aliyunEndpointProblem('https://evil.example.com')).toMatch(/green-cip/);
    expect(aliyunEndpointProblem('::')).toMatch(/valid/);
  });
});

describe('verdict mapping', () => {
  it('high → block, medium → review, low/none → pass, anything else throws', () => {
    expect(mapRiskLevel('high')).toBe('block');
    expect(mapRiskLevel('MEDIUM')).toBe('review');
    expect(mapRiskLevel('low')).toBe('pass');
    expect(mapRiskLevel('none')).toBe('pass');
    expect(() => mapRiskLevel(undefined)).toThrow(/RiskLevel/);
  });
});

describe('provider', () => {
  it('sends a signed TextModerationPlus request with the LLM services per direction', async () => {
    const { impl, calls } = fakeFetch(() => ok('none'));
    const p = createAliyunGreenProvider(cfg, { fetchImpl: impl, now: () => new Date('2026-10-10T00:00:00Z'), nonce: () => 'nonce-1' });
    await expect(p.checkInput('帮我改简历', goapplyCtx())).resolves.toEqual({ verdict: 'pass', labels: [], provider: 'aliyun_green', reason: 'clean' });
    await p.checkOutput('好的', goapplyCtx());
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(first.url).toBe('https://green-cip.cn-shanghai.aliyuncs.com/');
    expect(first.init.method).toBe('POST');
    const params = Object.fromEntries(first.params.entries());
    expect(params).toMatchObject({
      Action: 'TextModerationPlus',
      Version: '2022-03-02',
      Format: 'JSON',
      AccessKeyId: 'test-ak',
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: 'nonce-1',
      Timestamp: '2026-10-10T00:00:00Z',
      Service: 'llm_query_moderation',
      ServiceParameters: JSON.stringify({ content: '帮我改简历' }),
    });
    const { Signature, ...unsigned } = params;
    expect(Signature).toBe(signRpc('POST', unsigned, 'test-secret'));
    expect(second.params.get('Service')).toBe('llm_response_moderation');
    expect(JSON.stringify(first.init)).not.toContain('test-secret');
  });

  it('maps a high-risk answer to block with labels and never keeps RiskWords', async () => {
    const { impl } = fakeFetch(() => ok('high', ['political_content', 'contraband']));
    const p = createAliyunGreenProvider(cfg, { fetchImpl: impl });
    const r = await p.checkOutput('任意', goapplyCtx());
    expect(r).toMatchObject({ verdict: 'block', labels: ['political_content', 'contraband'], reason: 'provider_label', hitOffset: 0 });
    expect(JSON.stringify(r)).not.toContain('SECRET-WORDS');
  });

  it('skips the call for empty text', async () => {
    const { impl, calls } = fakeFetch(() => ok('none'));
    const p = createAliyunGreenProvider(cfg, { fetchImpl: impl });
    await expect(p.checkInput('   ', goapplyCtx())).resolves.toMatchObject({ verdict: 'pass' });
    expect(calls).toHaveLength(0);
  });

  it('checks long text in ≤2000-character slices; one bad slice blocks the whole text', async () => {
    const text = 'a'.repeat(ALIYUN_MAX_CHUNK_CHARS) + 'b'.repeat(ALIYUN_MAX_CHUNK_CHARS) + 'BAD' + 'c'.repeat(10);
    const { impl, calls } = fakeFetch((content) => (content.includes('BAD') ? ok('high', ['abuse']) : ok('low')));
    const p = createAliyunGreenProvider(cfg, { fetchImpl: impl });
    const r = await p.checkOutput(text, goapplyCtx());
    expect(calls.map((c) => Array.from(JSON.parse(c.params.get('ServiceParameters') as string).content as string).length)).toEqual([2000, 2000, 13]);
    expect(r).toMatchObject({ verdict: 'block', labels: ['abuse'], hitOffset: 4000, hitSlice: { index: 2, start: 4000, length: 13 } });
  });

  it('places the hit on RiskWords found in the flagged slice (they are never returned)', async () => {
    const text = 'a'.repeat(ALIYUN_MAX_CHUNK_CHARS) + 'b'.repeat(1500) + '违规词' + 'c'.repeat(497);
    const { impl } = fakeFetch((content) => (content.includes('违规词') ? ok('high', ['abuse'], '别的词,违规词') : ok('none')));
    const r = await createAliyunGreenProvider(cfg, { fetchImpl: impl }).checkOutput(text, goapplyCtx());
    expect(r).toMatchObject({ verdict: 'block', hitOffset: 3500 });
    expect(r).not.toHaveProperty('hitSlice');
    expect(JSON.stringify(r)).not.toContain('违规词');
  });

  it('through the engine: the event excerpt is placed on the RiskWords hit, or marked as the slice start', async () => {
    const rows: Array<Record<string, unknown>> = [];
    setContentSafetyEventWriter(async (row) => {
      rows.push(row.matched as unknown as Record<string, unknown>);
    });
    try {
      const text = 'a'.repeat(ALIYUN_MAX_CHUNK_CHARS) + 'b'.repeat(1500) + '违规词' + 'c'.repeat(497);
      const found = fakeFetch((content) => (content.includes('违规词') ? ok('medium', ['ad'], '违规词') : ok('none')));
      setContentSafetyProvider(createAliyunGreenProvider(cfg, { fetchImpl: found.impl }));
      const r = await checkOutput(text, goapplyCtx());
      expect(r).not.toHaveProperty('hitSlice');
      expect(rows[0]).toMatchObject({ excerptAnchor: 'hit' });
      expect(rows[0].excerpt).toBe('b'.repeat(60) + '违规词' + 'c'.repeat(137));

      const missing = fakeFetch((content) => (content.includes('违规词') ? ok('medium', ['ad'], '') : ok('none')));
      setContentSafetyProvider(createAliyunGreenProvider(cfg, { fetchImpl: missing.impl }));
      await checkOutput(text, goapplyCtx());
      expect(rows[1]).toMatchObject({ excerptAnchor: 'slice_start', slice: { index: 1, length: 2000 } });
      expect(rows[1].excerpt).toBe('b'.repeat(200));
    } finally {
      setContentSafetyProvider(null);
      setContentSafetyEventWriter(null);
    }
  });

  it('locateRiskWords finds the earliest listed word and ignores blanks', () => {
    expect(locateRiskWords('abc 坏词 def 恶词', ['恶词,坏词'])).toBe(4);
    expect(locateRiskWords('abc', ['', ' , ', 'zzz'])).toBeUndefined();
    expect(locateRiskWords('x坏', ['坏'])).toBe(1);
  });

  it('medium risk gives review with the provider labels', async () => {
    const { impl } = fakeFetch(() => ok('medium', ['ad']));
    await expect(createAliyunGreenProvider(cfg, { fetchImpl: impl }).checkInput('x', goapplyCtx())).resolves.toMatchObject({
      verdict: 'review',
      labels: ['ad'],
    });
  });
});

describe('fail-closed through the engine', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setContentSafetyEventWriter(async () => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    setContentSafetyProvider(null);
    setContentSafetyEventWriter(null);
  });

  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ['HTTP 500', () => new Response('oops', { status: 500 }), 'provider_error'],
    ['API error code', () => new Response(JSON.stringify({ Code: 408, Message: 'no permission' })), 'provider_error'],
    ['non-JSON body', () => new Response('<html>', { status: 200 }), 'invalid_result'],
    ['unknown RiskLevel', () => new Response(JSON.stringify({ Code: 200, Data: { RiskLevel: 'weird' } })), 'invalid_result'],
    [
      'network failure',
      () => {
        throw new TypeError('fetch failed');
      },
      'provider_error',
    ],
  ];

  it.each(cases)('%s → 503 ai_unavailable, never the unfiltered output', async (_name, respond, cause) => {
    const { impl } = fakeFetch(respond);
    setContentSafetyProvider(createAliyunGreenProvider(cfg, { fetchImpl: impl }));
    const err = await checkOutput('模型输出', goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(err.details.cause).toBe(cause);
    expect(mapError(err).status).toBe(503);
  });

  it('a hanging Aliyun call times out, aborts the request and fails closed', async () => {
    let signal: AbortSignal | undefined;
    const impl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    setContentSafetyProvider(createAliyunGreenProvider(cfg, { fetchImpl: impl as unknown as typeof fetch }), { timeoutMs: 20 });
    const err = await checkInput('你好', goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyUnavailableError);
    expect(err.details.cause).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });

  it('a high-risk answer → 422 content_blocked', async () => {
    const { impl } = fakeFetch(() => ok('high', ['contraband']));
    setContentSafetyProvider(createAliyunGreenProvider(cfg, { fetchImpl: impl }));
    const err = await checkInput('x', goapplyCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(mapError(err).body).toMatchObject({ code: 'content_blocked', details: { stage: 'input', labels: ['contraband'] } });
  });
});
