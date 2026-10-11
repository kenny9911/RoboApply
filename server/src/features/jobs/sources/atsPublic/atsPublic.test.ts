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
import { atsPostingKeyFromUrl, normalizeProviderJob, asMarketHookJob, marketOfPosting, type ProviderJobInput } from '../../normalize/index.js';
import { createRapidApiAdapter, rapidApiSearchParams } from '../../ingest/adapters/rapidApi.js';
import { planQueries, tuplesFromFilters } from '../../ingest/planner.js';
import { adaptersForBrand } from '../../ingest/providers.js';
import { adapterCostModel, getSourceAdapter, sourceUserAgent } from '../index.js';
import {
  CareerSourceBodySchema,
  CONNECTOR_DISABLED,
  ImportCareerSourcesBodySchema,
  isBoardTokenFor,
  ListCareerSourcesQuerySchema,
  PatchCareerSourceBodySchema,
  PUBLIC_ATS,
  PUBLIC_ATS_NAMES,
  tenantLabelOf,
  type TwCardMeta,
} from './contract.js';
import {
  ashby,
  connectorEnabled,
  connectorFor,
  CONNECTORS,
  enabledAts,
  greenhouse,
  GREENHOUSE_CHANGE_MARGIN_MS,
  GREENHOUSE_FULL_READ_EVERY_MS,
  greenhouseFullReadDue,
  greenhouseListUrl,
  greenhouseNeedsText,
  greenhouseReadUrl,
  hasPlaceholderName,
  lever,
  leverEu,
  mapGreenhouseJob,
  prioritise,
  smartrecruiters,
  smartRecruitersListUrl,
  SR_MAX_DETAILS,
  type BoardSource,
} from './connectors.js';
import { BEISEN_DISPLAY_FIELDS, BEISEN_PAGE_SIZE, BEISEN_PASSES, BEISEN_READ_KEYS, beisenRequestBody, createBeisenConnector, isOutsideMainland, type ContactStrip } from './connectors/beisen.js';
import { personioHost, personioTime } from './connectors/personio.js';
import { recruiteeTime } from './connectors/recruitee.js';
import { mapWorkableJob, workablePostingUrl } from './connectors/workable.js';
import { createAtsPublicAdapter } from './adapter.js';
import { companyNamesMatch, createBoardDiscovery, DISCOVERY_ATS, DISCOVERY_MEMORY, DISCOVERY_PAUSE_MS, judgeCandidate, oneWord, parsePostingKey } from './discovery.js';
import { API_HOSTS, assertApiHost, BEISEN_HOST_PATTERN, boardRequestHeaders, BoardFetchError, getJson, getXml, postJson, TENANT_HOST_RULES, type FetchLike } from './http.js';
import { childNamed, childrenNamed, childText, elementMarkup, MAX_XML_DEPTH, parseXml } from './xml.js';
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
import { CN_COPY_SUFFIX, copyIdsOf, copySelected, postingIdOf, routeBoardRead, routePosting, selectedCopies, splitPostingByMarket, storedIdsOf } from './market.js';
import { extractPermitTags, MAX_QUOTE_CHARS, quoteInPosting } from './permitTags.js';
import { REMOVED_BOARDS_CONFIG_KEY, REMOVED_BOARDS_MAX, forgetRemovedBoards, readRemovedBoards, rememberRemovedBoard, removedBoardKey } from './removed.js';
import {
  CANDIDATE_MAX_ATTEMPTS,
  candidateRetry,
  classifyBoardError,
  failureStamp,
  firstReadAfterSwitchOn,
  isSkippedBoardError,
  nextReadDelayMs,
  skippedStamp,
  successStamp,
  syncIntervalMs,
  TENANT_DENIED,
  tenantAskedRecently,
  transientAttempt,
  withTenantFloor,
} from './schedule.js';
import { checkImportRow, jsonImportRow, readImportCsv, toView } from './service.js';
import {
  atsSourceName,
  BEISEN_TENANT_FLOOR_MS,
  beisenEnabled,
  beisenMaxPostingsPerRun,
  boardsConcurrency,
  careerSourceState,
  decodeEntities,
  discoveryValidationsPerRun,
  externalIdFor,
  isMainlandOnlyAts,
  LARGE_BOARD_POSTINGS,
  LEVER_MAX_PAGES,
  MAINLAND_ONLY_ATS,
  MAX_RESPONSE_BYTES,
  mergeCountries,
  normalizeCountries,
  smartRecruitersDetailsPerRun,
  sourceCoversCountry,
  sourceFeedsMarket,
  tenantDenied,
  tenantDenylist,
  workableEnabled,
} from './shared.js';
import { CAREER_SOURCE_COLUMNS, closedExternalIds, diffByPostingId, readBoard, storesEveryPosting, toCareerSourceRow, withoutInternationalCopies, type CareerSourceDb, type CareerSourceRow } from './sync.js';
import { atsPublicAdapter } from './register.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtureText = (name: string): string => readFileSync(join(HERE, '__fixtures__', name), 'utf8');
const fixture = (name: string): unknown => JSON.parse(fixtureText(name));
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
    // JI-8: the list call also asks for the pay ranges (`pay_transparency=true`); still ONE request.
    expect(calls).toEqual(['https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs?content=true&pay_transparency=true']);
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
  it('only the vendors\' own API hosts over https (MKT-5B adds Workable\'s and Lever\'s EU instance)', () => {
    expect([...API_HOSTS]).toEqual(['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', 'api.smartrecruiters.com', 'apply.workable.com', 'api.eu.lever.co']);
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
      if (u.hostname === 'api.lever.co' || u.hostname === 'api.eu.lever.co') return { ok: true, status: 200, text: async () => '[]' };
      if (u.hostname.endsWith('.recruitee.com')) return { ok: true, status: 200, text: async () => '{"offers":[]}' };
      if (u.hostname.endsWith('.jobs.personio.de')) return { ok: true, status: 200, text: async () => '<workzag-jobs/>' };
      if (u.hostname === 'api.smartrecruiters.com') {
        const body = /\/postings\/p1$/.test(u.pathname) ? { id: 'p1', jobAd: { sections: { jobDescription: { text: '<p>x</p>' } } } } : { totalFound: 1, content: [{ id: 'p1', name: 'Role', location: { city: 'Taipei', country: 'tw' } }] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'Co', jobs: [] }) };
    };
    for (const c of Object.values(CONNECTORS)) await c.read({ ats: c.ats, boardToken: 'co', companyName: 'co', countryCode: null }, { now: NOW, fetch, env: {} });
    // Every connector that exists without a flag: the four of WP-42 and the four of MKT-5B.
    expect(Object.keys(CONNECTORS)).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu']);
    expect(requests).toBeGreaterThanOrEqual(10);
    expect([...agents]).toEqual([sourceUserAgent('intl', {})]);
  });
});

// ── The registry entry (the board sync is the only reader) ───────────────

