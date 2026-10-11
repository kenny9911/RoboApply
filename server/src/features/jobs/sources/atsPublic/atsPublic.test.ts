// @vitest-environment node
//
// WP-42: public ATS connectors (contract tests against the documented-shape
// fixtures in __fixtures__/, plus any live recordings made with
// __fixtures__/record.ts), the `ats_public` ingest adapter, the Taiwan
// market hooks (sourceName, permit tags with quotes, card meta) and the
// RapidAPI country=tw planner seam. No network, no database.
// Parity wave (PAR-7): the boards serve both markets. A posting belongs to the
// market of its own location (mainland China → cn, anything else → intl); the
// listing is filtered to the source's market BEFORE any cap; a mainland
// SmartRecruiters source lists with country=cn and pages to the end; the
// verified seed list of mainland boards.

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
import { ashby, CONNECTORS, greenhouse, lever, prioritise, smartrecruiters, smartRecruitersListUrl, splitByMarket, SR_MAX_DETAILS, type BoardSource } from './connectors.js';
import { ensureSeedCareerSources, parseSeedFile, SEED_MIN_MAINLAND_POSTINGS, seedBoardsToRegister, seedFileFor, seedStateKey } from './seeds.js';
import { BACKLOG_INTERVAL_MS, MAX_LISTED_PER_BOARD_CN, MAX_POSTINGS_PER_BOARD, SYNC_INTERVAL_MS } from './shared.js';
import { createAtsPublicAdapter, parseBacklogCursor } from './adapter.js';
import { API_HOSTS, assertApiHost, BoardFetchError, getJson, type FetchLike } from './http.js';
import {
  createAtsPublicHooks,
  isTaiwanJob,
  isTwNegotiable,
  mergePermitTags,
  TW_FLOOR_CLAUSE_SOURCE,
  TW_FLOOR_OTHER_PAY_BEFORE_SOURCE,
  TW_FLOOR_STATUTE_SOURCE,
  TW_NEGOTIABLE_SOURCE,
  twCardMeta,
  twNegotiableCardText,
  withAtsSourceName,
} from './hooks.js';
import {
  CJK_NEGOTIABLE_SOURCE,
  normalizeSalary,
  parseSalaryText,
  TW_FLOOR_CLAUSE_SOURCE as PARSER_FLOOR_CLAUSE_SOURCE,
  TW_FLOOR_OTHER_PAY_BEFORE_SOURCE as PARSER_FLOOR_OTHER_PAY_BEFORE_SOURCE,
  TW_FLOOR_STATUTE_SOURCE as PARSER_FLOOR_STATUTE_SOURCE,
} from '../../normalize/salary.js';
import { extractPermitTags, MAX_QUOTE_CHARS, quoteInPosting } from './permitTags.js';
import { atsSourceName, decodeEntities, externalIdFor } from './shared.js';
import { marketOfPosting } from '../../normalize/index.js';
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
  it('is registered for both markets, as a cursor source, unmetered, with a kill switch', () => {
    expect(getSourceAdapter('ats_public')).toBe(atsPublicAdapter);
    expect(atsPublicAdapter).toMatchObject({ provider: 'ats_public', kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] });
    expect(atsPublicAdapter.dailyCallLimit()).toBeNull();
    expect(atsPublicAdapter.transport?.()).toBe('board_api');
    expect(createAtsPublicAdapter({ env: {} }).isEnabled()).toBe(true);
    const off = createAtsPublicAdapter({ env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' } });
    expect(off.isEnabled()).toBe(false);
    expect(off.disabledReason?.()).toBe('kill_switch');
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toContain('ats_public');
    // GoApply's sources: the GoHire bank and the employer boards, never a search API.
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).toEqual(['bank_gohire', 'ats_public']);
  });

  it('reads due boards, stamps them, and reports postings the board no longer lists', async () => {
    const db = createFakePrisma({
      seed: {
        rACareerSiteSource: [source(), source({ id: 'cs2', boardToken: 'fresh', lastSyncedAt: new Date('2026-10-09T23:00:00Z') }), source({ id: 'cs3', enabled: false, boardToken: 'off' })],
        rAJob: [
          { id: 'j1', market: 'intl', sourceBoard: 'greenhouse', externalId: 'formosarobotics:4012345', archivedAt: null, visibility: 'public' },
          { id: 'j2', market: 'intl', sourceBoard: 'greenhouse', externalId: 'formosarobotics:999', archivedAt: null, visibility: 'public' },
          { id: 'j3', market: 'intl', sourceBoard: 'greenhouse', externalId: 'otherco:999', archivedAt: null, visibility: 'public' },
          { id: 'j4', market: 'intl', sourceBoard: 'lever', externalId: 'formosarobotics:777', archivedAt: null, visibility: 'public' },
          // The other market's row of the same board is not this run's to close.
          { id: 'j5', market: 'cn', sourceBoard: 'greenhouse', externalId: 'formosarobotics:cn1', archivedAt: null, visibility: 'public' },
        ],
      },
    });
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch(GH_ROUTE), env: {} });
    const res = await adapter.fetch(QUERY, { now: NOW });
    expect(res.error).toBeUndefined();
    expect(res.jobs.map((j) => j.externalId)).toEqual(['formosarobotics:4012345', 'formosarobotics:4012399']);
    expect(res.closedExternalIds).toEqual(['formosarobotics:999']);
    expect(res.closeReason).toBe('source_removed');
    expect(res.notes).toEqual({ boards_read: 1 });
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

  it('answers exhausted:false while more boards are due; a run reads only the boards of its own market', async () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => source({ id: `cs${i}`, boardToken: `b${i}` })), source({ id: 'cn1', market: 'cn', boardToken: 'cnboard', countryCode: 'CN' })];
    const db = createFakePrisma({ seed: { rACareerSiteSource: rows, rAJob: [] } });
    const calls: string[] = [];
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch({}, calls), env: {} });
    const res = await adapter.fetch(QUERY, { now: NOW });
    expect(res.exhausted).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls.some((u) => u.includes('cnboard'))).toBe(false);
    calls.length = 0;
    const cn = await adapter.fetch({ ...QUERY, market: 'cn' }, { now: NOW });
    expect(calls).toEqual(['https://boards-api.greenhouse.io/v1/boards/cnboard/jobs?content=true']);
    expect(cn).toMatchObject({ jobs: [], exhausted: true, notes: { boards_read: 1, board_errors: 1 } });
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

