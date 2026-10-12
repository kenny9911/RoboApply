// @vitest-environment node
//
// The prep agents' web leg (prep/webSearch.ts): Tavily results are kept only
// from sites that may be read (never LinkedIn, Indeed, Glassdoor, BOSS直聘 …),
// a query never carries personal information, a missing key or a failure
// answers null, and posting search keeps job pages only. `fetch` is a spy:
// nothing leaves the process.
// Run: npx vitest run server/src/interview-engine/prep/webSearch.test.ts

import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import {
  ATS_POSTING_DOMAINS,
  TAVILY_SEARCH_URL,
  formatResults,
  looksLikePosting,
  searchWeb,
  searchWebPostings,
  splitPostingTitle,
  toWebResults,
  type FetchLike,
  type WebResult,
} from './webSearch.js';

const robo = getBrand('roboapply');
const go = getBrand('goapply');
const ENV = { TAVILY_API_KEY: 'tvly-test' };

type FetchInit = Parameters<FetchLike>[1];

function fakeFetch(results: unknown[], reply: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async (_url: string, _init: FetchInit) => ({
    ok: reply.ok ?? true,
    status: reply.status ?? 200,
    json: async () => ({ results }),
  }));
}

const sentBody = (fetch: ReturnType<typeof fakeFetch>, call = 0) =>
  JSON.parse(fetch.mock.calls[call]![1].body) as Record<string, unknown>;

describe('toWebResults', () => {
  it('keeps usable rows; drops boards whose terms forbid reading, non-web links and untitled rows', () => {
    const out = toWebResults(
      [
        { title: 'Senior Engineer - Acme', url: 'https://boards.greenhouse.io/acme/jobs/1', content: 'Build things.\r\n\r\nGo.', published_date: '2026-10-01' },
        { title: 'Acme on LinkedIn', url: 'https://www.linkedin.com/jobs/view/1' },
        { title: 'Indeed UK', url: 'https://uk.indeed.com/viewjob?jk=1' },
        { title: 'Glassdoor', url: 'https://www.glassdoor.co.uk/Interview/acme.htm' },
        { title: 'BOSS直聘', url: 'https://www.zhipin.com/job_detail/1.html' },
        { title: '104', url: 'https://www.104.com.tw/job/1' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'File', url: 'ftp://files.example.com/jd.txt' },
        { title: 'Broken', url: 'not a url' },
        { title: '', url: 'https://example.com/untitled' },
        { url: 'https://example.com/no-title' },
        null,
        'a row',
        { title: 'Careers', url: '  https://www.acme.example/careers/42  ' },
      ],
      {},
    );
    expect(out).toEqual([
      { title: 'Senior Engineer - Acme', url: 'https://boards.greenhouse.io/acme/jobs/1', host: 'boards.greenhouse.io', content: 'Build things.\n\nGo.', publishedAt: '2026-10-01' },
      { title: 'Careers', url: 'https://www.acme.example/careers/42', host: 'acme.example', content: '', publishedAt: null },
    ]);
  });

  it('answers [] for anything but a list, and applies the extra denylist from the environment', () => {
    expect(toWebResults(undefined, {})).toEqual([]);
    expect(toWebResults({ results: [] }, {})).toEqual([]);
    const row = { title: 'Job', url: 'https://jobs.example.org/1' };
    expect(toWebResults([row], {})).toHaveLength(1);
    expect(toWebResults([row], { IMPORT_FETCH_DENYLIST: 'example.org' })).toEqual([]);
  });
});

describe('splitPostingTitle', () => {
  it.each([
    ['Senior Engineer - Acme', 'jobs.lever.co', { title: 'Senior Engineer', company: 'Acme' }],
    ['Acme | Senior Engineer', 'careers.acme.com', { title: 'Senior Engineer', company: 'Acme' }],
    ['Senior Engineer – Acme', 'acme.com', { title: 'Senior Engineer', company: 'Acme' }],
    ['  Backend   Engineer  —  Initech ', 'initech.com', { title: 'Backend Engineer', company: 'Initech' }],
    ['Job Application for Data Scientist at Globex', 'boards.greenhouse.io', { title: 'Data Scientist', company: 'Globex' }],
    ['Data Scientist @ Globex', 'jobs.ashbyhq.com', { title: 'Data Scientist', company: 'Globex' }],
    ['Staff Engineer', 'acme.com', { title: 'Staff Engineer', company: null }],
  ])('%j on %s', (raw, host, expected) => {
    expect(splitPostingTitle(raw, host)).toEqual(expected);
  });
});

