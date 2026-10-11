// @vitest-environment node
//
// 台灣就業通 open-data adapter (MKT-3E; JT-2, JT-4): the request, the field
// mapping, pay only from the numeric fields, the resumable sweep and the
// closure rule. Nothing here reaches the network or a database: the endpoint
// is a scripted fake, the fixture rows are SYNTHETIC, the clock is fixed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { getBrand } from '../../../platform/brand/index.js';
import { TW_COUNTIES, districtsOfCounty } from '../geo/index.js';
import { adaptersForBrand } from '../ingest/providers.js';
import { MARKET_HOOK_SETS } from '../marketHooks.js';
import { normalizeProviderJob, type ProviderJobInput } from '../normalize/index.js';
import { TW_JOBNO_MAJORS } from '../taxonomy/index.js';
import { getSourceAdapter, registeredSourceAdapters, sourceUserAgent, type SourceFetchResult, type SourceQuery } from './index.js';
import { ensureTwOpenDataAdapter, twOpenDataAdapter } from './register.js';
import {
  TW_OPEN_DATA_CLOSE_PAGE,
  TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT,
  TW_OPEN_DATA_DEFAULT_URL,
  TW_OPEN_DATA_MAX_BYTES,
  TW_OPEN_DATA_ROW_CAP,
  TW_SWEEP_TABLES,
  advanceTwSweep,
  createTwOpenDataAdapter,
  emptyTwSweepCursor,
  failTwSweep,
  finishTwSweep,
  formatTwSweepCursor,
  parseTwOpenDataCsv,
  parseTwSweepCursor,
  requestTwOpenData,
  startTwSweep,
  twAbsenceProven,
  twOpenDataBaseUrl,
  twOpenDataConfig,
  twOpenDataEnabled,
  twOpenDataHeader,
  twOpenDataRowToInput,
  twOpenDataStatus,
  twOpenDataUrl,
  twSweepFinished,
  twSweepRequest,
  twVacancyLink,
  type TwClosureRow,
  type TwFetchLike,
  type TwOpenDataDb,
  type TwOpenDataRow,
  type TwSweepTables,
} from './twOpenData.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, '__fixtures__', 'tw', 'joblist.synthetic.csv'), 'utf8');
const NOW = new Date('2026-10-11T04:00:00.000Z');

// ── Helpers ─────────────────────────────────────────────────────────────────

const HEAD = [
  'OCCU_DESC（職務名稱）', 'WK_TYPE（職務性質）', 'CJOB1_COUNT（職務大類別代碼）', 'CJOB_NAME1（職務大類別名稱）', 'CJOB2_COUNT（職務小類別代碼）', 'CJOB_NAME2（職務小類別名稱）',
  'JOB_PERSON（雇用人數）', 'STOP_DATE（應徵截止日期）', 'JOB_DETAIL（工作內容）', 'CITYNAME（工作地點）', 'EXPERIENCE（工作經驗）', 'WKTIME（工作時間）', 'SALARYCD（核薪方式）',
  'NT_L（薪資範圍下限）', 'NT_U（薪資範圍上限）', 'EDGRDESC（最低學歷要求）', 'URL_QUERY（職缺資料URL）', 'COMPNAME（公司名稱）', 'TRANDATE（職缺更新日期）',
];
const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;

interface RowSpec {
  employer: string;
  hire: number | string;
  place: string;
}

