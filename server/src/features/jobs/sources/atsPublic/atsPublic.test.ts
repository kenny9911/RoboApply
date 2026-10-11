// @vitest-environment node
//
// WP-42 and the market wave (MKT-3D): the public job-board connectors (contract
// tests against the documented-shape fixtures in __fixtures__/, plus any live
// recordings made with __fixtures__/record.ts), reading and routing one board,
// the inert `ats_public` registry entry, discovery, the Taiwan market hooks
// (sourceName, permit tags with quotes, card meta) and the RapidAPI country=tw
// planner seam. No network, no database: every board is a fake fetch.
//
// One board feeds both brands (MARKET_STRATEGY JC-4): a board is read once and
// each posting lands in the market of its own location (mainland China -> cn,
// anything else -> intl); a posting located in both is written twice, the
// mainland copy as `<id>#cn`. Greenhouse and Ashby hand on a whole board from
// one call, Lever pages to the end, SmartRecruiters always lists completely
// (once per country) and reads posting texts only for postings not stored yet
// (JI-4). The board sync that leases, writes and stamps is tested in
// ingest/boards.test.ts; the seed files in seeds.test.ts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrand } from '../../../../platform/brand/index.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { MARKET_HOOK_SETS, afterEnrich as marketAfterEnrich, afterNormalize, cardMeta, type MarketHookJob } from '../../marketHooks.js';
import { normalizeProviderJob, asMarketHookJob, marketOfPosting, type ProviderJobInput } from '../../normalize/index.js';
import { createRapidApiAdapter, rapidApiSearchParams } from '../../ingest/adapters/rapidApi.js';
import { planQueries, tuplesFromFilters } from '../../ingest/planner.js';
import { adaptersForBrand } from '../../ingest/providers.js';
import { adapterCostModel, getSourceAdapter, sourceUserAgent } from '../index.js';
import { CareerSourceBodySchema, ImportCareerSourcesBodySchema, ListCareerSourcesQuerySchema, PatchCareerSourceBodySchema, PUBLIC_ATS_NAMES, type TwCardMeta } from './contract.js';
import { ashby, CONNECTORS, greenhouse, hasPlaceholderName, lever, prioritise, smartrecruiters, smartRecruitersListUrl, SR_MAX_DETAILS, type BoardSource } from './connectors.js';
import { createAtsPublicAdapter } from './adapter.js';
import { companyNamesMatch, createBoardDiscovery, DISCOVERY_ATS, DISCOVERY_MEMORY, DISCOVERY_PAUSE_MS, judgeCandidate, oneWord, parsePostingKey } from './discovery.js';
import { API_HOSTS, assertApiHost, boardRequestHeaders, BoardFetchError, getJson, type FetchLike } from './http.js';
import {
  createAtsPublicHooks,
  isTaiwanJob,
  isTwNegotiable,
  mergePermitTags,
  twCardMeta,
  twNegotiableCardText,
  withAtsSourceName,
} from './hooks.js';
import { normalizeSalary, parseSalaryText } from '../../normalize/salary.js';
import { CN_COPY_SUFFIX, copySelected, routeBoardRead, routePosting, selectedCopies, splitPostingByMarket, storedIdsOf } from './market.js';
import { extractPermitTags, MAX_QUOTE_CHARS, quoteInPosting } from './permitTags.js';
import { REMOVED_BOARDS_CONFIG_KEY, REMOVED_BOARDS_MAX, forgetRemovedBoards, readRemovedBoards, rememberRemovedBoard, removedBoardKey } from './removed.js';
import { CANDIDATE_MAX_ATTEMPTS, candidateRetry, classifyBoardError, failureStamp, nextReadDelayMs, successStamp, syncIntervalMs, transientAttempt } from './schedule.js';
import { checkImportRow, jsonImportRow, readImportCsv, toView } from './service.js';
import {
  atsSourceName,
  boardsConcurrency,
  careerSourceState,
  decodeEntities,
  discoveryValidationsPerRun,
  externalIdFor,
  LEVER_MAX_PAGES,
  mergeCountries,
  normalizeCountries,
  smartRecruitersDetailsPerRun,
  sourceCoversCountry,
  sourceFeedsMarket,
} from './shared.js';
import { CAREER_SOURCE_COLUMNS, closedExternalIds, readBoard, toCareerSourceRow, type CareerSourceDb, type CareerSourceRow } from './sync.js';
import { atsPublicAdapter } from './register.js';

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

  it('pages with skip / limit to the end: a board of 730 postings is read whole over 8 pages (no size cap)', async () => {
    const page = (n: number, offset: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${offset + i}`, text: `Role ${offset + i}`, hostedUrl: `https://jobs.lever.co/pinecloud/id-${offset + i}` }));
    const calls: string[] = [];
    const board = (total: number): FetchLike => async (url) => {
      calls.push(url);
      const skip = Number(new URL(url).searchParams.get('skip'));
      return { ok: true, status: 200, text: async () => JSON.stringify(page(Math.max(0, Math.min(100, total - skip)), skip)) };
    };
    const read = await lever.read(LV, { now: NOW, fetch: board(730) });
    expect(read).toMatchObject({ complete: true, calls: 8, pendingDetails: 0, boardCompanyName: null });
    expect(read.inputs).toHaveLength(730);
    expect(read.listedIds).toHaveLength(730);
    expect(calls.at(-1)).toBe('https://api.lever.co/v0/postings/pinecloud?mode=json&skip=700&limit=100');
    // A board of exactly 200 needs the empty third page to know it ended.
    calls.length = 0;
    expect(await lever.read(LV, { now: NOW, fetch: board(200) })).toMatchObject({ complete: true, calls: 3 });
  });

  it('a listing that never ends stops at the safety stop and is reported incomplete (closures are then skipped)', async () => {
    const endless: FetchLike = async (url) => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      return { ok: true, status: 200, text: async () => JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `id-${skip + i}`, text: 'Role', hostedUrl: `https://jobs.lever.co/pinecloud/id-${skip + i}` }))) };
    };
    const capped = await lever.read(LV, { now: NOW, fetch: endless });
    expect(capped.complete).toBe(false);
    expect(capped.calls).toBe(LEVER_MAX_PAGES);
    expect(capped.listedIds).toHaveLength(LEVER_MAX_PAGES * 100);
  });

  it('listOnly reads the same listing and hands on no inputs', async () => {
    const read = await lever.read(LV, { now: NOW, fetch: fakeFetch({ 'https://api.lever.co/v0/postings/pinecloud': fixture('lever.json') }) }, { listOnly: true });
    expect(read.inputs).toEqual([]);
    expect(read.listing).toHaveLength(2);
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

// ── Who is asking (JI-4) ─────────────────────────────────────────────────

describe('every board request says who is asking', () => {
  it('sends the identifying User-Agent next to Accept, for the market whose brand reads the board', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetch: FetchLike = async (_url, init) => {
      seen.push(init.headers);
      return { ok: true, status: 200, text: async () => '{"jobs":[]}' };
    };
    const env = { JOB_SOURCES_CONTACT: 'mailto:jobs@example.com', CN_JOB_SOURCES_CONTACT: 'mailto:zhaopin@example.cn' };
    await getJson('https://boards-api.greenhouse.io/v1/boards/x/jobs', { fetch, env });
    await getJson('https://boards-api.greenhouse.io/v1/boards/x/jobs', { fetch, env, market: 'cn' });
    expect(seen[0]).toEqual({ Accept: 'application/json', 'User-Agent': sourceUserAgent('intl', env) });
    expect(seen[0]!['User-Agent']).toBe('RoboApplyJobs/1.0 (+mailto:jobs@example.com)');
    // GoApply never sends RoboApply's contact.
    expect(seen[1]!['User-Agent']).toBe('GoApplyJobs/1.0 (+mailto:zhaopin@example.cn)');
    expect(boardRequestHeaders({ env: {} })['User-Agent']).toMatch(/^RoboApplyJobs\/1\.0 \(\+https:\/\//);
  });

  it('every request of every connector carries it (listing pages, the board name, posting texts)', async () => {
    const agents = new Set<string | undefined>();
    let requests = 0;
    const fetch: FetchLike = async (url, init) => {
      requests += 1;
      agents.add(init.headers?.['User-Agent']);
      const u = new URL(url);
      if (u.hostname === 'api.lever.co') return { ok: true, status: 200, text: async () => '[]' };
      if (u.hostname === 'api.smartrecruiters.com') {
        const body = /\/postings\/p1$/.test(u.pathname) ? { id: 'p1', jobAd: { sections: { jobDescription: { text: '<p>x</p>' } } } } : { totalFound: 1, content: [{ id: 'p1', name: 'Role', location: { city: 'Taipei', country: 'tw' } }] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'Co', jobs: [] }) };
    };
    for (const c of Object.values(CONNECTORS)) await c.read({ ats: c.ats, boardToken: 'co', companyName: 'co', countryCode: null }, { now: NOW, fetch, env: {} });
    expect(requests).toBeGreaterThanOrEqual(6);
    expect([...agents]).toEqual([sourceUserAgent('intl', {})]);
  });
});

// ── The registry entry (the board sync is the only reader) ───────────────

describe('ats_public adapter', () => {
  it('stays registered for both markets, as a free cursor source with a kill switch', () => {
    expect(getSourceAdapter('ats_public')).toBe(atsPublicAdapter);
    expect(atsPublicAdapter).toMatchObject({ provider: 'ats_public', kind: 'cursor', markets: ['intl', 'cn'], costModel: 'free' });
    expect(adapterCostModel(atsPublicAdapter)).toBe('free');
    expect([...atsPublicAdapter.sourceBoards]).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);
    expect(atsPublicAdapter.dailyCallLimit()).toBeNull();
    expect(atsPublicAdapter.supportsCountry('TW')).toBe(false);
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toContain('ats_public');
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).toContain('ats_public');
    const off = createAtsPublicAdapter({ env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' } });
    expect(off.isEnabled()).toBe(false);
    expect(off.disabledReason?.()).toBe('kill_switch');
    expect(createAtsPublicAdapter({ env: {} }).isEnabled()).toBe(true);
  });

  it('fetch reads nothing: the board sync is the only reader, so the standing query costs no request', async () => {
    const adapter = createAtsPublicAdapter({ env: {} });
    for (const market of ['intl', 'cn'] as const) {
      const res = await adapter.fetch({ id: 'q1', provider: 'ats_public', market, origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } }, { now: NOW });
      expect(res).toEqual({ jobs: [], calls: 0, exhausted: true });
    }
  });
});

// ── Sources: countries, markets and the view ─────────────────────────────

type Row = Record<string, unknown>;
function sourceRow(over: Row = {}): CareerSourceRow {
  return toCareerSourceRow({
    id: 'cs1',
    market: 'intl',
    ats: 'greenhouse',
    boardToken: 'globalco',
    companyName: 'Global Co',
    companyId: null,
    countryCode: null,
    enabled: true,
    ...over,
  });
}

describe('a source is not tied to one market: countries, origin and sync state', () => {
  it('sourceCoversCountry: an empty list covers every country, a list only its own codes', () => {
    expect(sourceCoversCountry({ countries: [] }, 'TW')).toBe(true);
    expect(sourceCoversCountry({}, 'CN')).toBe(true);
    expect(sourceCoversCountry({ countries: ['TW', 'CN'] }, 'tw')).toBe(true);
    expect(sourceCoversCountry({ countries: ['TW', 'CN'] }, 'US')).toBe(false);
    expect(sourceCoversCountry({ countries: ['cn', 'bogus', 7 as never] }, 'CN')).toBe(true);
  });

  it('sourceFeedsMarket: cn = empty or contains CN; intl = empty or contains any other code', () => {
    const rows: Array<[string[], boolean, boolean]> = [
      [[], true, true],
      [['CN'], false, true],
      [['US'], true, false],
      [['TW', 'CN'], true, true],
      [['HK'], true, false],
    ];
    for (const [countries, intl, cn] of rows) {
      expect(sourceFeedsMarket({ countries }, 'intl'), countries.join()).toBe(intl);
      expect(sourceFeedsMarket({ countries }, 'cn'), countries.join()).toBe(cn);
    }
  });

  it('mergeCountries: an empty list means every country and wins; otherwise the union, each code once, sorted', () => {
    expect(mergeCountries(['TW'], ['CN'])).toEqual(['CN', 'TW']);
    expect(mergeCountries(['TW', 'CN'], ['TW'])).toEqual(['CN', 'TW']);
    expect(mergeCountries([], ['CN'])).toEqual([]);
    expect(mergeCountries(['CN'], [])).toEqual([]);
    expect(mergeCountries(null, undefined)).toEqual([]);
    expect(normalizeCountries(['tw', 'TW', ' cn ', 'TWN', '', null])).toEqual(['CN', 'TW']);
  });

  it('toCareerSourceRow gives a row written before the market wave its defaults', () => {
    const row = toCareerSourceRow({ id: 'old', ats: 'lever', boardToken: 'x', companyName: 'X', enabled: true });
    expect(row).toMatchObject({ market: 'intl', origin: 'admin', discoveredFrom: null, countries: [], failCount: 0, lastChangeAt: null, nextSyncAt: null, disabledAt: null });
    expect(CAREER_SOURCE_COLUMNS).toEqual(expect.arrayContaining(['origin', 'discoveredFrom', 'countries', 'failCount', 'lastChangeAt', 'nextSyncAt', 'disabledAt']));
    expect(Object.keys(row).sort()).toEqual([...CAREER_SOURCE_COLUMNS].sort());
  });

  it('toView returns origin, discoveredFrom, countries and the sync state, with dates as ISO text', () => {
    const view = toView(
      sourceRow({
        origin: 'discovered',
        discoveredFrom: 'jsearch:abc',
        countries: ['TW', 'CN'],
        failCount: 2,
        lastChangeAt: new Date('2026-10-09T00:00:00Z'),
        nextSyncAt: new Date('2026-10-10T02:00:00Z'),
        lastSyncedAt: new Date('2026-10-10T00:00:00Z'),
      }),
    );
    expect(view).toMatchObject({
      id: 'cs1',
      market: 'intl',
      origin: 'discovered',
      discoveredFrom: 'jsearch:abc',
      countries: ['CN', 'TW'],
      failCount: 2,
      lastChangeAt: '2026-10-09T00:00:00.000Z',
      nextSyncAt: '2026-10-10T02:00:00.000Z',
      lastSyncedAt: '2026-10-10T00:00:00.000Z',
      disabledAt: null,
      state: 'enabled',
    });
    // An unknown origin in the database reads as 'admin'.
    expect(toView(sourceRow({ origin: 'whatever' })).origin).toBe('admin');
  });

  it('state: enabled, candidate (never switched on) or disabled (by an admin or by failures)', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    expect(careerSourceState({ enabled: true, origin: 'discovered' })).toBe('enabled');
    // Waiting for its first list-only read.
    expect(careerSourceState({ enabled: false, origin: 'discovered', lastSyncedAt: null })).toBe('candidate');
    expect(careerSourceState({ enabled: false, origin: 'import', lastSyncedAt: null })).toBe('candidate');
    // That read did not match: still a candidate an admin may switch on by hand.
    expect(careerSourceState({ enabled: false, origin: 'discovered', lastSyncedAt: at, lastError: 'validation:name_mismatch' })).toBe('candidate');
    // Switched off after it had been read, or by failures, or an admin's own board.
    expect(careerSourceState({ enabled: false, origin: 'import', lastSyncedAt: at, lastError: null })).toBe('disabled');
    expect(careerSourceState({ enabled: false, origin: 'discovered', disabledAt: at })).toBe('disabled');
    expect(careerSourceState({ enabled: false, origin: 'admin' })).toBe('disabled');
    expect(careerSourceState({ enabled: false, origin: 'seed' })).toBe('disabled');
  });

  it('the contract: countries are ISO alpha-2 codes (at most 60, default none); the list filters by market, origin and state', () => {
    const body = { ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch' };
    expect(CareerSourceBodySchema.parse(body)).toMatchObject({ countries: [], enabled: true });
    expect(CareerSourceBodySchema.parse({ ...body, countries: ['TW', 'CN'] }).countries).toEqual(['TW', 'CN']);
    expect(CareerSourceBodySchema.safeParse({ ...body, countries: ['tw'] }).success).toBe(false);
    expect(CareerSourceBodySchema.safeParse({ ...body, countries: ['TWN'] }).success).toBe(false);
    expect(CareerSourceBodySchema.safeParse({ ...body, countries: Array.from({ length: 61 }, () => 'TW') }).success).toBe(false);
    // `market` in a body is accepted and ignored (earlier clients send it).
    expect(CareerSourceBodySchema.safeParse({ ...body, market: 'cn' }).success).toBe(true);
    expect(PatchCareerSourceBodySchema.parse({ countries: ['CN'] })).toEqual({ countries: ['CN'] });
    expect(PatchCareerSourceBodySchema.safeParse({ origin: 'seed' }).success).toBe(false);
    expect(ListCareerSourcesQuerySchema.parse({ market: 'cn', origin: 'discovered', state: 'candidate' })).toEqual({ market: 'cn', origin: 'discovered', state: 'candidate' });
    expect(ListCareerSourcesQuerySchema.safeParse({ state: 'paused' }).success).toBe(false);
    expect(ListCareerSourcesQuerySchema.safeParse({ origin: 'memory' }).success).toBe(false);
  });

  it('the settings come from the environment, inside their bounds', () => {
    expect(boardsConcurrency({})).toBe(6);
    expect(boardsConcurrency({ ATS_BOARDS_CONCURRENCY: '2' })).toBe(4);
    expect(boardsConcurrency({ ATS_BOARDS_CONCURRENCY: '40' })).toBe(8);
    expect(boardsConcurrency({ ATS_BOARDS_CONCURRENCY: 'many' })).toBe(6);
    expect(smartRecruitersDetailsPerRun({})).toBe(100);
    expect(smartRecruitersDetailsPerRun({ ATS_SR_DETAILS_PER_RUN: '250' })).toBe(250);
    expect(discoveryValidationsPerRun({})).toBe(20);
    expect(discoveryValidationsPerRun({ ATS_DISCOVERY_VALIDATIONS_PER_RUN: '0' })).toBe(0);
  });
});

// ── One posting, the market of its own location (JC-4) ───────────────────

function posting(over: Partial<ProviderJobInput> = {}): ProviderJobInput {
  return {
    externalId: 'globalco:1',
    sourceBoard: 'greenhouse',
    title: 'Software Engineer',
    company: 'Global Co',
    applyUrl: 'https://boards.greenhouse.io/globalco/jobs/1',
    sourceUrl: 'https://boards.greenhouse.io/globalco/jobs/1',
    descriptionHtml: '<p>SYNTHETIC posting text.</p>',
    ...over,
  };
}

describe('splitPostingByMarket: each posting lands in the market of its own location', () => {
  it('mainland only -> the cn copy with the plain externalId; Hong Kong, Macau, Taiwan and anywhere else -> intl', () => {
    for (const location of ['上海', 'Shanghai', 'Shanghai, China', '北京市', 'Shenzhen, Guangdong, China']) {
      const split = splitPostingByMarket(posting({ location }));
      expect(split.intl, location).toBeNull();
      expect(split.cn, location).toMatchObject({ externalId: 'globalco:1', location });
    }
    for (const location of ['Hong Kong', 'Macau', 'Taipei, Taiwan', '台北市', 'Singapore', 'London, United Kingdom', 'Remote', 'Multiple locations']) {
      const split = splitPostingByMarket(posting({ location }));
      expect(split.cn, location).toBeNull();
      expect(split.intl, location).toMatchObject({ externalId: 'globalco:1' });
    }
  });

  it('no location, or a board country tag alone, never makes a posting mainland; a country the board states for the posting does', () => {
    expect(splitPostingByMarket(posting())).toMatchObject({ cn: null, intl: { externalId: 'globalco:1' } });
    expect(splitPostingByMarket(posting({ locationCountry: 'CN', locationCountryEstimated: true }))).toMatchObject({ cn: null });
    expect(splitPostingByMarket(posting({ locationCountry: 'CN', locationCountryEstimated: false }))).toMatchObject({ intl: null, cn: { externalId: 'globalco:1' } });
    // SmartRecruiters states the country next to a city the text alone would not place.
    expect(splitPostingByMarket(posting({ location: 'Suzhou, Jiangsu', locationCity: 'Suzhou', locationRegion: 'Jiangsu', locationCountry: 'CN', locationCountryEstimated: false }))).toMatchObject({ intl: null });
  });

  it('located in both: two inputs, the intl copy keeps the id and the other locations, the cn copy is <id>#cn with the mainland ones', () => {
    const split = splitPostingByMarket(posting({ location: 'Shanghai, China', locations: ['Shanghai, China', 'Singapore'] }));
    expect(split.intl).toMatchObject({ externalId: 'globalco:1', location: 'Singapore', locations: ['Singapore'] });
    expect(split.cn).toMatchObject({ externalId: `globalco:1${CN_COPY_SUFFIX}`, location: 'Shanghai, China', locations: ['Shanghai, China'] });
    expect(CN_COPY_SUFFIX).toBe('#cn');
    // Whatever the order, and with several places on each side; a text that places nothing stays international.
    const many = splitPostingByMarket(posting({ location: 'Singapore', locations: ['Singapore', '上海', 'Beijing, China', 'Remote'] }));
    expect(many.intl).toMatchObject({ externalId: 'globalco:1', locations: ['Singapore', 'Remote'] });
    expect(many.cn).toMatchObject({ externalId: 'globalco:1#cn', locations: ['上海', 'Beijing, China'] });
    // Shenzhen and Hong Kong are on two sides.
    const border = splitPostingByMarket(posting({ location: 'Shenzhen', locations: ['Shenzhen', 'Hong Kong'] }));
    expect([border.intl?.locations, border.cn?.locations]).toEqual([['Hong Kong'], ['Shenzhen']]);
  });

  it('each copy is in exactly the market the normalizer gives it, so the write step never drops it as wrong_market', () => {
    for (const input of [
      posting({ location: '上海' }),
      posting({ location: 'Singapore' }),
      posting({ location: 'Shanghai, China', locations: ['Shanghai, China', 'Singapore'] }),
      posting({ location: 'Singapore', locations: ['Singapore', 'Shanghai'] }),
      posting({ location: 'Asia Pacific', locations: ['Asia Pacific', 'China'] }),
      posting({ location: 'Remote' }),
      posting(),
    ]) {
      for (const copy of routePosting(input)) {
        expect(marketOfPosting(copy.input), JSON.stringify(input.locations ?? input.location)).toBe(copy.market);
        expect(normalizeProviderJob(copy.input, 'ats_public', { now: NOW }).market).toBe(copy.market);
      }
    }
  });

  it('the source\'s countries: a copy is kept when one of its countries is in the list, or it is remote with no country', () => {
    const tw = posting({ location: 'Taipei, Taiwan' });
    const sh = posting({ location: '上海' });
    const sg = posting({ location: 'Singapore' });
    const remote = posting({ location: 'Remote' });
    const remoteUs = posting({ location: 'Remote - United States' });
    const vague = posting({ location: 'Multiple locations' });
    const kept = (input: ProviderJobInput, countries: string[]) => selectedCopies(input, countries).kept.map((c) => c.input.externalId);
    // No list: everything.
    for (const p of [tw, sh, sg, remote, remoteUs, vague]) expect(kept(p, [])).toHaveLength(1);
    expect(kept(tw, ['TW'])).toEqual(['globalco:1']);
    expect(kept(sh, ['TW'])).toEqual([]);
    expect(kept(sg, ['TW', 'CN'])).toEqual([]);
    expect(kept(sh, ['TW', 'CN'])).toEqual(['globalco:1']);
    expect(kept(remote, ['TW'])).toEqual(['globalco:1']);
    // Remote inside another country is that country's posting.
    expect(kept(remoteUs, ['TW'])).toEqual([]);
    expect(kept(vague, ['TW'])).toEqual([]);
    // A posting on both sides read for CN only: the mainland copy alone, still as <id>#cn.
    const both = posting({ location: 'Shanghai, China', locations: ['Shanghai, China', 'Singapore'] });
    expect(kept(both, ['CN'])).toEqual(['globalco:1#cn']);
    expect(selectedCopies(both, ['CN']).countryNotSelected).toBe(1);
    expect(copySelected({ countries: ['SG'], remoteAnywhere: false }, ['sg'])).toBe(true);
  });

  it('routeBoardRead: the listing gives the externalIds a board maps to right now, the inputs go to their markets, skipped copies are counted', () => {
    const listing = [
      posting({ externalId: 'globalco:1', location: '上海' }),
      posting({ externalId: 'globalco:2', location: 'Singapore' }),
      posting({ externalId: 'globalco:3', location: 'Shanghai, China', locations: ['Shanghai, China', 'Singapore'] }),
      posting({ externalId: 'globalco:4', location: 'Taipei, Taiwan' }),
    ];
    const all = routeBoardRead({ listing, inputs: listing }, []);
    expect(all.listedIds.sort()).toEqual(['globalco:1', 'globalco:2', 'globalco:3', 'globalco:3#cn', 'globalco:4']);
    expect(all.byMarket.intl.map((i) => i.externalId)).toEqual(['globalco:2', 'globalco:3', 'globalco:4']);
    expect(all.byMarket.cn.map((i) => i.externalId)).toEqual(['globalco:1', 'globalco:3#cn']);
    expect(all.countryNotSelected).toBe(0);
    const twOnly = routeBoardRead({ listing, inputs: listing }, ['TW']);
    expect(twOnly.listedIds).toEqual(['globalco:4']);
    expect(twOnly.byMarket).toEqual({ intl: [expect.objectContaining({ externalId: 'globalco:4' })], cn: [] });
    expect(twOnly.countryNotSelected).toBe(4);
    // Which ids this deployment stores a listed posting under (none = its text is never asked for).
    expect(storedIdsOf(listing[2]!, [], ['intl', 'cn'])).toEqual(['globalco:3', 'globalco:3#cn']);
    expect(storedIdsOf(listing[2]!, [], ['intl'])).toEqual(['globalco:3']);
    expect(storedIdsOf(listing[0]!, [], ['intl'])).toEqual([]);
    expect(storedIdsOf(listing[1]!, ['CN'], ['intl', 'cn'])).toEqual([]);
  });
});

// ── Reading one board (JI-4, JC-4) ───────────────────────────────────────

const ghJob = (id: number, location: string, title = 'Software Engineer') => ({
  id,
  title,
  absolute_url: `https://boards.greenhouse.io/globalco/jobs/${id}`,
  location: { name: location },
  content: '&lt;p&gt;SYNTHETIC posting text.&lt;/p&gt;',
  first_published: '2026-10-01T00:00:00Z',
});
const GH_LIST = 'https://boards-api.greenhouse.io/v1/boards/globalco/jobs';
const openRow = (sourceBoard: string, externalId: string, lastSeenAt: Date | null = null) => ({ id: `job:${externalId}`, sourceBoard, externalId, archivedAt: null, visibility: 'public', lastSeenAt });
const boardDb = (jobs: Row[] = []) => createFakePrisma({ seed: { rAJob: jobs } });
const asDb = (fake: ReturnType<typeof createFakePrisma>) => fake as unknown as CareerSourceDb;
const BOTH = { markets: ['intl', 'cn'] as const };

describe('readBoard: one read, both markets, exact closures', () => {
  it('a 728-posting Greenhouse board is read whole from ONE request and every posting is handed on; none of its stored rows is closed', async () => {
    // Built here, not a 5 MB file: 700 postings abroad, 28 in mainland China.
    const jobs = Array.from({ length: 728 }, (_, i) => ghJob(i + 1, i % 26 === 0 ? '上海' : 'Dublin, Ireland'));
    const calls: string[] = [];
    const fake = boardDb(jobs.map((j) => openRow('greenhouse', `globalco:${j.id}`)));
    const res = await readBoard(asDb(fake), sourceRow(), { now: NOW, fetch: fakeFetch({ [GH_LIST]: { jobs } }, calls) }, BOTH);
    expect(calls).toEqual([`${GH_LIST}?content=true`]);
    expect(res.error).toBeNull();
    expect(res.read).toMatchObject({ complete: true, calls: 1, pendingDetails: 0 });
    expect(res.read!.inputs).toHaveLength(728);
    expect(res.routed!.byMarket.intl).toHaveLength(700);
    expect(res.routed!.byMarket.cn).toHaveLength(28);
    expect(res.routed!.listedIds).toHaveLength(728);
    expect(res.closedExternalIds).toEqual([]);
  });

  it('a 上海 posting goes to cn and not to intl, a Singapore posting of the same board to intl, with the employer\'s own links', async () => {
    const res = await readBoard(asDb(boardDb()), sourceRow(), { now: NOW, fetch: fakeFetch({ [GH_LIST]: { jobs: [ghJob(1, '上海'), ghJob(2, 'Singapore')] } }) }, BOTH);
    expect(res.routed!.byMarket.cn.map((i) => [i.externalId, i.applyUrl])).toEqual([['globalco:1', 'https://boards.greenhouse.io/globalco/jobs/1']]);
    expect(res.routed!.byMarket.intl.map((i) => i.externalId)).toEqual(['globalco:2']);
    const cn = normalizeProviderJob(res.routed!.byMarket.cn[0]!, 'ats_public', { now: NOW });
    expect(cn).toMatchObject({ market: 'cn', provider: 'ats_public', sourceBoard: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/globalco/jobs/1', sourceName: 'Global Co · Greenhouse' });
  });

  it('a posting in Shanghai and Singapore is two rows; when it later lists only Singapore, exactly the #cn row is closed', async () => {
    const both = { ...ghJob(7, 'Shanghai, China'), offices: [{ name: 'Shanghai', location: 'Shanghai, China' }, { name: 'Singapore', location: 'Singapore' }] };
    const calls: string[] = [];
    const first = await readBoard(asDb(boardDb()), sourceRow(), { now: NOW, fetch: fakeFetch({ [GH_LIST]: { jobs: [both] } }, calls) }, BOTH);
    expect(calls).toHaveLength(1);
    expect(first.routed!.byMarket.intl).toEqual([expect.objectContaining({ externalId: 'globalco:7', locations: ['Singapore'] })]);
    expect(first.routed!.byMarket.cn).toEqual([expect.objectContaining({ externalId: 'globalco:7#cn', locations: ['Shanghai, China'] })]);
    // Both copies are stored; the board now lists Singapore only.
    const stored = boardDb([openRow('greenhouse', 'globalco:7'), openRow('greenhouse', 'globalco:7#cn')]);
    const later = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: fakeFetch({ [GH_LIST]: { jobs: [ghJob(7, 'Singapore')] } }) }, BOTH);
    expect(later.closedExternalIds).toEqual(['globalco:7#cn']);
    expect(later.routed!.byMarket).toMatchObject({ intl: [{ externalId: 'globalco:7' }], cn: [] });
  });

  it('closures compare our open rows of THIS board only: another company on the same system, archived and private rows are left alone', async () => {
    const stored = boardDb([
      openRow('greenhouse', 'globalco:1'),
      openRow('greenhouse', 'globalco:99'),
      openRow('greenhouse', 'globalcorp:5'),
      openRow('lever', 'globalco:99'),
      { ...openRow('greenhouse', 'globalco:50'), archivedAt: NOW },
      { ...openRow('greenhouse', 'globalco:51'), visibility: 'private' },
    ]);
    const res = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: fakeFetch({ [GH_LIST]: { jobs: [ghJob(1, 'Singapore')] } }) }, BOTH);
    expect(res.closedExternalIds).toEqual(['globalco:99']);
    expect(closedExternalIds(new Map([['a', null], ['b', null]]), ['b', 'c'])).toEqual(['a']);
  });

  it('a board that cannot be read closes nothing and reports why; an unknown job-board system makes no request', async () => {
    const stored = boardDb([openRow('greenhouse', 'globalco:1')]);
    const gone = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: fakeFetch({}) }, BOTH);
    expect(gone).toMatchObject({ read: null, routed: null, closedExternalIds: [], error: 'board_not_found' });
    const calls: string[] = [];
    const odd = await readBoard(asDb(stored), sourceRow({ ats: 'workday' }), { now: NOW, fetch: fakeFetch({}, calls) }, BOTH);
    expect(odd).toMatchObject({ read: null, error: 'unsupported_job_board', calls: 0 });
    expect(calls).toEqual([]);
  });

  it('a source registered without a name carries its board id until the board states its own (Greenhouse: one more documented request)', async () => {
    const calls: string[] = [];
    const routes = { [GH_LIST]: { jobs: [ghJob(1, 'Singapore')] }, 'https://boards-api.greenhouse.io/v1/boards/globalco': { name: 'Global Co Ltd' } };
    // `fakeFetch` matches a prefix followed by ? or &; the board-name request is the exact URL.
    const res = await readBoard(asDb(boardDb()), sourceRow({ companyName: 'globalco' }), { now: NOW, fetch: fakeFetch(routes, calls) }, BOTH);
    expect(calls).toEqual([`${GH_LIST}?content=true`, 'https://boards-api.greenhouse.io/v1/boards/globalco']);
    expect(res.read).toMatchObject({ boardCompanyName: 'Global Co Ltd', calls: 2 });
    expect(res.routed!.byMarket.intl[0]).toMatchObject({ company: 'Global Co Ltd', sourcePublisher: 'Global Co Ltd · Greenhouse' });
    expect(hasPlaceholderName({ companyName: 'globalco', boardToken: 'globalco' })).toBe(true);
    expect(hasPlaceholderName({ companyName: 'Global Co', boardToken: 'globalco' })).toBe(false);
  });
});