describe('ats_public adapter', () => {
  it('stays registered for both markets, as a free cursor source with a kill switch', () => {
    expect(getSourceAdapter('ats_public')).toBe(atsPublicAdapter);
    expect(atsPublicAdapter).toMatchObject({ provider: 'ats_public', kind: 'cursor', markets: ['intl', 'cn'], costModel: 'free' });
    expect(adapterCostModel(atsPublicAdapter)).toBe('free');
    // Every system a connector writes rows for (the rows' `sourceBoard`), the ones added by MKT-5B included.
    expect([...atsPublicAdapter.sourceBoards]).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu', 'beisen']);
    expect([...atsPublicAdapter.sourceBoards]).toEqual([...PUBLIC_ATS]);
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
    expect(calls).toEqual([`${GH_LIST}?content=true&pay_transparency=true`]);
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
    expect(calls).toEqual([`${GH_LIST}?content=true&pay_transparency=true`, 'https://boards-api.greenhouse.io/v1/boards/globalco']);
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
    // The listing without texts, in its own shape (no content, offices or departments).
    const gh = await greenhouse.read(GH, { now: NOW, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': fixture('greenhouse-list.json') }) }, { listOnly: true, firstPage: true });
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

// ═════════════════════════════════════════════════════════════════════════
// MKT-5B (JI-8, JC-8): more board systems. Workable, Recruitee, Personio and
// Lever's EU instance; Greenhouse pay ranges and application deadline; 北森
// tenant boards behind CN_ATS_BEISEN_ENABLED. Every board below is a fake
// fetch over a documented-shape or SYNTHETIC fixture; nothing is requested.
// ═════════════════════════════════════════════════════════════════════════

const BEISEN_ON = { CN_ATS_BEISEN_ENABLED: 'true' };
/** A fetch that answers every request with one body and records what was asked. */
function answering(body: string, seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []): FetchLike {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, text: async () => body };
  };
}
const normalizeAny = (input: ProviderJobInput) => normalizeProviderJob(input, 'ats_public', { now: NOW });

describe('MKT-5B item 1: the list of systems, host rules and board ids', () => {
  it('PUBLIC_ATS holds every system a connector reads, each with a display name; both Lever instances read "Lever"', () => {
    expect([...PUBLIC_ATS]).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu', 'beisen']);
    expect(PUBLIC_ATS_NAMES).toEqual({ greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio', lever_eu: 'Lever', beisen: '北森' });
    expect(atsSourceName('Nordwind', 'lever_eu')).toBe('Nordwind · Lever');
    expect(atsSourceName('示例科技', 'beisen')).toBe('示例科技 · 北森');
    // The older type guard now answers for the whole list.
    for (const ats of PUBLIC_ATS) expect(toCareerSourceRow({ id: 'x', ats }).ats).toBe(ats);
  });

  it.each([
    // The vendors' own API hosts: exact.
    ['https://apply.workable.com/api/v1/widget/accounts/acme?details=true', {}, true],
    ['https://api.eu.lever.co/v0/postings/acme?mode=json', {}, true],
    ['https://www.workable.com/api/v1/widget/accounts/acme', {}, false],
    ['https://apply.workable.com.evil.net/api/v1/widget/accounts/acme', {}, false],
    ['https://jobs.eu.lever.co/acme/1', {}, false],
    // Tenant hosts: one lower-case label in front of the vendor's domain, nothing else.
    ['https://acme.recruitee.com/api/offers/', {}, true],
    ['https://acme-co-2.recruitee.com/api/offers/', {}, true],
    ['https://acme.jobs.personio.de/xml?language=en', {}, true],
    ['https://acme.jobs.personio.com/xml?language=en', {}, true],
    ['https://evil.recruitee.com.example.org/api/offers/', {}, false],
    ['https://recruitee.com.evil.net/api/offers/', {}, false],
    ['https://recruitee.com/api/offers/', {}, false],
    ['https://www.recruitee.com/api/offers/', {}, false],
    ['https://api.recruitee.com/c/1/offers', {}, false],
    ['https://a.b.recruitee.com/api/offers/', {}, false],
    ['https://-acme.recruitee.com/api/offers/', {}, false],
    ['https://acme_co.recruitee.com/api/offers/', {}, false],
    ['https://xrecruitee.com/api/offers/', {}, false],
    ['https://acme.jobs.personio.fr/xml', {}, false],
    ['https://jobs.personio.de/xml', {}, false],
    ['https://acme.personio.de/xml', {}, false],
    ['https://acme.jobs.personio.de.evil.net/xml', {}, false],
    ['https://www.jobs.personio.de/xml', {}, false],
    // https only, no port, no credentials.
    ['http://acme.recruitee.com/api/offers/', {}, false],
    ['https://acme.recruitee.com:8443/api/offers/', {}, false],
    ['https://user:pw@acme.recruitee.com/api/offers/', {}, false],
    // 北森 tenant boards: no rule at all while the flag is off.
    ['https://acme.zhiye.com/api/Jobad/GetJobAdPageList', {}, false],
    ['https://acme.zhiye.com/api/Jobad/GetJobAdPageList', { CN_ATS_BEISEN_ENABLED: 'false' }, false],
    ['https://www.zhiye.com/', {}, false],
    ['https://zhiye.com/', {}, false],
    ['https://acme.zhiye.com/api/Jobad/GetJobAdPageList', BEISEN_ON, true],
    ['https://www.zhiye.com/', BEISEN_ON, false],
    ['https://zhiye.com/', BEISEN_ON, false],
    ['https://evil.zhiye.com.example.org/api/Jobad/GetJobAdPageList', BEISEN_ON, false],
    ['https://a.b.zhiye.com/api/Jobad/GetJobAdPageList', BEISEN_ON, false],
    ['https://evil-zhiye.com/api/Jobad/GetJobAdPageList', BEISEN_ON, false],
    ['https://acme.beisen.com/', BEISEN_ON, false],
  ] as Array<[string, Record<string, string>, boolean]>)('assertApiHost %s with %j -> %s', (url, env, allowed) => {
    if (allowed) expect(assertApiHost(url, env).hostname).toBe(new URL(url).hostname);
    else expect(() => assertApiHost(url, env)).toThrow(/^host_not_allowed:/);
  });

  it('each tenant-host rule is one anchored pattern, and the 北森 rule is not among the standing ones', () => {
    expect(TENANT_HOST_RULES.map((r) => r.ats)).toEqual(['recruitee', 'personio']);
    for (const pattern of [...TENANT_HOST_RULES.map((r) => r.pattern), BEISEN_HOST_PATTERN]) {
      expect(pattern.source.startsWith('^')).toBe(true);
      expect(pattern.source.endsWith('$')).toBe(true);
      expect(pattern.flags).toBe('');
    }
    // Every connector that exists without a flag asks an allowed host with an empty environment.
    for (const c of Object.values(CONNECTORS)) expect(() => assertApiHost(c.boardUrl('token'), {})).not.toThrow();
  });

  it('a board id on a tenant host is the lower-case sub-domain label: an upper-case Personio id is refused, a Workable source passes', () => {
    const body = (ats: string, boardToken: string) => CareerSourceBodySchema.safeParse({ ats, boardToken, companyName: 'Acme' });
    expect(body('workable', 'acme-co').success).toBe(true);
    expect(body('lever_eu', 'AcmeCo').success).toBe(true);
    expect(body('recruitee', 'acme').success).toBe(true);
    expect(body('personio', 'acme').success).toBe(true);
    expect(body('personio', 'acme.com').success).toBe(true);
    expect(body('beisen', 'acme').success).toBe(true);
    const refused = body('personio', 'Acme');
    expect(refused.success).toBe(false);
    expect(refused.error!.issues).toEqual([expect.objectContaining({ path: ['boardToken'], message: 'invalid_board_id' })]);
    for (const [ats, token] of [['personio', 'acme.de'], ['personio', 'acme_co'], ['personio', 'www'], ['personio', '.com'], ['recruitee', 'acme.com'], ['recruitee', 'Acme'], ['recruitee', 'api'], ['recruitee', '-acme'], ['beisen', 'Acme'], ['beisen', 'acme.zhiye'], ['recruitee', 'a'.repeat(64)]] as const) {
      expect(body(ats, token).success, `${ats} ${token}`).toBe(false);
    }
    // The four older systems keep the general pattern (a SmartRecruiters id is written in mixed case).
    expect(body('smartrecruiters', 'BoschGroup').success).toBe(true);
    expect(body('greenhouse', 'Acme_Co.1').success).toBe(true);
    expect(isBoardTokenFor('recruitee', 'a'.repeat(63))).toBe(true);
    expect(isBoardTokenFor('recruitee', 42)).toBe(false);
    expect(tenantLabelOf('personio', 'acme.com')).toBe('acme');
    expect(tenantLabelOf('recruitee', 'acme.com')).toBeNull();
    expect(tenantLabelOf('greenhouse', 'acme')).toBeNull();
    // The import checks a row the same way.
    expect(checkImportRow({ line: 2, ats: 'personio', boardToken: 'Acme', companyName: 'Acme', countries: [] })).toBe('invalid_board_id');
    expect(checkImportRow({ line: 2, ats: 'Personio', boardToken: 'acme', companyName: 'Acme', countries: [] })).toMatchObject({ ats: 'personio', boardToken: 'acme' });
  });

  it('which connectors exist: Workable unless its kill switch is set, 北森 only with its flag; a disabled one cannot be obtained', () => {
    expect(enabledAts({})).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu']);
    expect(enabledAts({ ATS_WORKABLE_DISABLED: 'true', ...BEISEN_ON })).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'personio', 'lever_eu', 'beisen']);
    expect(workableEnabled({})).toBe(true);
    expect(workableEnabled({ ATS_WORKABLE_DISABLED: 'false' })).toBe(true);
    expect(beisenEnabled({})).toBe(false);
    expect(beisenEnabled({ CN_ATS_BEISEN_ENABLED: 'yes' })).toBe(true);
    expect(connectorEnabled('beisen', {})).toBe(false);
    // The registry holds no 北森 object: with an empty environment nothing can build a request to a tenant board.
    expect(Object.keys(CONNECTORS)).not.toContain('beisen');
    expect(() => connectorFor('beisen', {})).toThrow(CONNECTOR_DISABLED);
    expect(() => connectorFor('workable', { ATS_WORKABLE_DISABLED: 'true' })).toThrow(CONNECTOR_DISABLED);
    expect(connectorFor('workable', {}).ats).toBe('workable');
    expect(connectorFor('beisen', BEISEN_ON).ats).toBe('beisen');
    expect(connectorFor('lever_eu', {})).toBe(leverEu);
    // Passed over, not failed: the reason is not a failure class of its own count.
    expect(isSkippedBoardError(CONNECTOR_DISABLED)).toBe(true);
    expect(isSkippedBoardError(TENANT_DENIED)).toBe(true);
    expect(isSkippedBoardError('board_not_found')).toBe(false);
    expect(skippedStamp(NOW, CONNECTOR_DISABLED)).toEqual({ lastError: 'connector_disabled', nextSyncAt: new Date(NOW.getTime() + 24 * 3_600_000) });
  });

  it('a new feed error is a hard failure like its JSON twin: not XML, an id that cannot be a host', () => {
    expect(classifyBoardError('not_xml')).toBe('hard');
    expect(classifyBoardError('invalid_board_id')).toBe('hard');
    expect(classifyBoardError('redirect')).toBe('hard');
  });
});

describe('MKT-5B item 1: the XML reader and getXml', () => {
  it('reads elements by name, CDATA verbatim and entities decoded; skips the declaration, comments and a DOCTYPE', () => {
    const root = parseXml(
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE feed [ <!ENTITY boom "never expanded"> ]>\n<!-- a comment with <tags> -->\n' +
        '<feed xmlns:x="urn:x"><item id="1" note="a > b"><name>Tom &amp; Jerry &#039;s &#x4E2D;&#25991; &boom;</name><value><![CDATA[<p>5 < 6 &amp; raw</p>]]></value><empty/><x:tag>ns</x:tag></item><item><name>second</name></item></feed>',
    );
    expect(root.name).toBe('feed');
    const items = childrenNamed(root, 'item');
    expect(items).toHaveLength(2);
    // Predefined and numeric entities are decoded; an entity the document declares itself is left as written.
    expect(childText(items[0], 'name')).toBe("Tom & Jerry 's 中文 &boom;");
    // CDATA is verbatim: its markup and its &amp; are the value.
    expect(childText(items[0], 'value')).toBe('<p>5 < 6 &amp; raw</p>');
    expect(childNamed(items[0], 'empty')).toMatchObject({ text: '', children: [] });
    expect(childText(items[0], 'empty')).toBeNull();
    expect(childText(items[0], 'x:tag')).toBe('ns');
    expect(childText(items[0], 'missing')).toBeNull();
    expect(childText(items[1], 'name')).toBe('second');
    expect(childrenNamed(null, 'item')).toEqual([]);
  });

  it('an element whose markup is written in unescaped is read from between its tags; text of child elements is not its own', () => {
    const root = parseXml('<a><value><p>Hello <b>there</b></p></value><plain> spaced \n text </plain></a>');
    expect(elementMarkup(childNamed(root, 'value'))).toBe('<p>Hello <b>there</b></p>');
    expect(childNamed(root, 'value')!.text).toBe('');
    expect(elementMarkup(childNamed(root, 'plain'))).toBe('spaced \n text');
    expect(elementMarkup(null)).toBeNull();
  });

  it('is tolerant where a feed is sloppy, and refuses what is not a feed', () => {
    // A missing end tag at the end of the document; an end tag that closes an outer element.
    expect(childText(parseXml('<a><b>x</b><c>y'), 'c')).toBe('y');
    expect(childrenNamed(parseXml('<a><b><c>1</b><b>2</b></a>'), 'b').map((b) => b.text)).toEqual(['', '2']);
    expect(parseXml('<a>1 < 2</a>').text).toBe('1 < 2');
    expect(() => parseXml('')).toThrow('not_xml');
    expect(() => parseXml('just text')).toThrow('not_xml');
    // Deeper than any feed we read: refused, never recursed into.
    expect(() => parseXml('<a>'.repeat(MAX_XML_DEPTH + 1))).toThrow('unexpected_shape');
    expect(parseXml('<a>'.repeat(MAX_XML_DEPTH)).name).toBe('a');
  });

  it('getXml: the same guards as getJson (host, redirect, size), asks for XML and says who is asking', async () => {
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const url = 'https://acme.jobs.personio.de/xml?language=en';
    expect(await getXml(url, { fetch: answering('<workzag-jobs/>', seen), env: {} })).toBe('<workzag-jobs/>');
    expect(seen[0]!.init).toMatchObject({ redirect: 'error', headers: { Accept: 'application/xml, text/xml', 'User-Agent': sourceUserAgent('intl', {}) } });
    expect(seen[0]!.init.method).toBeUndefined();
    // A redirect (what a host that is not a customer's answers) is never followed.
    await expect(getXml(url, { fetch: async () => ({ ok: false, status: 302, text: async () => '' }) })).rejects.toMatchObject({ message: 'redirect', status: 302 });
    await expect(getXml(url, { fetch: async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); } })).rejects.toMatchObject({ message: 'redirect' });
    // An oversized body is refused whole.
    await expect(getXml(url, { fetch: answering(`<a>${'x'.repeat(MAX_RESPONSE_BYTES)}</a>`) })).rejects.toThrow('response_too_large');
    // Not a feed: an HTML page, JSON, nothing.
    for (const body of ['<!DOCTYPE html><html><body>Sign in</body></html>', '<html lang="en"></html>', '{"jobs":[]}', '']) await expect(getXml(url, { fetch: answering(body) })).rejects.toThrow('not_xml');
    await expect(getXml(url, { fetch: async () => ({ ok: false, status: 404, text: async () => '' }) })).rejects.toThrow('board_not_found');
    // A host outside the rules is refused before anything is sent.
    const never: FetchLike = async () => {
      throw new Error('must not be called');
    };
    await expect(getXml('https://acme.jobs.personio.fr/xml', { fetch: never })).rejects.toThrow('host_not_allowed:acme.jobs.personio.fr');
  });

  it('postJson reaches 北森 tenant boards only, and only while the flag is on; it sends no cookie, token or Referer', async () => {
    const never: FetchLike = async () => {
      throw new Error('must not be called');
    };
    const tenant = 'https://acme.zhiye.com/api/Jobad/GetJobAdPageList';
    // Flag off: no request to that domain can be built.
    await expect(postJson(tenant, {}, { fetch: never, env: {} })).rejects.toThrow('host_not_allowed:acme.zhiye.com');
    // Flag on: still not a verb for the systems we read with GET.
    for (const url of ['https://apply.workable.com/api/v1/widget/accounts/acme', 'https://acme.recruitee.com/api/offers/', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs']) {
      await expect(postJson(url, {}, { fetch: never, env: BEISEN_ON }), url).rejects.toThrow(/^host_not_allowed:/);
    }
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    expect(await postJson(tenant, { PageIndex: 0 }, { fetch: answering('{"Data":[],"Count":0}', seen), env: BEISEN_ON, market: 'cn' })).toEqual({ Data: [], Count: 0 });
    expect(seen[0]!.init).toMatchObject({ method: 'POST', body: '{"PageIndex":0}', redirect: 'error' });
    expect(seen[0]!.init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': sourceUserAgent('cn', BEISEN_ON) });
    await expect(postJson(tenant, {}, { fetch: answering('<html>captcha</html>'), env: BEISEN_ON })).rejects.toThrow('not_json');
    await expect(postJson(tenant, {}, { fetch: async () => ({ ok: false, status: 302, text: async () => '' }), env: BEISEN_ON })).rejects.toThrow('redirect');
  });
});

// ── Workable ─────────────────────────────────────────────────────────────

const WK: BoardSource = { ats: 'workable', boardToken: 'tidewater', companyName: 'Tidewater Analytics', countryCode: null };
const WK_URL = 'https://apply.workable.com/api/v1/widget/accounts/tidewater';

describe('MKT-5B item 2: Workable', () => {
  it('reads the widget listing once and maps each posting: apply link, publication day, stated country, remote only where stated', async () => {
    const calls: string[] = [];
    const read = await connectorFor('workable', {}).read(WK, { now: NOW, fetch: fakeFetch({ [WK_URL]: fixture('workable.json') }, calls), env: {} });
    expect(calls).toEqual([`${WK_URL}?details=true`]);
    expect(read).toMatchObject({ complete: true, calls: 1, pendingDetails: 0, failedDetails: 0, boardCompanyName: 'Tidewater Analytics' });
    // The row without a shortcode is not a posting.
    expect(read.listedIds).toEqual(['tidewater:A1B2C3D4E5', 'tidewater:F6G7H8J9K0', 'tidewater:L1M2N3P4Q5']);
    expect(read.inputs[0]).toMatchObject({
      externalId: 'tidewater:A1B2C3D4E5',
      sourceBoard: 'workable',
      title: 'Machine Learning Engineer',
      company: 'Tidewater Analytics',
      sourcePublisher: 'Tidewater Analytics · Workable',
      applyUrl: 'https://apply.workable.com/j/A1B2C3D4E5/apply',
      sourceUrl: 'https://apply.workable.com/tidewater/j/A1B2C3D4E5',
      location: 'Paris, Île-de-France, France',
      // The location the employer hides is not listed.
      locations: ['Paris, Île-de-France, France'],
      locationCity: 'Paris',
      locationCountry: 'FR',
      locationCountryEstimated: false,
      workModel: 'remote',
      employmentType: 'Full-time',
      seniority: 'Mid-Senior level',
      postedAt: '2026-09-02',
      postedAtEstimated: false,
    });
    // No pay field exists: none is mapped.
    for (const input of read.inputs) for (const key of ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryText']) expect(input).not.toHaveProperty(key);
    // Remote only where the board says so.
    expect(read.inputs.map((i) => i.workModel)).toEqual(['remote', null, null]);
    // A posting that states no link falls back to its page under the account; none stated, no publication day.
    expect(read.inputs[2]).toMatchObject({ applyUrl: workablePostingUrl('tidewater', 'L1M2N3P4Q5'), postedAt: null, postedAtEstimated: true, locationCountry: 'TW' });
  });

  it('a place the employer hides is passed on in no field: text, city, region and stated country all come from the first SHOWN place (review finding)', () => {
    const job = (over: Record<string, unknown>) => mapWorkableJob({ title: 'Analyst', shortcode: 'H1', ...over }, WK, NOW)!;
    const berlin = { country: 'Germany', countryCode: 'DE', city: 'Berlin', region: 'Berlin' };
    const paris = { country: 'France', countryCode: 'FR', city: 'Paris', region: 'Île-de-France' };
    // The top-level fields repeat the first entry of `locations[]`, here the hidden one.
    const hiddenFirst = job({ country: 'Germany', city: 'Berlin', state: 'Berlin', locations: [{ ...berlin, hidden: true }, { ...paris, hidden: false }] });
    expect(hiddenFirst).toMatchObject({ location: 'Paris, Île-de-France, France', locations: ['Paris, Île-de-France, France'], locationCity: 'Paris', locationRegion: 'Île-de-France', locationCountry: 'FR', locationCountryEstimated: false });
    expect(JSON.stringify(hiddenFirst)).not.toMatch(/Berlin|Germany|"DE"/);
    expect(normalizeAny(hiddenFirst)).toMatchObject({ locationCountry: 'FR', locationCity: 'Paris' });
    // Every place hidden: the posting states no place (the board's tag stays a weak hint, like on any board).
    const allHidden = job({ country: 'Germany', city: 'Berlin', state: 'Berlin', locations: [{ ...berlin, hidden: true }] });
    expect(allHidden).toMatchObject({ location: null, locations: [], locationCity: null, locationRegion: null });
    expect(allHidden).not.toHaveProperty('locationCountry');
    expect(JSON.stringify(allHidden)).not.toMatch(/Berlin|Germany/);
    // No list of places at all: the top-level fields are the posting's place.
    const topOnly = job({ country: 'Germany', city: 'Berlin', state: 'Berlin' });
    expect(topOnly).toMatchObject({ location: 'Berlin, Germany', locations: ['Berlin, Germany'], locationCity: 'Berlin', locationRegion: 'Berlin', locationCountry: 'DE', locationCountryEstimated: false });
    expect(job({ country: 'Germany', city: 'Berlin', state: 'Berlin', locations: [] })).toMatchObject({ location: 'Berlin, Germany', locationCountry: 'DE' });
    // Shown places in their own order; the first is the posting's own.
    const two = job({ country: 'France', city: 'Paris', state: 'Île-de-France', locations: [{ ...paris, hidden: false }, { ...berlin, hidden: false }] });
    expect(two).toMatchObject({ location: 'Paris, Île-de-France, France', locations: ['Paris, Île-de-France, France', 'Berlin, Germany'], locationCountry: 'FR' });
  });

  it('normalizes to rows with the apply URL, the posted date, the country, and the posting key other sources give the same posting', async () => {
    const read = await connectorFor('workable', {}).read(WK, { now: NOW, fetch: fakeFetch({ [WK_URL]: fixture('workable.json') }), env: {} });
    const [first, second, third] = read.inputs.map(normalizeAny);
    expect(first).toMatchObject({
      provider: 'ats_public',
      sourceBoard: 'workable',
      sourceName: 'Tidewater Analytics · Workable',
      originalSourceName: null,
      applyUrl: 'https://apply.workable.com/j/A1B2C3D4E5/apply',
      atsType: 'workable',
      atsPostingKey: 'workable:tidewater:a1b2c3d4e5',
      market: 'intl',
      locationCountry: 'FR',
      workModel: 'remote',
      employmentType: 'full_time',
      seniority: 'senior',
      salaryDisclosed: false,
      postedAtEstimated: false,
    });
    // A calendar day is the start of that day.
    expect(first!.postedAt!.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(first!.descriptionPlain).toContain('Build & ship models');
    expect(second).toMatchObject({ locationCountry: 'US', workModel: null, employmentType: 'part_time' });
    expect(third).toMatchObject({ locationCountry: 'TW', postedAtEstimated: true, applyUrl: 'https://apply.workable.com/tidewater/j/L1M2N3P4Q5' });
    // The key a JSearch row of the same posting carries (its link names the account and the shortcode).
    expect(atsPostingKeyFromUrl('https://apply.workable.com/tidewater/j/A1B2C3D4E5/')).toBe(first!.atsPostingKey);
  });

  it('a posting absent from the next listing is closed; one answer is the whole board', async () => {
    const stored = boardDb([openRow('workable', 'tidewater:A1B2C3D4E5'), openRow('workable', 'tidewater:GONE000001'), openRow('workable', 'othertenant:A1B2C3D4E5'), openRow('greenhouse', 'tidewater:GONE000001')]);
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'workable', boardToken: 'tidewater', companyName: 'Tidewater Analytics' }), { now: NOW, fetch: fakeFetch({ [WK_URL]: fixture('workable.json') }), env: {} }, BOTH);
    expect(res.error).toBeNull();
    expect(res.read).toMatchObject({ complete: true, calls: 1 });
    expect(res.closedExternalIds).toEqual(['tidewater:GONE000001']);
    expect(res.routed!.byMarket.intl.map((i) => i.externalId)).toEqual(['tidewater:A1B2C3D4E5', 'tidewater:F6G7H8J9K0', 'tidewater:L1M2N3P4Q5']);
  });

  it('with ATS_WORKABLE_DISABLED=true a Workable source is not read: no request, nothing closed, the reason reported', async () => {
    const calls: string[] = [];
    const stored = boardDb([openRow('workable', 'tidewater:GONE000001')]);
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'workable', boardToken: 'tidewater' }), { now: NOW, fetch: fakeFetch({ [WK_URL]: fixture('workable.json') }, calls), env: { ATS_WORKABLE_DISABLED: 'true' } }, BOTH);
    expect(res).toMatchObject({ read: null, routed: null, closedExternalIds: [], calls: 0, error: 'connector_disabled' });
    expect(calls).toEqual([]);
  });

  it('an answer that is not the listing fails the board', async () => {
    await expect(connectorFor('workable', {}).read(WK, { now: NOW, fetch: fakeFetch({ [WK_URL]: { name: 'x' } }), env: {} })).rejects.toThrow('unexpected_shape');
    await expect(connectorFor('workable', {}).read(WK, { now: NOW, fetch: fakeFetch({}), env: {} })).rejects.toThrow('board_not_found');
  });
});

