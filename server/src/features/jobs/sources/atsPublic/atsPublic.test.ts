// @vitest-environment node
//
// WP-42: public ATS connectors (contract tests against the documented-shape
// fixtures in __fixtures__/, plus any live recordings made with
// __fixtures__/record.ts), the `ats_public` ingest adapter, the Taiwan
// market hooks (sourceName, permit tags with quotes, card meta) and the
// RapidAPI country=tw planner seam. No network, no database.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrand } from '../../../../platform/brand/index.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { MARKET_HOOK_SETS, afterEnrich as marketAfterEnrich, afterNormalize, cardMeta } from '../../marketHooks.js';
import { normalizeProviderJob, asMarketHookJob, type ProviderJobInput } from '../../normalize/index.js';
import { createRapidApiAdapter, rapidApiSearchParams } from '../../ingest/adapters/rapidApi.js';
import { planQueries, tuplesFromFilters } from '../../ingest/planner.js';
import { adaptersForBrand } from '../../ingest/providers.js';
import { getSourceAdapter } from '../index.js';
import { CareerSourceBodySchema, PUBLIC_ATS_NAMES, type TwCardMeta } from './contract.js';
import { ashby, CONNECTORS, greenhouse, lever, prioritise, smartrecruiters, SR_MAX_DETAILS, type BoardSource } from './connectors.js';
import { createAtsPublicAdapter } from './adapter.js';
import { API_HOSTS, assertApiHost, BoardFetchError, getJson, type FetchLike } from './http.js';
import { createAtsPublicHooks, isTaiwanJob, mergePermitTags, twCardMeta, twNegotiableCardText, withAtsSourceName } from './hooks.js';
import { extractPermitTags, MAX_QUOTE_CHARS, quoteInPosting } from './permitTags.js';
import { atsSourceName, decodeEntities, externalIdFor } from './shared.js';
import { dueCareerSources, readCareerSource } from './sync.js';
import { atsPublicAdapter } from './register.js';
import { twOpenDataEnabled, twOpenDataStatus, TW_OPEN_DATA_ATTRIBUTION } from '../twOpenData.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(HERE, '__fixtures__', name), 'utf8'));
const NOW = new Date('2026-10-10T00:00:00.000Z');

/** A fetch that answers from a URL → body table; anything else is a 404. */
function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url === prefix || url.startsWith(`${prefix}?`) || url.startsWith(`${prefix}&`));
    if (!hit) return { ok: false, status: 404, text: async () => '{"error":"not found"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) };
  };
}

const GH: BoardSource = { ats: 'greenhouse', boardToken: 'formosarobotics', companyName: 'Formosa Robotics', countryCode: 'TW' };
const LV: BoardSource = { ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countryCode: null };
const AB: BoardSource = { ats: 'ashby', boardToken: 'islandlabs', companyName: 'Island Labs', countryCode: 'TW' };
const SR: BoardSource = { ats: 'smartrecruiters', boardToken: 'HarborFoods', companyName: 'Harbor Foods', countryCode: 'TW' };

function normalize(input: ProviderJobInput) {
  return normalizeProviderJob(input, 'ats_public', { market: 'intl', now: NOW });
}

// ── Connectors ───────────────────────────────────────────────────────────