// ── SmartRecruiters: complete listing, texts over successive runs (JI-4) ──

interface SrPosting {
  id: string;
  country: string;
  city: string;
}

/** A SYNTHETIC SmartRecruiters board: the listing honours limit, offset and the API's own `country` filter. */
function srBoard(token: string, postings: SrPosting[], options: { failText?: Set<string>; failStatus?: number; company?: string } = {}) {
  const urls: string[] = [];
  const texts: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const detail = new RegExp(`^/v1/companies/${token}/postings/([^/]+)$`).exec(u.pathname);
    if (detail) {
      const id = decodeURIComponent(detail[1]!);
      texts.push(id);
      if (options.failText?.has(id)) return { ok: false, status: options.failStatus ?? 500, text: async () => '' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id, postingUrl: `https://jobs.smartrecruiters.com/${token}/${id}`, jobAd: { sections: { jobDescription: { title: 'Job', text: '<p>SYNTHETIC text.</p>' } } } }) };
    }
    if (u.pathname !== `/v1/companies/${token}/postings`) return { ok: false, status: 404, text: async () => '' };
    const country = u.searchParams.get('country');
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    const rows = postings.filter((p) => !country || p.country === country);
    const content = rows.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      name: `Role ${p.id}`,
      company: { name: options.company ?? 'Harbor Group' },
      location: { city: p.city, country: p.country, fullLocation: `${p.city}, ${p.country.toUpperCase()}` },
      releasedDate: '2026-10-01T00:00:00.000Z',
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ totalFound: rows.length, offset, limit, content }) };
  };
  return { fetch, urls, texts, listingUrls: () => urls.filter((u) => new URL(u).pathname.endsWith('/postings')) };
}