// ── Recruitee and Personio ───────────────────────────────────────────────

const RC: BoardSource = { ats: 'recruitee', boardToken: 'poldermobility', companyName: 'Polder Mobility', countryCode: null };
const RC_URL = 'https://poldermobility.recruitee.com/api/offers/';
const PS: BoardSource = { ats: 'personio', boardToken: 'alpenwerk', companyName: 'Alpenwerk', countryCode: 'DE' };
const PS_URL = 'https://alpenwerk.jobs.personio.de/xml';

describe('MKT-5B item 3: Recruitee', () => {
  it('reads the Careers Site API once and maps each published offer, with pay where the offer gives it', async () => {
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const read = await connectorFor('recruitee', {}).read(RC, { now: NOW, fetch: answering(fixtureText('recruitee.json'), seen), env: {} });
    expect(seen.map((r) => r.url)).toEqual([RC_URL]);
    expect(read).toMatchObject({ complete: true, calls: 1, boardCompanyName: 'Polder Mobility' });
    // The draft and the row without an id are not postings.
    expect(read.listedIds).toEqual(['poldermobility:1853589', 'poldermobility:1853590']);
    expect(read.inputs[0]).toMatchObject({
      sourceBoard: 'recruitee',
      title: 'Backend Developer',
      sourcePublisher: 'Polder Mobility · Recruitee',
      applyUrl: 'https://poldermobility.recruitee.com/o/backend-developer',
      sourceUrl: 'https://poldermobility.recruitee.com/o/backend-developer',
      location: 'Amsterdam, Noord-Holland, Netherlands',
      locations: ['Amsterdam, Noord-Holland, Netherlands', 'Berlin, Germany'],
      locationCountry: 'NL',
      locationCountryEstimated: false,
      workModel: 'hybrid',
      employmentType: 'fulltime permanent',
      salaryMin: 4000,
      salaryMax: 5200,
      salaryCurrency: 'EUR',
      salaryPeriod: 'month',
      postedAt: '2026-09-26T10:46:21Z',
      postedAtEstimated: false,
      expiresAt: '2026-11-15T23:59:59Z',
    });
    // The two HTML parts are one posting.
    expect(read.inputs[0]!.descriptionHtml).toBe('<p>SYNTHETIC description text.</p><ul><li>SYNTHETIC requirement: Go &amp; PostgreSQL</li></ul>');
    // An offer without amounts states no pay; remote as stated; no country invented.
    expect(read.inputs[1]).toMatchObject({ workModel: 'remote', location: null, postedAt: '2026-10-02T08:00:00Z' });
    for (const key of ['salaryMin', 'salaryMax', 'salaryCurrency', 'expiresAt', 'locationCountry']) expect(read.inputs[1]).not.toHaveProperty(key);
    // The offer's mailbox address is never read into a posting.
    expect(JSON.stringify(read.inputs)).not.toMatch(/mailbox|job\.wefd3|@poldermobility/);
  });

  it('normalizes to rows with the apply URL, dates, pay and plain description text', async () => {
    const read = await connectorFor('recruitee', {}).read(RC, { now: NOW, fetch: answering(fixtureText('recruitee.json')), env: {} });
    const [first, second] = read.inputs.map(normalizeAny);
    expect(first).toMatchObject({
      sourceBoard: 'recruitee',
      sourceName: 'Polder Mobility · Recruitee',
      applyUrl: 'https://poldermobility.recruitee.com/o/backend-developer',
      atsType: 'recruitee',
      market: 'intl',
      locationCountry: 'NL',
      workModel: 'hybrid',
      employmentType: 'full_time',
      salaryMin: 4000,
      salaryMax: 5200,
      salaryCurrency: 'EUR',
      salaryPeriod: 'month',
      salaryDisclosed: true,
      postedAtEstimated: false,
    });
    expect(first!.postedAt!.toISOString()).toBe('2026-09-26T10:46:21.000Z');
    expect(first!.expiresAt!.toISOString()).toBe('2026-11-15T23:59:59.000Z');
    // HTML comes out as plain text.
    expect(first!.descriptionPlain).toBe('SYNTHETIC description text.\n\n• SYNTHETIC requirement: Go & PostgreSQL');
    expect(second).toMatchObject({ workModel: 'remote', employmentType: 'part_time', salaryDisclosed: false, expiresAt: null });
  });

  it('reports a complete listing, so a posting that left the board is closed', async () => {
    const stored = boardDb([openRow('recruitee', 'poldermobility:1853589'), openRow('recruitee', 'poldermobility:777')]);
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'recruitee', boardToken: 'poldermobility', companyName: 'Polder Mobility' }), { now: NOW, fetch: answering(fixtureText('recruitee.json')), env: {} }, BOTH);
    expect(res.read!.complete).toBe(true);
    expect(res.closedExternalIds).toEqual(['poldermobility:777']);
  });

  it('times: the documented "YYYY-MM-DD HH:MM:SS UTC" and ISO; anything else is no date', () => {
    expect(recruiteeTime('2026-09-26 10:46:21 UTC')).toBe('2026-09-26T10:46:21Z');
    expect(recruiteeTime('2026-09-26T10:46:21.000Z')).toBe('2026-09-26T10:46:21.000Z');
    expect(recruiteeTime('yesterday')).toBeNull();
    expect(recruiteeTime(null)).toBeNull();
  });
});