describe('connector contract: Greenhouse', () => {
  it('reads boards-api …/jobs?content=true and maps every posting', async () => {
    const calls: string[] = [];
    const read = await greenhouse.read(GH, { now: NOW, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': fixture('greenhouse.json') }, calls) });
    expect(calls).toEqual(['https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs?content=true']);
    expect(read.calls).toBe(1);
    expect(read.complete).toBe(true);
    expect(read.listedIds).toEqual(['formosarobotics:4012345', 'formosarobotics:4012399']);
    const [first] = read.inputs;
    expect(first).toMatchObject({
      externalId: 'formosarobotics:4012345',
      sourceBoard: 'greenhouse',
      title: 'Backend Engineer',
      company: 'Formosa Robotics',
      sourcePublisher: 'Formosa Robotics · Greenhouse',
      applyUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345',
      sourceUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345',
      location: 'Taipei, Taiwan',
      postedAt: '2026-09-20T02:00:00-04:00',
      postedAtEstimated: false,
      locationCountry: 'TW',
      locationCountryEstimated: true,
    });
    // Escaped content is decoded one level: real HTML, entities inside it kept.
    expect(first!.descriptionHtml).toContain('<p>待遇面議（經常性薪資達4萬元或以上）。</p>');
    expect(first!.descriptionHtml).toContain('PostgreSQL &amp; Kubernetes');
    // updated_at is not a posting date.
    expect(read.inputs[1]).toMatchObject({ postedAt: null, postedAtEstimated: true });
  });

  it('normalizes with provider ats_public: sourceName = company + ATS, sourceBoard = the ATS, 面議 kept verbatim and not disclosed', async () => {
    const read = await greenhouse.read(GH, { now: NOW, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': fixture('greenhouse.json') }) });
    const job = normalize(read.inputs[0]!);
    expect(job).toMatchObject({
      provider: 'ats_public',
      sourceBoard: 'greenhouse',
      sourceName: 'Formosa Robotics · Greenhouse',
      originalSourceName: null,
      locationCountry: 'TW',
      salaryDisclosed: false,
      salaryMin: null,
      salaryMax: null,
      atsType: 'greenhouse',
    });
    expect(job.salaryText).toContain('面議');
    const firmware = normalize(read.inputs[1]!);
    expect(firmware.locationCountry).toBe('TW'); // Hsinchu resolves inside the board's country hint
    expect(firmware).toMatchObject({ salaryDisclosed: true, salaryMin: 55000, salaryMax: 75000, salaryCurrency: 'TWD', salaryPeriod: 'month' });
  });

  it('fails the board (no closures) on a 404 or an unexpected shape', async () => {
    await expect(greenhouse.read(GH, { now: NOW, fetch: fakeFetch({}) })).rejects.toThrow('board_not_found');
    await expect(
      greenhouse.read(GH, { now: NOW, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': { nope: true } }) }),
    ).rejects.toThrow('unexpected_shape');
  });
});

describe('connector contract: Lever', () => {
  it('reads api.lever.co/v0/postings/{site}?mode=json with skip/limit paging', async () => {
    const calls: string[] = [];
    const read = await lever.read(LV, { now: NOW, fetch: fakeFetch({ 'https://api.lever.co/v0/postings/pinecloud': fixture('lever.json') }, calls) });
    expect(calls).toEqual(['https://api.lever.co/v0/postings/pinecloud?mode=json&skip=0&limit=100']);
    expect(read.complete).toBe(true);
    expect(read.inputs).toHaveLength(2);
    expect(read.inputs[0]).toMatchObject({
      externalId: 'pinecloud:5f1e2d3c-0000-4a4a-9b9b-111111111111',
      sourceBoard: 'lever',
      applyUrl: 'https://jobs.lever.co/pinecloud/5f1e2d3c-0000-4a4a-9b9b-111111111111/apply',
      sourceUrl: 'https://jobs.lever.co/pinecloud/5f1e2d3c-0000-4a4a-9b9b-111111111111',
      locationCountry: 'TW',
      locationCountryEstimated: false,
      workModel: 'hybrid',
      employmentType: 'Full-time',
      salaryMin: 60000,
      salaryMax: 90000,
      salaryCurrency: 'TWD',
      salaryPeriod: 'per-month-salary',
      postedAt: new Date(1758844800000).toISOString(),
    });
    expect(read.inputs[0]!.descriptionHtml).toContain('<h3>Requirements</h3><ul><li>3+ years of product design</li>');
    expect(read.inputs[1]).toMatchObject({ workModel: null, locationCountry: 'SG' });
    const job = normalize(read.inputs[0]!);
    expect(job).toMatchObject({ workModel: 'hybrid', employmentType: 'full_time', salaryPeriod: 'month', salaryDisclosed: true, sourceName: 'Pine Cloud · Lever' });
  });

  it('pages until a short page and marks a capped listing incomplete', async () => {
    const page = (n: number, offset: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${offset + i}`, text: `Role ${offset + i}`, hostedUrl: `https://jobs.lever.co/pinecloud/id-${offset + i}` }));
    const full: FetchLike = async (url) => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      return { ok: true, status: 200, text: async () => JSON.stringify(page(100, skip)) };
    };
    const capped = await lever.read(LV, { now: NOW, fetch: full });
    expect(capped.complete).toBe(false);
    expect(capped.calls).toBe(5);
    expect(capped.inputs).toHaveLength(500);
  });
});

describe('connector contract: Ashby', () => {
  it('reads the posting API with compensation, skips unlisted jobs, hides pay the employer hides', async () => {
    const calls: string[] = [];
    const read = await ashby.read(AB, { now: NOW, fetch: fakeFetch({ 'https://api.ashbyhq.com/posting-api/job-board/islandlabs': fixture('ashby.json') }, calls) });
    expect(calls).toEqual(['https://api.ashbyhq.com/posting-api/job-board/islandlabs?includeCompensation=true']);
    expect(read.listedIds).toEqual(['islandlabs:a1b2c3d4-1111-2222-3333-444455556666', 'islandlabs:a1b2c3d4-1111-2222-3333-777788889999']);
    const [analyst, staff] = read.inputs;
    expect(analyst).toMatchObject({
      sourceBoard: 'ashby',
      locationCountry: 'TW',
      locationCountryEstimated: false,
      locationCity: 'Taipei',
      workModel: 'OnSite',
      employmentType: 'FullTime',
      salaryMin: null,
      salaryMax: null,
      salaryText: null,
      applyUrl: 'https://jobs.ashbyhq.com/islandlabs/a1b2c3d4-1111-2222-3333-444455556666/application',
    });
    expect(staff).toMatchObject({ workModel: 'remote', salaryMin: 180000, salaryMax: 220000, salaryCurrency: 'USD', salaryPeriod: '1 YEAR', salaryText: 'US$180K – US$220K' });
    // The board's TW tag is only a weak hint: a remote job is not placed in Taiwan by it.
    expect(normalize(staff!).workModel).toBe('remote');
    const job = normalize(analyst!);
    expect(job).toMatchObject({ workModel: 'onsite', employmentType: 'full_time', salaryDisclosed: false });
    expect(job.salaryText).toContain('依公司規定');
  });
});

describe('connector contract: SmartRecruiters', () => {
  it('lists postings, reads each posting text, and skips a posting whose text failed (still listed)', async () => {
    const detail = fixture('smartrecruiters-detail.json') as Record<string, unknown>;
    const calls: string[] = [];
    const routes: Record<string, unknown> = {
      'https://api.smartrecruiters.com/v1/companies/HarborFoods/postings': fixture('smartrecruiters-list.json'),
      'https://api.smartrecruiters.com/v1/companies/HarborFoods/postings/744000098765432': detail['744000098765432'],
    };
    const read = await smartrecruiters.read(SR, { now: NOW, fetch: fakeFetch(routes, calls) });
    expect(calls[0]).toBe('https://api.smartrecruiters.com/v1/companies/HarborFoods/postings?limit=100&offset=0');
    expect(read.calls).toBe(3);
    expect(read.complete).toBe(true);
    expect(read.listedIds).toEqual(['HarborFoods:744000098765432', 'HarborFoods:744000098765433']);
    expect(read.inputs).toHaveLength(1);
    expect(read.inputs[0]).toMatchObject({
      externalId: 'HarborFoods:744000098765432',
      sourceBoard: 'smartrecruiters',
      sourceUrl: 'https://jobs.smartrecruiters.com/HarborFoods/744000098765432-sales-representative',
      locationCountry: 'TW',
      locationCity: 'Taichung',
      employmentType: 'Full-time',
      seniority: 'Entry Level',
      postedAt: '2026-09-25T08:00:00.000Z',
    });
    const job = normalize(read.inputs[0]!);
    expect(job).toMatchObject({ salaryDisclosed: true, salaryMin: 32000, salaryMax: 38000, salaryPeriod: 'month', sourceName: 'Harbor Foods · SmartRecruiters' });
    expect(SR_MAX_DETAILS).toBeGreaterThan(0);
  });

  it('listOnly reads the listing and no posting texts', async () => {
    const calls: string[] = [];
    const routes = { 'https://api.smartrecruiters.com/v1/companies/HarborFoods/postings': fixture('smartrecruiters-list.json') };
    const read = await smartrecruiters.read(SR, { now: NOW, fetch: fakeFetch(routes, calls) }, { listOnly: true });
    expect(calls).toEqual(['https://api.smartrecruiters.com/v1/companies/HarborFoods/postings?limit=100&offset=0']);
    expect(read).toMatchObject({ inputs: [], listedIds: ['HarborFoods:744000098765432', 'HarborFoods:744000098765433'], calls: 1 });
  });

  it('a board with more than SR_MAX_DETAILS postings is covered in full over runs (new first, then longest-unrefreshed)', async () => {
    const TOTAL = 250;
    const ids = Array.from({ length: TOTAL }, (_, i) => `p${String(i).padStart(3, '0')}`);
    const posting = (id: string) => ({ id, name: `Role ${id}`, location: { city: 'Taipei', country: 'tw' }, releasedDate: '2026-10-01T00:00:00.000Z' });
    const detailed: string[] = [];
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      const m = /\/postings\/([^/?]+)$/.exec(u.pathname);
      if (m) {
        detailed.push(m[1]!);
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: m[1], jobAd: { sections: { jobDescription: { text: '<p>x</p>' } } } }) };
      }
      const offset = Number(u.searchParams.get('offset'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ totalFound: TOTAL, content: ids.slice(offset, offset + 100).map(posting) }) };
    };
    // Ingest saves what a run returns (lastSeenAt = that run's time).
    const known = new Map<string, Date | null>();
    const covered = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      detailed.length = 0;
      const at = new Date(NOW.getTime() + run * 3_600_000);
      const read = await smartrecruiters.read(SR, { now: at, fetch }, { known });
      expect(read.listedIds).toHaveLength(TOTAL);
      expect(detailed.length).toBeLessThanOrEqual(SR_MAX_DETAILS);
      for (const input of read.inputs) {
        known.set(input.externalId, at);
        covered.add(input.externalId);
      }
      if (run === 0) expect(read.inputs[0]!.externalId).toBe('HarborFoods:p000');
      if (run === 1) expect(read.inputs.map((i) => i.externalId)).toContain('HarborFoods:p199');
      // Run 3: the last 50 new postings, then the 50 refreshed longest ago.
      if (run === 2) expect(read.inputs.map((i) => i.externalId).slice(49, 51)).toEqual(['HarborFoods:p249', 'HarborFoods:p000']);
    }
    expect(covered.size).toBe(TOTAL);
  });

  it('prioritise: unknown postings first, then oldest refresh, capped', () => {
    const known = new Map<string, Date | null>([
      ['a', new Date('2026-10-09T00:00:00Z')],
      ['b', null],
      ['d', new Date('2026-10-01T00:00:00Z')],
    ]);
    expect(prioritise(['a', 'b', 'c', 'd', 'e'], (x) => x, known, 4)).toEqual(['c', 'e', 'b', 'd']);
    expect(prioritise(['a', 'b'], (x) => x, undefined, 1)).toEqual(['a']);
    expect(prioritise(['a', 'c'], (x) => x, known, 5)).toEqual(['a', 'c']);
  });
});