// ── Both markets: a posting belongs to the market of its own location ─────

/** A Greenhouse listing entry located where `location` says. */
function ghJob(id: number, location: string, title = 'Software Engineer') {
  return { id, title, absolute_url: `https://boards.greenhouse.io/globalco/jobs/${id}`, location: { name: location }, content: '&lt;p&gt;Build things.&lt;/p&gt;', first_published: '2026-10-01T00:00:00Z' };
}
const GLOBAL_CN: BoardSource = { ats: 'greenhouse', boardToken: 'globalco', companyName: 'Global Co', countryCode: 'CN' };
const GLOBAL_ROUTE = (jobs: unknown[]) => ({ 'https://boards-api.greenhouse.io/v1/boards/globalco/jobs': { jobs } });

describe('market by posting location (mainland China → cn, anything else → intl)', () => {
  it('marketOfPosting reads the posting\'s own location; Hong Kong, Macau, Taiwan and a board tag alone are not mainland', () => {
    const at = (location: string, over: Partial<ProviderJobInput> = {}) => marketOfPosting({ externalId: 'x', title: 't', company: 'c', location, ...over });
    for (const loc of ['上海', 'Shanghai, China', 'Suzhou, Jiangsu, China', '北京市海淀区', 'Shenzhen', 'China']) expect(at(loc)).toBe('cn');
    for (const loc of ['Singapore', 'Hong Kong SAR, China', 'Hong Kong, Hong Kong, China', '香港', 'Macau, China', 'Taipei, Taiwan', 'Taiwan, China', 'Remote', 'San Francisco, CA', '']) expect(at(loc)).toBe('intl');
    // The board's own country tag is a weak hint: it never makes a posting mainland on its own.
    expect(at('Remote', { locationCountry: 'CN', locationCountryEstimated: true })).toBe('intl');
    // The provider's own country for this posting does (SmartRecruiters states it per posting)…
    expect(at('Wuxi', { locationCountry: 'cn' })).toBe('cn');
    // …unless the place is Hong Kong, which SmartRecruiters files under country cn.
    expect(at('Hong Kong, Hong Kong, China', { locationCountry: 'cn', locationCity: 'Hong Kong' })).toBe('intl');
  });

  it('a 上海 posting from a cn source lands in market cn with the employer\'s own apply URL; a Singapore posting from the same source is skipped as wrong_market', async () => {
    const db = createFakePrisma({ seed: { rACareerSiteSource: [source({ id: 'cn1', market: 'cn', boardToken: 'globalco', companyName: 'Global Co', countryCode: 'CN' })], rAJob: [] } });
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch(GLOBAL_ROUTE([ghJob(1, '上海', '数据分析师'), ghJob(2, 'Singapore')])), env: {} });
    const res = await adapter.fetch({ ...QUERY, market: 'cn' }, { now: NOW });
    expect(res.jobs.map((j) => j.externalId)).toEqual(['globalco:1']);
    expect(res.notes).toMatchObject({ boards_read: 1, wrong_market: 1 });
    const job = normalizeProviderJob(res.jobs[0]!, 'ats_public', { market: 'cn', now: NOW });
    expect(job).toMatchObject({ market: 'cn', locationCountry: 'CN', locationCity: '上海', applyUrl: 'https://boards.greenhouse.io/globalco/jobs/1', sourceBoard: 'greenhouse', fromRecruiterBank: false });
    // The source name is the employer and its job board, on GoApply too.
    expect((await afterNormalize(asMarketHookJob(job), { brand: 'goapply', market: 'cn', stage: 'ingest' })).sourceName).toBe('Global Co · Greenhouse');
    // The listing count and the closure check are the mainland postings only.
    expect(db.$rows('rACareerSiteSource')[0]).toMatchObject({ lastJobCount: 1 });
  });

  it('the same 上海 posting read through an intl source is skipped the same way and never handed to RoboApply\'s index', async () => {
    const db = createFakePrisma({ seed: { rACareerSiteSource: [source({ id: 'i1', market: 'intl', boardToken: 'globalco', companyName: 'Global Co', countryCode: null })], rAJob: [] } });
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch(GLOBAL_ROUTE([ghJob(1, '上海'), ghJob(2, 'Singapore')])), env: {} });
    const res = await adapter.fetch(QUERY, { now: NOW });
    expect(res.jobs.map((j) => j.externalId)).toEqual(['globalco:2']);
    expect(res.notes).toMatchObject({ wrong_market: 1 });
    // And the normalizer itself would refuse it: its market is its location, whatever market reads the board.
    expect(normalizeProviderJob(await greenhouse.read(GLOBAL_CN, { now: NOW, fetch: fakeFetch(GLOBAL_ROUTE([ghJob(1, '上海')])) }).then((r) => r.inputs[0]!), 'ats_public', { market: 'intl', now: NOW }).market).toBe('cn');
  });

  it('the mainland filter runs before the per-board cap: a board of 800 postings with 5 mainland ones stores all 5 in one run', async () => {
    const mainland = new Map([[120, '上海'], [333, 'Beijing, China'], [512, 'Shenzhen, Guangdong, China'], [640, '杭州'], [799, 'Chengdu, China']]);
    const jobs = Array.from({ length: 800 }, (_, i) => ghJob(i, mainland.get(i) ?? 'Berlin, Germany'));
    const read = await greenhouse.read(GLOBAL_CN, { now: NOW, fetch: fakeFetch(GLOBAL_ROUTE(jobs)) }, { market: 'cn' });
    expect(read.inputs.map((i) => i.externalId)).toEqual([...mainland.keys()].map((id) => `globalco:${id}`));
    expect(read.listedIds).toHaveLength(5);
    expect(read).toMatchObject({ wrongMarket: 795, pending: 0, complete: true });
    // Without the filter the cap alone would have cut the listing at the first 500 and dropped two of them every run.
    expect((await greenhouse.read(GLOBAL_CN, { now: NOW, fetch: fakeFetch(GLOBAL_ROUTE(jobs)) })).inputs).toHaveLength(MAX_POSTINGS_PER_BOARD);
    // The international reading of the same board never spends its cap on the mainland postings.
    const intl = await greenhouse.read({ ...GLOBAL_CN, countryCode: null }, { now: NOW, fetch: fakeFetch(GLOBAL_ROUTE(jobs)) }, { market: 'intl' });
    expect(intl).toMatchObject({ wrongMarket: 5, pending: 795 - MAX_POSTINGS_PER_BOARD });
    expect(intl.inputs.some((i) => mainland.has(Number(i.externalId.split(':')[1])))).toBe(false);
  });

  it('Lever: a mainland source pages the listing past the input cap, so a posting on page 8 is found', async () => {
    const calls: string[] = [];
    const page = (skip: number) => Array.from({ length: skip < 700 ? 100 : 40 }, (_, i) => ({ id: `p${skip + i}`, text: 'Engineer', hostedUrl: `https://jobs.lever.co/bigco/p${skip + i}`, categories: { location: skip + i === 733 ? 'Shanghai' : 'Berlin' }, country: skip + i === 733 ? 'CN' : 'DE', createdAt: 1_760_000_000_000 }));
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(page(Number(new URL(url).searchParams.get('skip')))) };
    };
    const big: BoardSource = { ats: 'lever', boardToken: 'bigco', companyName: 'Big Co', countryCode: 'CN' };
    const cn = await lever.read(big, { now: NOW, fetch }, { market: 'cn' });
    expect(cn.inputs.map((i) => i.externalId)).toEqual(['bigco:p733']);
    expect(cn).toMatchObject({ complete: true, wrongMarket: 739, calls: 8 });
    // RoboApply's reading keeps today's listing cap (5 pages).
    calls.length = 0;
    const intl = await lever.read(big, { now: NOW, fetch }, { market: 'intl' });
    expect(calls).toHaveLength(MAX_POSTINGS_PER_BOARD / 100);
    expect(intl.complete).toBe(false);
  });

  it('SmartRecruiters: a cn source lists with country=cn, pages to the end and reports a complete listing; the posting texts stay capped per run', async () => {
    expect(smartRecruitersListUrl('BoschGroup', 200, 'cn')).toBe('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=200&country=cn');
    expect(smartRecruitersListUrl('BoschGroup', 0, 'intl')).toBe('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=0');
    const total = 1322;
    const listCalls: string[] = [];
    let details = 0;
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/postings')) {
        listCalls.push(url);
        const offset = Number(u.searchParams.get('offset'));
        const content = Array.from({ length: Math.min(100, total - offset) }, (_, i) => ({ id: `id${offset + i}`, name: '软件工程师', releasedDate: '2026-10-09T00:00:00.000Z', location: { city: 'Suzhou', region: 'Jiangsu', country: 'cn', fullLocation: 'Suzhou, Jiangsu, China' } }));
        return { ok: true, status: 200, text: async () => JSON.stringify({ totalFound: total, limit: 100, offset, content }) };
      }
      details += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobAd: { sections: { jobDescription: { title: '职位描述', text: '<p>负责软件开发。</p>' } } }, applyUrl: `https://jobs.smartrecruiters.com/BoschGroup/${u.pathname.split('/').pop()}` }) };
    };
    const bosch: BoardSource = { ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countryCode: 'CN' };
    const read = await smartrecruiters.read(bosch, { now: NOW, fetch }, { market: 'cn', known: new Map() });
    expect(listCalls).toHaveLength(14);
    expect(listCalls.every((u) => u.includes('country=cn'))).toBe(true);
    expect(read.complete).toBe(true);
    expect(read.listedIds).toHaveLength(total);
    expect(details).toBe(SR_MAX_DETAILS);
    expect(read.inputs).toHaveLength(SR_MAX_DETAILS);
    expect(read.pending).toBe(total - SR_MAX_DETAILS);
    expect(normalizeProviderJob(read.inputs[0]!, 'ats_public', { now: NOW })).toMatchObject({ market: 'cn', locationCountry: 'CN', applyUrl: 'https://jobs.smartrecruiters.com/BoschGroup/id0' });
    expect(MAX_LISTED_PER_BOARD_CN).toBeGreaterThanOrEqual(3000);
    // An international source sends no country filter and keeps today's listing cap.
    listCalls.length = 0;
    const intl = await smartrecruiters.read({ ...bosch, countryCode: null }, { now: NOW, fetch }, { market: 'intl', listOnly: true });
    expect(listCalls).toHaveLength(MAX_POSTINGS_PER_BOARD / 100);
    expect(listCalls.some((u) => u.includes('country='))).toBe(false);
    expect(intl).toMatchObject({ complete: false, wrongMarket: MAX_POSTINGS_PER_BOARD });
  });

  it('lastSyncedAt is always the time of the read, also for a board with postings still unread (review fix)', async () => {
    const jobs = Array.from({ length: MAX_POSTINGS_PER_BOARD + 20 }, (_, i) => ghJob(i, '上海'));
    const row = source({ id: 'cn1', market: 'cn', boardToken: 'globalco', companyName: 'Global Co', countryCode: 'CN' });
    const db = createFakePrisma({ seed: { rACareerSiteSource: [row], rAJob: [] } });
    const res = await readCareerSource(db as never, row as never, { now: NOW, fetch: fakeFetch(GLOBAL_ROUTE(jobs)) });
    expect(res.read).toMatchObject({ pending: 20 });
    expect((db.$rows('rACareerSiteSource')[0]!.lastSyncedAt as Date).getTime()).toBe(NOW.getTime());
    // On its own the row is due after the usual interval only.
    expect(await dueCareerSources(db as never, 'cn', new Date(NOW.getTime() + BACKLOG_INTERVAL_MS + 1), 5)).toHaveLength(0);
    expect(await dueCareerSources(db as never, 'cn', new Date(NOW.getTime() + SYNC_INTERVAL_MS + 1), 5)).toHaveLength(1);
    // Named as a backlog board it is due after the backlog interval, not before, and never twice.
    expect(await dueCareerSources(db as never, 'cn', new Date(NOW.getTime() + BACKLOG_INTERVAL_MS - 1), 5, { backlogIds: ['cn1'] })).toHaveLength(0);
    expect(await dueCareerSources(db as never, 'cn', new Date(NOW.getTime() + BACKLOG_INTERVAL_MS + 1), 5, { backlogIds: ['cn1'] })).toHaveLength(1);
    expect(await dueCareerSources(db as never, 'cn', new Date(NOW.getTime() + SYNC_INTERVAL_MS + 1), 5, { backlogIds: ['cn1', 'cn1'] })).toHaveLength(1);
    // A backlog id of the other market, or of a board that is off, is never due through the list.
    expect(await dueCareerSources(db as never, 'intl', new Date(NOW.getTime() + BACKLOG_INTERVAL_MS + 1), 5, { backlogIds: ['cn1'] })).toHaveLength(0);
  });

  it('the adapter remembers a mainland backlog board in its cursor and reads it again after 30 minutes; an international board keeps 6 hours', async () => {
    const many = Array.from({ length: MAX_POSTINGS_PER_BOARD + 20 }, (_, i) => ghJob(i, '上海'));
    const cnRow = source({ id: 'cn1', market: 'cn', boardToken: 'globalco', companyName: 'Global Co', countryCode: 'CN', lastSyncedAt: null });
    const db = createFakePrisma({ seed: { rACareerSiteSource: [cnRow], rAJob: [] } });
    const adapter = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch(GLOBAL_ROUTE(many)), env: {} });
    const query = (cursor?: string) => ({ id: 'q', provider: 'ats_public' as const, market: 'cn' as const, origin: 'bank_sync' as const, params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) } });

    const first = await adapter.fetch(query(), { now: NOW });
    expect(first.notes).toMatchObject({ boards_read: 1, board_backlog: 20 });
    expect(first.cursor).toBe('backlog:cn1');
    expect(parseBacklogCursor(first.cursor)).toEqual(['cn1']);
    expect((db.$rows('rACareerSiteSource')[0]!.lastSyncedAt as Date).getTime()).toBe(NOW.getTime());

    // 10 minutes later: not due. 31 minutes later: read again. Nothing to write when the list did not change.
    const soon = await adapter.fetch(query(first.cursor!), { now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(soon.notes).toEqual({});
    expect(soon.cursor).toBeNull();
    const later = new Date(NOW.getTime() + BACKLOG_INTERVAL_MS + 60_000);
    const second = await adapter.fetch(query(first.cursor!), { now: later });
    expect(second.notes).toMatchObject({ boards_read: 1 });
    expect((db.$rows('rACareerSiteSource')[0]!.lastSyncedAt as Date).getTime()).toBe(later.getTime());
    expect(second.cursor).toBeNull();

    // Once a read leaves nothing unread the board leaves the list (an emptied list is written as "backlog:").
    const few = createAtsPublicAdapter({ db: () => db as never, fetch: fakeFetch(GLOBAL_ROUTE([ghJob(1, '上海')])), env: {} });
    const done = await few.fetch(query('backlog:cn1'), { now: new Date(later.getTime() + BACKLOG_INTERVAL_MS + 60_000) });
    expect(done.cursor).toBe('backlog:');
    expect(parseBacklogCursor(done.cursor)).toEqual([]);
    // A removed or switched-off board is dropped from the list without being read.
    const gone = await few.fetch(query('backlog:cn1,deleted-source'), { now: new Date(later.getTime() + BACKLOG_INTERVAL_MS + 120_000) });
    expect(gone.notes).toEqual({});
    expect(gone.cursor).toBe('backlog:cn1');

    // International: a board over the per-run cap is NOT remembered and keeps the usual interval.
    const intlRow = source({ id: 'i1', market: 'intl', boardToken: 'globalco', companyName: 'Global Co', lastSyncedAt: null });
    const intlDb = createFakePrisma({ seed: { rACareerSiteSource: [intlRow], rAJob: [] } });
    const intlJobs = Array.from({ length: MAX_POSTINGS_PER_BOARD + 20 }, (_, i) => ghJob(i, 'Singapore'));
    const intlAdapter = createAtsPublicAdapter({ db: () => intlDb as never, fetch: fakeFetch(GLOBAL_ROUTE(intlJobs)), env: {} });
    const intlQuery = (cursor?: string) => ({ ...query(cursor), market: 'intl' as const });
    const intlFirst = await intlAdapter.fetch(intlQuery(), { now: NOW });
    expect(intlFirst.notes).toMatchObject({ boards_read: 1, board_backlog: 20 });
    expect(intlFirst.cursor).toBeNull();
    const intlSoon = await intlAdapter.fetch(intlQuery('backlog:i1'), { now: new Date(NOW.getTime() + BACKLOG_INTERVAL_MS + 60_000) });
    expect(intlSoon.notes).toEqual({});
  });

  it('splitByMarket with no market keeps every posting (callers that do not scope a read)', () => {
    expect(splitByMarket([1, 2, 3], () => null, undefined)).toEqual({ mine: [1, 2, 3], wrongMarket: 0 });
  });
});