describe('MKT-5B item 3: Personio', () => {
  it('reads the XML feed once and maps each position: the tenant\'s own job page, the offices, the sections under their own headings', async () => {
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const read = await connectorFor('personio', {}).read(PS, { now: NOW, fetch: answering(fixtureText('personio.xml'), seen), env: {} });
    expect(seen.map((r) => r.url)).toEqual([`${PS_URL}?language=en`]);
    expect(seen[0]!.init.headers!.Accept).toBe('application/xml, text/xml');
    expect(read).toMatchObject({ complete: true, calls: 1, boardCompanyName: null });
    expect(read.listedIds).toEqual(['alpenwerk:1834171', 'alpenwerk:1834172', 'alpenwerk:1834173']);
    expect(read.inputs[0]).toMatchObject({
      sourceBoard: 'personio',
      title: 'Senior Backend Engineer (m/f/d)',
      company: 'Alpenwerk',
      sourcePublisher: 'Alpenwerk · Personio',
      applyUrl: 'https://alpenwerk.jobs.personio.de/job/1834171',
      sourceUrl: 'https://alpenwerk.jobs.personio.de/job/1834171',
      location: 'Munich',
      locations: ['Munich', 'Berlin', 'Vienna'],
      // Personio states no country: the board's tag stays a weak hint.
      locationCountry: 'DE',
      locationCountryEstimated: true,
      employmentType: ['full-time', 'permanent'],
      seniority: 'experienced',
      postedAt: '2026-09-13T14:10:41+02:00',
      postedAtEstimated: false,
    });
    // CDATA verbatim, the heading's entity decoded then escaped for HTML, the empty section left out.
    expect(read.inputs[0]!.descriptionHtml).toBe(
      "<h3>The Role: How you'll make an impact</h3><p>SYNTHETIC role text with <strong>markup</strong> &amp; an entity kept as written.</p><h3>Requirements</h3><ul><li>SYNTHETIC requirement: 5 < years < 10</li></ul>",
    );
    // Text sent escaped instead of in CDATA is the same markup.
    expect(read.inputs[1]).toMatchObject({ title: 'Working Student People & Culture', descriptionHtml: '<h3>Tasks</h3><p>SYNTHETIC text sent escaped instead of in CDATA.</p>', employmentType: ['part-time', 'permanent'] });
    expect(read.inputs[2]).toMatchObject({ employmentType: ['intern', 'full-time'], descriptionHtml: null, postedAt: null, postedAtEstimated: true });
    // Personio states no pay: none is mapped.
    for (const input of read.inputs) for (const key of ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryText']) expect(input).not.toHaveProperty(key);
  });

  it('normalizes to rows with the apply URL and dates; HTML and CDATA text come out as plain description text', async () => {
    const read = await connectorFor('personio', {}).read(PS, { now: NOW, fetch: answering(fixtureText('personio.xml')), env: {} });
    const [first, second, third] = read.inputs.map(normalizeAny);
    expect(first).toMatchObject({ sourceBoard: 'personio', sourceName: 'Alpenwerk · Personio', applyUrl: 'https://alpenwerk.jobs.personio.de/job/1834171', atsType: 'personio', locationCountry: 'DE', employmentType: 'full_time', salaryDisclosed: false, postedAtEstimated: false });
    expect(first!.postedAt!.toISOString()).toBe('2026-09-13T12:10:41.000Z');
    expect(first!.descriptionPlain).toBe("The Role: How you'll make an impact\nSYNTHETIC role text with markup & an entity kept as written.\nRequirements\n\n• SYNTHETIC requirement: 5 < years < 10");
    expect(second).toMatchObject({ employmentType: 'part_time' });
    expect(second!.descriptionPlain).toBe('Tasks\nSYNTHETIC text sent escaped instead of in CDATA.');
    expect(third).toMatchObject({ employmentType: 'internship', postedAtEstimated: true });
  });

  it('a redirect (a host that is not a customer\'s) fails the read as a hard failure and closes nothing', async () => {
    const stored = boardDb([openRow('personio', 'alpenwerk:1834171'), openRow('personio', 'alpenwerk:1')]);
    const redirecting: FetchLike = async () => ({ ok: false, status: 301, text: async () => '' });
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'personio', boardToken: 'alpenwerk', companyName: 'Alpenwerk' }), { now: NOW, fetch: redirecting, env: {} }, BOTH);
    expect(res).toMatchObject({ read: null, routed: null, closedExternalIds: [], error: 'redirect' });
    expect(classifyBoardError(res.error!)).toBe('hard');
    // The same board, answering: complete, so the posting that left is closed.
    const ok = await readBoard(asDb(stored), sourceRow({ ats: 'personio', boardToken: 'alpenwerk', companyName: 'Alpenwerk' }), { now: NOW, fetch: answering(fixtureText('personio.xml')), env: {} }, BOTH);
    expect(ok.read!.complete).toBe(true);
    expect(ok.closedExternalIds).toEqual(['alpenwerk:1']);
  });

  it('a feed with another root, or an HTML page, is not the feed; an empty feed is an empty board', async () => {
    await expect(connectorFor('personio', {}).read(PS, { now: NOW, fetch: answering('<rss><channel/></rss>'), env: {} })).rejects.toThrow('unexpected_shape');
    await expect(connectorFor('personio', {}).read(PS, { now: NOW, fetch: answering('<!doctype html><html></html>'), env: {} })).rejects.toThrow('not_xml');
    expect(await connectorFor('personio', {}).read(PS, { now: NOW, fetch: answering('<?xml version="1.0"?><workzag-jobs></workzag-jobs>'), env: {} })).toMatchObject({ listedIds: [], complete: true });
  });

  it('a tenant on the .com host is the board id with the .com marker; the offset without its colon is read', async () => {
    expect(personioHost('acme')).toBe('acme.jobs.personio.de');
    expect(personioHost('acme.com')).toBe('acme.jobs.personio.com');
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const read = await connectorFor('personio', {}).read({ ...PS, boardToken: 'alpenwerk.com' }, { now: NOW, fetch: answering(fixtureText('personio.xml'), seen), env: {} });
    expect(seen[0]!.url).toBe('https://alpenwerk.jobs.personio.com/xml?language=en');
    expect(read.inputs[0]).toMatchObject({ externalId: 'alpenwerk.com:1834171', applyUrl: 'https://alpenwerk.jobs.personio.com/job/1834171' });
    expect(personioTime('2016-05-31T12:14:07+0200')).toBe('2016-05-31T12:14:07+02:00');
    expect(personioTime('2024-11-13T14:10:41+00:00')).toBe('2024-11-13T14:10:41+00:00');
    expect(personioTime(null)).toBeNull();
  });
});

// ── Lever EU; Greenhouse pay ranges and deadline ─────────────────────────

describe('MKT-5B item 4: Lever\'s EU instance', () => {
  const EU: BoardSource = { ats: 'lever_eu', boardToken: 'nordwind', companyName: 'Nordwind', countryCode: null };

  it('is the Lever connector on api.eu.lever.co; its rows keep the board name lever_eu and the posting key lever_eu:<site>:<id>', async () => {
    const calls: string[] = [];
    const read = await leverEu.read(EU, { now: NOW, fetch: fakeFetch({ 'https://api.eu.lever.co/v0/postings/nordwind': fixture('lever-eu.json') }, calls), env: {} });
    expect(calls).toEqual(['https://api.eu.lever.co/v0/postings/nordwind?mode=json&skip=0&limit=100']);
    expect(read).toMatchObject({ complete: true, calls: 1, boardCompanyName: null });
    expect(read.inputs[0]).toMatchObject({
      externalId: 'nordwind:7a2b3c4d-0000-4e4e-8c8c-333333333333',
      sourceBoard: 'lever_eu',
      sourcePublisher: 'Nordwind · Lever',
      // The links are the API's own, on the EU instance's host.
      applyUrl: 'https://jobs.eu.lever.co/nordwind/7a2b3c4d-0000-4e4e-8c8c-333333333333/apply',
      sourceUrl: 'https://jobs.eu.lever.co/nordwind/7a2b3c4d-0000-4e4e-8c8c-333333333333',
      // Pay as before: salaryRange and the plain description.
      salaryMin: 65000,
      salaryMax: 85000,
      salaryCurrency: 'EUR',
      salaryText: 'EUR 65,000 to 85,000 a year',
    });
    const jobs = read.inputs.map(normalizeAny);
    expect(jobs.map((j) => [j.sourceBoard, j.atsPostingKey, j.sourceName])).toEqual([
      ['lever_eu', 'lever_eu:nordwind:7a2b3c4d-0000-4e4e-8c8c-333333333333', 'Nordwind · Lever'],
      ['lever_eu', 'lever_eu:nordwind:7a2b3c4d-0000-4e4e-8c8c-444444444444', 'Nordwind · Lever'],
    ]);
    expect(jobs[0]).toMatchObject({ salaryDisclosed: true, salaryPeriod: 'year', atsType: 'lever' });
  });

  it('two tenants with the same site name on the two instances never share a row: different board, different key, different host', async () => {
    const global = await lever.read({ ...EU, ats: 'lever' }, { now: NOW, fetch: fakeFetch({ 'https://api.lever.co/v0/postings/nordwind': fixture('lever.json') }), env: {} });
    const eu = await leverEu.read(EU, { now: NOW, fetch: fakeFetch({ 'https://api.eu.lever.co/v0/postings/nordwind': fixture('lever-eu.json') }), env: {} });
    expect(new Set(global.inputs.map((i) => i.sourceBoard))).toEqual(new Set(['lever']));
    expect(new Set(eu.inputs.map((i) => i.sourceBoard))).toEqual(new Set(['lever_eu']));
    expect(lever.boardUrl('nordwind')).toBe('https://api.lever.co/v0/postings/nordwind?mode=json');
    expect(leverEu.boardUrl('nordwind')).toBe('https://api.eu.lever.co/v0/postings/nordwind?mode=json');
    // The global connector is unchanged by the refactor: the same fixture, the same first request.
    expect(global.inputs[0]).toMatchObject({ sourceBoard: 'lever', sourcePublisher: 'Nordwind · Lever' });
    // Closures of one instance never touch the other's rows.
    const stored = boardDb([openRow('lever', 'nordwind:gone'), openRow('lever_eu', 'nordwind:gone')]);
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'lever_eu', boardToken: 'nordwind', companyName: 'Nordwind' }), { now: NOW, fetch: fakeFetch({ 'https://api.eu.lever.co/v0/postings/nordwind': fixture('lever-eu.json') }), env: {} }, BOTH);
    expect(res.closedExternalIds).toEqual(['nordwind:gone']);
    expect(res.source.ats).toBe('lever_eu');
  });
});

