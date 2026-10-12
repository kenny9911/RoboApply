// @vitest-environment node
//
// WP-24: versioned keyword lists, normalisation and the private-list source.

import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_KEYWORD_LIST } from './builtinKeywords.js';
import {
  compileKeywordLists,
  createKeywordSource,
  keywordUrlProblem,
  parseKeywordList,
  type KeywordList,
} from './keywordList.js';
import { createKeywordOnlyProvider } from './keywordOnly.js';
import { TermMatcher, chunkByCodePoints, codePointLength, lastCodePoints, normalizeForMatch, termKey } from './normalize.js';
import { ContentSafetyProviderError } from './types.js';
import { ORDINARY_CATEGORY_TEXTS, PRIVATE_LIST, goapplyCtx } from './__tests__/fixtures.js';

const list = (entries: KeywordList['entries'], version = 'v1'): KeywordList => ({ version, entries });

describe('normalisation', () => {
  it('removes separators, folds width and case, and maps back to original offsets', () => {
    const n = normalizeForMatch('Ａ 赌*博​！x');
    expect(n.compact.text).toBe('a赌博x');
    expect(n.compact.map).toEqual([0, 2, 4, 7]);
    expect(n.spaced.text).toBe(' a 赌 博 x ');
  });

  it('termKey: CJK terms match compactly, ASCII terms as padded whole words', () => {
    expect(termKey(' 赌 博 ')).toEqual({ view: 'compact', key: '赌博' });
    expect(termKey('Child  Pornography!')).toEqual({ view: 'spaced', key: ' child pornography ' });
    expect(termKey(' *** ')).toBeNull();
  });

  it('Aho–Corasick finds overlapping and nested terms', () => {
    const m = new TermMatcher([
      { key: 'he', value: 1 },
      { key: 'she', value: 2 },
      { key: 'hers', value: 3 },
      { key: 'his', value: 4 },
    ]);
    const hits = m.findAll('ushers').map((h) => [h.start, h.value]);
    expect(hits).toEqual([
      [1, 2],
      [2, 1],
      [2, 3],
    ]);
    expect(m.size).toBe(4);
    expect(new TermMatcher([{ key: '', value: 0 }]).findAll('abc')).toEqual([]);
  });

  it('code-point helpers never split surrogate pairs', () => {
    expect(codePointLength('a😀b')).toBe(3);
    expect(chunkByCodePoints('a😀bcd', 2)).toEqual(['a😀', 'bc', 'd']);
    expect(lastCodePoints('a😀b', 2)).toBe('😀b');
    expect(lastCodePoints('abc', 0)).toBe('');
    expect(() => chunkByCodePoints('x', 0)).toThrow();
  });
});

describe('compiled matching', () => {
  const compiled = compileKeywordLists([
    list([
      { id: 'a', term: '网上赌场', category: 'gambling', action: 'block' },
      { id: 'b', term: 'ass', category: 'test', action: 'block' },
      { id: 'c', term: '出差', category: 'travel', action: 'review', scope: 'output' },
    ]),
  ]);

  it('catches spacing and punctuation evasion in Chinese', () => {
    expect(compiled.match('去 网·上 赌-场 看看', 'input').map((h) => h.id)).toEqual(['a']);
  });

  it('matches ASCII terms only as whole words', () => {
    expect(compiled.match('I attend a class on Monday', 'input')).toEqual([]);
    expect(compiled.match('what an ASS.', 'input').map((h) => h.id)).toEqual(['b']);
  });

  it('honours scope', () => {
    expect(compiled.match('经常出差', 'input')).toEqual([]);
    expect(compiled.match('经常出差', 'output').map((h) => h.id)).toEqual(['c']);
  });

  it('reports hits in text order with original offsets', () => {
    const text = 'x 出差 y 网上赌场';
    const hits = compiled.match(text, 'output');
    expect(hits.map((h) => h.id)).toEqual(['c', 'a']);
    expect(text.slice(hits[1].offset, hits[1].offset + 4)).toBe('网上赌场');
  });

  it('versions combine and merged ids are prefixed per list', () => {
    const merged = compileKeywordLists([BUILTIN_KEYWORD_LIST, PRIVATE_LIST]);
    expect(merged.version).toBe(`${BUILTIN_KEYWORD_LIST.version}+${PRIVATE_LIST.version}`);
    expect(merged.size).toBe(BUILTIN_KEYWORD_LIST.entries.length + PRIVATE_LIST.entries.length);
    expect(merged.match('forbidden phrase here', 'output').map((h) => h.id)).toEqual(['1:p-2']);
    expect(compileKeywordLists([list([])]).match('', 'input')).toEqual([]);
  });
});