/** A SYNTHETIC answer holding exactly `rows`. */
function csvRows(rows: readonly RowSpec[]): string {
  const lines = [HEAD.map(quote).join(',')];
  for (const row of rows) {
    const url = `https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=${row.employer}&HIRE_ID=${row.hire}`;
    lines.push(['範例職務', '全職', '01', '經營／行政／總務', '010206', '行政助理', '1', '20261231', 'SYNTHETIC', row.place, '無', '日班', '月薪', '30000', '-', '不拘', url, '範例公司', '20261010'].map(quote).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A SYNTHETIC answer of `n` rows whose ids are derived from `tag`. */
function csvOf(n: number, tag: string, place = '台北市中山區'): string {
  return csvRows(Array.from({ length: n }, (_, i) => ({ employer: tag, hire: i + 1, place })));
}

interface Call {
  url: string;
  city: string;
  zipno: string | null;
  jobno: string | null;
  headers: Record<string, string>;
  redirect: string | undefined;
}

type Script = (call: Call) => number | { status: number } | { body: string } | { throws: Error };

/**
 * A scripted endpoint: `script` answers each request with a row count, a
 * status, a body or a throw. A row count gives rows whose ids belong to that
 * one request, so a district answer never repeats a row of its county's
 * answer: tests that cap a county with it switch the second walk off
 * (`NO_SECOND_WALK`) unless the second walk is what they are about. For rows
 * that several requests return, use `listingEndpoint`.
 */
function fakeEndpoint(script: Script) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: TwFetchLike = async (url, init) => {
    const u = new URL(url);
    const call: Call = { url, city: u.searchParams.get('CITY') ?? '', zipno: u.searchParams.get('zipno'), jobno: u.searchParams.get('jobno'), headers: init.headers ?? {}, redirect: init.redirect };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    try {
      const answer = script(call);
      if (typeof answer === 'number') return { ok: true, status: 200, text: async () => csvOf(answer, `${call.city}${call.zipno ?? 'x'}${call.jobno ?? 'x'}`) };
      if ('throws' in answer) throw answer.throws;
      if ('status' in answer) return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => '' };
      return { ok: true, status: 200, text: async () => answer.body };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

/** The documented off switch of the second walk (a capped county is not read again by 大類). */
const NO_SECOND_WALK = { TW_OPEN_DATA_COUNTY_WALK_MIN: '0' };

/** A posting of a fake listing: the request attributes that return it, and the place it displays. */
interface Posting extends RowSpec {
  city: string;
  /** The `zipno` that returns it; null for a posting no district request returns. */
  zip: string | null;
  major: string;
}

/**
 * An endpoint over a listing, the way the source answers: a request returns
 * the postings filed under its CITY (and zipno, and jobno), the first 1,000
 * of them in listing order. What a posting DISPLAYS (`place`) plays no part.
 */
function listingEndpoint(listing: () => readonly Posting[]) {
  return fakeEndpoint((c) => ({
    body: csvRows(
      listing()
        .filter((p) => p.city === c.city && (!c.zipno || p.zip === c.zipno) && (!c.jobno || p.major === c.jobno))
        .slice(0, 1000),
    ),
  }));
}

const postings = (n: number, employer: string, over: Omit<Posting, 'employer' | 'hire'>): Posting[] => Array.from({ length: n }, (_, i) => ({ employer, hire: i + 1, ...over }));

const query = (cursor?: string | null): SourceQuery => ({
  id: 'q-tw',
  provider: 'tw_open_data',
  market: 'intl',
  origin: 'bank_sync',
  params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) },
});

interface Harness {
  adapter: ReturnType<typeof createTwOpenDataAdapter>;
  sleeps: number[];
  /** The harness clock (ms). Only a pause and `advance` move it. */
  clock(): number;
  /** Time passing outside the adapter (ingest writing a fetch's rows). */
  advance(ms: number): void;
  cursor: string | null;
  /** One fetch at `now`; the stored cursor follows what ingest would write. */
  step(now: Date, ctx?: { budgetMs?: number; signal?: AbortSignal }): Promise<SourceFetchResult>;
  /** Fetches at `now` until the adapter says there is no more to do right now. */
  drain(now: Date): Promise<SourceFetchResult[]>;
}

function harness(deps: Parameters<typeof createTwOpenDataAdapter>[0] & { cursor?: string | null }): Harness {
  const sleeps: number[] = [];
  let elapsed = 0;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    elapsed += ms;
  };
  const adapter = createTwOpenDataAdapter({ env: {}, sleep, clock: () => elapsed, ...deps });
  const h: Harness = {
    adapter,
    sleeps,
    clock: () => elapsed,
    advance: (ms) => void (elapsed += ms),
    cursor: deps.cursor ?? null,
    async step(now, ctx = {}) {
      const result = await adapter.fetch(query(h.cursor), { now, ...ctx });
      // Ingest stores a cursor only for a result without an error (pipeline.ts `runIngestQuery`).
      if (!result.error && result.cursor) h.cursor = result.cursor;
      return result;
    },
    async drain(now) {
      const out: SourceFetchResult[] = [];
      for (let i = 0; i < 2000; i++) {
        const result = await h.step(now);
        out.push(result);
        if (result.error || result.exhausted !== false) return out;
      }
      throw new Error('the sweep did not end');
    },
  };
  return h;
}

/** A small walk: three counties, the first with three districts, three 大類. */
const SMALL: TwSweepTables = {
  counties: [{ code: '01', name: '台北市' }, { code: '31', name: '新北市' }, { code: '11', name: '基隆市' }],
  districtsOf: (code) => (code === '01' ? [{ zip3: '100' }, { zip3: '103' }, { zip3: '104' }] : code === '31' ? [{ zip3: '220' }] : []),
  majors: ['01', '02', '03'],
};

const position = (c: Call) => [c.city, c.zipno, c.jobno].map((p) => p ?? '-').join('/');

function fixtureRows(): TwOpenDataRow[] {
  const page = parseTwOpenDataCsv(FIXTURE);
  if (!page.ok) throw new Error(page.error);
  return page.rows;
}

function fixtureInput(index: number): ProviderJobInput {
  const mapped = twOpenDataRowToInput(fixtureRows()[index]!, NOW);
  if ('skip' in mapped) throw new Error(`row ${index} was skipped: ${mapped.skip}`);
  return mapped.input;
}

const normalized = (input: ProviderJobInput) => normalizeProviderJob(input, 'tw_open_data', { market: 'intl', now: NOW });

// ── Switches ────────────────────────────────────────────────────────────────

describe('tw_open_data: on by default, off by one switch', () => {
  it('is on with nothing set (the licence is confirmed) and reads the documented endpoint', () => {
    expect(twOpenDataStatus({})).toEqual({ enabled: true });
    expect(twOpenDataEnabled({ TW_OPEN_DATA_JOBS_ENABLED: '' })).toBe(true);
    expect(twOpenDataEnabled({ TW_OPEN_DATA_JOBS_ENABLED: 'true' })).toBe(true);
    expect(twOpenDataBaseUrl({})).toBe(TW_OPEN_DATA_DEFAULT_URL);
    expect(TW_OPEN_DATA_DEFAULT_URL).toBe('https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx');
  });

  it.each(['false', '0', 'off', 'no', ' FALSE ', 'Off'])('TW_OPEN_DATA_JOBS_ENABLED=%s turns it off', (value) => {
    expect(twOpenDataStatus({ TW_OPEN_DATA_JOBS_ENABLED: value })).toEqual({ enabled: false, reason: 'kill_switch' });
  });

  it('with the switch off the adapter reports disabled and fetches nothing', async () => {
    const endpoint = fakeEndpoint(() => 5);
    const adapter = createTwOpenDataAdapter({ env: { TW_OPEN_DATA_JOBS_ENABLED: 'false' }, fetch: endpoint.fetch });
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.disabledReason?.()).toBe('kill_switch');
    expect(await adapter.fetch(query(), { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(endpoint.calls).toHaveLength(0);
  });

  it('accepts only an https endpoint on taiwanjobs.gov.tw', () => {
    expect(twOpenDataBaseUrl({ TW_OPEN_DATA_JOBS_URL: 'https://free.taiwanjobs.gov.tw/other/Webservice.ashx?x=1#y' })).toBe('https://free.taiwanjobs.gov.tw/other/Webservice.ashx');
    for (const bad of ['http://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx', 'https://www.104.com.tw/jobs', 'https://taiwanjobs.gov.tw.example.org/x', 'https://user:pw@free.taiwanjobs.gov.tw/x', 'not a url']) {
      expect(twOpenDataBaseUrl({ TW_OPEN_DATA_JOBS_URL: bad }), bad).toBeNull();
      expect(twOpenDataStatus({ TW_OPEN_DATA_JOBS_URL: bad })).toEqual({ enabled: false, reason: 'url_invalid' });
    }
  });

  it('reads its four numbers from the environment, with the documented defaults', () => {
    expect(twOpenDataConfig({})).toEqual({ requestsPerFetch: 5, pauseMs: 1500, sweepMs: 24 * 3_600_000, countyWalkMin: 50 });
    expect(TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT).toBe(50);
    expect(twOpenDataConfig({ TW_OPEN_DATA_REQUESTS_PER_FETCH: '8', TW_OPEN_DATA_PAUSE_MS: '250', TW_OPEN_DATA_SWEEP_HOURS: '12', TW_OPEN_DATA_COUNTY_WALK_MIN: '5' })).toEqual({
      requestsPerFetch: 8,
      pauseMs: 250,
      sweepMs: 12 * 3_600_000,
      countyWalkMin: 5,
    });
    expect(twOpenDataConfig({ TW_OPEN_DATA_REQUESTS_PER_FETCH: '0', TW_OPEN_DATA_PAUSE_MS: '-5', TW_OPEN_DATA_SWEEP_HOURS: 'soon', TW_OPEN_DATA_COUNTY_WALK_MIN: '-1' })).toEqual({
      requestsPerFetch: 1,
      pauseMs: 0,
      sweepMs: 24 * 3_600_000,
      countyWalkMin: 0,
    });
    // 0 is the off switch of the second walk; the sample is 1,000 rows, so nothing above it means anything.
    expect(twOpenDataConfig(NO_SECOND_WALK).countyWalkMin).toBe(0);
    expect(twOpenDataConfig({ TW_OPEN_DATA_COUNTY_WALK_MIN: '5000' }).countyWalkMin).toBe(1000);
  });

  it('describes itself: a free cursor source of the international market, Taiwan only, not metered', () => {
    const adapter = createTwOpenDataAdapter({ env: {} });
    expect(adapter).toMatchObject({ provider: 'tw_open_data', kind: 'cursor', markets: ['intl'], sourceBoards: ['tw_open_data'], costModel: 'free' });
    expect(adapter.dailyCallLimit()).toBeNull();
    expect(adapter.transport?.()).toBe('api');
    expect(adapter.supportsCountry('TW')).toBe(true);
    expect(adapter.supportsCountry('tw')).toBe(true);
    for (const other of ['US', 'CN', 'HK', 'JP', '*', '']) expect(adapter.supportsCountry(other), other).toBe(false);
  });
});

// ── The request ─────────────────────────────────────────────────────────────

describe('tw_open_data: one request', () => {
  it('builds the documented query: CITY, COUNT=1000, T=CSV, and zipno / jobno when asked', () => {
    const plain = new URL(twOpenDataUrl(TW_OPEN_DATA_DEFAULT_URL, { city: '01' }));
    expect(plain.origin + plain.pathname).toBe(TW_OPEN_DATA_DEFAULT_URL);
    expect(Object.fromEntries(plain.searchParams)).toEqual({ CITY: '01', COUNT: '1000', T: 'CSV' });
    expect(Object.fromEntries(new URL(twOpenDataUrl(TW_OPEN_DATA_DEFAULT_URL, { city: '12', zipno: '300', jobno: '08' })).searchParams)).toEqual({ CITY: '12', zipno: '300', jobno: '08', COUNT: '1000', T: 'CSV' });
  });

  it('sends the identifying User-Agent, never follows a redirect, and reads the rows', async () => {
    const endpoint = fakeEndpoint(() => 3);
    const page = await requestTwOpenData({ city: '11', zipno: '206' }, { fetch: endpoint.fetch, env: { JOB_SOURCES_CONTACT: 'mailto:jobs@example.test' } });
    expect(page.ok && page.rows.length).toBe(3);
    expect(endpoint.calls).toHaveLength(1);
    expect(endpoint.calls[0]).toMatchObject({ city: '11', zipno: '206', jobno: null, redirect: 'error' });
    expect(endpoint.calls[0]!.headers['User-Agent']).toBe(sourceUserAgent('intl', { JOB_SOURCES_CONTACT: 'mailto:jobs@example.test' }));
    expect(endpoint.calls[0]!.headers['User-Agent']).toBe('RoboApplyJobs/1.0 (+mailto:jobs@example.test)');
    expect(endpoint.calls[0]!.url.startsWith('https://free.taiwanjobs.gov.tw/')).toBe(true);
  });

  it.each([
    [{ status: 500 }, 'http_500'],
    [{ status: 404 }, 'http_404'],
    [{ status: 429 }, 'http_429'],
    [{ status: 302 }, 'redirect'],
    [{ throws: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }) }, 'redirect'],
    [{ throws: new Error('ECONNRESET') }, 'network'],
    [{ body: '<html><body>Service Unavailable</body></html>' }, 'not_csv'],
    [{ body: '"A","B"\r\n"1","2"\r\n' }, 'not_csv'],
  ] as const)('a bad answer is an error result, never a throw: %j → %s', async (answer, error) => {
    const endpoint = fakeEndpoint(() => answer as ReturnType<Script>);
    expect(await requestTwOpenData({ city: '01' }, { fetch: endpoint.fetch, env: {} })).toEqual({ ok: false, error });
  });

  it('refuses an oversized body, by its declared length or by what arrived', async () => {
    const declared: TwFetchLike = async () => ({ ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(TW_OPEN_DATA_MAX_BYTES + 1) : null) }, text: async () => { throw new Error('the body must not be read'); } });
    expect(await requestTwOpenData({ city: '01' }, { fetch: declared, env: {} })).toEqual({ ok: false, error: 'response_too_large' });
    const big = 'x'.repeat(TW_OPEN_DATA_MAX_BYTES + 1);
    const arrived: TwFetchLike = async () => ({ ok: true, status: 200, text: async () => big });
    expect(await requestTwOpenData({ city: '01' }, { fetch: arrived, env: {} })).toEqual({ ok: false, error: 'response_too_large' });
  });

  it('gives up after its timeout and when the caller aborts', async () => {
    const hanging: TwFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await requestTwOpenData({ city: '01' }, { fetch: hanging, env: {}, timeoutMs: 5 })).toEqual({ ok: false, error: 'timeout' });
    const controller = new AbortController();
    const pending = requestTwOpenData({ city: '01' }, { fetch: hanging, env: {}, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    expect(await requestTwOpenData({ city: '01' }, { fetch: hanging, env: {}, signal: controller.signal })).toEqual({ ok: false, error: 'aborted' });
  });

  it('makes no request when the configured endpoint is not usable', async () => {
    const endpoint = fakeEndpoint(() => 1);
    expect(await requestTwOpenData({ city: '01' }, { fetch: endpoint.fetch, env: { TW_OPEN_DATA_JOBS_URL: 'https://www.1111.com.tw/' } })).toEqual({ ok: false, error: 'url_invalid' });
    expect(endpoint.calls).toHaveLength(0);
  });
});

// ── The CSV ─────────────────────────────────────────────────────────────────