// Recorded responses (__fixtures__/record.ts writes <vendor>.recorded.json and
// recorded-meta.json; run by OPS/INT with network access). Each recording is
// checked against the connector's contract: every listed posting maps, and
// the fields the feed relies on come out of the real response shape.
describe('connector contract: recorded responses', () => {
  const metaPath = join(HERE, '__fixtures__', 'recorded-meta.json');
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, { boardToken: string }>) : {};
  for (const vendor of ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const) {
    const file = join(HERE, '__fixtures__', `${vendor}.recorded.json`);
    const token = meta[vendor]?.boardToken;
    if (!existsSync(file) || !token) {
      it.todo(`${vendor}: no recorded response yet (OPS: run __fixtures__/record.ts --${vendor} <public board>)`);
      continue;
    }
    it(`${vendor}: the recorded response maps through the connector`, async () => {
      const body = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & unknown[];
      const src: BoardSource = { ats: vendor, boardToken: token, companyName: 'Recorded Co', countryCode: null };
      const connector = CONNECTORS[vendor];
      const fetch: FetchLike = async (url) => {
        let answer: unknown;
        if (vendor === 'smartrecruiters') {
          const detail = /\/postings\/([^/?]+)$/.exec(new URL(url).pathname);
          answer = detail ? (body.details as Record<string, unknown>)[decodeURIComponent(detail[1]!)] : body.list;
        } else if (vendor === 'lever') {
          answer = new URL(url).searchParams.get('skip') === '0' ? body : [];
        } else {
          answer = body;
        }
        return answer === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => JSON.stringify(answer) };
      };
      const read = await connector.read(src, { now: NOW, fetch });
      expect(read.listedIds.length).toBeGreaterThan(0);
      expect(read.inputs.length).toBe(read.listedIds.length);
      for (const input of read.inputs) {
        expect(input.externalId.startsWith(`${token}:`)).toBe(true);
        expect(input.title).toBeTruthy();
        expect(input.sourceBoard).toBe(vendor);
        expect(input.applyUrl ?? input.sourceUrl).toMatch(/^https:\/\//);
        expect(input.descriptionHtml ?? input.description).toBeTruthy();
        expect(normalize(input).sourceName).toBe(`Recorded Co · ${PUBLIC_ATS_NAMES[vendor]}`);
      }
    });
  }
});