const srSource = (over: Row = {}) => sourceRow({ id: 'sr1', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', ...over });

describe('SmartRecruiters: the listing is always read completely; posting texts only for ids not stored yet', () => {
  it('a 1,300-posting board read for CN is fully ingested over 13 successive runs; every run lists it in full with country=cn and closes nothing', async () => {
    const postings: SrPosting[] = Array.from({ length: 1300 }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}`, country: 'cn', city: 'Suzhou' }));
    const fake = boardDb();
    const stored = fake.$rows('rAJob');
    const source = srSource({ countries: ['CN'] });
    for (let run = 1; run <= 13; run += 1) {
      const board = srBoard('BoschGroup', postings);
      const at = new Date(NOW.getTime() + run * 300_000);
      const res = await readBoard(asDb(fake), source, { now: at, fetch: board.fetch }, BOTH);
      // The whole listing, every run, on every page with the API's own country filter.
      const listing = board.listingUrls();
      expect(listing, `run ${run}`).toHaveLength(13);
      expect(listing.every((u) => new URL(u).searchParams.get('country') === 'cn')).toBe(true);
      expect(listing[0]).toBe(smartRecruitersListUrl('BoschGroup', 0, 'CN'));
      expect(listing.at(-1)).toBe('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=1200&country=cn');
      expect(res.read!.complete).toBe(true);
      expect(res.read!.listedIds).toHaveLength(1300);
      // 100 texts a run, only for postings we do not hold yet.
      expect(board.texts).toHaveLength(100);
      expect(board.texts.every((id) => !stored.some((r) => r.externalId === `BoschGroup:${id}`))).toBe(true);
      expect(res.read!.inputs).toHaveLength(100);
      expect(res.read!.pendingDetails, `run ${run}`).toBe(1300 - run * 100);
      // Nothing stored is closed for being "beyond a cap": there is none.
      expect(res.closedExternalIds).toEqual([]);
      expect(res.routed!.byMarket.intl).toEqual([]);
      for (const input of res.routed!.byMarket.cn) stored.push(openRow('smartrecruiters', input.externalId, at));
    }
    expect(new Set(stored.map((r) => r.externalId)).size).toBe(1300);

    // Everything is stored: the budget now refreshes the rows saved longest ago (the first run's).
    const refresh = srBoard('BoschGroup', postings);
    const res14 = await readBoard(asDb(fake), source, { now: new Date(NOW.getTime() + 14 * 300_000), fetch: refresh.fetch }, BOTH);
    expect(res14.read!.pendingDetails).toBe(0);
    expect(refresh.texts).toHaveLength(100);
    expect(refresh.texts.slice().sort()[0]).toBe('p0000');
    expect(res14.closedExternalIds).toEqual([]);

    // The employer takes one posting down: exactly that row is closed.
    const without = postings.filter((p) => p.id !== 'p0777');
    const res15 = await readBoard(asDb(fake), source, { now: new Date(NOW.getTime() + 15 * 300_000), fetch: srBoard('BoschGroup', without).fetch }, BOTH);
    expect(res15.closedExternalIds).toEqual(['BoschGroup:p0777']);
  });

  it('a source read for TW and CN is listed once per country and the two listings are merged', async () => {
    const postings: SrPosting[] = [
      ...Array.from({ length: 120 }, (_, i) => ({ id: `cn${i}`, country: 'cn', city: 'Wuxi' })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `tw${i}`, country: 'tw', city: 'Taipei' })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: `de${i}`, country: 'de', city: 'Stuttgart' })),
    ];
    const fake = boardDb();
    const source = srSource({ countries: ['TW', 'CN'] });
    const board = srBoard('BoschGroup', postings);
    const res = await readBoard(asDb(fake), source, { now: NOW, fetch: board.fetch }, BOTH);
    expect(board.listingUrls().map((u) => new URL(u).search)).toEqual(['?limit=100&offset=0&country=cn', '?limit=100&offset=100&country=cn', '?limit=100&offset=0&country=tw']);
    expect(res.read!.complete).toBe(true);
    expect(res.read!.listedIds).toHaveLength(124);
    // The German postings are never listed, so never asked for.
    expect(board.texts.some((id) => id.startsWith('de'))).toBe(false);
    expect(res.read!.inputs).toHaveLength(100);
    expect(res.read!.pendingDetails).toBe(24);
    for (const input of [...res.routed!.byMarket.cn, ...res.routed!.byMarket.intl]) fake.$rows('rAJob').push(openRow('smartrecruiters', input.externalId, NOW));
    // The next run reads the rest: the Taiwan postings land in intl, the mainland ones in cn.
    const next = srBoard('BoschGroup', postings);
    const second = await readBoard(asDb(fake), source, { now: new Date(NOW.getTime() + 300_000), fetch: next.fetch }, BOTH);
    expect(second.routed!.byMarket.intl.map((i) => i.externalId).sort()).toEqual(['BoschGroup:tw0', 'BoschGroup:tw1', 'BoschGroup:tw2', 'BoschGroup:tw3']);
    // 20 mainland postings were still unread; what is left of the budget refreshes 76 already stored.
    expect(second.routed!.byMarket.cn).toHaveLength(96);
    expect(second.routed!.byMarket.cn.map((i) => i.externalId)).toEqual(expect.arrayContaining(Array.from({ length: 20 }, (_, i) => `BoschGroup:cn${100 + i}`)));
    expect(next.texts).toHaveLength(100);
    expect(second.read!.pendingDetails).toBe(0);
    expect(second.closedExternalIds).toEqual([]);
  });

  it('no countries: one pass without the filter; a posting of a market this deployment does not write is never asked for its text', async () => {
    const postings: SrPosting[] = [
      { id: 'a', country: 'cn', city: 'Wuxi' },
      { id: 'b', country: 'tw', city: 'Taipei' },
    ];
    const board = srBoard('HarborFoods', postings);
    const res = await readBoard(asDb(boardDb()), srSource({ boardToken: 'HarborFoods', countries: [] }), { now: NOW, fetch: board.fetch }, { markets: ['intl'] });
    expect(board.listingUrls()).toEqual(['https://api.smartrecruiters.com/v1/companies/HarborFoods/postings?limit=100&offset=0']);
    expect(board.texts).toEqual(['b']);
    // Still listed (the closure diff is about what the board lists), and not "pending": it is not wanted here.
    expect(res.routed!.listedIds.sort()).toEqual(['HarborFoods:a', 'HarborFoods:b']);
    expect(res.read!.pendingDetails).toBe(0);
  });

  it('a failed text request skips that posting for the run and never fails the board: it is counted as failed, apart from the texts not asked for yet', async () => {
    const postings: SrPosting[] = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, country: 'cn', city: 'Wuxi' }));
    const board = srBoard('BoschGroup', postings, { failText: new Set(['p2']) });
    const res = await readBoard(asDb(boardDb()), srSource({ countries: ['CN'] }), { now: NOW, fetch: board.fetch }, BOTH);
    expect(res.error).toBeNull();
    expect(res.read!.inputs.map((i) => i.externalId)).toEqual(['BoschGroup:p0', 'BoschGroup:p1', 'BoschGroup:p3', 'BoschGroup:p4']);
    expect(res.read!.listedIds).toHaveLength(5);
    // Asked for and not read is "failed"; "pending" is only what the run did not ask for.
    expect(res.read).toMatchObject({ failedDetails: 1, pendingDetails: 0 });
    expect(res.closedExternalIds).toEqual([]);

    // With a budget of 3: p0, p1 read, p2 failed, p3 and p4 not asked for.
    const small = srBoard('BoschGroup', postings, { failText: new Set(['p2']) });
    const partly = await readBoard(asDb(boardDb()), srSource({ countries: ['CN'] }), { now: NOW, fetch: small.fetch }, { ...BOTH, detailsBudget: 3 });
    expect(small.texts.sort()).toEqual(['p0', 'p1', 'p2']);
    expect(partly.read).toMatchObject({ failedDetails: 1, pendingDetails: 2 });

    // A stored posting whose refresh fails is neither: the row is there, and the next regular read asks again.
    const stored = boardDb(postings.map((p) => openRow('smartrecruiters', `BoschGroup:${p.id}`, NOW)));
    const refresh = await readBoard(asDb(stored), srSource({ countries: ['CN'] }), { now: NOW, fetch: srBoard('BoschGroup', postings, { failText: new Set(['p2']) }).fetch }, BOTH);
    expect(refresh.read).toMatchObject({ failedDetails: 0, pendingDetails: 0 });
    expect(refresh.closedExternalIds).toEqual([]);
  });

  it('told to slow down (429) it asks for no further text in that run; what was not asked for stays pending', async () => {
    const postings: SrPosting[] = Array.from({ length: 40 }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, country: 'cn', city: 'Wuxi' }));
    const board = srBoard('BoschGroup', postings, { failText: new Set(postings.map((p) => p.id)), failStatus: 429 });
    const res = await readBoard(asDb(boardDb()), srSource({ countries: ['CN'] }), { now: NOW, fetch: board.fetch }, BOTH);
    expect(res.error).toBeNull();
    // Four requests were in flight when the first 429 came back; the other 36 were never sent.
    expect(board.texts.length).toBeLessThanOrEqual(4);
    expect(res.read!.inputs).toEqual([]);
    expect(res.read!.failedDetails).toBe(board.texts.length);
    expect(res.read!.pendingDetails).toBe(40 - board.texts.length);
  });

  it('a run that ran out of time mid-text is not a failure of the board: the posting is simply not read yet', async () => {
    const postings: SrPosting[] = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, country: 'cn', city: 'Wuxi' }));
    const stop = new AbortController();
    const inner = srBoard('BoschGroup', postings);
    const fetch: FetchLike = async (url, init) => {
      if (/\/postings\/p1$/.test(url)) {
        stop.abort();
        throw new Error('aborted');
      }
      return inner.fetch(url, init);
    };
    const res = await readBoard(asDb(boardDb()), srSource({ countries: ['CN'] }), { now: NOW, fetch, signal: stop.signal }, { ...BOTH, detailsBudget: 3 });
    expect(res.error).toBeNull();
    expect(res.read!.failedDetails).toBe(0);
    expect(res.read!.pendingDetails).toBe(3 - res.read!.inputs.length);
  });

  it('firstPage (a check by hand, a candidate): one request per country pass, the count from the board\'s own total, the company from the first row', async () => {
    const postings: SrPosting[] = [
      ...Array.from({ length: 1322 }, (_, i) => ({ id: `cn${i}`, country: 'cn', city: 'Wuxi' })),
      ...Array.from({ length: 31 }, (_, i) => ({ id: `tw${i}`, country: 'tw', city: 'Taipei' })),
      ...Array.from({ length: 900 }, (_, i) => ({ id: `de${i}`, country: 'de', city: 'Stuttgart' })),
    ];
    const source: BoardSource = { ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countryCode: null, countries: ['CN', 'TW'] };
    const board = srBoard('BoschGroup', postings, { company: 'Bosch Group' });
    const read = await smartrecruiters.read(source, { now: NOW, fetch: board.fetch }, { listOnly: true, firstPage: true });
    expect(board.urls).toEqual([smartRecruitersListUrl('BoschGroup', 0, 'CN'), smartRecruitersListUrl('BoschGroup', 0, 'TW')]);
    expect(read).toMatchObject({ calls: 2, listedCount: 1353, complete: false, inputs: [], pendingDetails: 0, failedDetails: 0, boardCompanyName: 'Bosch Group' });
    // The rows it did read are still handed back (131 of 1,353), so nothing may be closed from this read.
    expect(read.listing).toHaveLength(131);

    // No countries: one request for the whole board, however large it is.
    const whole = srBoard('BoschGroup', postings, { company: 'Bosch Group' });
    const all = await smartrecruiters.read({ ...source, countries: [] }, { now: NOW, fetch: whole.fetch }, { listOnly: true, firstPage: true });
    expect(whole.urls).toEqual([smartRecruitersListUrl('BoschGroup', 0)]);
    expect(all).toMatchObject({ calls: 1, listedCount: 2253, complete: false });

    // A board whose first page is everything is complete, and counted.
    const tiny = srBoard('HarborFoods', postings.slice(0, 7));
    const few = await smartrecruiters.read({ ...source, boardToken: 'HarborFoods', countries: [] }, { now: NOW, fetch: tiny.fetch }, { listOnly: true, firstPage: true });
    expect(few).toMatchObject({ calls: 1, listedCount: 7, complete: true });
    // Without listOnly the flag changes nothing: the sync always reads the listing to its end.
    const sync = srBoard('BoschGroup', postings.slice(0, 250));
    const full = await smartrecruiters.read({ ...source, countries: ['CN'] }, { now: NOW, fetch: sync.fetch }, { firstPage: true, detailsBudget: 1 });
    expect(sync.listingUrls()).toHaveLength(3);
    expect(full).toMatchObject({ complete: true, listedCount: 250 });
    // The other systems answer a listing in one call or page quickly: they read it whole and count it.
    const gh = await greenhouse.read(GH, { now: NOW, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': fixture('greenhouse.json') }) }, { listOnly: true, firstPage: true });
    expect(gh.listedCount).toBe(gh.listing.length);
    expect(gh.complete).toBe(true);
  });

  it('the per-run budget is a setting; the listing states the company, which names a source registered without one', async () => {
    const postings: SrPosting[] = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, country: 'cn', city: 'Wuxi' }));
    const board = srBoard('Ubisoft2', postings, { company: 'Ubisoft' });
    const res = await readBoard(asDb(boardDb()), srSource({ boardToken: 'Ubisoft2', companyName: 'Ubisoft2', countries: ['CN'] }), { now: NOW, fetch: board.fetch }, { ...BOTH, detailsBudget: 10 });
    expect(board.texts).toHaveLength(10);
    expect(res.read).toMatchObject({ pendingDetails: 20, boardCompanyName: 'Ubisoft' });
    expect(res.read!.inputs[0]).toMatchObject({ company: 'Ubisoft', sourcePublisher: 'Ubisoft · SmartRecruiters' });
    // listOnly: the listing alone, no text request.
    const listOnly = srBoard('Ubisoft2', postings, { company: 'Ubisoft' });
    const read = await smartrecruiters.read({ ats: 'smartrecruiters', boardToken: 'Ubisoft2', companyName: 'Ubisoft2', countryCode: null, countries: ['CN'] }, { now: NOW, fetch: listOnly.fetch }, { listOnly: true });
    expect(listOnly.texts).toEqual([]);
    expect(read).toMatchObject({ inputs: [], pendingDetails: 0, boardCompanyName: 'Ubisoft', complete: true });
    expect(read.listing).toHaveLength(30);
  });
});

// ── The sync schedule (pure rules; ingest/boards.ts applies them) ────────

describe('when a board is read next, and when it is switched off', () => {
  const H = 3_600_000;
  const state = (over: Row = {}) => ({ failCount: 0, lastChangeAt: null, lastSyncedAt: null, lastError: null, ...over }) as { failCount: number; lastChangeAt: Date | null; lastSyncedAt: Date | null; lastError: string | null };

  it('success: +2 h when it changed in the last 48 h, +12 h in the last 14 days, +24 h otherwise; at once while texts are unread', () => {
    const ago = (h: number) => new Date(NOW.getTime() - h * H);
    expect(syncIntervalMs(ago(1), NOW)).toBe(2 * H);
    expect(syncIntervalMs(ago(48), NOW)).toBe(2 * H);
    expect(syncIntervalMs(ago(49), NOW)).toBe(12 * H);
    expect(syncIntervalMs(ago(14 * 24), NOW)).toBe(12 * H);
    expect(syncIntervalMs(ago(14 * 24 + 1), NOW)).toBe(24 * H);
    expect(syncIntervalMs(null, NOW)).toBe(24 * H);

    const changed = successStamp(state({ lastChangeAt: ago(400), failCount: 2 }), { now: NOW, listed: 40, changed: true, pendingDetails: 0 });
    expect(changed).toEqual({ lastSyncedAt: NOW, lastError: null, failCount: 0, lastJobCount: 40, lastChangeAt: NOW, nextSyncAt: new Date(NOW.getTime() + 2 * H) });
    const quiet = successStamp(state({ lastChangeAt: ago(72) }), { now: NOW, listed: 40, changed: false, pendingDetails: 0 });
    expect(quiet).toEqual({ lastSyncedAt: NOW, lastError: null, failCount: 0, lastJobCount: 40, nextSyncAt: new Date(NOW.getTime() + 12 * H) });
    expect(successStamp(state(), { now: NOW, listed: 0, changed: false, pendingDetails: 0 }).nextSyncAt).toEqual(new Date(NOW.getTime() + 24 * H));
    expect(successStamp(state(), { now: NOW, listed: 1300, changed: true, pendingDetails: 1200 }).nextSyncAt).toEqual(NOW);
  });

  it('posting texts: not asked for yet -> at once; asked for and not read -> in 1 h; refused every text -> in 1 h whatever is pending', () => {
    const at = (r: { pendingDetails: number; failedDetails?: number; readDetails?: number }, lastChangeAt: Date | null = NOW) => nextReadDelayMs(lastChangeAt, { now: NOW, ...r }) / H;
    // Nothing owed: the board's interval.
    expect(at({ pendingDetails: 0, failedDetails: 0, readDetails: 100 })).toBe(2);
    // A backlog and the host answers: carry on at the next board sync.
    expect(at({ pendingDetails: 1200, failedDetails: 0, readDetails: 100 })).toBe(0);
    expect(at({ pendingDetails: 1200 })).toBe(0);
    // One text that keeps failing must not hold up a backlog that is moving...
    expect(at({ pendingDetails: 1100, failedDetails: 1, readDetails: 99 })).toBe(0);
    // ...and must not bring the board back every 5 minutes once the backlog is done.
    expect(at({ pendingDetails: 0, failedDetails: 1, readDetails: 2 })).toBe(1);
    expect(at({ pendingDetails: 0, failedDetails: 1, readDetails: 0 })).toBe(1);
    // Refused every text it asked for (a rate limit): later, never sooner, whatever is still pending.
    expect(at({ pendingDetails: 1200, failedDetails: 4, readDetails: 0 })).toBe(1);
    // Never later than the board's own interval.
    expect(at({ pendingDetails: 0, failedDetails: 3, readDetails: 0 }, null)).toBe(1);
    const stamp = successStamp(state({ lastChangeAt: NOW }), { now: NOW, listed: 3, changed: false, pendingDetails: 0, failedDetails: 1, readDetails: 2 });
    expect(stamp).toMatchObject({ lastError: null, failCount: 0, nextSyncAt: new Date(NOW.getTime() + H) });
  });

  it('a hard failure counts and retries in 1 h; the third in a row switches the source off and schedules the archive 48 h later', () => {
    for (const code of ['board_not_found', 'redirect', 'unexpected_shape', 'not_json', 'unsupported_job_board']) expect(classifyBoardError(code), code).toBe('hard');
    // The host says no to this request as it is: gone, refused, malformed, or an answer too large to ever read.
    for (const code of ['http_400', 'http_401', 'http_403', 'http_410', 'http_422', 'response_too_large']) expect(classifyBoardError(code), code).toBe('hard');
    // These pass by themselves: slow, busy, or asked too often.
    for (const code of ['timeout', 'http_408', 'http_429', 'http_500', 'http_503', 'network:reset', 'network', 'unexpected:boom']) expect(classifyBoardError(code), code).toBe('transient');
    const first = failureStamp(state(), { now: NOW, error: 'board_not_found' });
    expect(first).toEqual({ lastSyncedAt: NOW, lastError: 'board_not_found', failCount: 1, nextSyncAt: new Date(NOW.getTime() + H) });
    const second = failureStamp(state({ failCount: 1 }), { now: NOW, error: 'redirect' });
    expect(second).toMatchObject({ failCount: 2 });
    expect(second.enabled).toBeUndefined();
    const third = failureStamp(state({ failCount: 2 }), { now: NOW, error: 'board_not_found' });
    expect(third).toEqual({ lastSyncedAt: NOW, lastError: 'board_not_found', failCount: 3, enabled: false, disabledAt: NOW, nextSyncAt: new Date(NOW.getTime() + 48 * H) });
  });

  it('a board that refuses us (401, 403) counts too, but is asked again only 6 h later: three refusals span at least 12 hours', () => {
    let s = state();
    let at = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const stamp = failureStamp(s, { now: at, error: 'http_403' });
      expect(stamp.enabled).toBeUndefined();
      waits.push((stamp.nextSyncAt.getTime() - at.getTime()) / H);
      s = state({ failCount: stamp.failCount, lastSyncedAt: stamp.lastSyncedAt, lastError: stamp.lastError });
      at = stamp.nextSyncAt;
    }
    expect(waits).toEqual([6, 6]);
    const off = failureStamp(s, { now: at, error: 'http_403' });
    expect(off).toMatchObject({ failCount: 3, enabled: false, disabledAt: at, lastError: 'http_403' });
    expect(at.getTime() - NOW.getTime()).toBe(12 * H);
    expect(failureStamp(state(), { now: NOW, error: 'http_401' }).nextSyncAt).toEqual(new Date(NOW.getTime() + 6 * H));
    // A board that is gone for good (410) is an ordinary hard failure: 1 h.
    expect(failureStamp(state(), { now: NOW, error: 'http_410' })).toMatchObject({ failCount: 1, nextSyncAt: new Date(NOW.getTime() + H) });
  });

  it('a candidate\'s passing failures are counted: tried again 1 h x the attempt later, and the third is final', () => {
    expect(CANDIDATE_MAX_ATTEMPTS).toBe(3);
    expect(candidateRetry(0, NOW)).toEqual({ failCount: 1, final: false, nextSyncAt: new Date(NOW.getTime() + H) });
    expect(candidateRetry(1, NOW)).toEqual({ failCount: 2, final: false, nextSyncAt: new Date(NOW.getTime() + 2 * H) });
    expect(candidateRetry(2, NOW)).toEqual({ failCount: 3, final: true, nextSyncAt: null });
    expect(candidateRetry(7, NOW).final).toBe(true);
  });

  it('a transient failure never counts and never switches off: it waits 1 h x the attempt, at most 6 h', () => {
    let s = state({ failCount: 2 });
    let at = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const stamp = failureStamp(s, { now: at, error: 'timeout' });
      expect(stamp.enabled).toBeUndefined();
      expect(stamp.failCount).toBe(2);
      waits.push((stamp.nextSyncAt.getTime() - at.getTime()) / H);
      s = state({ failCount: stamp.failCount, lastSyncedAt: stamp.lastSyncedAt, lastError: stamp.lastError });
      at = stamp.nextSyncAt;
    }
    expect(waits).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 6]);
    // A success in between starts over.
    expect(transientAttempt(state({ lastSyncedAt: NOW, lastError: null }), new Date(NOW.getTime() + 5 * H))).toBe(1);
    expect(transientAttempt(state({ lastSyncedAt: NOW, lastError: 'board_not_found' }), new Date(NOW.getTime() + H))).toBe(1);
  });
});

// ── Discovery (JI-3) ─────────────────────────────────────────────────────

const discovered = (over: Row = {}): MarketHookJob => ({
  market: 'intl',
  provider: 'jsearch',
  sourceBoard: 'jsearch',
  externalId: 'abc123',
  companyName: 'Acme',
  title: 'Engineer',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  atsPostingKey: 'greenhouse:acme:1',
  ...over,
});

describe('discovery: a posting that links to a job board names a candidate source', () => {
  it('parsePostingKey reads <ats>:<tenant>:<postingId> and nothing else', () => {
    expect(parsePostingKey('greenhouse:acme:1')).toEqual({ ats: 'greenhouse', tenant: 'acme', postingId: '1' });
    expect(parsePostingKey('Lever:pine-cloud:5f1e-22:x')).toEqual({ ats: 'lever', tenant: 'pine-cloud', postingId: '5f1e-22:x' });
    expect(parsePostingKey('ashby:kraken.com:abc')).toMatchObject({ tenant: 'kraken.com' });
    for (const bad of [undefined, null, 7, '', 'greenhouse', 'greenhouse:acme', 'greenhouse::1', ':acme:1', 'greenhouse:acme:', 'greenhouse:ac me:1', 'greenhouse:../etc:1', `greenhouse:${'a'.repeat(121)}:1`]) {
      expect(parsePostingKey(bad), String(bad)).toBeNull();
    }
    expect([...DISCOVERY_ATS]).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'lever_eu']);
  });

  it('an ingested JSearch row with a boards.greenhouse.io link creates a disabled candidate that says which row named it', async () => {
    const fake = createFakePrisma();
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    expect(await discovery.note(discovered(), { stage: 'ingest' })).toBe('offered');
    const rows = fake.$rows('rACareerSiteSource');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market: 'intl', ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', origin: 'discovered', discoveredFrom: 'jsearch:abc123', enabled: false, countries: [] });
    // A mainland row records the console of its market; a system we cannot read yet is kept for its connector.
    await discovery.note(discovered({ market: 'cn', provider: 'activejobs', sourceBoard: 'activejobs', externalId: 'x9', atsPostingKey: 'workable:northwind:AB12', companyName: '示例公司' }), { stage: 'ingest' });
    expect(rows[1]).toMatchObject({ market: 'cn', ats: 'workable', boardToken: 'northwind', discoveredFrom: 'activejobs:x9', enabled: false });
  });

  it('a user\'s import records only that an import named the board: discoveredFrom is exactly user_import, nothing personal is stored', async () => {
    const fake = createFakePrisma();
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    const job = discovered({
      provider: 'user_import',
      sourceBoard: 'user_import',
      externalId: 'import:u_42:9f8e',
      atsPostingKey: 'ashby:islandlabs:a1b2',
      companyName: 'Island Labs',
      ownerUserId: 'u_42',
      applyUrl: 'https://jobs.ashbyhq.com/islandlabs/a1b2?utm_source=my-private-list',
      descriptionPlain: 'My notes: recruiter Jane, jane@example.com',
    });
    expect(await discovery.note(job, { stage: 'import' })).toBe('offered');
    const [row] = fake.$rows('rACareerSiteSource');
    expect(row).toMatchObject({ ats: 'ashby', boardToken: 'islandlabs', origin: 'discovered', discoveredFrom: 'user_import', enabled: false });
    // Only the public board id, the company name and the fixed marker: no user id, no link, no text.
    const { createdAt: _c, updatedAt: _u, id: _i, ...written } = row!;
    expect(written).toEqual({ market: 'intl', ats: 'ashby', boardToken: 'islandlabs', companyName: 'Island Labs', origin: 'discovered', discoveredFrom: 'user_import', enabled: false, countries: [] });
    expect(JSON.stringify(row)).not.toMatch(/u_42|utm_source|jane|9f8e/);
    // The provider alone marks an import too.
    const again = createBoardDiscovery({ db: () => createFakePrisma() as never, env: {} });
    expect(await again.note(job)).toBe('offered');
  });

  it('ignores our own board rows, a posting without a key, a malformed key, an unknown system and the kill switch, without touching the database', async () => {
    const db = vi.fn();
    const discovery = createBoardDiscovery({ db: db as never, env: {} });
    expect(await discovery.note(discovered({ provider: 'ats_public', sourceBoard: 'greenhouse' }))).toBe('ignored');
    expect(await discovery.note(discovered({ atsPostingKey: undefined }))).toBe('ignored');
    expect(await discovery.note(discovered({ atsPostingKey: 'greenhouse:acme' }))).toBe('ignored');
    expect(await discovery.note(discovered({ atsPostingKey: 'workday:acme:1' }))).toBe('ignored');
    expect(await discovery.note(discovered({ atsPostingKey: 42 }))).toBe('ignored');
    const off = createBoardDiscovery({ db: db as never, env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' } });
    expect(await off.note(discovered())).toBe('ignored');
    expect(db).not.toHaveBeenCalled();
    expect(discovery.stats()).toMatchObject({ ignored: 5, offered: 0 });
  });

  it('the same board seen 1,000 times makes one insert attempt; a board already in the list (under any spelling) makes none', async () => {
    const fake = createFakePrisma();
    const createMany = vi.spyOn(fake.rACareerSiteSource!, 'createMany');
    const findFirst = vi.spyOn(fake.rACareerSiteSource!, 'findFirst');
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    for (let i = 0; i < 1000; i += 1) await discovery.note(discovered({ externalId: `row${i}`, atsPostingKey: `greenhouse:acme:${i}` }), { stage: 'ingest' });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(fake.$rows('rACareerSiteSource')).toHaveLength(1);
    expect(discovery.stats()).toMatchObject({ offered: 1, known: 999 });

    // The lookup is by job-board system and board id, whatever the letter case ("BoschGroup" / "boschgroup").
    const where: unknown[] = [];
    const insert = vi.fn();
    const listed = {
      rACareerSiteSource: {
        findFirst: async (args: { where: unknown }) => {
          where.push(args.where);
          return { id: 's1' };
        },
        createMany: insert,
      },
    };
    const second = createBoardDiscovery({ db: () => listed as never, env: {} });
    expect(await second.note(discovered({ atsPostingKey: 'smartrecruiters:boschgroup:744' }))).toBe('known');
    expect(where).toEqual([{ ats: 'smartrecruiters', boardToken: { equals: 'boschgroup', mode: 'insensitive' } }]);
    expect(insert).not.toHaveBeenCalled();
  });

  it('a board an admin removed is not proposed again, under any spelling; adding it again by hand lifts that', async () => {
    const fake = createFakePrisma();
    await rememberRemovedBoard(fake as never, { ats: 'greenhouse', boardToken: 'Acme' }, 'admin1');
    const createMany = vi.spyOn(fake.rACareerSiteSource!, 'createMany');
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    expect(await discovery.note(discovered(), { stage: 'ingest' })).toBe('known');
    expect(await discovery.note(discovered({ externalId: 'other', atsPostingKey: 'greenhouse:acme:77' }), { stage: 'import' })).toBe('known');
    expect(createMany).not.toHaveBeenCalled();
    expect(fake.$rows('rACareerSiteSource')).toEqual([]);
    // Another board is still proposed, and so is the same id on another job-board system.
    expect(await discovery.note(discovered({ atsPostingKey: 'lever:acme:1' }))).toBe('offered');
    // The admin adds it again: a fresh process proposes nothing (it is in the list) and the removal is forgotten.
    expect(await forgetRemovedBoards(fake as never, [{ ats: 'greenhouse', boardToken: 'acme' }])).toBe(1);
    expect(await readRemovedBoards(fake as never)).toEqual([]);
    const later = createBoardDiscovery({ db: () => fake as never, env: {} });
    expect(await later.note(discovered())).toBe('offered');
  });

  it('the removed list: board ids only, one entry per board, the oldest forgotten beyond its cap, an unreadable document reads as empty', async () => {
    const fake = createFakePrisma();
    expect(await readRemovedBoards(fake as never)).toEqual([]);
    expect(removedBoardKey({ ats: 'SmartRecruiters', boardToken: ' BoschGroup ' })).toBe('smartrecruiters:boschgroup');
    await rememberRemovedBoard(fake as never, { ats: 'greenhouse', boardToken: 'acme' }, 'admin1');
    await rememberRemovedBoard(fake as never, { ats: 'lever', boardToken: 'pinecloud' });
    await rememberRemovedBoard(fake as never, { ats: 'greenhouse', boardToken: 'ACME' }, 'admin2');
    expect(await readRemovedBoards(fake as never)).toEqual(['lever:pinecloud', 'greenhouse:acme']);
    const [row] = fake.$rows('appConfig');
    expect(row).toMatchObject({ key: REMOVED_BOARDS_CONFIG_KEY, updatedBy: 'admin2' });
    expect(JSON.parse(String(row!.value))).toEqual({ boards: ['lever:pinecloud', 'greenhouse:acme'] });
    // Forgetting a board that was never removed writes nothing.
    const upsert = vi.spyOn(fake.appConfig!, 'upsert');
    expect(await forgetRemovedBoards(fake as never, [{ ats: 'ashby', boardToken: 'islandlabs' }])).toBe(0);
    expect(await forgetRemovedBoards(fake as never, [])).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    row!.value = JSON.stringify({ boards: Array.from({ length: REMOVED_BOARDS_MAX }, (_, i) => `greenhouse:co${i}`) });
    await rememberRemovedBoard(fake as never, { ats: 'greenhouse', boardToken: 'newest' });
    const capped = await readRemovedBoards(fake as never);
    expect(capped).toHaveLength(REMOVED_BOARDS_MAX);
    expect(capped[0]).toBe('greenhouse:co1');
    expect(capped.at(-1)).toBe('greenhouse:newest');
    row!.value = 'not json';
    expect(await readRemovedBoards(fake as never)).toEqual([]);
  });

  it('remembers 5,000 boards per process and forgets the oldest first', async () => {
    const fake = createFakePrisma();
    const createMany = vi.spyOn(fake.rACareerSiteSource!, 'createMany');
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    for (let i = 0; i <= DISCOVERY_MEMORY; i += 1) await discovery.note(discovered({ atsPostingKey: `lever:co${i}:1` }));
    expect(createMany).toHaveBeenCalledTimes(DISCOVERY_MEMORY + 1);
    // The newest is remembered; the very first was pushed out and is looked up again (and found in the list).
    expect(await discovery.note(discovered({ atsPostingKey: `lever:co${DISCOVERY_MEMORY}:2` }))).toBe('known');
    expect(createMany).toHaveBeenCalledTimes(DISCOVERY_MEMORY + 1);
    expect(await discovery.note(discovered({ atsPostingKey: 'lever:co0:2' }))).toBe('known');
    expect(createMany).toHaveBeenCalledTimes(DISCOVERY_MEMORY + 1);
  });

  it('a database error is swallowed and counted, pauses collecting for a minute, and the board is offered again afterwards', async () => {
    let clock = 1_000_000;
    let broken = true;
    const fake = createFakePrisma();
    const calls = vi.fn();
    const discovery = createBoardDiscovery({
      db: () => {
        calls();
        if (broken) throw new Error('connection refused');
        return fake as never;
      },
      env: {},
      now: () => clock,
    });
    await expect(discovery.note(discovered())).resolves.toBe('failed');
    // One failed attempt, not one per posting.
    await expect(discovery.note(discovered({ atsPostingKey: 'lever:other:1' }))).resolves.toBe('paused');
    expect(calls).toHaveBeenCalledTimes(1);
    broken = false;
    clock += DISCOVERY_PAUSE_MS + 1;
    await expect(discovery.note(discovered())).resolves.toBe('offered');
    expect(fake.$rows('rACareerSiteSource')).toHaveLength(1);
    expect(discovery.stats()).toMatchObject({ failed: 1, paused: 1, offered: 1 });
  });

  it('the market hook offers every ingested or imported posting, of any market and provider, and can never fail or stall it', async () => {
    const seen: Array<[unknown, string]> = [];
    const hooks = createAtsPublicHooks({ discover: async (job, ctx) => void seen.push([job.atsPostingKey, ctx.stage]) });
    const ctx = (stage: 'ingest' | 'import' | 'enrich' | 'card', market: 'intl' | 'cn' = 'intl') => ({ brand: market === 'cn' ? ('goapply' as const) : ('roboapply' as const), market, stage });
    const cn = discovered({ market: 'cn', provider: 'bank_gohire' });
    expect(hooks.appliesTo(discovered(), ctx('ingest'))).toBe(true);
    expect(hooks.appliesTo(cn, ctx('ingest', 'cn'))).toBe(true);
    expect(hooks.appliesTo(discovered({ provider: 'user_import' }), ctx('import'))).toBe(true);
    // Reading a card is not a discovery, and the mainland gets no Taiwan card meta.
    expect(hooks.appliesTo(cn, ctx('card', 'cn'))).toBe(false);
    expect(hooks.appliesTo(discovered(), ctx('card'))).toBe(false);
    const out = await hooks.afterNormalize!(discovered(), ctx('ingest'));
    expect(out).toEqual(discovered());
    await hooks.afterNormalize!(cn, ctx('import', 'cn'));
    await hooks.afterNormalize!(discovered(), ctx('card'));
    expect(seen).toEqual([['greenhouse:acme:1', 'ingest'], ['greenhouse:acme:1', 'import']]);
    // An ats_public row still gets its source name, and is handed to the collector, which ignores it.
    const own = await hooks.afterNormalize!({ market: 'intl', provider: 'ats_public', sourceBoard: 'lever', companyName: 'Pine Cloud' }, ctx('ingest'));
    expect(own.sourceName).toBe('Pine Cloud · Lever');

    const throwing = createAtsPublicHooks({
      discover: async () => {
        throw new Error('boom');
      },
    });
    await expect(throwing.afterNormalize!(discovered(), ctx('ingest'))).resolves.toEqual(discovered());
    const stalled = createAtsPublicHooks({ discover: () => new Promise(() => undefined), discoverWaitMs: 5 });
    const started = Date.now();
    await expect(stalled.afterNormalize!(discovered(), ctx('ingest'))).resolves.toEqual(discovered());
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('judgeCandidate: at least one posting AND the company matches; where the board states none, the id must be the company or its domain', () => {
    const acme = { boardToken: 'acme', companyName: 'Acme' };
    expect(judgeCandidate(acme, { listed: 12, boardCompanyName: 'Acme' })).toBe('ok');
    expect(judgeCandidate(acme, { listed: 12, boardCompanyName: 'Acme, Inc.' })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'acme', companyName: 'Acme Robotics Taiwan' }, { listed: 3, boardCompanyName: 'Acme Robotics' })).toBe('ok');
    expect(judgeCandidate(acme, { listed: 12, boardCompanyName: 'Other Corp' })).toBe('name_mismatch');
    expect(judgeCandidate(acme, { listed: 0, boardCompanyName: 'Acme' })).toBe('empty_board');
    // Lever and Ashby state no company.
    expect(judgeCandidate({ boardToken: 'asteralabs', companyName: 'Astera Labs' }, { listed: 4, boardCompanyName: null })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'pinecloud', companyName: 'Pine Cloud, Inc.' }, { listed: 4, boardCompanyName: null })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'shopback-2', companyName: 'ShopBack' }, { listed: 4, boardCompanyName: null })).toBe('name_unconfirmed');
    expect(judgeCandidate({ boardToken: 'kraken', companyName: 'Payward', domain: 'kraken.com' }, { listed: 4, boardCompanyName: null })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'kraken', companyName: 'Payward', domain: 'https://www.kraken.com/careers' }, { listed: 4, boardCompanyName: null })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'kraken', companyName: 'Payward', domain: 'payward.com' }, { listed: 4, boardCompanyName: null })).toBe('name_unconfirmed');
    expect(judgeCandidate({ boardToken: 'empty', companyName: 'Empty' }, { listed: 0, boardCompanyName: null })).toBe('empty_board');
    expect(companyNamesMatch('ACME', 'acme')).toBe(true);
    expect(companyNamesMatch('AB', 'Abbott')).toBe(false);
    expect(companyNamesMatch(null, 'Acme')).toBe(false);
    expect(oneWord('Astera Labs')).toBe('asteralabs');
  });

  it('a candidate registered without a company name carries its board id: on Lever and Ashby that confirms nothing, only its domain can', () => {
    // The name IS the board id (an import without a name, a discovered row whose posting named no company).
    expect(judgeCandidate({ boardToken: 'shopback-2', companyName: 'shopback-2' }, { listed: 5, boardCompanyName: null })).toBe('name_unconfirmed');
    expect(judgeCandidate({ boardToken: 'kraken.com', companyName: 'kraken.com' }, { listed: 5, boardCompanyName: null })).toBe('name_unconfirmed');
    expect(judgeCandidate({ boardToken: 'ramp', companyName: 'ramp' }, { listed: 5, boardCompanyName: null })).toBe('name_unconfirmed');
    expect(judgeCandidate({ boardToken: 'ramp', companyName: ' ramp ' }, { listed: 5, boardCompanyName: null })).toBe('name_unconfirmed');
    // An employer we know under that name whose own domain starts with the board id does confirm it.
    expect(judgeCandidate({ boardToken: 'ramp', companyName: 'ramp', domain: 'ramp.com' }, { listed: 5, boardCompanyName: null })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'ramp', companyName: 'ramp', domain: 'rampart.io' }, { listed: 5, boardCompanyName: null })).toBe('name_unconfirmed');
    // A name someone gave still confirms the id it spells.
    expect(judgeCandidate({ boardToken: 'ramp', companyName: 'Ramp' }, { listed: 5, boardCompanyName: null })).toBe('ok');
    // Where the board states its company, a placeholder is judged against that name.
    expect(judgeCandidate({ boardToken: 'acme', companyName: 'acme' }, { listed: 5, boardCompanyName: 'Acme Robotics' })).toBe('ok');
    expect(judgeCandidate({ boardToken: 'acme', companyName: 'acme' }, { listed: 5, boardCompanyName: 'Zenith Foods' })).toBe('name_mismatch');
  });

  it('companyNamesMatch compares whole words: a name is never found inside another word', () => {
    // Equal once normalised, with or without spaces and legal endings.
    expect(companyNamesMatch('Bosch Group', 'BoschGroup')).toBe(true);
    expect(companyNamesMatch('Acme, Inc.', 'ACME')).toBe(true);
    // The shorter name's words are a run of whole words in the longer one: at its start, or inside it.
    expect(companyNamesMatch('Bosch', 'Bosch Group')).toBe(true);
    expect(companyNamesMatch('Acme Robotics', 'Acme Robotics Taiwan')).toBe(true);
    expect(companyNamesMatch('Harbor Foods', 'The Harbor Foods Company of Asia')).toBe(true);
    // Not inside a word, and not words that are apart or out of order.
    expect(companyNamesMatch('Arc', 'Search Party')).toBe(false);
    expect(companyNamesMatch('Box', 'Dropbox')).toBe(false);
    expect(companyNamesMatch('Meta', 'Metabase')).toBe(false);
    expect(companyNamesMatch('Harbor Asia', 'Harbor Foods Asia')).toBe(false);
    expect(companyNamesMatch('Foods Harbor', 'Harbor Foods Group')).toBe(false);
    // A one-word name of fewer than three characters is never "contained".
    expect(companyNamesMatch('GE', 'GE Aerospace')).toBe(false);
    expect(companyNamesMatch('GE', 'ge')).toBe(true);
    // Scripts written without spaces are compared as text: at least three characters, inside the longer name.
    expect(companyNamesMatch('示例科技', '上海示例科技')).toBe(true);
    expect(companyNamesMatch('示例', '示例科技集团')).toBe(false);
    expect(companyNamesMatch('示例科技', '样本网络')).toBe(false);
    expect(judgeCandidate({ boardToken: 'arc', companyName: 'Arc' }, { listed: 9, boardCompanyName: 'Search Party' })).toBe('name_mismatch');
  });
});

// ── Bulk import: reading a file (JI-3; the route is in routes.test.ts) ───

describe('bulk import: reading and checking rows', () => {
  it('reads a CSV with the header ats,boardToken,companyName,countries (countries separated by |) and keeps the file line', () => {
    const csv = ['ats,boardToken,companyName,countries', 'greenhouse,acme,Acme,', '', 'smartrecruiters,BoschGroup,"Bosch, Group",TW|CN', 'lever,pinecloud'].join('\n');
    expect(readImportCsv(csv)).toEqual([
      { line: 2, ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', countries: [''] },
      { line: 4, ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch, Group', countries: ['TW', 'CN'] },
      { line: 5, ats: 'lever', boardToken: 'pinecloud', companyName: undefined, countries: [''] },
    ]);
    // The two required columns in any order and letter case; a byte-order mark is fine.
    expect(readImportCsv('﻿BoardToken,ATS\nacme,greenhouse\n')).toEqual([{ line: 2, ats: 'greenhouse', boardToken: 'acme', companyName: null, countries: [] }]);
    expect(() => readImportCsv('company,token\nAcme,acme\n')).toThrow(/first line must name the columns/);
    expect(() => readImportCsv('ats,boardToken\n"unterminated')).toThrow(/could not be read as CSV/);
  });

  it('checks a row: a known job-board system, a board id inside the pattern, ISO countries; a missing name is left for the board to state', () => {
    const row = (over: Row) => ({ line: 1, ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', countries: [], ...over });
    expect(checkImportRow(row({ ats: ' Greenhouse ', boardToken: ' acme ', countries: ['tw', ' CN ', ''] }))).toEqual({ line: 1, ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', countries: ['CN', 'TW'] });
    expect(checkImportRow(row({ companyName: '  ' }))).toMatchObject({ companyName: null });
    expect(checkImportRow(row({ companyName: null, countries: null }))).toMatchObject({ companyName: null, countries: [] });
    expect(checkImportRow(row({ ats: 'workday' }))).toBe('unknown_job_board');
    expect(checkImportRow(row({ ats: 7 }))).toBe('unknown_job_board');
    expect(checkImportRow(row({ boardToken: '../etc' }))).toBe('invalid_board_id');
    expect(checkImportRow(row({ boardToken: '' }))).toBe('invalid_board_id');
    expect(checkImportRow(row({ countries: ['TWN'] }))).toBe('invalid_country');
    expect(checkImportRow(row({ countries: [7] }))).toBe('invalid_country');
    expect(checkImportRow(row({ countries: 'TW' }))).toBe('unreadable_row');
    expect(checkImportRow(row({ companyName: 42 }))).toBe('unreadable_row');
    expect(checkImportRow(row({ boardToken: undefined }))).toBe('invalid_board_id');
    expect(checkImportRow(row({ boardToken: 12345 }))).toBe('invalid_board_id');
    expect(checkImportRow(row({ ats: undefined }))).toBe('unknown_job_board');
    expect(checkImportRow(row({ companyName: 'x'.repeat(201) }))).toBe('company_name_too_long');
    const many = Array.from({ length: 61 }, (_, i) => `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    expect(checkImportRow(row({ countries: many }))).toBe('too_many_countries');
  });

  it('a JSON list may hold anything: each entry becomes a row that is checked by itself, so one bad entry never refuses the file', () => {
    expect(jsonImportRow({ ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countries: ['TW'], note: 'ignored' }, 4)).toEqual({ line: 4, ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countries: ['TW'] });
    expect(checkImportRow(jsonImportRow({ ats: 'lever' }, 2))).toBe('invalid_board_id');
    expect(checkImportRow(jsonImportRow({ boardToken: 'acme' }, 2))).toBe('unknown_job_board');
    for (const entry of [null, 'greenhouse,acme', 7, ['greenhouse', 'acme'], undefined]) expect(checkImportRow(jsonImportRow(entry, 3)), String(entry)).toBe('unreadable_row');
    // The body accepts such a list; the row limit still holds.
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'json', rows: [{ ats: 'lever' }, null, 7, { ats: 5, boardToken: {} }] }).success).toBe(true);
  });

  it('the body: rows with format json, or csv with format csv; at most 5,000 rows; enable defaults to false', () => {
    const one = { ats: 'greenhouse', boardToken: 'acme' };
    expect(ImportCareerSourcesBodySchema.parse({ format: 'json', rows: [one] })).toMatchObject({ enable: false, rows: [one] });
    expect(ImportCareerSourcesBodySchema.parse({ format: 'csv', csv: 'ats,boardToken\n', enable: true })).toMatchObject({ enable: true });
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'json' }).success).toBe(false);
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'json', csv: 'x' }).success).toBe(false);
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'csv', rows: [one] }).success).toBe(false);
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'json', rows: Array.from({ length: 5000 }, () => one) }).success).toBe(true);
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'json', rows: Array.from({ length: 5001 }, () => one) }).success).toBe(false);
    expect(ImportCareerSourcesBodySchema.safeParse({ format: 'csv', csv: 'x'.repeat(1_000_001) }).success).toBe(false);
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
    // MKT-3E registers the Taiwan open-data set third; this set keeps its place.
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toEqual(['cn', 'ats_public', 'tw_sources']);
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

  it('JT-1: the 台灣就業通 no-figure sentence is negotiable pay on the card, with no amount in the card text', () => {
    const AMOUNT = /\d|[０-９]|[一二三四五六七八九十百千]\s*[萬万]|以上/;
    for (const posted of ['依學經歷、證照核薪(每月經常性薪資達4萬元以上)', '依學經歷、證照核薪（每月經常性薪資達4萬元以上）', '依學經歷、證照核薪(每月經常性薪資達5萬元以上)']) {
      const pay = twCardMeta({ ...TW_JOB, provider: 'tw_open_data', sourceBoard: 'tw_open_data', atsType: null, salaryText: posted })!.pay;
      expect(pay, posted).toEqual({ text: '依學經歷、證照核薪', posted, disclosed: false, negotiable: true });
      expect(pay.text, posted).not.toMatch(AMOUNT);
    }
    // The wording alone, in each form the parser accepts.
    for (const posted of ['依學經歷、證照核薪', '依學經歷', '核薪', '依學經歷核薪', '依学经历', '按公司規定']) {
      expect(twCardMeta({ ...TW_JOB, salaryText: posted })!.pay, posted).toEqual({ text: posted, posted, disclosed: false, negotiable: true });
    }
    // A row with a real figure is disclosed pay: the wording next to it changes nothing.
    expect(twCardMeta({ ...TW_JOB, salaryText: '月薪 45,000~60,000，依學經歷核薪', salaryDisclosed: true })!.pay).toEqual({
      text: '月薪 45,000~60,000，依學經歷核薪',
      posted: '月薪 45,000~60,000，依學經歷核薪',
      disclosed: true,
      negotiable: false,
    });
    // 核薪 inside another word (a field label, payroll work, "reviewing pay") is not wording about this job's pay.
    for (const salaryText of ['核薪方式：月薪', '經人事審核薪資後通知', '負責員工核薪作業與薪資計算', '主管負責部門人員考核薪酬調整', '審核薪水', '核薪人員']) {
      expect(twCardMeta({ ...TW_JOB, salaryText })!.pay.negotiable, salaryText).toBe(false);
    }
  });

  // Review finding: a Taiwan posting whose description lists 核薪 as a duty and states no pay got the pill
  // "pay as posted: 核薪". The normalizer now stores no pay text for it, so the card has nothing to show.
  it('JT-1: a posting that only lists payroll duties gets no pay text and no pay pill (D3)', () => {
    for (const description of ['1. 負責每月薪資核算、核薪、勞健保加退保', '負責員工核薪作業與薪資計算', '主管負責部門人員考核薪酬調整。', '人資將審核薪水並核薪']) {
      const stored = normalizeSalary({ description, country: 'TW', market: 'intl' });
      expect(stored, description).toMatchObject({ salaryText: null, salaryDisclosed: false });
      const pay = twCardMeta({ ...TW_JOB, provider: 'ats_public', salaryText: stored.salaryText, salaryDisclosed: stored.salaryDisclosed, descriptionPlain: description })!.pay;
      expect(pay, description).toEqual({ text: null, posted: null, disclosed: false, negotiable: false });
    }
    // The whole pipeline: an ats_public posting in Taiwan with a duties-only description.
    const job = asMarketHookJob(
      normalizeProviderJob(
        { externalId: 'greenhouse:SYNTHETIC-HR', sourceBoard: 'greenhouse', title: '人資專員', company: 'Formosa Robotics', location: '台北市', locationCountry: 'TW', applyUrl: 'https://boards.greenhouse.io/formosarobotics/jobs/1', description: '工作內容：\n1. 負責每月薪資核算、核薪、勞健保加退保\n2. 人資將審核薪水並核薪' },
        'ats_public',
        { market: 'intl', now: NOW },
      ),
    );
    expect(twCardMeta(job)!.pay).toEqual({ text: null, posted: null, disclosed: false, negotiable: false });
  });

  it('JT-1: the statute\'s own clause standing alone is "pay not listed" and leaves nothing for the card', () => {
    for (const posted of ['每月經常性薪資達4萬元以上', '（每月經常性薪資達4萬元以上）', '經常性薪資達5萬元或以上', '經常性薪資：4萬元以上']) {
      expect(isTwNegotiable(posted, false), posted).toBe(true);
      expect(twNegotiableCardText(posted), posted).toBeNull();
      expect(twCardMeta({ ...TW_JOB, salaryText: posted })!.pay, posted).toEqual({ text: null, posted, disclosed: false, negotiable: true });
    }
    expect(isTwNegotiable('每月經常性薪資達4萬元以上', true)).toBe(false);
  });

  it('JT-1: the Art. 5 clause leaves the card text at any threshold', () => {
    expect(twNegotiableCardText('待遇面議（經常性薪資達4萬元或以上）')).toBe('待遇面議');
    expect(twNegotiableCardText('待遇面議（經常性薪資達5萬元或以上）')).toBe('待遇面議');
    expect(twNegotiableCardText('待遇面議')).toBe('待遇面議');
    expect(twNegotiableCardText('依公司規定')).toBe('依公司規定');
    const ANY_THRESHOLD = /[4-9４-９四五六七八九]\s*[萬万]|[4-9４-９][0０][,，]?[0０]{3}|以上/;
    for (const amount of ['4萬', '5萬', '6萬', '9萬', '5万', '四萬', '五萬', '40,000', '50,000', '50000', '90,000', '５萬', '５０，０００', '５００００']) {
      for (const posted of [
        `待遇面議（經常性薪資達${amount}元或以上）`,
        `面議，經常性薪資達 ${amount} 元以上`,
        `待遇面議 (月薪NT$${amount}以上)`,
        `依公司規定；經常性薪資${amount}元（含）以上`,
        `依學經歷、證照核薪(每月經常性薪資達${amount}元以上)`,
      ]) {
        const card = twCardMeta({ ...TW_JOB, salaryText: posted })!.pay;
        expect(card.negotiable, posted).toBe(true);
        expect(card.disclosed, posted).toBe(false);
        expect(card.text, posted).not.toMatch(ANY_THRESHOLD);
        expect(card.text, posted).toMatch(/^(?:待遇面議|面議|依公司規定|依學經歷、證照核薪)$/);
        expect(card.posted, posted).toBe(posted);
      }
    }
    // Real figures that only end like a threshold, and the top of a range, stay in the text.
    expect(twNegotiableCardText('面議，年薪104萬以上')).toBe('面議，年薪104萬以上');
    expect(twNegotiableCardText('面議，年薪105萬以上')).toBe('面議，年薪105萬以上');
    expect(twNegotiableCardText('面議，月薪150,000以上')).toBe('面議，月薪150,000以上');
    expect(twNegotiableCardText('面議，月薪4.5萬以上')).toBe('面議，月薪4.5萬以上');
    expect(twNegotiableCardText('面議，月薪4萬~5萬以上')).toBe('面議，月薪4萬~5萬以上');
  });

  // Review finding (high, M1 gate): the clause with a period marker ("4萬/月含以上"), an unbracketed 含 or
  // no 以上 stayed on the card, so a negotiable posting printed the statutory threshold.
  it.each([
    ['面議（經常性薪資4萬/月含以上）', '面議'],
    ['面議（經常性薪資5萬/月含以上）', '面議'],
    ['依公司規定（經常性薪資4萬/月含以上）', '依公司規定'],
    ['面議（經常性薪資達4萬元/月以上）', '面議'],
    ['待遇面議（經常性薪資達40,000元／月（含）以上）', '待遇面議'],
    ['面議（經常性薪資達4萬元）', '面議'],
  ])('JT-1: the clause with a period marker, an unbracketed 含 or no 以上 leaves the card: %s', (posted, words) => {
    expect(twNegotiableCardText(posted)).toBe(words);
    expect(twCardMeta({ ...TW_JOB, salaryText: posted })!.pay).toEqual({ text: words, posted, disclosed: false, negotiable: true });
    // The parser agrees: no figure for the same words.
    expect(parseSalaryText(posted, { country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
  });

  it('JT-1: the statute term with an amount and no 以上 is "pay not listed" only next to the wording', () => {
    expect(isTwNegotiable('經常性薪資4萬/月含以上', false)).toBe(true);
    expect(twNegotiableCardText('經常性薪資4萬/月含以上')).toBeNull();
    // An amount the posting states (no 以上, no 面議): not negotiable, and the card keeps the words.
    expect(isTwNegotiable('經常性薪資5萬元', false)).toBe(false);
    expect(twCardMeta({ ...TW_JOB, salaryText: '經常性薪資5萬元' })!.pay).toMatchObject({ text: '經常性薪資5萬元', negotiable: false });
    // A range that starts like the threshold stays on the card.
    expect(twNegotiableCardText('面議，經常性薪資4萬~6萬')).toBe('面議，經常性薪資4萬~6萬');
  });

  // Review finding: an amount in another currency or for another period is not the clause (a month's regular
  // wage in Taiwan dollars): the card keeps the posting's words, as the parser keeps the figure.
  it('JT-1: an amount in another currency or for another period stays in the card text', () => {
    for (const posted of [
      '面議，年薪 USD 60,000 以上',
      '薪金面議，月薪 HK$40,000 以上',
      '面議，月薪 US$ 5萬以上',
      '面議，月薪 RMB 40,000 以上',
      '面議，月薪美金4萬以上',
      '面議，年薪 90,000 以上',
      '面議，時薪 90,000以上',
      '面議，月薪 ￥40,000 以上',
    ]) {
      expect(twNegotiableCardText(posted), posted).toBe(posted);
    }
    // Taiwan dollars, a month: the clause.
    expect(twNegotiableCardText('面議，月薪 NT$50,000 以上')).toBe('面議');
    expect(twNegotiableCardText('面議，月薪台幣5萬以上')).toBe('面議');
    expect(twNegotiableCardText('時薪面議，月薪4萬以上')).toBe('時薪面議');
  });

  it('JT-1: the card and the pay parser read the same wording and the same clause (one rule, in one place)', () => {
    // The hook reads the parser's own patterns (imported from normalize/index.ts since the M1 gate), so
    // the two cannot drift. They agree on real text: "no figure" for the parser is "negotiable" on the card.
    for (const posted of [
      '待遇面議',
      '待遇面議（經常性薪資達4萬元或以上）',
      '待遇面議（經常性薪資達5萬元或以上）',
      '依學經歷、證照核薪(每月經常性薪資達4萬元以上)',
      '依公司規定；經常性薪資四萬元（含）以上',
      '面議，年薪104萬以上',
      '月薪 45,000~60,000，依學經歷核薪',
      '月薪 5萬以上',
      '核薪方式：月薪',
      '面議，月薪5萬以上',
      '面議，月薪 NT$50,000 以上',
      '面議，年薪 USD 60,000 以上',
      '薪金面議，月薪 HK$40,000 以上',
      '面議，年薪 90,000 以上',
      '每月經常性薪資達4萬元以上',
      '（每月經常性薪資達5萬元以上）',
      '負責員工核薪作業與薪資計算',
      '主管負責部門人員考核薪酬調整',
    ]) {
      const parsed = parseSalaryText(posted, { country: 'TW' });
      const disclosed = !!parsed && !parsed.negotiable;
      const card = twCardMeta({ ...TW_JOB, salaryText: posted, salaryDisclosed: disclosed })!.pay;
      expect(card.negotiable, posted).toBe(parsed?.negotiable === true);
      // What the card shows of a "pay not listed" posting carries no figure for the parser either.
      if (card.negotiable && card.text) expect(parseSalaryText(card.text, { country: 'TW' }), posted).toMatchObject({ min: null, max: null, negotiable: true });
      // A figure the parser keeps is a figure the card text keeps.
      if (disclosed) expect(card.text, posted).toBe(posted);
    }
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