describe('MKT-5B item 4: Greenhouse pay ranges and application deadline', () => {
  const HL: BoardSource = { ats: 'greenhouse', boardToken: 'harborlabs', companyName: 'Harbor Labs', countryCode: null };
  const HL_LIST = 'https://boards-api.greenhouse.io/v1/boards/harborlabs/jobs';

  it('asks the list call for the pay ranges and makes no request per posting', async () => {
    const calls: string[] = [];
    const read = await greenhouse.read(HL, { now: NOW, fetch: fakeFetch({ [HL_LIST]: fixture('greenhouse-pay.json') }, calls), env: {} });
    expect(calls).toEqual([`${HL_LIST}?content=true&pay_transparency=true`]);
    expect(greenhouseReadUrl('harborlabs')).toBe(calls[0]);
    // The address shown to ops is still the listing itself.
    expect(greenhouse.boardUrl('harborlabs')).toBe(`${HL_LIST}?content=true`);
    expect(read.calls).toBe(1);
    expect(read.inputs).toHaveLength(3);
  });

  it('a range of 12000000-15000000 cents USD is 120,000-150,000 USD: the first range with numeric bounds, its title as the pay text', async () => {
    const read = await greenhouse.read(HL, { now: NOW, fetch: fakeFetch({ [HL_LIST]: fixture('greenhouse-pay.json') }), env: {} });
    expect(read.inputs[0]).toMatchObject({ salaryMin: 120000, salaryMax: 150000, salaryCurrency: 'USD', salaryText: 'NYC Salary Range' });
    expect(read.inputs[0]).not.toHaveProperty('expiresAt');
    const job = normalizeAny(read.inputs[0]!);
    expect(job).toMatchObject({ salaryMin: 120000, salaryMax: 150000, salaryCurrency: 'USD', salaryDisclosed: true, salarySource: 'provider', salaryText: 'NYC Salary Range', expiresAt: null });
    // The blurb is prose: it is never the pay text.
    expect(JSON.stringify(read.inputs[0])).not.toContain('blurb');
  });

  it('a stated application_deadline is the posting\'s expiry, and the posting is archived after it; first_published stays the posting date', async () => {
    const read = await greenhouse.read(HL, { now: NOW, fetch: fakeFetch({ [HL_LIST]: fixture('greenhouse-pay.json') }), env: {} });
    expect(read.inputs[1]).toMatchObject({ expiresAt: '2026-10-20T20:00:00Z', postedAt: '2026-10-01T09:00:00-04:00' });
    const job = normalizeAny(read.inputs[1]!);
    expect(job.expiresAt!.toISOString()).toBe('2026-10-20T20:00:00.000Z');
    expect(job.postedAt!.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    // The daily maintenance archives a row whose stated deadline has passed, whatever its source (ingest/maintain.ts).
    expect(job.expiresAt!.getTime()).toBeLessThan(new Date('2026-10-21T00:00:00Z').getTime());
  });

  it('a posting with neither is unchanged from before: no pay field, no expiry, and the description is still read for a pay line', async () => {
    const read = await greenhouse.read(HL, { now: NOW, fetch: fakeFetch({ [HL_LIST]: fixture('greenhouse-pay.json') }), env: {} });
    // A range without a numeric bound gives no pay.
    for (const key of ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryText', 'expiresAt']) expect(read.inputs[2]).not.toHaveProperty(key);
    expect(normalizeAny(read.inputs[2]!)).toMatchObject({ salaryDisclosed: false, expiresAt: null });
    // The older fixture: the keys a live board sends when nothing is set (`[]`, `null`) and a posting without the keys at all.
    const older = await greenhouse.read(GH, { now: NOW, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs': fixture('greenhouse.json') }), env: {} });
    for (const input of older.inputs) for (const key of ['salaryMin', 'salaryMax', 'salaryCurrency', 'expiresAt']) expect(input).not.toHaveProperty(key);
    // Its second posting states pay in its text only: the normalizer still finds it.
    expect(normalizeAny(older.inputs[1]!)).toMatchObject({ salaryMin: 55000, salaryMax: 75000, salaryCurrency: 'TWD', salaryDisclosed: true, salarySource: 'posting_text' });
  });
});

describe('MKT-5B (carry-over M4.7): Greenhouse asks which postings are listed before it asks for the texts', () => {
  const LIST = greenhouseListUrl('globalco');
  /** A posting as the listing WITHOUT texts sends it: no `content`, no `offices`, no `departments` (see __fixtures__/greenhouse-list.json). */
  const light = (id: number, updatedAt: string, location = 'Singapore', extra: Record<string, unknown> = {}) => ({ id, title: 'Software Engineer', absolute_url: `https://boards.greenhouse.io/globalco/jobs/${id}`, location: { name: location }, updated_at: updatedAt, first_published: '2026-09-01T00:00:00Z', ...extra });
  /** The same posting as the listing WITH texts sends it: its text and its offices. */
  const full = (id: number, updatedAt: string, location = 'Singapore', offices: string[] = [location]) => ({ ...light(id, updatedAt, location), content: '&lt;p&gt;SYNTHETIC posting text.&lt;/p&gt;', offices: offices.map((o) => ({ name: o, location: o })) });
  const SAVED = new Date('2026-10-09T22:00:00.000Z');
  /** A board whose two requests are told apart by `content=true`. */
  const board = (lightJobs: unknown[], fullJobs: unknown[], calls: string[]): FetchLike => async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: url.includes('content=true') ? fullJobs : lightJobs }) };
  };

  it('the listing without texts, in the shape a live board sends it, names the postings and does not place them: no offices, no departments, no text', () => {
    const body = fixture('greenhouse-list.json') as { jobs: Array<Record<string, unknown>> };
    // The keys one live board answered with on 2026-10-12 (names only; every value here is SYNTHETIC).
    expect(Object.keys(body.jobs[0]!).sort()).toEqual(['absolute_url', 'application_deadline', 'company_name', 'data_compliance', 'first_published', 'id', 'internal_job_id', 'language', 'location', 'metadata', 'requisition_id', 'title', 'updated_at']);
    for (const job of body.jobs) for (const key of ['offices', 'departments', 'content']) expect(job).not.toHaveProperty(key);
    const mapped = body.jobs.map((j) => mapGreenhouseJob(j, sourceRow() as unknown as BoardSource, NOW)!);
    // All it knows of a place is `location.name`: "APAC" places nothing, and the Singapore office of posting 7 is not in it.
    expect(mapped.map((m) => [m.externalId, m.locations, m.descriptionHtml])).toEqual([['globalco:7', ['Shanghai, China'], null], ['globalco:8', ['APAC'], null]]);
  });

  it('nothing new and no later edit: ONE small request, no inputs, nothing routed; the rows are compared by posting id', async () => {
    const calls: string[] = [];
    const stored = boardDb([openRow('greenhouse', 'globalco:1', SAVED), openRow('greenhouse', 'globalco:2', SAVED), openRow('greenhouse', 'globalco:9', SAVED)]);
    const jobs = [light(1, '2026-10-01T00:00:00Z'), light(2, '2026-10-09T10:00:00Z')];
    const res = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: board(jobs, [], calls), env: {} }, BOTH);
    expect(calls).toEqual([LIST]);
    expect(res.read).toMatchObject({ complete: true, calls: 1, inputs: [], unchangedById: true });
    expect(res.read!.listedIds).toEqual(['globalco:1', 'globalco:2']);
    expect(res.routed!.byMarket).toEqual({ intl: [], cn: [] });
    // The rows the board still lists are marked as seen; the one it dropped is closed.
    expect(res.seenExternalIds).toEqual(['globalco:1', 'globalco:2']);
    expect(res.closedExternalIds).toEqual(['globalco:9']);
  });

  it('a posting we do not hold, or one edited after our copy, makes the second request, and then the whole board is handed on and routed', async () => {
    for (const lightJobs of [
      // A new posting.
      [light(1, '2026-10-01T00:00:00Z'), light(3, '2026-10-09T23:00:00Z')],
      // An edit after we last saved it.
      [light(1, '2026-10-09T23:30:00Z')],
      // An edit just before we last saved it: inside the margin between a read and its write.
      [light(1, new Date(SAVED.getTime() - GREENHOUSE_CHANGE_MARGIN_MS + 60_000).toISOString())],
      // An edit time we cannot read.
      [light(1, 'not a date')],
    ]) {
      const calls: string[] = [];
      const stored = boardDb([openRow('greenhouse', 'globalco:1', SAVED)]);
      const fullJobs = lightJobs.map((j) => full(j.id, j.updated_at));
      const res = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: board(lightJobs, fullJobs, calls), env: {} }, BOTH);
      expect(calls, JSON.stringify(lightJobs)).toEqual([LIST, greenhouseReadUrl('globalco')]);
      expect(res.read).toMatchObject({ complete: true, calls: 2 });
      expect(res.read!.unchangedById).toBeUndefined();
      expect(res.read!.inputs).toHaveLength(lightJobs.length);
      expect(res.read!.inputs[0]!.descriptionHtml).toBe('<p>SYNTHETIC posting text.</p>');
      expect(res.routed!.byMarket.intl).toHaveLength(lightJobs.length);
      expect(res.seenExternalIds).toBeUndefined();
    }
    // An edit well before our copy is not a change.
    const calls: string[] = [];
    const quiet = [light(1, new Date(SAVED.getTime() - GREENHOUSE_CHANGE_MARGIN_MS - 60_000).toISOString())];
    await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1', SAVED)])), sourceRow(), { now: NOW, fetch: board(quiet, [], calls), env: {} }, BOTH);
    expect(calls).toEqual([LIST]);
  });

  it('a posting stored in both markets stays open in both: the listing shows only its Shanghai location and neither row is closed (review finding)', async () => {
    // The whole read stored two rows: the posting's offices are Shanghai and Singapore. The listing without texts
    // knows only "Shanghai, China". Routed, that listing would map to `globalco:7` alone and close `globalco:7#cn`.
    const calls: string[] = [];
    const stored = boardDb([openRow('greenhouse', 'globalco:7', SAVED), openRow('greenhouse', 'globalco:7#cn', SAVED)]);
    const held = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: board([light(7, '2026-10-01T00:00:00Z', 'Shanghai, China')], [], calls), env: {} }, BOTH);
    expect(calls).toEqual([LIST]);
    expect(held.closedExternalIds).toEqual([]);
    expect(held.seenExternalIds).toEqual(['globalco:7', 'globalco:7#cn']);
    // The same for a posting whose only stored row is its mainland copy's twin on the other side, and the reverse.
    for (const only of ['globalco:7', 'globalco:7#cn']) {
      const one = await readBoard(asDb(boardDb([openRow('greenhouse', only, SAVED)])), sourceRow(), { now: NOW, fetch: board([light(7, '2026-10-01T00:00:00Z', 'Shanghai, China')], [], []), env: {} }, BOTH);
      expect(one.closedExternalIds, only).toEqual([]);
      expect(one.seenExternalIds, only).toEqual([only]);
    }
    // When the board stops listing the posting, both of its rows are closed.
    const gone = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: board([], [], []), env: {} }, BOTH);
    expect(gone.read).toMatchObject({ unchangedById: true, complete: true });
    expect(gone.closedExternalIds).toEqual(['globalco:7', 'globalco:7#cn']);
    expect(gone.seenExternalIds).toBeUndefined();
    // The comparison itself.
    expect(diffByPostingId(new Map([['a:1', null], ['a:1#cn', null], ['a:2#cn', null], ['a:3', null]]), ['a:1', 'a:2'])).toEqual({ seen: ['a:1', 'a:1#cn', 'a:2#cn'], closed: ['a:3'] });
    expect([postingIdOf('a:1#cn'), postingIdOf('a:1'), copyIdsOf('a:1')]).toEqual(['a:1', 'a:1', ['a:1', 'a:1#cn']]);
  });

  it('a posting that gains or loses a location was edited: the whole read follows, and its routing opens or closes the mainland copy', async () => {
    // The Shanghai office was removed today: `updated_at` moved, the texts are read, the routed listing closes `#cn`.
    const calls: string[] = [];
    const stored = boardDb([openRow('greenhouse', 'globalco:7', SAVED), openRow('greenhouse', 'globalco:7#cn', SAVED)]);
    const edited = '2026-10-09T23:30:00Z';
    const res = await readBoard(asDb(stored), sourceRow(), { now: NOW, fetch: board([light(7, edited)], [full(7, edited, 'Singapore', ['Singapore'])], calls), env: {} }, BOTH);
    expect(calls).toEqual([LIST, greenhouseReadUrl('globalco')]);
    expect(res.closedExternalIds).toEqual(['globalco:7#cn']);
    expect(res.routed!.byMarket).toMatchObject({ intl: [{ externalId: 'globalco:7' }], cn: [] });
  });

  it('a board read for some countries only is read whole: its rows depend on the offices, which only the whole read states (review finding)', async () => {
    // Read for Taiwan only. The posting's location text is "APAC"; its offices say Taipei.
    let calls: string[] = [];
    const tw = sourceRow({ countries: ['TW'] });
    const twRead = await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:8', SAVED)])), tw, { now: NOW, fetch: board([light(8, '2026-10-01T00:00:00Z', 'APAC')], [full(8, '2026-10-01T00:00:00Z', 'APAC', ['Taipei, Taiwan'])], calls), env: {} }, BOTH);
    expect(calls).toEqual([greenhouseReadUrl('globalco')]);
    expect(twRead.closedExternalIds).toEqual([]);
    expect(twRead.routed!.byMarket.intl.map((i) => i.externalId)).toEqual(['globalco:8']);
    // Read for mainland China only. The location text is "Singapore"; the offices add Shanghai, which is the row we hold.
    calls = [];
    const cn = sourceRow({ countries: ['CN'] });
    const cnRead = await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:10#cn', SAVED)])), cn, { now: NOW, fetch: board([light(10, '2026-10-01T00:00:00Z')], [full(10, '2026-10-01T00:00:00Z', 'Singapore', ['Singapore', 'Shanghai, China'])], calls), env: {} }, BOTH);
    expect(calls).toEqual([greenhouseReadUrl('globalco')]);
    expect(cnRead.closedExternalIds).toEqual([]);
    expect(cnRead.routed!.byMarket.cn.map((i) => i.externalId)).toEqual(['globalco:10#cn']);
    expect(cnRead.routed!.byMarket.intl).toEqual([]);
    // A deployment that writes one market keeps only some postings too: the whole read, as before.
    for (const markets of [['intl'], ['cn']] as const) {
      calls = [];
      await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1', SAVED)])), sourceRow(), { now: NOW, fetch: board([light(1, '2026-10-01T00:00:00Z')], [full(1, '2026-10-01T00:00:00Z')], calls), env: {} }, { markets });
      expect(calls, markets[0]).toEqual([greenhouseReadUrl('globalco')]);
    }
    // The rule in one place: every country, and both markets written here.
    expect(storesEveryPosting({ countries: [] }, ['intl', 'cn'])).toBe(true);
    expect(storesEveryPosting({ countries: ['TW'] }, ['intl', 'cn'])).toBe(false);
    expect(storesEveryPosting({ countries: [] }, ['intl'])).toBe(false);
    expect(storesEveryPosting({ countries: [] }, ['cn'])).toBe(false);
    // The connector by itself takes the first step only when it is told so.
    calls = [];
    await greenhouse.read(GH, { now: NOW, fetch: board([light(1, '2026-10-01T00:00:00Z')], [full(1, '2026-10-01T00:00:00Z')], calls), env: {} }, { known: new Map([['formosarobotics:1', SAVED]]) });
    expect(calls).toEqual([greenhouseReadUrl('formosarobotics')]);
  });

  it('which postings need their text is decided by posting id and edit time, never by where the posting is', () => {
    const known = new Map<string, Date | null>([['globalco:1', SAVED], ['globalco:2#cn', SAVED], ['globalco:3', SAVED], ['globalco:3#cn', new Date(SAVED.getTime() - 3 * 3_600_000)], ['globalco:4', null]]);
    const needs = (id: number, updatedAt: string, extra: Record<string, unknown> = {}) => greenhouseNeedsText(light(id, updatedAt), { externalId: `globalco:${id}`, ...extra }, NOW, known);
    // Held under its own id, or under its mainland copy's alone: nothing to read.
    expect(needs(1, '2026-10-01T00:00:00Z')).toBe(false);
    expect(needs(2, '2026-10-01T00:00:00Z')).toBe(false);
    // Held under neither: new.
    expect(needs(5, '2026-10-01T00:00:00Z')).toBe(true);
    // Two copies: the older one decides whether an edit is later than our copy.
    expect(needs(3, new Date(SAVED.getTime() - 2 * 3_600_000).toISOString())).toBe(true);
    expect(needs(3, new Date(SAVED.getTime() - 4 * 3_600_000).toISOString())).toBe(false);
    // A row we cannot date, or an edit time we cannot read: read it.
    expect(needs(4, '2026-10-01T00:00:00Z')).toBe(true);
    expect(needs(1, '')).toBe(true);
    // A stated deadline that has passed: not kept open, so never "new"; one still ahead is.
    expect(needs(5, '2026-10-01T00:00:00Z', { expiresAt: '2026-10-05T00:00:00Z' })).toBe(false);
    expect(needs(5, '2026-10-01T00:00:00Z', { expiresAt: '2026-10-25T00:00:00Z' })).toBe(true);
  });

  it('a posting whose stated deadline has passed is not kept open, so it does not count as new on every read', async () => {
    const calls: string[] = [];
    const jobs = [light(1, '2026-10-01T00:00:00Z'), light(2, '2026-10-01T00:00:00Z', 'Singapore', { application_deadline: '2026-10-05T00:00:00Z' })];
    await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1', SAVED)])), sourceRow(), { now: NOW, fetch: board(jobs, [], calls), env: {} }, BOTH);
    expect(calls).toEqual([LIST]);
    // A deadline still ahead is an open posting we do not hold.
    const again: string[] = [];
    const ahead = [light(1, '2026-10-01T00:00:00Z'), light(2, '2026-10-01T00:00:00Z', 'Singapore', { application_deadline: '2026-10-25T00:00:00Z' })];
    await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1', SAVED)])), sourceRow(), { now: NOW, fetch: board(ahead, ahead.map((j) => ({ ...j, content: 'x' })), again), env: {} }, BOTH);
    expect(again).toEqual([LIST, greenhouseReadUrl('globalco')]);
  });

  it('a board we hold nothing of, a source still without its name, and a check by hand are read as before', async () => {
    // Nothing stored: the texts at once.
    let calls: string[] = [];
    await readBoard(asDb(boardDb()), sourceRow(), { now: NOW, fetch: board([], [full(1, '2026-10-01T00:00:00Z')], calls), env: {} }, BOTH);
    expect(calls).toEqual([greenhouseReadUrl('globalco')]);
    // Stored rows that were never stamped (written before this rule): the texts at once.
    calls = [];
    await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1')])), sourceRow(), { now: NOW, fetch: board([], [full(1, '2026-10-01T00:00:00Z')], calls), env: {} }, BOTH);
    expect(calls).toEqual([greenhouseReadUrl('globalco')]);
    // A source registered without its company name: the whole read, and the board's own name.
    calls = [];
    const nameless: FetchLike = async (url) => {
      calls.push(url);
      const body = url.endsWith('/boards/globalco') ? { name: 'Global Co Ltd' } : { jobs: [full(1, '2026-10-01T00:00:00Z')] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1', SAVED)])), sourceRow({ companyName: 'globalco' }), { now: NOW, fetch: nameless, env: {} }, BOTH);
    expect(calls).toEqual([greenhouseReadUrl('globalco'), 'https://boards-api.greenhouse.io/v1/boards/globalco']);
    // A check by hand reads the listing only, once, and is never the "nothing to read" answer.
    calls = [];
    const check = await greenhouse.read(GH, { now: NOW, fetch: board([light(1, '2026-10-01T00:00:00Z')], [], calls), env: {} }, { listOnly: true, storesEveryPosting: true, known: new Map([['formosarobotics:1', SAVED]]) });
    expect(calls).toEqual([greenhouseListUrl('formosarobotics')]);
    expect(check.unchangedById).toBeUndefined();
  });

  it('once a week, at an hour of its own for every board, the first read is a whole read whatever the listing says', async () => {
    const week = GREENHOUSE_FULL_READ_EVERY_MS;
    expect(week).toBe(7 * 24 * 3_600_000);
    const known = (at: Date) => new Map<string, Date | null>([['globalco:1', at], ['globalco:2', null]]);
    // Read a moment ago: not due. Read more than a week ago: due.
    expect(greenhouseFullReadDue('globalco', NOW, known(new Date(NOW.getTime() - 60_000)))).toBe(greenhouseFullReadDue('globalco', NOW, known(new Date(NOW.getTime() - 60_000))));
    expect(greenhouseFullReadDue('globalco', NOW, known(new Date(NOW.getTime() - week - 1)))).toBe(true);
    expect(greenhouseFullReadDue('globalco', NOW, new Map([['globalco:1', null]]))).toBe(true);
    // Over any eight days of reads every two hours, exactly one or two reads are whole reads, never none.
    for (const token of ['globalco', 'stripe', 'a', 'formosarobotics']) {
      let last = new Date(NOW.getTime() - 2 * 3_600_000);
      let whole = 0;
      for (let t = NOW.getTime(); t < NOW.getTime() + 8 * 24 * 3_600_000; t += 2 * 3_600_000) {
        if (greenhouseFullReadDue(token, new Date(t), known(last))) whole += 1;
        last = new Date(t);
      }
      expect(whole, token).toBeGreaterThanOrEqual(1);
      expect(whole, token).toBeLessThanOrEqual(2);
    }
    // The boards do not all fall on the same hour.
    const dueAt = (token: string) => {
      let last = new Date(NOW.getTime() - 3_600_000);
      for (let t = NOW.getTime(); ; t += 3_600_000) {
        if (greenhouseFullReadDue(token, new Date(t), known(last))) return t;
        last = new Date(t);
      }
    };
    expect(new Set(['globalco', 'stripe', 'coupang', 'databricks', 'airtable', 'aptoslabs'].map(dueAt)).size).toBeGreaterThan(1);
    // On that read the texts are asked for although the listing shows no change.
    const calls: string[] = [];
    const longAgo = new Date(NOW.getTime() - week - 3_600_000);
    await readBoard(asDb(boardDb([openRow('greenhouse', 'globalco:1', longAgo)])), sourceRow(), { now: NOW, fetch: board([light(1, '2026-01-01T00:00:00Z')], [full(1, '2026-01-01T00:00:00Z')], calls), env: {} }, BOTH);
    expect(calls).toEqual([greenhouseReadUrl('globalco')]);
  });
});