describe('searchWeb', () => {
  it('without a key (or a query) answers null and sends nothing', async () => {
    const fetch = fakeFetch([]);
    expect(await searchWeb(robo, 'Backend Engineer interview', {}, { env: {}, fetch })).toBeNull();
    expect(await searchWeb(robo, '   ', {}, { env: ENV, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the query to Tavily with the boards that forbid reading excluded, and drops them from the answer', async () => {
    const fetch = fakeFetch([
      { title: 'Acme interview process', url: 'https://acme.example/blog/interviews', content: 'Three rounds.' },
      { title: 'Acme reviews', url: 'https://www.glassdoor.com/Interview/acme.htm', content: 'Copied content' },
    ]);
    const out = await searchWeb(robo, '"Acme" interview process', { maxResults: 50, includeDomains: ['acme.example'], depth: 'advanced' }, { env: ENV, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(TAVILY_SEARCH_URL);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const body = sentBody(fetch);
    expect(body).toMatchObject({
      api_key: 'tvly-test',
      query: '"Acme" interview process',
      max_results: 10,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: false,
      include_domains: ['acme.example'],
    });
    expect(body.exclude_domains).toEqual(expect.arrayContaining(['linkedin.com', 'glassdoor.com', 'glassdoor.co.uk', 'indeed.com', 'zhipin.com', 'lagou.com', '104.com.tw']));
    expect(out).toEqual([{ title: 'Acme interview process', url: 'https://acme.example/blog/interviews', host: 'acme.example', content: 'Three rounds.', publishedAt: null }]);
  });

  it('defaults to a basic search of six results without a domain filter; clamps the count to 1..10', async () => {
    const fetch = fakeFetch([]);
    await searchWeb(robo, 'Backend Engineer', {}, { env: ENV, fetch });
    await searchWeb(robo, 'Backend Engineer', { maxResults: 0 }, { env: ENV, fetch });
    expect(sentBody(fetch, 0)).toMatchObject({ max_results: 6, search_depth: 'basic' });
    expect(sentBody(fetch, 0)).not.toHaveProperty('include_domains');
    expect(sentBody(fetch, 1).max_results).toBe(1);
  });

  it('answers null for a failed or thrown request', async () => {
    expect(await searchWeb(robo, 'Backend Engineer', {}, { env: ENV, fetch: fakeFetch([], { ok: false, status: 500 }) })).toBeNull();
    const throwing = vi.fn(async () => Promise.reject(new Error('network down')));
    expect(await searchWeb(robo, 'Backend Engineer', {}, { env: ENV, fetch: throwing })).toBeNull();
  });

  it('never sends a query carrying personal information', async () => {
    const fetch = fakeFetch([]);
    expect(await searchWeb(robo, 'jane.doe@example.com backend engineer', {}, { env: ENV, fetch })).toBeNull();
    expect(await searchWeb(robo, 'Jane Doe backend engineer', { knownValues: ['Jane Doe'] }, { env: ENV, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    // The same query without the known value goes out.
    await searchWeb(robo, 'backend engineer', { knownValues: ['Jane Doe'] }, { env: ENV, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('GoApply calls the vendor by default (D5), and never under the strict residency switch', async () => {
    const fetch = fakeFetch([]);
    expect(await searchWeb(go, '后端工程师 面试', {}, { env: ENV, fetch })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await searchWeb(go, '后端工程师 面试', {}, { env: { ...ENV, CN_RESIDENCY_STRICT: 'true' }, fetch })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up at its timeout, or when the caller aborts', async () => {
    const hanging = vi.fn(
      (_url: string, init: FetchInit) =>
        new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    expect(await searchWeb(robo, 'Backend Engineer', {}, { env: ENV, fetch: hanging, timeoutMs: 5 })).toBeNull();
    const controller = new AbortController();
    const pending = searchWeb(robo, 'Backend Engineer', {}, { env: ENV, fetch: hanging, timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect(await pending).toBeNull();
  });
});

describe('looksLikePosting', () => {
  it.each([
    // Open ATS boards and employers' own career hosts.
    ['https://jobs.lever.co/acme/1234', true],
    ['https://boards.greenhouse.io/acme', true],
    ['https://careers.tencent.com/jobdesc.html?postId=1', true],
    ['https://talent.alibaba.com/off-campus/position-detail?positionId=9', true],
    ['https://jobs.acme.cn/', true],
    ['https://campus.example.com/', true],
    // A posting path or query on any host.
    ['https://acme.example/careers/42', true],
    ['https://acme.example/en/position?id=3', true],
    ['https://acme.example/?gh_jid=123', true],
    ['https://acme.example/zhaopin/detail/7', true],
    // Articles about jobs are not postings.
    ['https://example.com/blog/how-to-get-a-job', false],
    ['https://acme.example/news/we-are-hiring-jobs', false],
    ['https://example.com/guides/job-search', false],
    ['https://example.com/articles/career-advice', false],
    ['https://medium.com/@x/my-interview', false],
    ['https://acme.example/about', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    let host = 'x';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // keep the placeholder host
    }
    expect(looksLikePosting(url, host)).toBe(expected);
  });
});

describe('searchWebPostings', () => {
  const RESULTS = [
    { title: 'Senior Engineer - Acme', url: 'https://jobs.lever.co/acme/1234', content: 'Build the platform. Requirements: Go.', published_date: '2026-10-05' },
    { title: 'Backend Engineer', url: 'https://boards.greenhouse.io/globex/jobs/987', content: 'Payments team.' },
    { title: 'Platform Engineer | Initech', url: 'https://initech.example/careers/platform-engineer', content: 'Kubernetes.' },
    { title: 'How to ace the interview', url: 'https://blog.example.com/how-to-ace', content: 'Tips.' },
    { title: 'How to get a job at Acme', url: 'https://example.com/blog/how-to-get-a-job', content: 'Advice.' },
    { title: 'Senior Engineer at Acme', url: 'https://www.linkedin.com/jobs/view/1', content: 'Not readable.' },
  ];

  it('lists job pages only, labelled with their host; never a board whose terms forbid reading', async () => {
    const fetch = fakeFetch(RESULTS);
    const postings = await searchWebPostings(robo, { title: 'Senior Engineer' }, { env: ENV, fetch });
    expect(postings).toHaveLength(3);
    expect(postings!.map((p) => [p.provider, p.title, p.company])).toEqual([
      ['jobs.lever.co', 'Senior Engineer', 'Acme'],
      ['boards.greenhouse.io', 'Backend Engineer', 'globex'],
      ['initech.example', 'Platform Engineer', 'Initech'],
    ]);
    for (const posting of postings!) {
      expect(posting).toMatchObject({ source: 'web', jobId: null, location: null });
      expect(posting.ref).toMatch(/^web:[0-9a-f]{16}$/);
    }
    expect(new Set(postings!.map((p) => p.ref)).size).toBe(3);
    expect(postings![0]).toMatchObject({
      url: 'https://jobs.lever.co/acme/1234',
      postedAt: '2026-10-05',
      snippet: 'Build the platform. Requirements: Go.',
      description: 'Build the platform. Requirements: Go.',
    });
  });

  it('asks the open ATS boards for a title alone, the whole web with a company, and in Chinese on GoApply', async () => {
    const fetch = fakeFetch([]);
    await searchWebPostings(robo, { title: 'Backend Engineer' }, { env: ENV, fetch });
    expect(sentBody(fetch, 0).include_domains).toEqual(ATS_POSTING_DOMAINS);
    expect(sentBody(fetch, 0).query).toBe('"Backend Engineer" job opening responsibilities qualifications');

    await searchWebPostings(robo, { title: 'Backend Engineer', company: 'Acme', country: 'DE' }, { env: ENV, fetch });
    expect(sentBody(fetch, 1)).not.toHaveProperty('include_domains');
    expect(sentBody(fetch, 1).query).toBe('Acme "Backend Engineer" job opening responsibilities qualifications DE');

    await searchWebPostings(go, { title: '后端工程师', company: '某公司' }, { env: ENV, fetch });
    expect(sentBody(fetch, 2).query).toBe('某公司 后端工程师 招聘 岗位职责 任职要求');
    expect(sentBody(fetch, 2)).not.toHaveProperty('include_domains');

    await searchWebPostings(robo, { title: '軟體工程師', language: 'zh-TW' }, { env: ENV, fetch });
    expect(sentBody(fetch, 3).query).toBe('軟體工程師 招聘 岗位职责 任职要求');
  });

  it('answers null without a title or when the search is unavailable', async () => {
    const fetch = fakeFetch(RESULTS);
    expect(await searchWebPostings(robo, { title: '   ' }, { env: ENV, fetch })).toBeNull();
    expect(await searchWebPostings(robo, { title: 'Backend Engineer' }, { env: {}, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('formatResults', () => {
  const result = (n: number, content: string): WebResult => ({ title: `T${n}`, url: `https://e.example/${n}`, host: 'e.example', content, publishedAt: null });

  it('numbers the results for citation and stays within the character budget', () => {
    expect(formatResults([result(1, 'one'), result(2, 'two')])).toBe('[1] T1 — https://e.example/1\none\n\n[2] T2 — https://e.example/2\ntwo');
    const capped = formatResults([result(1, 'a'.repeat(40)), result(2, 'b'.repeat(400)), result(3, 'c')], 120);
    expect(capped).toContain('[1] T1');
    expect(capped).not.toContain('[2] T2');
    // A later result that still fits keeps its original number (the agent cites by it).
    expect(capped).toContain('[3] T3');
    expect(capped.length).toBeLessThanOrEqual(120);
  });
});