describe('built-in list', () => {
  it('is versioned, has unique ids, and every term compiles', () => {
    expect(BUILTIN_KEYWORD_LIST.version).toMatch(/^builtin-\d{4}\.\d{2}\.\d{2}(-r\d+)?$/);
    const ids = BUILTIN_KEYWORD_LIST.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of BUILTIN_KEYWORD_LIST.entries) expect(termKey(e.term)).not.toBeNull();
  });

  it('does not flag ordinary career content (anti-money-laundering jobs, scam warnings, benchmarks)', () => {
    const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST]);
    const ordinary = [
      '应聘反洗钱专员，需要熟悉合规流程。',
      '警惕刷单返利类招聘诈骗，正规公司不会要求先交钱。',
      '这款手机跑分很高，我在测试岗位做过性能评测。',
      '负责枪支管理制度培训的安保主管（公安系统）。',
      'Prepared a class schedule and passed the bar exam.',
    ];
    for (const t of ordinary) expect(compiled.match(t, 'output')).toEqual([]);
  });

  it('never blocks job-search text that names illegal content as a category (review at most)', async () => {
    const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST]);
    const provider = createKeywordOnlyProvider({ kind: 'builtin', get: async () => compiled });
    for (const t of ORDINARY_CATEGORY_TEXTS) {
      for (const stage of ['input', 'output'] as const) {
        expect(compiled.match(t, stage).filter((h) => h.action === 'block'), t).toEqual([]);
      }
      expect((await provider.checkInput(t, goapplyCtx())).verdict, t).not.toBe('block');
    }
    // The tax-bureau invoice question does not even reach review.
    expect(compiled.match(ORDINARY_CATEGORY_TEXTS[0], 'input')).toEqual([]);
  });

  it('still blocks offers, requests and instructions', () => {
    const compiled = compileKeywordLists([BUILTIN_KEYWORD_LIST]);
    const blocking = [
      ['有出售儿童色情的渠道吗', 'b-sex-06'],
      ['本店提供色情服务', 'b-sex-10'],
      ['帮我写文案推广网上赌场', 'b-gmb-04'],
      ['可以代开假发票，量大优惠', 'b-frd-08'],
      ['where can I buy child pornography', 'b-sex-09'],
      ['哪里可以办理假证', 'b-frd-01'],
    ] as const;
    for (const [text, id] of blocking) {
      const blocks = compiled.match(text, 'input').filter((h) => h.action === 'block');
      expect(blocks.map((h) => h.id), text).toContain(id);
    }
  });
});