// ── 北森 ───────────────────────────────────────────────────────────────────

describe('MKT-5B item 5: 北森 tenant boards, off until counsel signs off', () => {
  const pages = (fixture('beisen.json') as { pages: Array<{ Count: number; Data: unknown[] }> }).pages;
  const BS: BoardSource = { ats: 'beisen', boardToken: 'shili', companyName: '示例科技', countryCode: null };
  const LIST = 'https://shili.zhiye.com/api/Jobad/GetJobAdPageList';
  /** A SYNTHETIC tenant board of `total` postings in mainland cities; answers by the page the request body asks for. */
  const tenant = (total: number, seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [], city = '上海'): FetchLike => async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body ?? '{}') as { PageIndex: number; PageSize: number };
    const start = body.PageIndex * body.PageSize;
    const Data = Array.from({ length: Math.max(0, Math.min(body.PageSize, total - start)) }, (_, i) => ({ Id: `00000000-0000-4000-8000-${String(start + i).padStart(12, '0')}`, JobAdName: `合成岗位 ${start + i}`, LocNames: [city], Duty: '<p>合成示例。</p>', Require: '', Salary: '面议', PostDateInt: 0, PostDate: '2026-10-01T09:00:00' }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ Count: total, Data }) };
  };
  const noStrip: ContactStrip = (text) => ({ text, removed: 0 });

  it('off by default: with an empty environment no zhiye.com request can be built, by the host guard or by the registry', async () => {
    const never: FetchLike = async () => {
      throw new Error('must not be called');
    };
    expect(() => assertApiHost(LIST, {})).toThrow('host_not_allowed:shili.zhiye.com');
    expect(() => connectorFor('beisen', {})).toThrow('connector_disabled');
    // Even a connector built by hand is stopped by the host guard while the flag is off.
    await expect(createBeisenConnector({ maxPostings: 200, strip: noStrip }).read(BS, { now: NOW, fetch: never, env: {} })).rejects.toThrow('host_not_allowed:shili.zhiye.com');
    // readBoard reports the source as passed over, with no request and nothing closed.
    const calls: string[] = [];
    const res = await readBoard(asDb(boardDb([openRow('beisen', 'shili:x')])), sourceRow({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技' }), { now: NOW, fetch: fakeFetch({}, calls), env: {} }, BOTH);
    expect(res).toMatchObject({ read: null, closedExternalIds: [], calls: 0, error: 'connector_disabled' });
    expect(calls).toEqual([]);
    expect(beisenMaxPostingsPerRun({})).toBe(200);
    expect(beisenMaxPostingsPerRun({ CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN: '50' })).toBe(50);
    expect(beisenMaxPostingsPerRun({ CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN: '0' })).toBe(1);
    expect(beisenMaxPostingsPerRun({ CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN: '999999' })).toBe(2000);
    expect(beisenMaxPostingsPerRun({ CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN: 'many' })).toBe(200);
  });

  it('with the flag on it POSTs the listing as the mainland brand, with the documented body and nothing that identifies a browser session', async () => {
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const read = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: answering(JSON.stringify(pages[0]), seen), env: BEISEN_ON, market: 'cn' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(LIST);
    expect(seen[0]!.init.method).toBe('POST');
    expect(JSON.parse(seen[0]!.init.body!)).toEqual({ PageIndex: 0, PageSize: 50, Category: ['1'], KeyWords: '', SpecialType: 0, PortalId: '', DisplayFields: ['Category', 'Kind', 'LocId', 'PostDate', 'Salary'] });
    expect(beisenRequestBody(BEISEN_PASSES[0]!, 3)).toMatchObject({ PageIndex: 3, PageSize: BEISEN_PAGE_SIZE });
    // Who is asking: GoApply's User-Agent. No cookie, token, signature or Referer.
    expect(seen[0]!.init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': sourceUserAgent('cn', BEISEN_ON) });
    expect(seen[0]!.init.headers!['User-Agent']).toMatch(/^GoApplyJobs\//);
    // The QR-code field is not even asked for.
    expect(BEISEN_DISPLAY_FIELDS).not.toContain('WorkWeChatQrCode');
    expect(read).toMatchObject({ complete: true, calls: 1, boardCompanyName: null, droppedPostings: 1 });
    expect(read.listedIds).toEqual(['shili:0a1b2c3d-1111-4a4a-9b9b-000000000001', 'shili:0a1b2c3d-1111-4a4a-9b9b-000000000002', 'shili:0a1b2c3d-1111-4a4a-9b9b-000000000003']);
  });

  it('every row is market cn, opens the posting\'s page on the employer\'s board, and names the employer and 北森 as its source', async () => {
    const read = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: answering(JSON.stringify(pages[0])), env: BEISEN_ON, market: 'cn' });
    const jobs = read.inputs.map(normalizeAny);
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job).toMatchObject({ market: 'cn', provider: 'ats_public', sourceBoard: 'beisen', sourceName: '示例科技 · 北森', originalSourceName: null, locationCountry: 'CN', atsType: 'beisen' });
      expect(job.applyUrl).toBe(`https://shili.zhiye.com/social/detail?jobAdId=${job.externalId.slice('shili:'.length)}`);
    }
    // The posting located outside mainland China is dropped and counted, never written to either market.
    expect(read.droppedPostings).toBe(1);
    expect(JSON.stringify(read.inputs)).not.toContain('新加坡');
    const routed = routeBoardRead(read, []);
    expect(routed.byMarket.intl).toEqual([]);
    expect(routed.byMarket.cn).toHaveLength(3);
  });

  it('where a posting is: a mainland place the table does not know stays, a place elsewhere is taken out, and a posting with no place left in the mainland is dropped (review findings)', async () => {
    const places = (fixture('beisen.json') as { places: { Count: number; Data: unknown[] } }).places;
    const read = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: answering(JSON.stringify(places)), env: BEISEN_ON, market: 'cn' });
    // Six of the eight are in mainland China. "香港, 台北" and "海外" are not: dropped and counted.
    expect(read).toMatchObject({ complete: true, droppedPostings: 2, listedCount: 6 });
    expect(Object.fromEntries(read.inputs.map((i) => [i.title, i.locations]))).toEqual({
      // A city the place table does not know, and a posting for the whole country: on a mainland employer's board they are in China.
      '合成地点示例 1': ['昆山'],
      '合成地点示例 2': ['全国'],
      // Places on both sides, in either order: the mainland ones only.
      '合成地点示例 3': ['上海'],
      '合成地点示例 4': ['深圳'],
      // No place at all.
      '合成地点示例 7': [],
      '合成地点示例 8': ['义乌', '张家港'],
    });
    expect(read.inputs.find((i) => i.title === '合成地点示例 4')!.location).toBe('深圳');
    // The country is stated for every posting handed on, so the normalizer reads it in China.
    for (const input of read.inputs) expect(input).toMatchObject({ locationCountry: 'CN', locationCountryEstimated: false });
    for (const job of read.inputs.map(normalizeAny)) expect(job).toMatchObject({ market: 'cn', locationCountry: 'CN', sourceBoard: 'beisen' });
    // No place outside the mainland is in what is handed on.
    const everything = JSON.stringify([read.inputs, read.listing]);
    for (const elsewhere of ['香港', '新加坡', '台北', '海外']) expect(everything, elsewhere).not.toContain(elsewhere);
    // Routed, every posting is ONE row of the mainland market under its plain id: no copy for the international market.
    const routed = routeBoardRead(read, []);
    expect(routed.byMarket.intl).toEqual([]);
    expect(routed.byMarket.cn.map((i) => i.externalId)).toEqual(read.listedIds);
    expect(routed.listedIds.some((id) => id.endsWith(CN_COPY_SUFFIX))).toBe(false);
    // readBoard hands on the same: nothing for market intl.
    const res = await readBoard(asDb(boardDb()), sourceRow({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技' }), { now: NOW, fetch: answering(JSON.stringify(places)), env: BEISEN_ON, market: 'cn' }, BOTH);
    expect(res.routed!.byMarket.intl).toEqual([]);
    expect(res.routed!.byMarket.cn).toHaveLength(6);
  });

  it('"outside mainland China" needs positive evidence: the name resolves to another country, or says abroad; an unknown name is not evidence', async () => {
    for (const name of ['香港', '澳门', '台北', '新竹', '高雄', '台湾', '新加坡', '东京', '美国', '德国', '吉隆坡', 'Singapore', 'Hong Kong', '海外', '境外', '国外']) expect(isOutsideMainland(name), name).toBe(true);
    // Cities the place table knows, and mainland cities it does not (the review found 41 of 92 such names dropped).
    const mainland = ['上海', '北京市', '深圳市南山区', '广东省', '昆山', '中山', '金华', '台州', '潍坊', '义乌', '芜湖', '绵阳', '镇江', '盐城', '威海', '桂林', '张家港', '常熟', '江阴', '慈溪', '晋江', '湖州', '嘉兴', '绍兴', '泰州', '扬州', '徐州', '淄博', '烟台', '临沂', '洛阳', '襄阳', '宜昌', '株洲', '赣州', '柳州', '遵义', '咸阳', '包头', '鄂尔多斯'];
    for (const name of [...mainland, '全国', '不限', '远程']) expect(isOutsideMainland(name), name).toBe(false);
    // A tenant board that lists one posting in each: every one is handed on, none is counted as outside.
    const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ Count: mainland.length, Data: mainland.map((city, i) => ({ Id: `city-${i}`, JobAdName: '合成岗位', LocNames: [city] })) }) });
    const read = await createBeisenConnector({ maxPostings: 200, strip: noStrip }).read(BS, { now: NOW, fetch, env: BEISEN_ON, market: 'cn' });
    expect(read).toMatchObject({ complete: true, droppedPostings: 0 });
    expect(read.inputs).toHaveLength(mainland.length);
    for (const job of read.inputs.map(normalizeAny)) expect(job, String(job.location)).toMatchObject({ market: 'cn', locationCountry: 'CN' });
  });

  it('a tenant board never hands on a copy for the international market, whatever the routing says (the second guard)', () => {
    // What the connector never produces: a posting that still names a place on each side.
    const twoSided = posting({ externalId: 'shili:1', sourceBoard: 'beisen', location: '上海', locations: ['上海', '香港'], locationCountry: 'CN', locationCountryEstimated: false });
    const routed = routeBoardRead({ listing: [twoSided], inputs: [twoSided] }, []);
    expect(routed.byMarket.intl.map((i) => i.externalId)).toEqual(['shili:1']);
    const read = { droppedPostings: 1 };
    const kept = withoutInternationalCopies(read, routed);
    expect(kept.byMarket.intl).toEqual([]);
    expect(kept.byMarket.cn.map((i) => i.externalId)).toEqual(['shili:1#cn']);
    expect(read.droppedPostings).toBe(2);
    // Nothing to take out: the routing as it is, nothing counted.
    const clean = routeBoardRead({ listing: [], inputs: [] }, []);
    expect(withoutInternationalCopies(read, clean)).toBe(clean);
    expect(read.droppedPostings).toBe(2);
    // The rules of a mainland tenant board all ask the same list, and such a board feeds the mainland market only.
    expect(MAINLAND_ONLY_ATS).toEqual(['beisen']);
    expect([isMainlandOnlyAts('beisen'), isMainlandOnlyAts('greenhouse'), isMainlandOnlyAts(null)]).toEqual([true, false, false]);
    expect([sourceFeedsMarket({ ats: 'beisen', countries: [] }, 'cn'), sourceFeedsMarket({ ats: 'beisen', countries: [] }, 'intl'), sourceFeedsMarket({ ats: 'beisen', countries: ['SG'] }, 'intl')]).toEqual([true, false, false]);
    expect(sourceFeedsMarket({ ats: 'greenhouse', countries: [] }, 'intl')).toBe(true);
  });

  it('dates and pay as posted: a zone-less time is Beijing time, year 0001 is no date, a bare pair is words and never an amount', async () => {
    const read = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: answering(JSON.stringify(pages[0])), env: BEISEN_ON, market: 'cn' });
    const [first, second, third] = read.inputs.map(normalizeAny);
    // "2026-10-08T09:30:00" on the board is 01:30 UTC.
    expect(first!.postedAt!.toISOString()).toBe('2026-10-08T01:30:00.000Z');
    expect(first).toMatchObject({ postedAtEstimated: false, salaryMin: 25000, salaryMax: 50000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryText: '25K-50K 元/月' });
    // The epoch field is an instant.
    expect(second!.postedAt!.toISOString()).toBe('2026-10-08T05:20:00.000Z');
    // "35-57": kept verbatim, not filterable.
    expect(second).toMatchObject({ salaryText: '35-57', salaryDisclosed: false, salaryMin: null, salaryMax: null });
    // Year 0001: no date. The row shows "last verified", never "posted".
    expect(read.inputs[2]).toMatchObject({ postedAt: null, postedAtEstimated: true });
    expect(third).toMatchObject({ postedAtEstimated: true, salaryText: '面议', salaryDisclosed: false });
  });

  it('the QR field, phone numbers and WeChat ids appear nowhere in the produced inputs: not as a key, not in a text', async () => {
    const read = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: answering(JSON.stringify(pages[0])), env: BEISEN_ON, market: 'cn' });
    const allowed = new Set(['externalId', 'sourceBoard', 'company', 'sourcePublisher', 'applyIsDirect', 'fetchedAt', 'title', 'applyUrl', 'sourceUrl', 'location', 'locations', 'locationCountry', 'locationCountryEstimated', 'salaryText', 'descriptionHtml', 'postedAt', 'postedAtEstimated']);
    for (const input of [...read.inputs, ...read.listing]) for (const key of Object.keys(input)) expect(allowed.has(key), key).toBe(true);
    const everything = JSON.stringify([read.inputs, read.listing]);
    // The fixture carries each of these: in the QR field, in two contact fields and typed into the posting text.
    const raw = JSON.stringify(pages[0]);
    for (const secret of ['synthetic.example.invalid/qr', 'WorkWeChatQrCode', '13800138000', '13900139000', 'synthetic_wx_01', 'synthetic_wx_field', 'ContactPhone', 'ContactWeChat']) {
      expect(raw, secret).toContain(secret);
      expect(everything, secret).not.toContain(secret);
    }
    // The rest of the text is still there, and so is what the normalizer stores from it.
    expect(read.inputs[0]!.descriptionHtml).toContain('负责后端服务的设计与开发');
    const stored = JSON.stringify(read.inputs.map(normalizeAny));
    for (const secret of ['13800138000', '13900139000', 'synthetic_wx', 'qr/0001']) expect(stored).not.toContain(secret);
    // Only the keys the mapper names are ever read from a posting.
    expect([...BEISEN_READ_KEYS].sort()).toEqual(['Duty', 'Id', 'JobAdName', 'LocNames', 'PostDate', 'PostDateInt', 'Require', 'Salary']);
    // The mapper's source names no other key of a posting.
    const mapper = readFileSync(join(HERE, 'connectors', 'beisen.ts'), 'utf8');
    const named = [...mapper.slice(mapper.indexOf('export function mapBeisenPosting'), mapper.indexOf('interface PassRead')).matchAll(/\bj\.([A-Za-z]+)\b/g)].map((m) => m[1]!);
    expect([...new Set([...named, 'PostDateInt', 'PostDate'])].sort()).toEqual([...BEISEN_READ_KEYS].sort());
    expect(mapper).not.toMatch(/j\.WorkWeChatQrCode|j\.Contact|j\.Phone|j\.Mobile|j\.Email/);
  });

  it('a listing longer than the cap is read up to the cap, marked incomplete, and closes nothing', async () => {
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const stored = boardDb([openRow('beisen', 'shili:left-the-board')]);
    const env = { ...BEISEN_ON, CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN: '120' };
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技' }), { now: NOW, fetch: tenant(500, seen), env, market: 'cn' }, BOTH);
    // 120 postings: three pages of 50, asked one after the other.
    expect(seen.map((r) => (JSON.parse(r.init.body!) as { PageIndex: number }).PageIndex)).toEqual([0, 1, 2]);
    expect(res.read).toMatchObject({ complete: false, calls: 3, listedCount: 500 });
    expect(res.read!.inputs).toHaveLength(120);
    expect(res.closedExternalIds).toEqual([]);
    // The default cap is 200: four pages.
    const four: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const capped = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: tenant(1000, four), env: BEISEN_ON, market: 'cn' });
    expect(four).toHaveLength(4);
    expect(capped).toMatchObject({ complete: false, listedCount: 1000 });
    expect(capped.inputs).toHaveLength(200);
    // A board under the cap is complete: what left it is closed.
    const small = await readBoard(asDb(stored), sourceRow({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技' }), { now: NOW, fetch: tenant(60), env: BEISEN_ON, market: 'cn' }, BOTH);
    expect(small.read).toMatchObject({ complete: true, calls: 2 });
    expect(small.closedExternalIds).toEqual(['shili:left-the-board']);
    // Exactly the cap, and the board says that is all of it: complete.
    expect(await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: tenant(200), env: BEISEN_ON, market: 'cn' })).toMatchObject({ complete: true, calls: 4 });
  });

  it('a listing is complete only when it holds as many DISTINCT postings as the board states: a portal that repeats rows closes nothing (review finding)', async () => {
    const row = (n: number) => ({ Id: `id-${n}`, JobAdName: '合成岗位', LocNames: ['上海'] });
    // A portal that counts its pages from 1: PageIndex 0 and 1 both answer the first 50 of its 120 postings.
    const asked: number[] = [];
    const repeating: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body!) as { PageIndex: number };
      asked.push(body.PageIndex);
      const page = Math.max(0, body.PageIndex - 1);
      const Data = Array.from({ length: Math.max(0, Math.min(50, 120 - page * 50)) }, (_, i) => row(page * 50 + i));
      return { ok: true, status: 200, text: async () => JSON.stringify({ Count: 120, Data }) };
    };
    const stored = boardDb([openRow('beisen', 'shili:id-110'), openRow('beisen', 'shili:left-the-board')]);
    const res = await readBoard(asDb(stored), sourceRow({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技' }), { now: NOW, fetch: repeating, env: BEISEN_ON, market: 'cn' }, BOTH);
    // By the page arithmetic the listing ended (3 pages, 150 rows of 120), but only 100 distinct postings were read.
    expect(asked).toEqual([0, 1, 2]);
    expect(res.read).toMatchObject({ complete: false, calls: 3, listedCount: 120 });
    expect(res.read!.inputs).toHaveLength(100);
    // `id-110` is still on the board and was not read: nothing is closed.
    expect(res.closedExternalIds).toEqual([]);
    const once = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const complete = async (body: unknown) => (await createBeisenConnector({ maxPostings: 200, strip: noStrip }).read(BS, { now: NOW, fetch: once(body), env: BEISEN_ON, market: 'cn' })).complete;
    // The board states more, or fewer, postings than it sent: not complete.
    expect(await complete({ Count: 5, Data: [row(1), row(2), row(3)] })).toBe(false);
    expect(await complete({ Count: 2, Data: [row(1), row(2), row(3)] })).toBe(false);
    // The same posting twice: not complete, with or without a stated total.
    expect(await complete({ Count: 3, Data: [row(1), row(2), row(2)] })).toBe(false);
    expect(await complete({ Data: [row(1), row(2), row(2)] })).toBe(false);
    // As many distinct postings as stated (a row without an id counts for itself); or no total and no row twice.
    expect(await complete({ Count: 3, Data: [row(1), row(2), { JobAdName: '合成：缺少 Id' }] })).toBe(true);
    expect(await complete({ Data: [row(1), row(2)] })).toBe(true);
    expect(await complete({ Count: 0, Data: [] })).toBe(true);
  });

  it('an answer that is not the listing (a sign-in prompt, a captcha page, a redirect) is a hard failure and is never worked around', async () => {
    const refused = (fixture('beisen.json') as { refused: unknown }).refused;
    const cases: Array<[FetchLike, string]> = [
      [answering(JSON.stringify(refused)), 'unexpected_shape'],
      [answering('<html><body>请完成验证</body></html>'), 'not_json'],
      [async () => ({ ok: false, status: 302, text: async () => '' }), 'redirect'],
      [async () => ({ ok: false, status: 401, text: async () => '' }), 'http_401'],
      [async () => ({ ok: false, status: 403, text: async () => '' }), 'http_403'],
    ];
    for (const [fetch, error] of cases) {
      let requests = 0;
      const counting: FetchLike = (url, init) => {
        requests += 1;
        return fetch(url, init);
      };
      await expect(connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: counting, env: BEISEN_ON, market: 'cn' }), error).rejects.toThrow(error);
      expect(requests, error).toBe(1);
      expect(classifyBoardError(error), error).toBe('hard');
    }
  });

  it('a tenant on CN_ATS_TENANT_DENYLIST is never asked; a check by hand asks for one page only', async () => {
    const env = { ...BEISEN_ON, CN_ATS_TENANT_DENYLIST: ' Shili , other-co,not a label,' };
    expect(tenantDenylist(env)).toEqual(['other-co', 'shili']);
    expect(tenantDenylist({})).toEqual([]);
    expect(tenantDenied({ ats: 'beisen', boardToken: 'shili' }, env)).toBe(true);
    expect(tenantDenied({ ats: 'beisen', boardToken: 'free' }, env)).toBe(false);
    // The list names tenant boards: a Greenhouse board that happens to share the id is not on it.
    expect(tenantDenied({ ats: 'greenhouse', boardToken: 'shili' }, env)).toBe(false);
    const never: FetchLike = async () => {
      throw new Error('must not be called');
    };
    await expect(connectorFor('beisen', env).read(BS, { now: NOW, fetch: never, env, market: 'cn' })).rejects.toThrow('tenant_denied');
    // An id that cannot be a host label makes no request either.
    await expect(connectorFor('beisen', BEISEN_ON).read({ ...BS, boardToken: 'Shili' }, { now: NOW, fetch: never, env: BEISEN_ON })).rejects.toThrow('invalid_board_id');
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const check = await connectorFor('beisen', BEISEN_ON).read(BS, { now: NOW, fetch: tenant(500, seen), env: BEISEN_ON, market: 'cn' }, { listOnly: true, firstPage: true });
    expect(seen).toHaveLength(1);
    expect(check).toMatchObject({ inputs: [], listedCount: 500, complete: false });
  });

  it('the 30-minute floor: no stamp of a tenant board sets its next read earlier; a source just switched off keeps its archive time', () => {
    expect(BEISEN_TENANT_FLOOR_MS).toBe(30 * 60_000);
    const soon = { lastSyncedAt: NOW, lastError: null, failCount: 0, nextSyncAt: new Date(NOW.getTime()) };
    expect(withTenantFloor({ ats: 'beisen' }, soon, NOW).nextSyncAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
    // Other systems are not held back (a SmartRecruiters backlog continues at the next run).
    expect(withTenantFloor({ ats: 'smartrecruiters' }, soon, NOW)).toBe(soon);
    const later = { ...soon, nextSyncAt: new Date(NOW.getTime() + 2 * 3_600_000) };
    expect(withTenantFloor({ ats: 'beisen' }, later, NOW)).toBe(later);
    const off = failureStamp({ failCount: 2, lastChangeAt: null, lastSyncedAt: null, lastError: null }, { now: NOW, error: 'board_not_found' });
    expect(withTenantFloor({ ats: 'beisen' }, off, NOW)).toBe(off);
    expect(off.enabled).toBe(false);
  });

  it('the 30-minute floor: when a tenant was last asked, and when one that is switched on may first be read', () => {
    const min = (n: number) => new Date(NOW.getTime() + n * 60_000);
    // The time of the last request is `lastSyncedAt` (written before every request to a tenant).
    expect(tenantAskedRecently({ ats: 'beisen', lastSyncedAt: min(-29), nextSyncAt: null }, NOW)).toBe(true);
    expect(tenantAskedRecently({ ats: 'beisen', lastSyncedAt: min(-31), nextSyncAt: null }, NOW)).toBe(false);
    expect(tenantAskedRecently({ ats: 'beisen', lastSyncedAt: min(-31), nextSyncAt: min(10) }, NOW)).toBe(false);
    // A tenant with no read time: never asked, or asked only as a candidate, which then carries the time of its next possible request.
    expect(tenantAskedRecently({ ats: 'beisen', lastSyncedAt: null, nextSyncAt: null }, NOW)).toBe(false);
    expect(tenantAskedRecently({ ats: 'beisen', lastSyncedAt: null, nextSyncAt: min(20) }, NOW)).toBe(true);
    expect(tenantAskedRecently({ ats: 'beisen', lastSyncedAt: null, nextSyncAt: min(-1) }, NOW)).toBe(false);
    // Other systems have no floor.
    expect(tenantAskedRecently({ ats: 'greenhouse', lastSyncedAt: min(-1), nextSyncAt: min(20) }, NOW)).toBe(false);
    // Switching a source on: due at the next board sync, except a tenant that still carries such a time.
    expect(firstReadAfterSwitchOn({ ats: 'greenhouse', nextSyncAt: min(20), disabledAt: null }, NOW)).toBeNull();
    expect(firstReadAfterSwitchOn({ ats: 'beisen', nextSyncAt: null, disabledAt: null }, NOW)).toBeNull();
    expect(firstReadAfterSwitchOn({ ats: 'beisen', nextSyncAt: min(-5), disabledAt: null }, NOW)).toBeNull();
    expect(firstReadAfterSwitchOn({ ats: 'beisen', nextSyncAt: min(20), disabledAt: null }, NOW)).toEqual(min(20));
    // A candidate waiting for a retry hours away is not held longer than the floor.
    expect(firstReadAfterSwitchOn({ ats: 'beisen', nextSyncAt: min(120), disabledAt: null }, NOW)).toEqual(min(30));
    // A tenant that was switched on before (then off): its last request is in `lastSyncedAt`, and on a source
    // switched off by failures `nextSyncAt` is the time its postings are archived, not a read.
    expect(firstReadAfterSwitchOn({ ats: 'beisen', nextSyncAt: min(20), disabledAt: min(-60) }, NOW)).toBeNull();
  });

  it('a second pass (校招) is one more entry once its category is read from a real board: the pass decides the page path, and the cap spans both', async () => {
    // SYNTHETIC category value and path: the real ones are not known and are not shipped.
    const passes = [BEISEN_PASSES[0]!, { category: 'SYNTHETIC-CAMPUS', hire: 'campus' as const, pagePath: '/campus/detail' }];
    const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init });
      const body = JSON.parse(init.body!) as { Category: string[]; PageIndex: number };
      const campus = body.Category[0] === 'SYNTHETIC-CAMPUS';
      const Data = body.PageIndex === 0 ? Array.from({ length: campus ? 3 : 2 }, (_, i) => ({ Id: `${campus ? 'c' : 's'}-${i}`, JobAdName: '合成岗位', LocNames: ['北京'], Duty: '<p>合成示例。</p>' })) : [];
      return { ok: true, status: 200, text: async () => JSON.stringify({ Count: Data.length, Data }) };
    };
    const read = await createBeisenConnector({ maxPostings: 4, passes, strip: noStrip }).read(BS, { now: NOW, fetch, env: BEISEN_ON, market: 'cn' });
    expect(seen.map((r) => (JSON.parse(r.init.body!) as { Category: string[] }).Category[0])).toEqual(['1', 'SYNTHETIC-CAMPUS']);
    expect(read.inputs.map((i) => i.applyUrl)).toEqual([
      'https://shili.zhiye.com/social/detail?jobAdId=s-0',
      'https://shili.zhiye.com/social/detail?jobAdId=s-1',
      'https://shili.zhiye.com/campus/detail?jobAdId=c-0',
      'https://shili.zhiye.com/campus/detail?jobAdId=c-1',
    ]);
    // Four of five: the cap cut the second pass, so the listing is incomplete.
    expect(read).toMatchObject({ complete: false, calls: 2 });
    // The default connector reads the one category the source confirms.
    expect(BEISEN_PASSES).toEqual([{ category: '1', hire: 'social', pagePath: '/social/detail' }]);
  });
});

describe('MKT-5B: the answer limit and large boards', () => {
  it('one answer may hold 48 MB; a board of 600 postings or more is "large" (ingest/boards.ts reads those one at a time)', () => {
    expect(MAX_RESPONSE_BYTES).toBe(48 * 1024 * 1024);
    expect(LARGE_BOARD_POSTINGS).toBe(600);
    // At the densest answer measured (greenhouse/coupang, 2026-10-11: 11,048,005 characters for 673 postings) a board
    // under the "large" line answers with under 10 MB, which six answers in flight were allowed before.
    expect(Math.ceil(11_048_005 / 673) * (LARGE_BOARD_POSTINGS - 1)).toBeLessThan(10 * 1024 * 1024);
    // The three boards that waited for the limit fit under it (31,155,380 and 14,219,219 characters measured).
    expect(31_155_380).toBeLessThan(0.75 * MAX_RESPONSE_BYTES);
    expect(14_219_219).toBeLessThan(0.75 * MAX_RESPONSE_BYTES);
  });
});