// ── The verified seed list of mainland boards ─────────────────────────────

describe('mainland seed boards (seeds.cn.json)', () => {
  const file = seedFileFor('cn')!;

  it('has the documented shape: unique boards, known job-board systems, a measured count and where each name comes from', () => {
    expect(file).toMatchObject({ market: 'cn', countryCode: 'CN' });
    expect(file.version).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(file.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(file.boards.length).toBeGreaterThanOrEqual(10);
    const keys = file.boards.map((b) => `${b.ats}:${b.boardToken.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of file.boards) {
      expect(Object.keys(PUBLIC_ATS_NAMES)).toContain(b.ats);
      expect(CareerSourceBodySchema.safeParse({ ats: b.ats, boardToken: b.boardToken, companyName: b.companyName, countryCode: 'CN' }).success).toBe(true);
      expect(b.mainlandPostings).toBeGreaterThanOrEqual(1);
      // A name is the board's own metadata, or the board token where the system publishes none.
      if (b.nameSource === 'board_token') expect(b.companyName).toBe(b.boardToken);
      else expect(['greenhouse', 'smartrecruiters']).toContain(b.ats);
    }
    expect(seedFileFor('intl')).toBeNull();
  });

  it('parseSeedFile refuses a duplicate, an unknown job-board system, a missing name and a board with no verified posting', () => {
    const board = { ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', nameSource: 'board_metadata', mainlandPostings: 3 };
    const base = { market: 'cn', countryCode: 'CN', version: 'v1', verifiedAt: '2026-10-11', method: 'm' };
    expect(parseSeedFile({ ...base, boards: [board] }).boards).toHaveLength(1);
    expect(() => parseSeedFile({ ...base, boards: [board, { ...board, boardToken: 'ACME' }] })).toThrow(/listed twice/);
    expect(() => parseSeedFile({ ...base, boards: [{ ...board, ats: 'workday' }] })).toThrow(/unknown job-board system/);
    expect(() => parseSeedFile({ ...base, boards: [{ ...board, companyName: ' ' }] })).toThrow(/no company name/);
    expect(() => parseSeedFile({ ...base, boards: [{ ...board, mainlandPostings: 0 }] })).toThrow(/at least one verified posting/);
    expect(() => parseSeedFile({ ...base, boards: [{ ...board, nameSource: 'memory' }] })).toThrow(/where its name comes from/);
    expect(() => parseSeedFile({ ...base, market: 'tw', boards: [] })).toThrow(/market/);
  });

  it('registers only boards with at least 10 measured mainland postings: a global board with one or two stays free for the international site (review fix)', async () => {
    expect(SEED_MIN_MAINLAND_POSTINGS).toBe(10);
    const registered = seedBoardsToRegister(file);
    const held = file.boards.filter((b) => !registered.includes(b));
    expect(registered.every((b) => b.mainlandPostings >= 10)).toBe(true);
    expect(held.every((b) => b.mainlandPostings < 10)).toBe(true);
    // The acceptance needs at least 10 boards; the registered ones carry almost all of the measured postings.
    expect(registered.length).toBeGreaterThanOrEqual(10);
    const sum = (list: typeof file.boards) => list.reduce((n, b) => n + b.mainlandPostings, 0);
    expect(sum(registered)).toBeGreaterThanOrEqual(300);
    expect(sum(held) / sum(file.boards)).toBeLessThan(0.05);
    // Boards RoboApply keeps the right to add (measured with 1 to 7 mainland postings).
    expect(held.map((b) => b.boardToken)).toEqual(expect.arrayContaining(['airbnb', 'databricks', 'mongodb', 'appier', 'Canva']));
    expect(registered.map((b) => b.boardToken)).toEqual(expect.arrayContaining(['BoschGroup', 'AbbVie', 'veeva', 'riotgames']));

    const db = createFakePrisma({ seed: { rACareerSiteSource: [] } });
    expect(await ensureSeedCareerSources(db as never, 'cn')).toMatchObject({ status: 'registered', added: registered.length });
    const tokens = db.$rows('rACareerSiteSource').map((r) => r.boardToken);
    for (const b of held) expect(tokens).not.toContain(b.boardToken);
    // A held board is not remembered as offered, so a later version that registers it still can.
    const state = JSON.parse(String(db.$rows('appConfig')[0]!.value)) as { offered: string[] };
    expect(state.offered).toHaveLength(registered.length);
    const later = { ...file, version: `${file.version}.jc4`, boards: file.boards.map((b) => (b.boardToken === 'airbnb' ? { ...b, mainlandPostings: 12 } : b)) };
    expect(await ensureSeedCareerSources(db as never, 'cn', later)).toMatchObject({ status: 'registered', added: 1 });
  });

  it('registers the boards once with market cn and countryCode CN, leaves an existing board alone and never re-adds a removed one', async () => {
    const taken = file.boards[0]!;
    const db = createFakePrisma({ seed: { rACareerSiteSource: [source({ id: 'mine', market: 'intl', ats: taken.ats, boardToken: taken.boardToken, companyName: 'Kept as it is', countryCode: 'TW' })] } });
    const first = await ensureSeedCareerSources(db as never, 'cn');
    const registered = seedBoardsToRegister(file);
    expect(first).toMatchObject({ status: 'registered', version: file.version, added: registered.length - 1, alreadyPresent: 1 });
    const rows = db.$rows('rACareerSiteSource');
    expect(rows.find((r) => r.id === 'mine')).toMatchObject({ market: 'intl', companyName: 'Kept as it is', countryCode: 'TW' });
    expect(rows.filter((r) => r.id !== 'mine').every((r) => r.market === 'cn' && r.countryCode === 'CN' && r.enabled === true)).toBe(true);
    expect(db.$rows('appConfig').map((r) => r.key)).toEqual([seedStateKey('cn')]);
    // Same version again: nothing is added, even after an admin removed a board.
    const removed = rows.find((r) => r.id !== 'mine')!;
    await db.rACareerSiteSource.delete({ where: { id: removed.id } });
    expect(await ensureSeedCareerSources(db as never, 'cn')).toMatchObject({ status: 'up_to_date', added: 0 });
    // A later version adds only its new boards.
    const next = { ...file, version: `${file.version}.next`, boards: [...file.boards, { ats: 'greenhouse' as const, boardToken: 'newco', companyName: 'New Co', nameSource: 'board_metadata' as const, mainlandPostings: 40 }] };
    expect(await ensureSeedCareerSources(db as never, 'cn', next)).toMatchObject({ status: 'registered', added: 1, alreadyPresent: 0 });
    expect(db.$rows('rACareerSiteSource').some((r) => r.boardToken === removed.boardToken && r.ats === removed.ats)).toBe(false);
    // A market with no seed file gets none.
    expect(await ensureSeedCareerSources(db as never, 'intl')).toMatchObject({ status: 'no_seed', added: 0 });
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

  it('JT-1: the card and the pay parser read the same wording and the same clause (one rule, kept in step)', () => {
    // The hook's patterns are the parser's, character for character (an area may not import another
    // area's internals, so they are copied): change one file and this fails until the other follows.
    expect(TW_NEGOTIABLE_SOURCE).toBe(CJK_NEGOTIABLE_SOURCE);
    expect(TW_FLOOR_CLAUSE_SOURCE).toBe(PARSER_FLOOR_CLAUSE_SOURCE);
    expect(TW_FLOOR_STATUTE_SOURCE).toBe(PARSER_FLOOR_STATUTE_SOURCE);
    expect(TW_FLOOR_OTHER_PAY_BEFORE_SOURCE).toBe(PARSER_FLOOR_OTHER_PAY_BEFORE_SOURCE);
    // And they agree on real text: "no figure" for the parser is "negotiable" on the card.
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

// ── TW open data (guarded stub) ──────────────────────────────────────────

describe('TW open data', () => {
  it('stays off until the licence spike is confirmed, whatever the env says', () => {
    expect(twOpenDataStatus({ TW_OPEN_DATA_JOBS_ENABLED: 'true', TW_OPEN_DATA_JOBS_URL: 'https://data.gov.tw/x.json' })).toEqual({ enabled: false, reason: 'licence_unverified' });
    expect(twOpenDataEnabled({ TW_OPEN_DATA_JOBS_ENABLED: 'true' })).toBe(false);
    expect(getSourceAdapter('tw_open_data' as never)).toBeNull();
    expect(TW_OPEN_DATA_ATTRIBUTION).toContain('台灣就業通');
  });
});