describe('tw_open_data: the CSV answer', () => {
  it('matches a column on the ASCII part before the bracket, full-width or half-width, with or without the byte-order mark', () => {
    expect(twOpenDataHeader('OCCU_DESC（職務名稱）')).toBe('OCCU_DESC');
    expect(twOpenDataHeader('﻿OCCU_DESC（職務名稱）')).toBe('OCCU_DESC');
    expect(twOpenDataHeader('NT_L(薪資範圍下限)')).toBe('NT_L');
    expect(twOpenDataHeader(' url_query ')).toBe('URL_QUERY');
    const rows = fixtureRows();
    expect(rows).toHaveLength(8);
    expect(Object.keys(rows[0]!)).toEqual(HEAD.map(twOpenDataHeader));
    expect(rows[0]).toMatchObject({ OCCU_DESC: '範例軟體工程師（SYNTHETIC）', NT_L: '30000', NT_U: '38000', CJOB2_COUNT: '080202', STOP_DATE: '20261231' });
    // The same answer with half-width brackets and no mark reads the same.
    const halfWidth = FIXTURE.replace(/^﻿/, '').replace(/^.*\r\n/, (head) => head.replace(/（/g, '(').replace(/）/g, ')'));
    expect(parseTwOpenDataCsv(halfWidth)).toEqual({ ok: true, rows });
  });

  it('an empty answer is an empty listing; a quoted comma, quote or line break stays inside its cell', () => {
    expect(parseTwOpenDataCsv('')).toEqual({ ok: true, rows: [] });
    expect(parseTwOpenDataCsv('﻿\r\n')).toEqual({ ok: true, rows: [] });
    expect(parseTwOpenDataCsv(`${HEAD.map(quote).join(',')}\r\n`)).toEqual({ ok: true, rows: [] });
    const tricky = csvOf(1, '77').replace('SYNTHETIC', 'a, "b"\r\nc'.replace(/"/g, '""'));
    const page = parseTwOpenDataCsv(tricky);
    expect(page.ok && page.rows).toHaveLength(1);
    expect(page.ok && page.rows[0]!.JOB_DETAIL).toBe('a, "b"\r\nc');
  });
});

// ── Mapping ─────────────────────────────────────────────────────────────────

describe('tw_open_data: a row becomes a posting', () => {
  it('maps the monthly-pay row field by field', () => {
    expect(fixtureInput(0)).toEqual({
      externalId: 'tw:9000001:90000001',
      sourceBoard: 'tw_open_data',
      title: '範例軟體工程師（SYNTHETIC）',
      company: '範例科技股份有限公司',
      description: 'SYNTHETIC 範例職缺內容：開發與維護內部系統。',
      applyUrl: 'https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=9000001&HIRE_ID=90000001',
      sourceUrl: 'https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=9000001&HIRE_ID=90000001',
      sourcePublisher: '台灣就業通',
      location: '新竹縣竹北市',
      locationCountry: 'TW',
      locationDistrict: '竹北市',
      employmentType: '全職',
      salaryMin: 30000,
      salaryMax: 38000,
      salaryCurrency: 'TWD',
      salaryPeriod: 'month',
      // TRANDATE 20261009, the first instant of that day in Taipei.
      postedAt: new Date('2026-10-08T16:00:00.000Z'),
      postedAtEstimated: true,
      fetchedAt: NOW,
      // STOP_DATE 20261231, the end of that day in Taipei (UTC+8).
      expiresAt: new Date('2026-12-31T15:59:59.000Z'),
      experienceLevel: '2+',
      educationLevel: 'bachelor',
      taxonomyId: 'software_engineer',
      headcount: 2,
      workShift: '日班',
    });
  });

  it('JT-2: a 月薪 row is 30,000 to 38,000 TWD a month, disclosed', () => {
    const job = normalized(fixtureInput(0));
    expect(job).toMatchObject({ salaryMin: 30000, salaryMax: 38000, salaryCurrency: 'TWD', salaryPeriod: 'month', salaryDisclosed: true, salarySource: 'provider' });
    expect(job.expiresAt?.toISOString()).toBe('2026-12-31T15:59:59.000Z');
    expect(job.postedAtEstimated).toBe(true);
    expect(job.employmentType).toBe('full_time');
    expect(job.educationLevel).toBe('bachelor');
    expect(job.minYears).toBe(2);
    expect(job.headcount).toBe(2);
  });

  it('JT-2: the no-figure sentence gives no figure, pay not disclosed, and that text; the threshold is never stored', () => {
    const input = fixtureInput(1);
    expect(input).toMatchObject({ salaryMin: null, salaryMax: null, salaryText: '依學經歷、證照核薪(每月經常性薪資達4萬元以上)' });
    expect(input.salaryCurrency).toBeUndefined();
    expect(input.salaryPeriod).toBeUndefined();
    const job = normalized(input);
    expect(job.salaryMin).toBeNull();
    expect(job.salaryMax).toBeNull();
    expect(job.salaryAnnualMin).toBeNull();
    expect(job.salaryDisclosed).toBe(false);
    expect(job.salaryText).toBe('依學經歷、證照核薪(每月經常性薪資達4萬元以上)');
    expect(JSON.stringify({ min: job.salaryMin, max: job.salaryMax, annualMin: job.salaryAnnualMin, annualMax: job.salaryAnnualMax })).not.toMatch(/40000|480000/);
    // 額滿為止 is not a date: the source states no deadline.
    expect(input.expiresAt).toBeNull();
    expect(input.experienceLevel).toBe('0+');
    expect(input.educationLevel).toBe('none');
    expect(job.educationLevel).toBe('none');
    expect(job.minYears).toBe(0);
  });

  it('pay comes only from numeric NT_L / NT_U, with the period of SALARYCD', () => {
    // Hourly, a lower bound only: the missing upper bound stays missing.
    expect(fixtureInput(2)).toMatchObject({ salaryMin: 196, salaryMax: null, salaryCurrency: 'TWD', salaryPeriod: 'hour', employmentType: '兼職' });
    expect(normalized(fixtureInput(2))).toMatchObject({ salaryMin: 196, salaryMax: null, salaryPeriod: 'hour', salaryDisclosed: true, employmentType: 'part_time' });
    // Daily.
    expect(fixtureInput(5)).toMatchObject({ salaryMin: 2000, salaryMax: 3000, salaryPeriod: 'day', experienceLevel: '0-1' });
    // Part-time monthly pay is monthly pay.
    expect(fixtureInput(6)).toMatchObject({ salaryMin: 15450, salaryMax: 30900, salaryPeriod: 'month', educationLevel: 'master', experienceLevel: '0+' });
    // Piece work: the two numbers are per piece. No period, no figure, the type as the pay text.
    const piece = fixtureInput(4);
    expect(piece).toMatchObject({ salaryMin: null, salaryMax: null, salaryText: '論件計酬' });
    expect(piece.salaryPeriod).toBeUndefined();
    const job = normalized(piece);
    expect(job.salaryMin).toBeNull();
    expect(job.salaryMax).toBeNull();
    expect(job.salaryDisclosed).toBe(false);
  });

  it('a bound that is not a positive number is no bound, whatever the type says', () => {
    const base = fixtureRows()[0]!;
    for (const [lo, hi] of [['-', '-'], ['', ''], ['0', '0'], ['面議', '4萬'], ['40,000', '以上'], ['-1', '1e5']] as const) {
      const mapped = twOpenDataRowToInput({ ...base, NT_L: lo, NT_U: hi }, NOW);
      expect('input' in mapped && mapped.input, `${lo}/${hi}`).toMatchObject({ salaryMin: null, salaryMax: null, salaryText: '月薪' });
    }
    // A statutory-clause sentence in SALARYCD never becomes a figure, even next to numbers in the bound cells of another type.
    const clause = twOpenDataRowToInput({ ...base, SALARYCD: '依學經歷、證照核薪(每月經常性薪資達5萬元以上)', NT_L: '50000', NT_U: '-' }, NOW);
    expect('input' in clause && clause.input).toMatchObject({ salaryMin: null, salaryMax: null, salaryText: '依學經歷、證照核薪(每月經常性薪資達5萬元以上)' });
    expect('input' in clause && normalized(clause.input)).toMatchObject({ salaryMin: null, salaryDisclosed: false });
  });

  it('education: only the five levels the input knows; everything else is left unset', () => {
    const base = fixtureRows()[0]!;
    const level = (value: string) => {
      const mapped = twOpenDataRowToInput({ ...base, EDGRDESC: value }, NOW);
      return 'input' in mapped ? mapped.input.educationLevel : 'skipped';
    };
    expect(['不拘', '專科', '大學', '碩士', '博士'].map(level)).toEqual(['none', 'associate', 'bachelor', 'master', 'phd']);
    for (const other of ['高中', '高職', '國中', '國小', '', '其他']) expect(level(other), other).toBeNull();
  });

  it('experience: 無 and 不拘 ask for none, N年以上 for at least N, N年內 for up to N', () => {
    const base = fixtureRows()[0]!;
    const band = (value: string) => {
      const mapped = twOpenDataRowToInput({ ...base, EXPERIENCE: value }, NOW);
      return 'input' in mapped ? mapped.input.experienceLevel : 'skipped';
    };
    expect(['無', '不拘', '1年以上', '10年以上', '1年內'].map(band)).toEqual(['0+', '0+', '1+', '10+', '0-1']);
    for (const other of ['', '若干', '三年以上']) expect(band(other), other).toBeNull();
  });

  it('dates: only a real YYYYMMDD is a date', () => {
    const base = fixtureRows()[0]!;
    const dates = (stop: string, tran: string) => {
      const mapped = twOpenDataRowToInput({ ...base, STOP_DATE: stop, TRANDATE: tran }, NOW);
      if (!('input' in mapped)) throw new Error('skipped');
      return [mapped.input.expiresAt, mapped.input.postedAt];
    };
    expect(dates('20261231', '20261009')).toEqual([new Date('2026-12-31T15:59:59.000Z'), new Date('2026-10-08T16:00:00.000Z')]);
    expect(dates('20270101', '20270101')).toEqual([new Date('2027-01-01T15:59:59.000Z'), new Date('2026-12-31T16:00:00.000Z')]);
    for (const bad of ['額滿為止', '', '2026-12-31', '20261331', '20260230', '1151231', '19991231']) expect(dates(bad, bad), bad).toEqual([null, null]);
  });

  it('JT-2: a row whose link lacks HIRE_ID is skipped and counted, never given an invented id', () => {
    expect(twOpenDataRowToInput(fixtureRows()[3]!, NOW)).toEqual({ skip: 'no_external_id' });
    expect(twOpenDataRowToInput(fixtureRows()[7]!, NOW)).toEqual({ skip: 'no_apply_url' });
    const base = fixtureRows()[0]!;
    expect(twOpenDataRowToInput({ ...base, URL_QUERY: '' }, NOW)).toEqual({ skip: 'no_apply_url' });
    expect(twOpenDataRowToInput({ ...base, URL_QUERY: 'javascript:alert(1)' }, NOW)).toEqual({ skip: 'no_apply_url' });
    expect(twOpenDataRowToInput({ ...base, URL_QUERY: 'https://job.taiwanjobs.gov.tw/x?HIRE_ID=5' }, NOW)).toEqual({ skip: 'no_external_id' });
    expect(twOpenDataRowToInput({ ...base, URL_QUERY: 'https://job.taiwanjobs.gov.tw/x?EMPLOYER_ID=1 OR 1&HIRE_ID=5' }, NOW)).toEqual({ skip: 'no_external_id' });
    expect(twVacancyLink('https://job.taiwanjobs.gov.tw/x?employer_id=12&Hire_Id=34')).toMatchObject({ employerId: '12', hireId: '34' });
  });

  it('JT-2: every posting is in Taiwan, names 台灣就業通 and applies on the vacancy page (D1)', () => {
    const inputs = fixtureRows().map((row) => twOpenDataRowToInput(row, NOW)).flatMap((r) => ('input' in r ? [r.input] : []));
    expect(inputs).toHaveLength(6);
    for (const input of inputs) {
      expect(input.locationCountry).toBe('TW');
      expect(input.sourcePublisher).toBe('台灣就業通');
      expect(input.applyUrl).toMatch(/^https:\/\/job\.taiwanjobs\.gov\.tw\/Internet\/jobwanted\/JobDetail\.aspx\?EMPLOYER_ID=\d+&HIRE_ID=\d+$/);
      expect(input.sourceUrl).toBe(input.applyUrl);
      expect(input.externalId).toMatch(/^tw:\d+:\d+$/);
      // Nothing the dataset does not have is filled in.
      expect(input.companyLogoUrl).toBeUndefined();
      expect(input.companyFacts).toBeUndefined();
      const job = normalized(input);
      expect(job).toMatchObject({ market: 'intl', locationCountry: 'TW', sourceBoard: 'tw_open_data', sourceName: '台灣就業通', originalSourceName: null, postedAtEstimated: true, visibility: 'public' });
      expect(job.applyUrl).toBe(input.applyUrl);
      expect(job.originalHost).toBe('job.taiwanjobs.gov.tw');
    }
    expect(new Set(inputs.map((i) => i.externalId)).size).toBe(inputs.length);
  });

  it('JT-4: a mapped 小類 gives the role from the source\'s own code; an unmapped one leaves the title to decide', () => {
    const mappedJob = normalized(fixtureInput(0));
    expect(mappedJob.primaryTaxonomyId).toBe('software_engineer');
    expect(mappedJob.fieldSources.taxonomy).toBe('provider');
    // The code wins over a title that says something else.
    const other = normalized({ ...fixtureInput(0), title: '門市人員' });
    expect(other.primaryTaxonomyId).toBe('software_engineer');
    expect(other.fieldSources.taxonomy).toBe('provider');
    // 170113 照顧服務員 is not in the map: no role from the code.
    const unmapped = fixtureInput(1);
    expect(unmapped.taxonomyId).toBeNull();
    expect(normalized(unmapped).fieldSources.taxonomy).not.toBe('provider');
    // The title decides, and a care worker (照顧服務員) is not restaurant staff: the tree has no such role, so the
    // row has none (an honest unknown), in either reading of the title.
    expect(normalized(unmapped)).toMatchObject({ primaryTaxonomyId: null, taxonomyIds: [] });
    for (const title of ['照顧服務員', '居家照顧服務員', '加油站服務員']) expect(normalized({ ...unmapped, title }).taxonomyIds, title).toEqual([]);
    expect(normalized({ ...unmapped, title: '餐廳服務員' }).taxonomyIds).toContain('server');
    const byTitle = normalized({ ...unmapped, title: '軟體工程師' });
    expect(byTitle.primaryTaxonomyId).toBe('software_engineer');
    expect(byTitle.fieldSources.taxonomy).toBe('title');
  });

  it('the district is read from the place; 不限 names the county only', () => {
    expect(fixtureInput(0).locationDistrict).toBe('竹北市');
    expect(fixtureInput(1)).toMatchObject({ location: '台中市不限', locationDistrict: null });
    expect(fixtureInput(2).locationDistrict).toBe('中山區');
    expect(fixtureInput(5)).toMatchObject({ location: '臺南市善化區', locationDistrict: '善化區' });
  });
});

// ── The sweep: pure steps ───────────────────────────────────────────────────

describe('tw_open_data: the sweep cursor', () => {
  it('round-trips through JSON and starts fresh from anything that is not a cursor', () => {
    const cursor = {
      ...startTwSweep(emptyTwSweepCursor(), NOW),
      county: 3,
      zip: 7,
      jobno: 2,
      incomplete: true,
      errors: 1,
      partial: ['01', '31'],
      pending: ['9000001:12', 'A-1:b_2'],
      close: { before: NOW.toISOString(), afterId: 'abc', partial: ['01'] },
      counts: { requests: 9, rows: 4000, errors: 1, cappedLeaves: 1, skippedPositions: 0, countyOnly: 37, unreached: 2, cappedCountyMajors: 1 },
    };
    expect(parseTwSweepCursor(formatTwSweepCursor(cursor))).toEqual(cursor);
    // The second walk is a county read by 大類; it round-trips, and no other position can claim to be one.
    const second = { ...cursor, zip: null, jobno: 4, second: true };
    expect(parseTwSweepCursor(formatTwSweepCursor(second))).toEqual(second);
    expect(parseTwSweepCursor(formatTwSweepCursor({ ...cursor, second: true })).second).toBe(false);
    for (const junk of [null, undefined, '', 'backlog:a,b', '2026-10-11T00:00:00Z|abc', '[]', '{"v":2,"county":5}', '{broken', '42']) {
      expect(parseTwSweepCursor(junk as string), String(junk)).toEqual(emptyTwSweepCursor());
    }
    // A hand-edited cursor keeps what is valid and drops the rest.
    expect(parseTwSweepCursor('{"v":1,"county":-3,"zip":"x","jobno":1.5,"errors":"2","sweepStartedAt":"never","partial":["01","1","xx",5]}')).toEqual({ ...emptyTwSweepCursor(), partial: ['01'] });
    // The id list keeps only ids of the two-part shape, once each, and never more than one answer holds.
    expect(parseTwSweepCursor('{"v":1,"pending":["1:2","1:2","no colon","a:b:c",7,"x y:1"]}').pending).toEqual(['1:2']);
    expect(parseTwSweepCursor(JSON.stringify({ v: 1, pending: Array.from({ length: 1500 }, (_, i) => `e:${i}`) })).pending).toHaveLength(1000);
    expect(parseTwSweepCursor('{"v":1,"pending":"1:2"}').pending).toBeNull();
  });

  it('walks county by county while answers are under the cap', () => {
    let cursor = startTwSweep(emptyTwSweepCursor(), NOW);
    const seen: string[] = [];
    while (!twSweepFinished(cursor, SMALL)) {
      const r = twSweepRequest(cursor, SMALL)!;
      seen.push([r.city, r.zipno ?? '-', r.jobno ?? '-'].join('/'));
      cursor = advanceTwSweep(cursor, 10, SMALL);
    }
    expect(seen).toEqual(['01/-/-', '31/-/-', '11/-/-']);
    expect(cursor).toMatchObject({ county: 3, zip: null, jobno: null, incomplete: false, partial: [], counts: { requests: 3, rows: 30, cappedLeaves: 0 } });
    expect(twSweepRequest(cursor, SMALL)).toBeNull();
  });

  it('a capped county is walked by district, a capped district by 大類, and a capped leaf marks the sweep incomplete', () => {
    const answers: Record<string, number> = { '01/-/-': 1000, '01/103/-': 1000, '01/103/02': 1000 };
    let cursor = startTwSweep(emptyTwSweepCursor(), NOW);
    const seen: string[] = [];
    while (!twSweepFinished(cursor, SMALL)) {
      const r = twSweepRequest(cursor, SMALL)!;
      const key = [r.city, r.zipno ?? '-', r.jobno ?? '-'].join('/');
      seen.push(key);
      cursor = advanceTwSweep(cursor, answers[key] ?? 4, SMALL);
    }
    expect(seen).toEqual(['01/-/-', '01/100/-', '01/103/-', '01/103/01', '01/103/02', '01/103/03', '01/104/-', '31/-/-', '11/-/-']);
    expect(cursor).toMatchObject({ incomplete: true, partial: ['01'], counts: { requests: 9, cappedLeaves: 1, rows: 3000 + 6 * 4 } });
  });

  it('with no district table a capped county is walked by 大類', () => {
    const answers: Record<string, number> = { '11/-/-': 1000, '11/-/03': 1000 };
    let cursor = { ...startTwSweep(emptyTwSweepCursor(), NOW), county: 2 };
    const seen: string[] = [];
    while (!twSweepFinished(cursor, SMALL)) {
      const r = twSweepRequest(cursor, SMALL)!;
      const key = [r.city, r.zipno ?? '-', r.jobno ?? '-'].join('/');
      seen.push(key);
      cursor = advanceTwSweep(cursor, answers[key] ?? 4, SMALL);
    }
    expect(seen).toEqual(['11/-/-', '11/-/01', '11/-/02', '11/-/03']);
    // Its own answer hit the cap, so it is not a county read whole, however it was split.
    expect(cursor).toMatchObject({ incomplete: true, partial: ['11'], pending: null, second: false, counts: { cappedLeaves: 1, countyOnly: 0 } });
  });

  it('measures what the split by district misses: the ids of a capped county\'s own answer that no district returns', () => {
    const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `9:${from + i}`);
    let cursor = advanceTwSweep(startTwSweep(emptyTwSweepCursor(), NOW), 1000, SMALL, { ids: ids(1, 1000) });
    expect(cursor).toMatchObject({ county: 0, zip: 0, partial: ['01'] });
    expect(cursor.pending).toHaveLength(1000);
    // Each district answer takes its rows off the list; a row it returns that the county answer did not hold changes nothing.
    cursor = advanceTwSweep(cursor, 400, SMALL, { ids: ids(1, 400) });
    expect(cursor.pending).toHaveLength(600);
    cursor = advanceTwSweep(cursor, 300, SMALL, { ids: [...ids(401, 690), ...ids(5001, 5010)] });
    expect(cursor.pending).toHaveLength(310);
    // The last district: 30 rows of the county's first 1,000 were returned by no district. Under the default
    // threshold (50) the county is left; the figure is in the sweep's counts.
    const left = advanceTwSweep(cursor, 280, SMALL, { ids: ids(691, 970) });
    expect(left).toMatchObject({ county: 1, zip: null, jobno: null, second: false, pending: null, incomplete: false, counts: { countyOnly: 30, unreached: 0 } });
    // An answer whose ids are not known measures nothing and is never read as "nothing was missed".
    expect(advanceTwSweep(cursor, 280, SMALL).counts.countyOnly).toBe(310);
  });

  it('a capped county whose districts miss enough of its answer is read a second time by 大類; a capped answer there does not make the sweep incomplete', () => {
    const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `9:${from + i}`);
    const step = { countyWalkMin: 30 };
    let cursor = advanceTwSweep(startTwSweep(emptyTwSweepCursor(), NOW), 1000, SMALL, { ...step, ids: ids(1, 1000) });
    cursor = advanceTwSweep(cursor, 400, SMALL, { ...step, ids: ids(1, 400) });
    cursor = advanceTwSweep(cursor, 290, SMALL, { ...step, ids: ids(401, 690) });
    cursor = advanceTwSweep(cursor, 280, SMALL, { ...step, ids: ids(691, 970) });
    // 30 left, at the threshold: the county is not left, it is read again 大類 by 大類.
    expect(cursor).toMatchObject({ county: 0, zip: null, jobno: 0, second: true, counts: { countyOnly: 30 } });
    expect(twSweepRequest(cursor, SMALL)).toEqual({ city: '01', zipno: null, jobno: '01' });
    cursor = advanceTwSweep(cursor, 12, SMALL, { ...step, ids: ids(971, 982) });
    expect(twSweepRequest(cursor, SMALL)).toEqual({ city: '01', zipno: null, jobno: '02' });
    // Still at the cap: counted, kept, and the sweep stays complete (this walk is extra coverage, not the split).
    cursor = advanceTwSweep(cursor, 1000, SMALL, { ...step, ids: ids(983, 999) });
    expect(cursor).toMatchObject({ jobno: 2, second: true, incomplete: false, counts: { cappedLeaves: 0, cappedCountyMajors: 1 } });
    cursor = advanceTwSweep(cursor, 0, SMALL, { ...step, ids: [] });
    // One row of the county's answer came back from no narrower request at all.
    expect(cursor).toMatchObject({ county: 1, zip: null, jobno: null, second: false, pending: null, incomplete: false, counts: { countyOnly: 30, unreached: 1, cappedCountyMajors: 1 } });
    // With the threshold at 0 the second walk never starts.
    let off = advanceTwSweep(startTwSweep(emptyTwSweepCursor(), NOW), 1000, SMALL, { countyWalkMin: 0, ids: ids(1, 1000) });
    for (let i = 0; i < 3; i++) off = advanceTwSweep(off, 1, SMALL, { countyWalkMin: 0, ids: [] });
    expect(off).toMatchObject({ county: 1, second: false, counts: { countyOnly: 1000 } });
    // A position given up during the second walk moves on like any other.
    const struck = failTwSweep(failTwSweep(failTwSweep({ ...cursor, county: 0, jobno: 2, second: true, pending: ['9:1000'] }, SMALL, step), SMALL, step), SMALL, step);
    expect(struck).toMatchObject({ county: 1, second: false, pending: null, incomplete: true, counts: { skippedPositions: 1 } });
  });

  it('a failed request keeps its position; the third strike gives it up and marks the sweep incomplete', () => {
    let cursor = advanceTwSweep(startTwSweep(emptyTwSweepCursor(), NOW), 1000, SMALL);
    expect(twSweepRequest(cursor, SMALL)).toEqual({ city: '01', zipno: '100', jobno: null });
    cursor = failTwSweep(cursor, SMALL);
    expect(cursor).toMatchObject({ county: 0, zip: 0, errors: 1, incomplete: false });
    cursor = failTwSweep(cursor, SMALL);
    expect(cursor).toMatchObject({ county: 0, zip: 0, errors: 2, incomplete: false });
    // A success in between clears the strikes.
    expect(advanceTwSweep(cursor, 3, SMALL)).toMatchObject({ zip: 1, errors: 0, incomplete: false });
    cursor = failTwSweep(cursor, SMALL);
    expect(cursor).toMatchObject({ county: 0, zip: 1, errors: 0, incomplete: true, counts: { errors: 3, skippedPositions: 1 } });
  });

  it('only a complete sweep becomes the latest complete one, and a closure needs a complete sweep before it', () => {
    const t1 = new Date('2026-10-11T00:00:00.000Z');
    const t2 = new Date('2026-10-12T00:00:00.000Z');
    const t3 = new Date('2026-10-13T00:00:00.000Z');
    const first = finishTwSweep({ ...startTwSweep(emptyTwSweepCursor(), t1), county: 22, partial: ['01'] });
    expect(first).toMatchObject({ lastCompleteSweepStartedAt: t1.toISOString(), prevSweepStartedAt: null, close: null, lastCompletePartial: ['01'] });
    const incomplete = finishTwSweep({ ...startTwSweep(first, t2), county: 22, incomplete: true, partial: ['31'] });
    expect(incomplete).toMatchObject({ lastCompleteSweepStartedAt: t1.toISOString(), prevSweepStartedAt: null, close: null, lastCompletePartial: ['01'] });
    const third = finishTwSweep({ ...startTwSweep(incomplete, t3), county: 22, partial: ['13'] });
    expect(third).toMatchObject({ lastCompleteSweepStartedAt: t3.toISOString(), prevSweepStartedAt: t1.toISOString(), lastCompletePartial: ['13'] });
    expect(third.close).toEqual({ before: t1.toISOString(), afterId: null, partial: ['13', '01'] });
  });

  it('the committed tables: 22 counties in the document\'s order and the 22 大類', () => {
    expect(TW_SWEEP_TABLES.counties).toBe(TW_COUNTIES);
    expect(TW_SWEEP_TABLES.counties).toHaveLength(22);
    expect(TW_SWEEP_TABLES.majors).toEqual(TW_JOBNO_MAJORS.map((m) => m.code));
    expect(TW_SWEEP_TABLES.majors).toEqual(Array.from({ length: 22 }, (_, i) => String(i + 1).padStart(2, '0')));
    expect(TW_SWEEP_TABLES.districtsOf('01')).toEqual(districtsOfCounty('01'));
    expect(TW_OPEN_DATA_ROW_CAP).toBe(1000);
  });
});