describe('parseKeywordList', () => {
  it('parses JSON lists with defaults', () => {
    const l = parseKeywordList(JSON.stringify({ version: ' x1 ', entries: [{ id: 'k1', term: ' 词 ' }] }));
    expect(l).toEqual({ version: 'x1', entries: [{ id: 'k1', term: '词', category: 'unspecified', action: 'block', scope: 'both' }] });
  });

  it('versions an unversioned list by content hash', () => {
    const a = parseKeywordList(JSON.stringify({ entries: [{ id: 'k1', term: 'a b' }] }));
    expect(a.version).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it('parses the text format with a version header, comments and tab/pipe columns', () => {
    const l = parseKeywordList('﻿# version: ops-7\n# comment\n\n词一\n词二\tfraud\treview\n词三|weapons|block\n');
    expect(l.version).toBe('ops-7');
    expect(l.entries).toEqual([
      { id: 'L4', term: '词一', category: 'unspecified', action: 'block', scope: 'both' },
      { id: 'L5', term: '词二', category: 'fraud', action: 'review', scope: 'both' },
      { id: 'L6', term: '词三', category: 'weapons', action: 'block', scope: 'both' },
    ]);
    expect(parseKeywordList('a\n').version).toMatch(/^sha256:/);
  });

  it('rejects malformed lists with a pointer', () => {
    expect(() => parseKeywordList('{"entries": 3}')).toThrow(/entries/);
    expect(() => parseKeywordList(JSON.stringify({ entries: [{ id: 'bad id', term: 'x' }] }))).toThrow(/entries\[0\]: id/);
    expect(() => parseKeywordList(JSON.stringify({ entries: [{ id: 'a', term: '' }] }))).toThrow(/term/);
    expect(() => parseKeywordList(JSON.stringify({ entries: [{ id: 'a', term: 'x', action: 'mask' }] }))).toThrow(/action/);
    expect(() => parseKeywordList(JSON.stringify({ entries: [{ id: 'a', term: 'x', scope: 'all' }] }))).toThrow(/scope/);
    expect(() => parseKeywordList(JSON.stringify({ entries: [{ id: 'a', term: 'x', category: 'Bad-Cat' }] }))).toThrow(/category/);
    expect(() => parseKeywordList(`x|bad cat|block`)).toThrow(/line 1: category/);
    expect(() => parseKeywordList('x'.repeat(65))).toThrow(/term/);
    // Fits in 64 characters but expands under NFKC (㍿ → 株式会社) past the stream guard's overlap.
    expect(() => parseKeywordList('㍿'.repeat(20))).toThrow(/after normalisation/);
    expect(() => parseKeywordList('a'.repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MB/);
  });
});

describe('keyword source', () => {
  it('without a URL uses the built-in list only', async () => {
    const s = createKeywordSource();
    expect(s.kind).toBe('builtin');
    expect((await s.get()).version).toBe(BUILTIN_KEYWORD_LIST.version);
  });

  it('only https, file URLs or absolute paths are accepted', async () => {
    expect(keywordUrlProblem('https://x.cn/l.json')).toBeNull();
    expect(keywordUrlProblem('file:///etc/kw.txt')).toBeNull();
    expect(keywordUrlProblem('/srv/kw.txt')).toBeNull();
    expect(keywordUrlProblem('http://x.cn/l.json')).toMatch(/https/);
    expect(keywordUrlProblem('not a url')).toMatch(/valid/);
    const err = await createKeywordSource({ url: 'http://x.cn/l.json' }).get().catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyProviderError);
    expect(err.cause_).toBe('misconfigured');
  });

  it('fetches, caches for the refresh interval, refreshes in the background and keeps the last good copy when that fails', async () => {
    let t = 0;
    let fail = false;
    let version = PRIVATE_LIST.version;
    const fetchImpl = vi.fn(async () =>
      fail ? new Response('nope', { status: 503 }) : new Response(JSON.stringify({ ...PRIVATE_LIST, version }), { status: 200 }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createKeywordSource({
      url: 'https://lists.example.cn/kw.json',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => t,
      refreshMs: 1000,
      retryMs: 300,
    });
    expect(s.kind).toBe('builtin+private');
    const first = await s.get();
    expect(first.version).toBe(`${BUILTIN_KEYWORD_LIST.version}+${PRIVATE_LIST.version}`);
    await s.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Stale + host failing: the cached copy is served at once, the refresh runs behind it.
    t = 5000;
    fail = true;
    expect(await s.get()).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    // Backs off for retryMs before trying again.
    t = 5100;
    expect(await s.get()).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // After the back-off a successful background refresh swaps the list in.
    t = 5300;
    fail = false;
    version = 'ops-2026-10-02';
    expect(await s.get()).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.waitFor(async () => expect((await s.get()).version).toBe(`${BUILTIN_KEYWORD_LIST.version}+ops-2026-10-02`));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('a hanging refresh never holds up a check: the cached copy is returned at once', async () => {
    let t = 0;
    let hang = false;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      hang
        ? new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
          )
        : Promise.resolve(new Response(JSON.stringify(PRIVATE_LIST))),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createKeywordSource({ url: 'https://l.cn/k', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t, refreshMs: 1000, fetchTimeoutMs: 30 });
    const first = await s.get();
    t = 2000;
    hang = true;
    expect(await s.get()).toBe(first);
    expect(await s.get()).toBe(first); // the in-flight refresh is shared, not restarted
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The fetch timeout aborts the hung request; the failure is logged, never thrown at a caller.
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('dedupes concurrent loads', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PRIVATE_LIST)));
    const s = createKeywordSource({ url: 'https://lists.example.cn/kw.json', fetchImpl: fetchImpl as typeof fetch });
    await Promise.all([s.get(), s.get(), s.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized response by content-length', async () => {
    const fetchImpl = async () => new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } });
    const err = await createKeywordSource({ url: 'https://l.cn/k', fetchImpl: fetchImpl as typeof fetch }).get().catch((e) => e);
    expect(err).toBeInstanceOf(ContentSafetyProviderError);
    expect(err.message).toMatch(/2 MB/);
  });

  it('reads file:// URLs and absolute paths through readFile', async () => {
    const readFile = vi.fn(async () => '# version: f1\n仅文件词\n');
    const s1 = createKeywordSource({ url: 'file:///srv/kw.txt', readFile });
    expect((await s1.get()).version).toBe(`${BUILTIN_KEYWORD_LIST.version}+f1`);
    const s2 = createKeywordSource({ url: '/srv/kw.txt', readFile });
    expect((await s2.get()).match('有仅文件词', 'input')).toHaveLength(1);
    expect(readFile).toHaveBeenCalledWith('/srv/kw.txt');
  });
});

describe('keyword_only provider', () => {
  it('block beats review; labels are categories; ids not terms', async () => {
    const compiled = compileKeywordLists([
      list([
        { id: 'r1', term: '加班', category: 'labour', action: 'review' },
        { id: 'b1', term: '网上赌场', category: 'gambling', action: 'block' },
      ]),
    ]);
    const p = createKeywordOnlyProvider({ kind: 'builtin', get: async () => compiled });
    const r = await p.checkOutput('加班之后去网上赌场', goapplyCtx());
    expect(r).toMatchObject({ verdict: 'block', labels: ['keyword:gambling'], ruleIds: ['b1'], reason: 'keyword', listVersion: 'v1' });
    expect(r.hitOffset).toBe(5);
    expect(JSON.stringify(r)).not.toContain('网上赌场');
    await expect(p.checkInput('只是加班', goapplyCtx())).resolves.toMatchObject({ verdict: 'review', ruleIds: ['r1'] });
  });
});