describe('outbound HTTP rules (no scraping)', () => {
  it('only the four documented API hosts over https', () => {
    expect([...API_HOSTS]).toEqual(['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', 'api.smartrecruiters.com']);
    for (const url of [
      'https://www.104.com.tw/jobs/search/',
      'https://www.1111.com.tw/',
      'https://www.cake.me/jobs',
      'https://www.yourator.co/jobs',
      'https://acme.wd5.myworkdayjobs.com/en-US/careers',
      'https://www.linkedin.com/jobs',
      'http://boards-api.greenhouse.io/v1/boards/x/jobs',
    ]) {
      expect(() => assertApiHost(url), url).toThrow(BoardFetchError);
    }
    for (const c of Object.values(CONNECTORS)) expect(() => assertApiHost(c.boardUrl('token'))).not.toThrow();
  });

  it('never follows a redirect off the allowed host', async () => {
    const inits: unknown[] = [];
    const redirecting: FetchLike = async (_url, init) => {
      inits.push(init);
      return { ok: false, status: 302, text: async () => '' };
    };
    await expect(getJson('https://boards-api.greenhouse.io/v1/boards/x/jobs', { fetch: redirecting })).rejects.toMatchObject({ message: 'redirect', status: 302 });
    expect(inits[0]).toMatchObject({ redirect: 'error' });
    const undiciStyle: FetchLike = async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    };
    await expect(getJson('https://api.lever.co/v0/postings/x?mode=json', { fetch: undiciStyle })).rejects.toMatchObject({ message: 'redirect' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(getJson('https://api.lever.co/v0/postings/x?mode=json', { fetch: redirecting, signal: aborted.signal })).rejects.toMatchObject({ message: 'timeout' });
  });

  it('no connector source names a job-board site or Workday', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const banned = /104\.com\.tw|1111\.com\.tw|cake\.me|yourator\.co|myworkdayjobs|workday\.com|linkedin\.com\/jobs|indeed\.com/i;
    for (const f of files) expect(readFileSync(join(HERE, f), 'utf8'), f).not.toMatch(banned);
  });

  it('Workday cannot be added as a source', () => {
    expect(CareerSourceBodySchema.safeParse({ ats: 'workday', boardToken: 'acme', companyName: 'Acme' }).success).toBe(false);
    expect(CareerSourceBodySchema.safeParse({ ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme' }).success).toBe(true);
    expect(CareerSourceBodySchema.safeParse({ ats: 'greenhouse', boardToken: '../etc', companyName: 'Acme' }).success).toBe(false);
  });

  it('getJson maps timeouts, bad JSON and HTTP errors to BoardFetchError', async () => {
    const url = 'https://api.lever.co/v0/postings/x?mode=json';
    await expect(getJson(url, { fetch: async () => ({ ok: true, status: 200, text: async () => 'not json' }) })).rejects.toThrow('not_json');
    await expect(getJson(url, { fetch: async () => ({ ok: false, status: 500, text: async () => '' }) })).rejects.toThrow('http_500');
    const hang: FetchLike = (_u, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(getJson(url, { fetch: hang, timeoutMs: 5 })).rejects.toThrow('timeout');
  });
});

describe('helpers', () => {
  it('sourceName, external ids and entity decoding', () => {
    expect(atsSourceName('Appier', 'greenhouse')).toBe('Appier · Greenhouse');
    expect(atsSourceName('  ', 'lever')).toBe('Lever');
    expect(externalIdFor('acme', 12)).toBe('acme:12');
    expect(decodeEntities('&lt;b&gt;A &amp;amp; B&#39;s &#x4E2D;&nbsp;&bogus;')).toBe("<b>A &amp; B's 中 &bogus;");
  });
});

// ── The ingest adapter ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
function source(over: Row = {}): Row {
  return {
    id: 'cs1',
    market: 'intl',
    ats: 'greenhouse',
    boardToken: 'formosarobotics',
    companyName: 'Formosa Robotics',
    companyId: null,
    countryCode: 'TW',
    enabled: true,
    lastSyncedAt: null,
    lastJobCount: null,
    lastError: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

const GH_ROUTE = { 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': fixture('greenhouse.json') };
const QUERY = { id: 'q1', provider: 'ats_public' as const, market: 'intl' as const, origin: 'bank_sync' as const, params: { q: '', country: '*', datePosted: 'all' } };

describe('ats_public adapter', () => {
  it('is registered for RoboApply only, as a cursor source, unmetered, with a kill switch', () => {
    expect(getSourceAdapter('ats_public')).toBe(atsPublicAdapter);
    expect(atsPublicAdapter).toMatchObject({ provider: 'ats_public', kind: 'cursor', markets: ['intl'], sourceBoards: ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] });
    expect(atsPublicAdapter.dailyCallLimit()).toBeNull();
    expect(createAtsPublicAdapter({ env: {} }).isEnabled()).toBe(true);
    expect(createAtsPublicAdapter({ env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' } }).isEnabled()).toBe(false);
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toContain('ats_public');
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).not.toContain('ats_public');
  });

  it('reads due boards, stamps them, and reports postings the board no longer lists', async () => {
    const db = createFakePrisma({
      seed: {
        rACareerSiteSource: [source(), source({ id: 'cs2', boardToken: 'fresh', lastSyncedAt: new Date('2026-10-09T23:00:00Z') }), source({ id: 'cs3', enabled: false, boardToken: 'off' })],
        rAJob: [
          { id: 'j1', sourceBoard: 'greenhouse', externalId: 'formosarobotics:4012345', archivedAt: null, visibility: 'public' },
          { id: 'j2', sourceBoard: 'greenhouse', externalId: 'formosarobotics:999', archivedAt: null, visibility: 'public' },
          { id: 'j3', sourceBoard: 'greenhouse', externalId: 'otherco:999', archivedAt: null, visibility: 'public' },
          { id: 'j4', sourceBoard: 'lever', externalId: 'formosarobotics:777', archivedAt: null, visibility: 'public' },
        ],
      },
    });
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch(GH_ROUTE), env: {} });
    const res = await adapter.fetch(QUERY, { now: NOW });
    expect(res.error).toBeUndefined();
    expect(res.jobs.map((j) => j.externalId)).toEqual(['formosarobotics:4012345', 'formosarobotics:4012399']);
    expect(res.closedExternalIds).toEqual(['formosarobotics:999']);
    expect(res.exhausted).toBe(true);
    expect(res.calls).toBe(1);
    const stamped = db.$rows('rACareerSiteSource').find((r) => r.id === 'cs1')!;
    expect(stamped).toMatchObject({ lastJobCount: 2, lastError: null });
    expect((stamped.lastSyncedAt as Date).toISOString()).toBe(NOW.toISOString());
    // Not due (read an hour ago) and disabled boards are untouched.
    expect(db.$rows('rACareerSiteSource').find((r) => r.id === 'cs2')!.lastJobCount).toBeNull();
  });

  it('a board that fails is stamped with the error and closes nothing', async () => {
    const db = createFakePrisma({
      seed: {
        rACareerSiteSource: [source()],
        rAJob: [{ id: 'j1', sourceBoard: 'greenhouse', externalId: 'formosarobotics:1', archivedAt: null, visibility: 'public' }],
      },
    });
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch({}), env: {} });
    const res = await adapter.fetch(QUERY, { now: NOW });
    expect(res).toMatchObject({ jobs: [], closedExternalIds: [], exhausted: true });
    expect(db.$rows('rACareerSiteSource')[0]).toMatchObject({ lastError: 'board_not_found', lastJobCount: null });
  });

  it('answers exhausted:false while more boards are due, and never runs for GoApply', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => source({ id: `cs${i}`, boardToken: `b${i}` }));
    const db = createFakePrisma({ seed: { rACareerSiteSource: rows, rAJob: [] } });
    const fetch = vi.fn(fakeFetch({}));
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch, env: {} });
    const res = await adapter.fetch(QUERY, { now: NOW });
    expect(res.exhausted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    const cn = await adapter.fetch({ ...QUERY, market: 'cn' }, { now: NOW });
    expect(cn).toEqual({ jobs: [], calls: 0, exhausted: true });
  });

  it('never throws: a database failure becomes an error result', async () => {
    const adapter = createAtsPublicAdapter({ db: () => { throw new Error('db down'); }, env: {} });
    expect(await adapter.fetch(QUERY, { now: NOW })).toMatchObject({ jobs: [], error: 'career_sources:db down' });
  });

  it('dueCareerSources: never-read first, then the longest unread past the interval', async () => {
    const db = createFakePrisma({
      seed: {
        rACareerSiteSource: [
          source({ id: 'old', lastSyncedAt: new Date('2026-10-08T00:00:00Z') }),
          source({ id: 'older', lastSyncedAt: new Date('2026-10-01T00:00:00Z') }),
          source({ id: 'new' }),
          source({ id: 'recent', lastSyncedAt: new Date('2026-10-09T22:00:00Z') }),
          source({ id: 'tw-cn', market: 'cn' }),
        ],
      },
    });
    expect((await dueCareerSources(db as never, 'intl', NOW, 10)).map((r) => r.id)).toEqual(['new', 'older', 'old']);
  });

  it('readCareerSource refuses an unknown job board without a request', async () => {
    const db = createFakePrisma({ seed: { rACareerSiteSource: [source({ ats: 'workday' })], rAJob: [] } });
    const fetch = vi.fn(fakeFetch({}));
    const res = await readCareerSource(db as never, source({ ats: 'workday' }) as never, { now: NOW, fetch });
    expect(res).toMatchObject({ read: null, error: 'unsupported_job_board', calls: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── RapidAPI: country=tw (WP-16b planner seam) ───────────────────────────

describe('RapidAPI searches Taiwan as country=tw', () => {
  it('when the profile country is TW, or the location is a Taiwanese city', () => {
    const brand = getBrand('roboapply');
    const byCountry = tuplesFromFilters({ taxonomyIds: [], titles: ['Backend Engineer'], country: 'TW' }, brand);
    const byCity = tuplesFromFilters({ titles: ['Backend Engineer'], locations: [{ label: 'Taipei', city: 'Taipei', radiusKm: 0 }] }, brand);
    expect(byCountry.map((t) => t.country)).toEqual(['TW']);
    expect(byCity.map((t) => [t.country, t.city])).toEqual([['TW', 'Taipei']]);

    const jsearch = createRapidApiAdapter('jsearch', { isEnabled: () => true });
    const activejobs = createRapidApiAdapter('activejobs', { isEnabled: () => true });
    const planned = planQueries([...byCountry, ...byCity].map((t) => ({ ...t, users: 1 })), [jsearch, activejobs]);
    expect(planned.length).toBeGreaterThan(0);
    for (const p of planned) {
      expect(p.params.country).toBe('TW');
      expect(rapidApiSearchParams(p.params, p.provider as 'jsearch').country).toBe('tw');
    }
    // A city in Taiwan wins over another search country.
    expect(rapidApiSearchParams({ q: 'Designer', country: 'US', city: 'Taipei', datePosted: 'week' }, 'jsearch').country).toBe('tw');
  });

  it('the JSearch adapter sends country=tw for a TW query', async () => {
    const search = vi.fn(async () => []);
    const adapter = createRapidApiAdapter('jsearch', { isEnabled: () => true, provider: { id: 'jsearch', search } as never });
    await adapter.fetch({ id: 'q', provider: 'jsearch', market: 'intl', origin: 'demand', params: { q: 'Data Analyst', country: 'TW', city: 'Taipei', datePosted: 'week' } }, { now: NOW });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ country: 'tw' }), expect.anything());
  });
});

// ── Permit tags (TW-09) ──────────────────────────────────────────────────

describe('Taiwan permit tags: only with a quote from the posting', () => {
  it('tags positive statements with the verbatim sentence', () => {
    const text = '我們正在尋找後端工程師。本公司可協助申請工作許可。Employment Gold Card holders are welcome to apply.';
    expect(extractPermitTags(text, 'https://example.com/job')).toEqual([
      { tag: 'tw_work_permit_support', evidenceQuote: '本公司可協助申請工作許可。', evidenceUrl: 'https://example.com/job' },
      { tag: 'tw_gold_card', evidenceQuote: 'Employment Gold Card holders are welcome to apply.', evidenceUrl: 'https://example.com/job' },
    ]);
    expect(extractPermitTags('We can help you obtain a Taiwan work permit (ARC).').map((t) => t.tag)).toEqual(['tw_work_permit_support']);
    expect(extractPermitTags('Visa sponsorship is available for this role.').map((t) => t.tag)).toEqual(['tw_work_permit_support']);
    expect(extractPermitTags('提供工作簽證').map((t) => t.tag)).toEqual(['tw_work_permit_support']);
  });

  it('never tags negated or silent postings', () => {
    for (const text of [
      '恕不協助申請工作許可。',
      '本職缺不提供工作簽證。',
      'We do not provide work visa sponsorship for this role.',
      'We are unable to sponsor work permits.',
      'Candidates must already hold a Gold Card.',
      'No visa sponsorship.',
      'Great team, great snacks.',
      '',
    ]) {
      expect(extractPermitTags(text), text).toEqual([]);
    }
    expect(extractPermitTags(null)).toEqual([]);
  });

  it('long sentences are clipped to a verbatim window around the match', () => {
    const long = `${'A'.repeat(300)} we will sponsor work permits for this role ${'B'.repeat(300)}`;
    const [tag] = extractPermitTags(long);
    expect(tag!.evidenceQuote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(long).toContain(tag!.evidenceQuote);
    expect(tag!.evidenceQuote).toContain('sponsor work permits');
  });

  it('quoteInPosting folds whitespace and width', () => {
    expect(quoteInPosting('可協助申請工作許可', '本公司 可協助申請工作許可。')).toBe(true);
    expect(quoteInPosting('可協助申請工作許可', '不同的文字')).toBe(false);
  });
});

// ── Market hooks ─────────────────────────────────────────────────────────

const TW_JOB = {
  id: 'job1',
  market: 'intl' as const,
  provider: 'greenhouse',
  sourceBoard: 'greenhouse',
  atsType: 'greenhouse',
  companyName: 'Formosa Robotics',
  locationCountry: 'TW',
  salaryText: '待遇面議（經常性薪資達4萬元或以上）',
  salaryDisclosed: false,
  sourceName: 'Formosa Robotics · Greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345',
  applyUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345',
  descriptionPlain: '我們正在尋找後端工程師。本公司可協助申請工作許可。',
  marketTags: null as unknown,
};

describe('ats_public market hooks', () => {
  it('stays registered second in MARKET_HOOK_SETS', () => {
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toEqual(['cn', 'ats_public']);
  });

  it('afterNormalize composes sourceName = company + ATS for ats_public postings only', async () => {
    const job = asMarketHookJob(
      normalizeProviderJob({ externalId: 'x:1', sourceBoard: 'lever', title: 'Engineer', company: 'Pine Cloud', applyUrl: 'https://jobs.lever.co/pinecloud/1' }, 'ats_public', { market: 'intl', now: NOW }),
    );
    const hooked = await afterNormalize({ ...job, sourceName: 'Lever', originalSourceName: 'Lever' }, { brand: 'roboapply', market: 'intl', stage: 'ingest' });
    expect(hooked).toMatchObject({ sourceName: 'Pine Cloud · Lever', originalSourceName: null });
    const other = { market: 'intl' as const, provider: 'activejobs', sourceBoard: 'activejobs', companyName: 'X', sourceName: 'Active Jobs DB' };
    expect(withAtsSourceName(other)).toBe(other);
  });

  it('isTaiwanJob reads the country or any location', () => {
    expect(isTaiwanJob({ market: 'intl', locationCountry: 'tw' })).toBe(true);
    expect(isTaiwanJob({ market: 'intl', locationCountry: 'US', locations: [{ country: 'TW' }] })).toBe(true);
    expect(isTaiwanJob({ market: 'intl', locationCountry: 'JP' })).toBe(false);
  });

  it('cardMeta: 面議 wording kept; the Art. 5 floor clause never reaches the card text', () => {
    const meta = cardMeta(TW_JOB, { brand: 'roboapply', market: 'intl', stage: 'card' }).ats_public as unknown as TwCardMeta;
    expect(meta).toEqual({
      country: 'TW',
      pay: { text: '待遇面議', posted: '待遇面議（經常性薪資達4萬元或以上）', disclosed: false, negotiable: true },
      permitTags: [],
      source: { name: 'Formosa Robotics · Greenhouse', url: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345', board: 'greenhouse' },
    });
    // Honesty: the card text carries no NT$40,000 floor in any spelling.
    const FLOOR = /4\s*[萬万]|四\s*[萬万]|40,?000/;
    expect(meta.pay.text).not.toMatch(FLOOR);
    for (const posted of [
      '待遇面議（經常性薪資達4萬元或以上）',
      '面議，經常性薪資達 40,000 元以上',
      '待遇面議 (月薪NT$40,000以上)',
      '依公司規定；經常性薪資四萬元（含）以上',
    ]) {
      const card = twCardMeta({ ...TW_JOB, salaryText: posted })!.pay;
      expect(card.negotiable, posted).toBe(true);
      expect(card.text, posted).not.toMatch(FLOOR);
      expect(card.text, posted).toMatch(/面議|依公司規定/);
      expect(card.posted).toBe(posted);
    }
    // A real figure is not a floor clause.
    expect(twNegotiableCardText('面議，年薪104萬以上')).toBe('面議，年薪104萬以上');
  });

  it('cardMeta: English "competitive salary" / DOE is not 面議 and gets no pay pill', () => {
    for (const salaryText of ['Competitive salary', 'DOE', 'Commensurate with experience']) {
      expect(twCardMeta({ ...TW_JOB, salaryText })!.pay).toEqual({ text: salaryText, posted: salaryText, disclosed: false, negotiable: false });
    }
  });

  it('cardMeta shows a permit tag only while its quote is still in the posting', () => {
    const tags = [
      { tag: 'tw_work_permit_support', evidenceQuote: '本公司可協助申請工作許可。', evidenceUrl: null },
      { tag: 'tw_gold_card', evidenceQuote: 'Gold Card holders welcome.', evidenceUrl: null },
      { tag: 'citizenship_required', evidenceQuote: 'x', evidenceUrl: null },
    ];
    const meta = twCardMeta({ ...TW_JOB, marketTags: tags })!;
    expect(meta.permitTags).toEqual([{ tag: 'tw_work_permit_support', quote: '本公司可協助申請工作許可。' }]);
  });

  it('cardMeta is null outside Taiwan and on GoApply; a disclosed range is not "negotiable"', () => {
    expect(twCardMeta({ ...TW_JOB, locationCountry: 'US' })).toBeNull();
    expect(twCardMeta({ ...TW_JOB, market: 'cn' })).toBeNull();
    expect(twCardMeta({ ...TW_JOB, salaryText: 'NT$55,000 - NT$75,000', salaryDisclosed: true })!.pay).toEqual({
      text: 'NT$55,000 - NT$75,000',
      posted: 'NT$55,000 - NT$75,000',
      disclosed: true,
      negotiable: false,
    });
    expect(twCardMeta({ ...TW_JOB, salaryText: null })!.pay).toEqual({ text: null, posted: null, disclosed: false, negotiable: false });
  });

  describe('afterEnrich writes permit tags with quotes', () => {
    let update: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      update = vi.fn(async () => ({}));
    });
    afterEach(() => vi.restoreAllMocks());
    const hooks = () => createAtsPublicHooks({ db: () => ({ rAJob: { update } }) as never });

    it('adds the tag next to tags other modules own', async () => {
      const existing = [{ tag: 'citizenship_not_required', evidenceQuote: 'q', evidenceUrl: null }];
      await hooks().afterEnrich!({ ...TW_JOB, marketTags: existing }, { brand: 'roboapply', market: 'intl', stage: 'enrich' });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'job1' },
        data: {
          marketTags: [
            ...existing,
            { tag: 'tw_work_permit_support', evidenceQuote: '本公司可協助申請工作許可。', evidenceUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345' },
          ],
        },
      });
    });

    it('removes a tag the posting no longer supports, and writes nothing when nothing changed', async () => {
      const stale = [{ tag: 'tw_gold_card', evidenceQuote: 'Gold Card welcome', evidenceUrl: null }];
      await hooks().afterEnrich!({ ...TW_JOB, descriptionPlain: 'Plain posting.', marketTags: stale }, { brand: 'roboapply', market: 'intl', stage: 'enrich' });
      expect(update).toHaveBeenCalledTimes(1);
      expect((update.mock.calls[0]![0] as { data: { marketTags: unknown } }).data.marketTags).not.toEqual(stale);
      update.mockClear();
      await hooks().afterEnrich!({ ...TW_JOB, descriptionPlain: 'Plain posting.', marketTags: null }, { brand: 'roboapply', market: 'intl', stage: 'enrich' });
      expect(update).not.toHaveBeenCalled();
    });

    it('works with the row the enrich service sends (no location or links; provider = sourceBoard): loads them by id', async () => {
      // enrich/service.ts hookJob: EnrichJobRecord (JOB_SELECT) + update, provider = sourceBoard.
      const enrichJob = {
        id: 'job1',
        market: 'intl' as const,
        provider: 'greenhouse',
        sourceBoard: 'greenhouse',
        companyName: 'Formosa Robotics',
        description: '<p>我們正在尋找後端工程師。本公司可協助申請工作許可。</p>',
        descriptionPlain: '我們正在尋找後端工程師。本公司可協助申請工作許可。',
        marketTags: null,
      };
      const findUnique = vi.fn(async () => ({
        locationCountry: 'TW',
        locations: [],
        sourceUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345',
        applyUrl: null,
      }));
      const set = createAtsPublicHooks({ db: () => ({ rAJob: { update, findUnique } }) as never });
      const ctx = { brand: 'roboapply' as const, market: 'intl' as const, stage: 'enrich' as const };
      // Through the registry, exactly as the enrich service calls it.
      await marketAfterEnrich(enrichJob, ctx, [set]);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'job1' }, select: { locationCountry: true, locations: true, sourceUrl: true, applyUrl: true } });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'job1' },
        data: {
          marketTags: [{ tag: 'tw_work_permit_support', evidenceQuote: '本公司可協助申請工作許可。', evidenceUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/4012345' }],
        },
      });

      // Not in Taiwan: nothing written.
      update.mockClear();
      findUnique.mockResolvedValueOnce({ locationCountry: 'JP', locations: [], sourceUrl: null, applyUrl: null });
      await marketAfterEnrich(enrichJob, ctx, [set]);
      expect(update).not.toHaveBeenCalled();

      // No permit sentence and none of our tags: no database work at all.
      findUnique.mockClear();
      await marketAfterEnrich({ ...enrichJob, descriptionPlain: 'Plain posting.', description: null }, ctx, [set]);
      expect(findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();

      // A stale tag on a row the enrich service sends is removed after the load.
      findUnique.mockResolvedValueOnce({ locationCountry: 'TW', locations: [], sourceUrl: null, applyUrl: null });
      await marketAfterEnrich(
        { ...enrichJob, descriptionPlain: 'Plain posting.', description: null, marketTags: [{ tag: 'tw_gold_card', evidenceQuote: 'Gold Card welcome', evidenceUrl: null }] },
        ctx,
        [set],
      );
      expect(update).toHaveBeenCalledWith({ where: { id: 'job1' }, data: { marketTags: expect.anything() } });
    });

    it('mergePermitTags keeps other modules’ tags', () => {
      expect(mergePermitTags([{ tag: 'bianzhi', evidenceQuote: 'q', evidenceUrl: null }, { tag: 'tw_gold_card', evidenceQuote: 'old', evidenceUrl: null }], [])).toEqual([
        { tag: 'bianzhi', evidenceQuote: 'q', evidenceUrl: null },
      ]);
    });
  });
});

// ── TW open data (guarded stub) ──────────────────────────────────────────

describe('TW open data', () => {
  it('stays off until the licence spike is confirmed, whatever the env says', () => {
    expect(twOpenDataStatus({ TW_OPEN_DATA_JOBS_ENABLED: 'true', TW_OPEN_DATA_JOBS_URL: 'https://data.gov.tw/x.json' })).toEqual({ enabled: false, reason: 'licence_unverified' });
    expect(twOpenDataEnabled({ TW_OPEN_DATA_JOBS_ENABLED: 'true' })).toBe(false);
    expect(getSourceAdapter('tw_open_data' as never)).toBeNull();
    expect(TW_OPEN_DATA_ATTRIBUTION).toContain('台灣就業通');
  });
});