// ── The sweep: the adapter ──────────────────────────────────────────────────

describe('tw_open_data: a sweep through the adapter', () => {
  it('JT-2: county 01 at the cap is split by district, and a capped district by 大類', async () => {
    const taipei = districtsOfCounty('01');
    const cappedZip = taipei[2]!.zip3;
    const endpoint = fakeEndpoint((c) => {
      if (c.city !== '01') return 2;
      if (!c.zipno) return 1000;
      if (c.zipno === cappedZip && !c.jobno) return 1000;
      return 7;
    });
    const h = harness({ fetch: endpoint.fetch, env: NO_SECOND_WALK });
    const results = await h.drain(NOW);
    const taipeiCalls = endpoint.calls.filter((c) => c.city === '01').map(position);
    expect(taipeiCalls).toEqual([
      '01/-/-',
      ...taipei.slice(0, 2).map((d) => `01/${d.zip3}/-`),
      `01/${cappedZip}/-`,
      ...TW_JOBNO_MAJORS.map((m) => `01/${cappedZip}/${m.code}`),
      ...taipei.slice(3).map((d) => `01/${d.zip3}/-`),
    ]);
    // Every other county is one request, in the document's order.
    expect(endpoint.calls.filter((c) => c.city !== '01').map(position)).toEqual(TW_COUNTIES.slice(1).map((c) => `${c.code}/-/-`));
    expect(endpoint.calls[0]!.city).toBe('01');
    // Nothing was discarded: the capped answers' rows are in the results too.
    const jobs = results.flatMap((r) => r.jobs);
    expect(jobs).toHaveLength(1000 + 1000 + 22 * 7 + (taipei.length - 1) * 7 + 21 * 2);
    const end = parseTwSweepCursor(h.cursor);
    expect(end).toMatchObject({ county: 22, incomplete: false, partial: ['01'], lastCompleteSweepStartedAt: NOW.toISOString(), close: null });
    expect(end.counts.requests).toBe(endpoint.calls.length);
    expect(results.at(-1)).toMatchObject({ exhausted: true, notes: { tw_sweep_finished: 1 } });
    expect(results.every((r) => !r.error)).toBe(true);
  });

  it('JT-2: a (district, 大類) leaf still at the cap keeps its rows, counts tw_capped_leaf and leaves the sweep incomplete', async () => {
    const endpoint = fakeEndpoint((c) => (c.city === '01' && (!c.zipno || c.zipno === '103') && (!c.jobno || c.jobno === '02') ? 1000 : 1));
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, env: { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    const results = await h.drain(NOW);
    expect(endpoint.calls.map(position)).toEqual(['01/-/-', '01/100/-', '01/103/-', '01/103/01', '01/103/02', '01/103/03', '01/104/-', '31/-/-', '11/-/-']);
    expect(results.flatMap((r) => r.jobs)).toHaveLength(3000 + 6);
    expect(results[0]!.notes).toMatchObject({ tw_capped_leaf: 1, tw_sweep_incomplete: 1 });
    expect(parseTwSweepCursor(h.cursor)).toMatchObject({ incomplete: true, lastCompleteSweepStartedAt: null, close: null, counts: { cappedLeaves: 1 } });
  });

  it('with an empty district table a capped county falls back to the 大類 split', async () => {
    const tables: TwSweepTables = { ...SMALL, districtsOf: () => [] };
    const endpoint = fakeEndpoint((c) => (c.city === '01' && !c.jobno ? 1000 : 3));
    const h = harness({ fetch: endpoint.fetch, tables, env: { TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    await h.drain(NOW);
    expect(endpoint.calls.map(position)).toEqual(['01/-/-', '01/-/01', '01/-/02', '01/-/03', '31/-/-', '11/-/-']);
    // The county's own answer hit the cap: it is not a county read whole, and what the 大類 answers did not return is counted.
    expect(parseTwSweepCursor(h.cursor)).toMatchObject({ incomplete: false, partial: ['01'], lastCompleteSweepStartedAt: NOW.toISOString(), counts: { countyOnly: 0, unreached: 1000 } });
  });

  it('JT-2: a fetch stops at its request budget, says there is more, and the next fetch resumes at the same county and district', async () => {
    const endpoint = fakeEndpoint((c) => (c.city === '01' && !c.zipno ? 1000 : 1));
    const env = { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '2' };
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, env });
    const first = await h.step(NOW);
    expect(first).toMatchObject({ calls: 2, exhausted: false });
    expect(endpoint.calls.map(position)).toEqual(['01/-/-', '01/100/-']);
    // The stored cursor is plain JSON text and holds the position: county 01, its second district.
    const stored = JSON.parse(h.cursor!) as Record<string, unknown>;
    expect(stored).toMatchObject({ v: 1, county: 0, zip: 1, jobno: null, incomplete: false, sweepStartedAt: NOW.toISOString() });
    // It also holds what is left of the county's own answer: 1,000 ids, none of them returned by the first district.
    expect(stored.pending).toHaveLength(1000);
    expect(twSweepRequest(parseTwSweepCursor(JSON.stringify(stored)), SMALL)).toEqual({ city: '01', zipno: '103', jobno: null });
    // A later run (another process: only the cursor text survives) picks up exactly there.
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const second = await harness({ fetch: endpoint.fetch, tables: SMALL, env, cursor: h.cursor }).step(later);
    expect(second).toMatchObject({ calls: 2, exhausted: false });
    expect(endpoint.calls.map(position)).toEqual(['01/-/-', '01/100/-', '01/103/-', '01/104/-']);
    // The sweep is still the one that started first.
    expect(parseTwSweepCursor(second.cursor)).toMatchObject({ sweepStartedAt: NOW.toISOString(), county: 1, zip: null, pending: null, counts: { countyOnly: 1000 } });
    expect(second.notes).toMatchObject({ tw_county_only: 1000 });
  });

  it('JT-2: what the split misses is measured, and a county that misses enough is read again by 大類', async () => {
    // County 01: 1,200 postings filed under its three districts, and 100 that no district request returns.
    // 60 of those 100 are among the county's first 1,000 rows; 40 are beyond them.
    const loose = postings(100, '8001', { city: '01', zip: null, major: '02', place: '台北市不限' });
    const filed = [
      ...postings(400, '8100', { city: '01', zip: '100', major: '01', place: '台北市中正區' }),
      ...postings(400, '8103', { city: '01', zip: '103', major: '02', place: '台北市大同區' }),
      ...postings(400, '8104', { city: '01', zip: '104', major: '03', place: '台北市中山區' }),
    ];
    const listing = [...loose.slice(0, 60), ...filed, ...loose.slice(60), ...postings(3, '8220', { city: '31', zip: '220', major: '01', place: '新北市板橋區' })];
    const looseIds = loose.map((p) => `tw:${p.employer}:${p.hire}`);

    const endpoint = listingEndpoint(() => listing);
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, env: { TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    const results = await h.drain(NOW);
    // 60 of the county's first 1,000 came back from no district: above the threshold of 50, so 01 is read by 大類 too.
    expect(endpoint.calls.map(position)).toEqual(['01/-/-', '01/100/-', '01/103/-', '01/104/-', '01/-/01', '01/-/02', '01/-/03', '31/-/-', '11/-/-']);
    const read = new Set(results.flatMap((r) => r.jobs.map((j) => j.externalId)));
    // The second walk reached every one of the 100, also the 40 the county's own answer had cut.
    expect(looseIds.every((id) => read.has(id))).toBe(true);
    expect(read.size).toBe(1303);
    expect(results[0]!.notes).toMatchObject({ tw_county_only: 60, tw_sweep_finished: 1 });
    expect(results[0]!.notes).not.toHaveProperty('tw_county_unreached');
    expect(parseTwSweepCursor(h.cursor)).toMatchObject({ incomplete: false, partial: ['01'], pending: null, second: false, counts: { countyOnly: 60, unreached: 0, cappedCountyMajors: 0 } });

    // With the second walk off the same figure is still reported, and the 40 are never read.
    const off = listingEndpoint(() => listing);
    const plain = harness({ fetch: off.fetch, tables: SMALL, env: { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    const plainResults = await plain.drain(NOW);
    expect(off.calls.map(position)).toEqual(['01/-/-', '01/100/-', '01/103/-', '01/104/-', '31/-/-', '11/-/-']);
    expect(plainResults[0]!.notes).toMatchObject({ tw_county_only: 60, tw_sweep_finished: 1 });
    expect(new Set(plainResults.flatMap((r) => r.jobs.map((j) => j.externalId))).size).toBe(1263);

    // Below the threshold (20 of the first 1,000) the county is not read again.
    const few = [...loose.slice(0, 20), ...filed, ...loose.slice(20)];
    const quiet = listingEndpoint(() => few);
    const quietResults = await harness({ fetch: quiet.fetch, tables: SMALL, env: { TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } }).drain(NOW);
    expect(quiet.calls.map(position)).toEqual(['01/-/-', '01/100/-', '01/103/-', '01/104/-', '31/-/-', '11/-/-']);
    expect(quietResults[0]!.notes).toMatchObject({ tw_county_only: 20 });
  });

  it('the second walk resumes from the stored cursor like any other position', async () => {
    const loose = postings(80, '8001', { city: '01', zip: null, major: '03', place: '台北市不限' });
    const listing = [...loose, ...postings(1000, '8100', { city: '01', zip: '100', major: '01', place: '台北市中正區' })];
    const endpoint = listingEndpoint(() => listing);
    // The district answer is itself at the cap (1,000 rows), so it is walked by 大類 before the county's second walk.
    const env = { TW_OPEN_DATA_REQUESTS_PER_FETCH: '9' };
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, env });
    const first = await h.step(NOW);
    expect(first).toMatchObject({ calls: 9, exhausted: false });
    expect(endpoint.calls.map(position)).toEqual(['01/-/-', '01/100/-', '01/100/01', '01/100/02', '01/100/03', '01/103/-', '01/104/-', '01/-/01', '01/-/02']);
    const stored = parseTwSweepCursor(h.cursor);
    expect(stored).toMatchObject({ county: 0, zip: null, jobno: 2, second: true });
    expect(stored.pending).toHaveLength(80);
    // (01, 大類 01) held 1,000 rows: counted, and the (district, 大類) leaf 01/100/01 too, which is what leaves the sweep incomplete.
    expect(first.notes).toMatchObject({ tw_county_only: 80, tw_capped_county_major: 1, tw_capped_leaf: 1 });
    const rest = await harness({ fetch: endpoint.fetch, tables: SMALL, env, cursor: h.cursor }).drain(new Date(NOW.getTime() + 60_000));
    expect(endpoint.calls.map(position).slice(9)).toEqual(['01/-/03', '31/-/-', '11/-/-']);
    expect(rest.flatMap((r) => r.jobs)).toHaveLength(80);
    expect(rest.at(-1)!.notes).toMatchObject({ tw_sweep_incomplete: 1 });
    expect(rest.at(-1)!.notes).not.toHaveProperty('tw_county_unreached');
  });

  it('requests are sequential, never concurrent, with the pause between two and the User-Agent on each', async () => {
    const endpoint = fakeEndpoint(() => 1);
    const h = harness({ fetch: endpoint.fetch, env: { JOB_SOURCES_CONTACT: 'https://www.roboapply.io/bots' } });
    const first = await h.step(NOW);
    expect(first.calls).toBe(5);
    expect(endpoint.calls).toHaveLength(5);
    expect(endpoint.maxInFlight()).toBe(1);
    // Four pauses between five requests: none before the first, none after the last.
    expect(h.sleeps).toEqual([1500, 1500, 1500, 1500]);
    for (const call of endpoint.calls) {
      expect(call.headers['User-Agent']).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io/bots)');
      expect(call.redirect).toBe('error');
    }
    await h.drain(NOW);
    expect(endpoint.maxInFlight()).toBe(1);
    expect(endpoint.calls).toHaveLength(22);
  });

  it('the pause also holds between the last request of one fetch and the first of the next', async () => {
    const times: number[] = [];
    const holder: { h?: Harness } = {};
    const endpoint = fakeEndpoint(() => {
      times.push(holder.h!.clock());
      return 1;
    });
    const h = (holder.h = harness({ fetch: endpoint.fetch }));
    // Ingest leases a running sweep again at once: no time passes between the two fetches.
    await h.step(NOW);
    await h.step(NOW);
    expect(times).toHaveLength(10);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `between request ${i} and ${i + 1}`).toBeGreaterThanOrEqual(1500);
    expect(h.sleeps).toEqual(Array.from({ length: 9 }, () => 1500));
    // Time that already passed (ingest writing the rows) counts toward the pause: only the rest is waited.
    h.advance(400);
    await h.step(NOW);
    expect(h.sleeps[9]).toBe(1100);
    expect(times[10]! - times[9]!).toBe(1500);
    h.advance(5000);
    const before = h.sleeps.length;
    await h.step(NOW);
    expect(h.sleeps.slice(before)).toEqual([1500, 1500, 1500, 1500]);
    // Another adapter instance (another process) owes nothing: it knows of no earlier request.
    const other = harness({ fetch: fakeEndpoint(() => 1).fetch, cursor: h.cursor });
    expect((await other.step(NOW)).calls).toBe(2);
    expect(other.sleeps).toEqual([1500]);
  });

  it('stops inside the caller\'s time budget: a first request that owes no pause always runs, a later one only with time left', async () => {
    const holder: { h?: Harness } = {};
    const endpoint = fakeEndpoint(() => {
      // One request takes four seconds.
      holder.h!.advance(4000);
      return 1;
    });
    const h = (holder.h = harness({ fetch: endpoint.fetch }));
    // 4 s spent, a 1.5 s pause and an 8 s reserve do not fit in 10 s: one request, more to do.
    expect(await h.step(NOW, { budgetMs: 10_000 })).toMatchObject({ calls: 1, exhausted: false });
    expect(h.sleeps).toEqual([]);
    // Two seconds pass before the next fetch: no pause is owed, so its first request runs whatever the budget.
    h.advance(2000);
    expect(await h.step(NOW, { budgetMs: 0 })).toMatchObject({ calls: 1, exhausted: false });
    expect(h.sleeps).toEqual([]);
    // Leased again at once with a full budget: the owed pause first, then five requests.
    expect(await h.step(NOW, { budgetMs: 60_000 })).toMatchObject({ calls: 5, exhausted: false });
    expect(h.sleeps).toEqual([1500, 1500, 1500, 1500, 1500]);
    // Leased again at once with a budget that cannot hold the owed pause: nothing is asked, the cursor
    // stays where it was and the query is not leased again in this tick.
    const stored = h.cursor;
    const held = await h.step(NOW, { budgetMs: 5000 });
    expect(held).toMatchObject({ jobs: [], calls: 0, exhausted: true });
    expect(held.cursor).toBe(stored);
    expect(endpoint.calls.map((c) => c.city)).toEqual(TW_COUNTIES.slice(0, 7).map((c) => c.code));
  });

  it('an aborted run makes no request and does not spin', async () => {
    const endpoint = fakeEndpoint(() => 1);
    const controller = new AbortController();
    controller.abort();
    const h = harness({ fetch: endpoint.fetch });
    expect(await h.step(NOW, { signal: controller.signal })).toMatchObject({ jobs: [], calls: 0, exhausted: true });
    expect(endpoint.calls).toHaveLength(0);
  });

  it('JT-2: after a complete sweep it makes no request for 24 hours, then starts the next sweep', async () => {
    const endpoint = fakeEndpoint(() => 1);
    const h = harness({ fetch: endpoint.fetch, tables: SMALL });
    await h.drain(NOW);
    expect(endpoint.calls).toHaveLength(3);
    const stored = h.cursor;
    for (const minutes of [1, 30, 12 * 60, 24 * 60 - 1]) {
      const idle = await h.step(new Date(NOW.getTime() + minutes * 60_000));
      expect(idle, `${minutes} min`).toEqual({ jobs: [], calls: 0, exhausted: true });
    }
    expect(endpoint.calls).toHaveLength(3);
    expect(h.cursor).toBe(stored);
    const nextDay = new Date(NOW.getTime() + 24 * 3_600_000);
    const again = await h.drain(nextDay);
    expect(endpoint.calls).toHaveLength(6);
    expect(again.flatMap((r) => r.jobs)).toHaveLength(3);
    expect(parseTwSweepCursor(h.cursor)).toMatchObject({ sweepStartedAt: nextDay.toISOString(), lastCompleteSweepStartedAt: nextDay.toISOString(), prevSweepStartedAt: NOW.toISOString() });
  });

  it('TW_OPEN_DATA_SWEEP_HOURS moves the cadence', async () => {
    const endpoint = fakeEndpoint(() => 1);
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, env: { TW_OPEN_DATA_SWEEP_HOURS: '6' } });
    await h.drain(NOW);
    expect(await h.step(new Date(NOW.getTime() + 5 * 3_600_000))).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect((await h.step(new Date(NOW.getTime() + 6 * 3_600_000))).calls).toBeGreaterThan(0);
  });

  it('a request error ends the fetch, keeps the rows read so far and leaves the cursor where it was; the next fetch retries it', async () => {
    let fail = true;
    const endpoint = fakeEndpoint((c) => (c.city === '31' && fail ? { status: 503 } : 4));
    const warn = vi.fn();
    const { logger } = await import('../../../services/LoggerService.js');
    const spy = vi.spyOn(logger, 'warn').mockImplementation(warn);
    try {
      const h = harness({ fetch: endpoint.fetch, tables: SMALL });
      const first = await h.step(NOW);
      // Not an ingest error: ingest stores no cursor for one, and the strike would be lost.
      expect(first.error).toBeUndefined();
      expect(first).toMatchObject({ calls: 2, exhausted: true, notes: { tw_request_errors: 1 } });
      expect(first.jobs).toHaveLength(4);
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ county: 1, zip: null, jobno: null, errors: 1, incomplete: false });
      expect(warn).toHaveBeenCalledWith('JOB_SOURCES', 'tw_open_data request failed', expect.objectContaining({ error: 'http_503', city: '31', strikes: 1 }));
      fail = false;
      const second = await h.drain(new Date(NOW.getTime() + 30 * 60_000));
      expect(endpoint.calls.map(position)).toEqual(['01/-/-', '31/-/-', '31/-/-', '11/-/-']);
      expect(second.flatMap((r) => r.jobs)).toHaveLength(8);
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ county: 3, errors: 0, incomplete: false, lastCompleteSweepStartedAt: NOW.toISOString() });
    } finally {
      spy.mockRestore();
    }
  });

  it('three consecutive errors at one position mark the sweep incomplete and move on', async () => {
    const endpoint = fakeEndpoint((c) => (c.city === '31' ? { throws: new Error('ETIMEDOUT') } : 4));
    const { logger } = await import('../../../services/LoggerService.js');
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const h = harness({ fetch: endpoint.fetch, tables: SMALL });
      const a = await h.step(NOW);
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ county: 1, errors: 1, incomplete: false });
      const b = await h.step(NOW);
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ county: 1, errors: 2, incomplete: false });
      const c = await h.step(NOW);
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ county: 2, errors: 0, incomplete: true, counts: { skippedPositions: 1, errors: 3 } });
      expect([a, b, c].map((r) => [r.calls, r.exhausted, r.error])).toEqual([[2, true, undefined], [1, true, undefined], [1, true, undefined]]);
      expect(c.notes).toMatchObject({ tw_request_errors: 1, tw_skipped_position: 1 });
      const rest = await h.drain(NOW);
      expect(endpoint.calls.map(position)).toEqual(['01/-/-', '31/-/-', '31/-/-', '31/-/-', '11/-/-']);
      expect(rest.at(-1)).toMatchObject({ exhausted: true, notes: { tw_sweep_incomplete: 1 } });
      // An incomplete sweep is not the latest complete one and schedules no closure.
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ county: 3, incomplete: true, lastCompleteSweepStartedAt: null, close: null });
    } finally {
      spy.mockRestore();
    }
  });

  it('counts the rows it skips, by reason', async () => {
    const endpoint = fakeEndpoint((c) => (c.city === '01' ? { body: FIXTURE } : 0));
    const h = harness({ fetch: endpoint.fetch, tables: SMALL });
    const first = await h.step(NOW);
    expect(first.jobs).toHaveLength(6);
    expect(first.notes).toMatchObject({ no_external_id: 1, no_apply_url: 1 });
    expect(first.jobs.map((j) => j.externalId)).not.toContain('tw:9000004:');
  });

  it('never fetches for another market, and never throws', async () => {
    const endpoint = fakeEndpoint(() => 1);
    const adapter = createTwOpenDataAdapter({ env: {}, fetch: endpoint.fetch });
    expect(await adapter.fetch({ ...query(), market: 'cn' }, { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(endpoint.calls).toHaveLength(0);
    // A table that fails when a capped county asks for its districts: the bug is an error result, not a throw.
    const broken = createTwOpenDataAdapter({ env: {}, fetch: fakeEndpoint(() => 1000).fetch, tables: { counties: [{ code: '01', name: '台北市' }], districtsOf: () => { throw new Error('table unavailable'); }, majors: [] }, sleep: async () => undefined });
    const out = await broken.fetch(query(), { now: NOW });
    expect(out.jobs).toEqual([]);
    expect(out.error).toBe('tw_open_data:table unavailable');
  });
});

// ── Closure ─────────────────────────────────────────────────────────────────

interface StoredRow extends TwClosureRow {
  lastSeenAt: Date;
  archivedAt: Date | null;
  sourceBoard: string;
  market: string;
  visibility: string;
}

/** A fake of the one read the adapter makes; `writeSeen` plays ingest's upsert (lastSeenAt = now). */
function fakeDb(initial: StoredRow[] = []) {
  const rows = new Map(initial.map((r) => [r.externalId, r]));
  const reads: Array<Parameters<TwOpenDataDb['rAJob']['findMany']>[0]> = [];
  const db: TwOpenDataDb = {
    rAJob: {
      async findMany(args) {
        reads.push(args);
        return [...rows.values()]
          .filter((r) => r.sourceBoard === args.where.sourceBoard && r.market === args.where.market && r.visibility === args.where.visibility && r.archivedAt === null)
          .filter((r) => r.lastSeenAt.getTime() < args.where.lastSeenAt.lt.getTime() && (!args.where.id || r.id > args.where.id.gt))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, args.take)
          .map(({ id, externalId, location }) => ({ id, externalId, location }));
      },
    },
  };
  return {
    db,
    rows,
    reads,
    writeSeen(jobs: readonly ProviderJobInput[], now: Date) {
      for (const job of jobs) {
        const prior = rows.get(job.externalId);
        rows.set(job.externalId, { id: prior?.id ?? `id-${job.externalId}`, externalId: job.externalId, location: job.location ?? null, lastSeenAt: now, archivedAt: null, sourceBoard: 'tw_open_data', market: 'intl', visibility: 'public' });
      }
    },
    archive(externalIds: readonly string[], now: Date) {
      for (const id of externalIds) {
        const row = rows.get(id);
        if (row && row.archivedAt === null) row.archivedAt = now;
      }
    },
  };
}

/** Runs one whole sweep the way ingest does: write each fetch's rows, then apply its closures. */
async function sweep(h: Harness, store: ReturnType<typeof fakeDb>, now: Date): Promise<{ closed: string[]; results: SourceFetchResult[] }> {
  const closed: string[] = [];
  const results: SourceFetchResult[] = [];
  for (let i = 0; i < 500; i++) {
    const result = await h.step(now);
    results.push(result);
    store.writeSeen(result.jobs, now);
    if (result.closedExternalIds?.length) {
      expect(result.closeReason).toBe('source_removed');
      store.archive(result.closedExternalIds, now);
      closed.push(...result.closedExternalIds);
    }
    if (result.error || result.exhausted !== false) return { closed, results };
  }
  throw new Error('the sweep did not end');
}

const DAY = 24 * 3_600_000;
const day = (n: number) => new Date(NOW.getTime() + n * DAY);

describe('tw_open_data: closure after two complete sweeps without the row', () => {
  /** County 01 lists `ids` (in 台北市中山區); the other two counties list nothing. */
  const listing = (ids: () => number) => fakeEndpoint((c) => (c.city === '01' ? ids() : 0));

  it('JT-2: a row seen in sweep 1 and absent from complete sweeps 2 and 3 is closed at the end of sweep 3', async () => {
    let listed = 3;
    const endpoint = listing(() => listed);
    const store = fakeDb();
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db });

    const one = await sweep(h, store, day(0));
    expect(one.closed).toEqual([]);
    expect([...store.rows.keys()].sort()).toEqual(['tw:01xx:1', 'tw:01xx:2', 'tw:01xx:3']);
    // No complete sweep before the first: no closure read at all.
    expect(store.reads).toHaveLength(0);

    listed = 2; // tw:01xx:3 has left the source.
    const two = await sweep(h, store, day(1));
    // One complete sweep without it is not enough.
    expect(two.closed).toEqual([]);
    expect(store.reads).toHaveLength(1);
    expect(store.reads[0]!.where).toMatchObject({ sourceBoard: 'tw_open_data', market: 'intl', visibility: 'public', archivedAt: null, lastSeenAt: { lt: day(0) } });
    expect(store.reads[0]).toMatchObject({ select: { id: true, externalId: true, location: true }, orderBy: { id: 'asc' }, take: TW_OPEN_DATA_CLOSE_PAGE });

    const three = await sweep(h, store, day(2));
    expect(three.closed).toEqual(['tw:01xx:3']);
    expect(store.reads[1]!.where.lastSeenAt).toEqual({ lt: day(1) });
    // The closure is its own step: no request and no posting in it, after the sweep's rows were written.
    const closing = three.results.at(-1)!;
    expect(closing).toMatchObject({ jobs: [], calls: 0, exhausted: true, closeReason: 'source_removed', closedExternalIds: ['tw:01xx:3'] });
    expect(three.results.at(-2)).toMatchObject({ exhausted: false, notes: { tw_sweep_finished: 1 } });
    expect(parseTwSweepCursor(h.cursor)).toMatchObject({ close: null, lastCompleteSweepStartedAt: day(2).toISOString(), prevSweepStartedAt: day(1).toISOString() });
    // Rows still listed are open.
    expect([...store.rows.values()].filter((r) => r.archivedAt === null).map((r) => r.externalId).sort()).toEqual(['tw:01xx:1', 'tw:01xx:2']);
  });

  it('JT-2: nothing is closed when sweep 3 was incomplete', async () => {
    let listed = 3;
    let broken = false;
    const endpoint = fakeEndpoint((c) => (c.city === '01' ? listed : c.city === '31' && broken ? { status: 500 } : 0));
    const { logger } = await import('../../../services/LoggerService.js');
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const store = fakeDb();
      const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db });
      await sweep(h, store, day(0));
      listed = 2;
      await sweep(h, store, day(1));
      const readsBefore = store.reads.length;
      broken = true;
      // Sweep 3: county 31 fails three times and is given up. Each failure ends a fetch.
      let last: SourceFetchResult | undefined;
      for (let i = 0; i < 6; i++) {
        const result = await h.step(day(2));
        store.writeSeen(result.jobs, day(2));
        expect(result.closedExternalIds ?? []).toEqual([]);
        last = result;
        const at = parseTwSweepCursor(h.cursor);
        if (at.sweepStartedAt === day(2).toISOString() && twSweepFinished(at, SMALL)) break;
      }
      expect(last).toMatchObject({ exhausted: true, notes: { tw_sweep_incomplete: 1 } });
      expect(parseTwSweepCursor(h.cursor)).toMatchObject({ incomplete: true, close: null, lastCompleteSweepStartedAt: day(1).toISOString() });
      expect(store.reads).toHaveLength(readsBefore);
      expect(store.rows.get('tw:01xx:3')!.archivedAt).toBeNull();

      // The next complete sweep closes it: complete sweeps 2 and 4 both lacked it.
      broken = false;
      const four = await sweep(h, store, day(3));
      expect(four.closed).toEqual(['tw:01xx:3']);
    } finally {
      spy.mockRestore();
    }
  });

  it('a row that comes back is seen again and is not closed', async () => {
    let listed = 3;
    const endpoint = listing(() => listed);
    const store = fakeDb();
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db });
    await sweep(h, store, day(0));
    listed = 2;
    await sweep(h, store, day(1));
    listed = 3; // Back in the listing in sweep 3.
    expect((await sweep(h, store, day(2))).closed).toEqual([]);
    listed = 2;
    expect((await sweep(h, store, day(3))).closed).toEqual([]);
    expect((await sweep(h, store, day(4))).closed).toEqual(['tw:01xx:3']);
  });

  it('only open public rows of this board in the international market are candidates', async () => {
    const old = day(-10);
    const row = (externalId: string, over: Partial<StoredRow> = {}): StoredRow => ({ id: `id-${externalId}`, externalId, location: '台北市中山區', lastSeenAt: old, archivedAt: null, sourceBoard: 'tw_open_data', market: 'intl', visibility: 'public', ...over });
    const store = fakeDb([
      row('tw:1:1'),
      row('tw:1:2', { archivedAt: old }),
      row('tw:1:3', { visibility: 'private' }),
      row('tw:1:4', { market: 'cn' }),
      row('gh:acme:5', { sourceBoard: 'greenhouse' }),
      row('tw:1:6', { lastSeenAt: day(0) }),
    ]);
    const endpoint = fakeEndpoint(() => 0);
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db });
    await sweep(h, store, day(0));
    expect((await sweep(h, store, day(1))).closed).toEqual(['tw:1:1']);
  });

  it('absence proves a row gone only when the county it displays was read whole in both sweeps', async () => {
    // A county whose own answer hit the cap proves nothing about its rows, whatever district they display.
    expect(twAbsenceProven('台北市中山區', new Set(['01']))).toBe(false);
    expect(twAbsenceProven('臺北市士林區', new Set(['01']))).toBe(false);
    expect(twAbsenceProven('台北市不限', new Set(['01']))).toBe(false);
    expect(twAbsenceProven('台北市某某區', new Set(['01']))).toBe(false);
    // A county read whole proves the absence of every row that displays it.
    expect(twAbsenceProven('台北市不限', new Set())).toBe(true);
    expect(twAbsenceProven('台北市中山區', new Set())).toBe(true);
    expect(twAbsenceProven('基隆市不限', new Set(['01']))).toBe(true);
    expect(twAbsenceProven('新北市板橋區', new Set(['01']))).toBe(true);
    // A place that names no county proves nothing.
    for (const place of [null, '', 'Taipei', '不限']) expect(twAbsenceProven(place, new Set()), String(place)).toBe(false);

    const old = day(-10);
    const row = (externalId: string, location: string): StoredRow => ({ id: `id-${externalId}`, externalId, location, lastSeenAt: old, archivedAt: null, sourceBoard: 'tw_open_data', market: 'intl', visibility: 'public' });
    const store = fakeDb([row('tw:9:1', '台北市不限'), row('tw:9:2', '台北市中山區'), row('tw:9:3', '新北市不限'), row('tw:9:4', '基隆市不限')]);
    // County 01 is at the cap in both sweeps; 31 and 11 are read whole.
    const endpoint = fakeEndpoint((c) => (c.city === '01' && !c.zipno ? 1000 : 0));
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db, env: { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    await h.drain(day(0));
    const results = await h.drain(day(1));
    const closing = results.at(-1)!;
    expect([...(closing.closedExternalIds ?? [])].sort()).toEqual(['tw:9:3', 'tw:9:4']);
    expect(closing.notes).toEqual({ tw_absence_unproven: 2 });
    expect(store.reads.at(-1)!.where.lastSeenAt).toEqual({ lt: day(0) });
  });

  it('a row its district request does not return, in a capped county, is not closed while it is still listed', async () => {
    // What the live endpoint does: `zipno` does not select on the district a row displays. X displays
    // 台北市大同區 (postal code 103) and no district request returns it; only the county's own answer does.
    const x: Posting = { employer: '8500', hire: 1, city: '01', zip: null, major: '02', place: '台北市大同區' };
    const gone: Posting = { employer: '8600', hire: 1, city: '31', zip: '220', major: '01', place: '新北市板橋區' };
    const taipei = postings(1100, '8100', { city: '01', zip: '103', major: '01', place: '台北市大同區' });
    let listing: Posting[] = [x, ...taipei, gone];
    const endpoint = listingEndpoint(() => listing);
    const store = fakeDb();
    // The second walk is off here: it would read X again by 大類 (the test above), and this test is about
    // a row that no request of a sweep returns.
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db, env: { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });

    // Sweep 1: X is among the county's first 1,000 rows and is stored. The 大同區 answer (103) does not hold it.
    const one = await sweep(h, store, day(0));
    expect(store.rows.has('tw:8500:1')).toBe(true);
    expect(endpoint.calls.filter((c) => c.zipno === '103' && !c.jobno)).toHaveLength(1);
    expect(one.results.some((r) => r.notes?.tw_county_only === 1)).toBe(true);

    // Sweeps 2 and 3: X is STILL LISTED, but beyond the county's first 1,000 rows, so no request returns it.
    // A posting of a county read whole really leaves the source.
    listing = [...taipei, x];
    expect((await sweep(h, store, day(1))).closed).toEqual([]);
    const three = await sweep(h, store, day(2));
    expect(parseTwSweepCursor(h.cursor)).toMatchObject({ incomplete: true });
    // The 大同區 answer was itself at the cap and its 大類 leaf too, so these sweeps were incomplete and close nothing.
    expect(three.closed).toEqual([]);

    // The same with every split under the cap, so that both sweeps are complete and a closure runs.
    const small = postings(1100, '8100', { city: '01', zip: '103', major: '01', place: '台北市大同區' }).map((p, i) => ({ ...p, zip: i < 550 ? '103' : '104' }));
    const store2 = fakeDb();
    listing = [x, ...small, gone];
    const endpoint2 = listingEndpoint(() => listing);
    const h2 = harness({ fetch: endpoint2.fetch, tables: SMALL, db: () => store2.db, env: { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    await sweep(h2, store2, day(0));
    expect(parseTwSweepCursor(h2.cursor)).toMatchObject({ incomplete: false, partial: ['01'] });
    expect(store2.rows.has('tw:8500:1')).toBe(true);
    listing = [...small, x];
    expect((await sweep(h2, store2, day(1))).closed).toEqual([]);
    const last = await sweep(h2, store2, day(2));
    // X displays a district of the table, was absent from two complete sweeps, and is not closed: its county
    // was not read whole. The posting that left a county read whole is closed in the same step.
    expect(last.closed).toEqual(['tw:8600:1']);
    expect(last.results.at(-1)).toMatchObject({ closedExternalIds: ['tw:8600:1'], notes: { tw_absence_unproven: 1 } });
    expect(store2.rows.get('tw:8500:1')!.archivedAt).toBeNull();
  });

  it('a county at the cap in only one of the two sweeps still does not close its rows', async () => {
    const old = day(-10);
    const store = fakeDb([{ id: 'id-1', externalId: 'tw:9:1', location: '台北市中山區', lastSeenAt: old, archivedAt: null, sourceBoard: 'tw_open_data', market: 'intl', visibility: 'public' }]);
    let capped = true;
    const endpoint = fakeEndpoint((c) => (c.city === '01' && !c.zipno ? (capped ? 1000 : 0) : 0));
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db, env: { ...NO_SECOND_WALK, TW_OPEN_DATA_REQUESTS_PER_FETCH: '50' } });
    await h.drain(day(0));
    capped = false;
    const second = await h.drain(day(1));
    expect(second.at(-1)!.closedExternalIds).toEqual([]);
    expect(second.at(-1)!.notes).toEqual({ tw_absence_unproven: 1 });
    // Two sweeps that both read the county whole do prove it.
    const third = await h.drain(day(2));
    expect(third.at(-1)!.closedExternalIds).toEqual(['tw:9:1']);
  });

  it('closes at most one page per step and continues where it stopped', async () => {
    const old = day(-10);
    const many: StoredRow[] = Array.from({ length: TW_OPEN_DATA_CLOSE_PAGE + 3 }, (_, i) => ({
      id: `id-${String(i).padStart(6, '0')}`,
      externalId: `tw:7:${i}`,
      location: '高雄市前鎮區',
      lastSeenAt: old,
      archivedAt: null,
      sourceBoard: 'tw_open_data',
      market: 'intl',
      visibility: 'public',
    }));
    const store = fakeDb(many);
    const endpoint = fakeEndpoint(() => 0);
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db: () => store.db });
    await h.drain(day(0));
    const results = await h.drain(day(1));
    const closing = results.filter((r) => r.closedExternalIds);
    expect(closing.map((r) => [r.closedExternalIds!.length, r.exhausted, r.calls])).toEqual([[TW_OPEN_DATA_CLOSE_PAGE, false, 0], [3, true, 0]]);
    expect(store.reads.at(-1)!.where.id).toEqual({ gt: `id-${String(TW_OPEN_DATA_CLOSE_PAGE - 1).padStart(6, '0')}` });
    expect(new Set(closing.flatMap((r) => r.closedExternalIds!)).size).toBe(TW_OPEN_DATA_CLOSE_PAGE + 3);
    expect(parseTwSweepCursor(h.cursor).close).toBeNull();
  });

  it('a failed closure read is an error result; the closure stays scheduled and runs on the next lease', async () => {
    const old = day(-10);
    const store = fakeDb([{ id: 'id-1', externalId: 'tw:8:1', location: '台北市中山區', lastSeenAt: old, archivedAt: null, sourceBoard: 'tw_open_data', market: 'intl', visibility: 'public' }]);
    let down = true;
    const db = (): TwOpenDataDb => {
      if (down) throw new Error('connection refused');
      return store.db;
    };
    const endpoint = fakeEndpoint(() => 0);
    const h = harness({ fetch: endpoint.fetch, tables: SMALL, db });
    await h.drain(day(0));
    const results = await h.drain(day(1));
    expect(results.at(-1)).toEqual({ jobs: [], calls: 0, error: 'tw_open_data_closure:connection refused' });
    expect(parseTwSweepCursor(h.cursor).close).toEqual({ before: day(0).toISOString(), afterId: null, partial: [] });
    const callsBefore = endpoint.calls.length;
    down = false;
    const retry = await h.step(new Date(day(1).getTime() + 3_600_000));
    expect(retry).toMatchObject({ calls: 0, exhausted: true, closedExternalIds: ['tw:8:1'], closeReason: 'source_removed' });
    expect(endpoint.calls).toHaveLength(callsBefore);
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe('tw_open_data: registration', () => {
  it('importing marketHooks registers the adapter once', () => {
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toContain('tw_sources');
    expect(getSourceAdapter('tw_open_data')).toBe(twOpenDataAdapter);
    ensureTwOpenDataAdapter();
    ensureTwOpenDataAdapter();
    expect(registeredSourceAdapters().filter((a) => a.provider === 'tw_open_data')).toEqual([twOpenDataAdapter]);
  });

  it('JT-2: RoboApply\'s ingest has the adapter and GoApply\'s never does', () => {
    const robo = adaptersForBrand(getBrand('roboapply'), {});
    expect(robo.map((a) => a.provider)).toContain('tw_open_data');
    expect(robo.filter((a) => a.provider === 'tw_open_data')).toEqual([twOpenDataAdapter]);
    const go = adaptersForBrand(getBrand('goapply'), {});
    expect(go.map((a) => a.provider)).not.toContain('tw_open_data');
    // Whatever a list says, an adapter of another market is never handed to GoApply.
    expect(adaptersForBrand(getBrand('goapply'), { JOB_PROVIDERS_GOAPPLY: 'tw_open_data,bank_gohire' }).map((a) => a.provider)).not.toContain('tw_open_data');
    // RoboApply can narrow it away like any other source.
    expect(adaptersForBrand(getBrand('roboapply'), { JOB_PROVIDERS_ROBOAPPLY: 'bank_robohire' }).map((a) => a.provider)).not.toContain('tw_open_data');
  });
});
