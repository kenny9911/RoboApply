// @vitest-environment node
//
// WP-42 and the market wave (MKT-3D; JI-3, JC-4, JT-5): the admin career-source
// routes (/api/v1/roboapply/admin/career-sources). Prisma is the in-memory
// fake; board HTTP is a fake fetch.
//
// One board, both sites: a board is ONE source row, so an admin on either
// host works on the same rows. The request's brand only decides the default
// of the list (the boards that feed that brand's market). "Check now" reads
// the listing once and marks the source due for the board sync: it touches no
// ingest query and queues no work; its request says who is asking as the brand
// of the admin's site. Bulk import takes a JSON list or a CSV. A removed board
// is remembered, so discovery does not bring it back.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { requireAdmin } from '../../../../middleware/admin.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../../../test/routeHarness.js';
import type { CareerSourceRunResult, CareerSourceView, ImportCareerSourcesResult } from './contract.js';
import { createBoardDiscovery } from './discovery.js';
import type { FetchLike } from './http.js';
import { REMOVED_BOARDS_CONFIG_KEY, readRemovedBoards } from './removed.js';
import { createCareerSourcesAdminRouter } from './routes.js';
import { createCareerSourcesService } from './service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_BODY = readFileSync(join(HERE, '__fixtures__', 'greenhouse.json'), 'utf8');
/** The same board as its listing WITHOUT texts answers: no `content`, `offices` or `departments` (what "Check now" reads). */
const GH_LIST_BODY = JSON.stringify({
  jobs: (JSON.parse(GH_BODY) as { jobs: Array<Record<string, unknown>> }).jobs.map(({ content: _content, offices: _offices, departments: _departments, ...rest }) => rest),
});
const RA = 'localhost:3611';
const GO = 'goapply.localhost:3611';
const ENV = { NODE_ENV: 'test', DEPLOY_REGION: '' };
const NOW = new Date('2026-10-10T00:00:00.000Z');

let harness: RouteHarness;
let admin: HarnessUser | null = { id: 'admin1', role: 'admin' };
let db: ReturnType<typeof createFakePrisma>;
let serviceEnv: Record<string, string> = {};
const fetched: string[] = [];
/** The User-Agent of every board request the service made. */
const agents: Array<string | undefined> = [];
const fetchBoard: FetchLike = async (url, init) => {
  fetched.push(url);
  agents.push(init.headers?.['User-Agent']);
  return url.startsWith('https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs')
    ? { ok: true, status: 200, text: async () => (url.includes('content=true') ? GH_BODY : GH_LIST_BODY) }
    : { ok: false, status: 404, text: async () => '' };
};

beforeAll(async () => {
  const service = createCareerSourcesService({ db: () => db as never, fetch: fetchBoard, now: () => NOW, env: new Proxy({}, { get: (_t, key: string) => serviceEnv[key] }) });
  harness = await startRouteHarness({
    env: ENV,
    mounts: [['/cs', createCareerSourcesAdminRouter({ adminAuth: [fakeAuth(() => admin), requireAdmin], service: () => service, env: ENV })]],
  });
});
afterAll(() => harness.close());

function sourceRow(over: Record<string, unknown> = {}) {
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
    origin: 'admin',
    discoveredFrom: null,
    countries: [],
    failCount: 0,
    lastChangeAt: null,
    nextSyncAt: null,
    disabledAt: null,
    createdBy: 'admin1',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

const job = (id: string, market: string, sourceBoard: string, externalId: string) => ({ id, market, sourceBoard, externalId, archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' });

beforeEach(() => {
  admin = { id: 'admin1', role: 'admin' };
  serviceEnv = {};
  fetched.length = 0;
  agents.length = 0;
  db = createFakePrisma({
    seed: {
      rACareerSiteSource: [
        // Read whole: feeds both sites.
        sourceRow(),
        // Read for the mainland only.
        sourceRow({ id: 'cs-cn', market: 'cn', ats: 'smartrecruiters', boardToken: 'MainlandCo', companyName: 'Mainland Co', countryCode: null, countries: ['CN'] }),
        // Read for the United States only.
        sourceRow({ id: 'cs-us', boardToken: 'usonly', companyName: 'US Only', countryCode: null, countries: ['US'] }),
      ],
      rAJob: [
        job('j1', 'intl', 'greenhouse', 'formosarobotics:4012345'),
        job('j2', 'intl', 'greenhouse', 'formosarobotics:111'),
        // The mainland copy of a posting located in both markets.
        job('j2cn', 'cn', 'greenhouse', 'formosarobotics:111#cn'),
        job('j3', 'intl', 'greenhouse', 'otherco:111'),
        job('j-cn', 'cn', 'smartrecruiters', 'MainlandCo:1'),
      ],
      rAIngestQuery: [{ id: 'q-ats', provider: 'ats_public', market: 'intl', enabled: true, nextRunAt: new Date('2026-10-10T00:30:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') }],
    },
    uniqueFields: { rACareerSiteSource: ['boardToken'] },
    defaults: {
      rACareerSiteSource: { lastSyncedAt: null, lastJobCount: null, lastError: null, companyId: null, countryCode: null, discoveredFrom: null, failCount: 0, lastChangeAt: null, nextSyncAt: null, disabledAt: null },
    },
  });
});

type Ok<T> = { success: true; data: T };
type Err = { success: false; error: string; code: string; details?: Record<string, unknown> };
const rows = (model: string) => db.$rows(model);
const source = (id: string) => rows('rACareerSiteSource').find((r) => r.id === id)!;
const list = async (host: string, query = '') => (await harness.request<Ok<{ items: CareerSourceView[] }>>('GET', `/cs${query}`, { host })).body.data.items;

describe('access', () => {
  it.each([
    ['GET', '/cs'],
    ['POST', '/cs'],
    ['POST', '/cs/import'],
    ['PATCH', '/cs/cs1'],
    ['DELETE', '/cs/cs1'],
    ['POST', '/cs/cs1/run'],
  ])('%s %s → 401 without a session, 403 for a non-admin', async (method, path) => {
    const init = { host: RA, ...(method === 'GET' ? {} : { body: {} }) };
    admin = null;
    expect((await harness.request(method, path, init)).status).toBe(401);
    admin = { id: 'u1', role: 'seeker' };
    expect((await harness.request(method, path, init)).status).toBe(403);
    expect(rows('rACareerSiteSource')).toHaveLength(3);
  });
});

describe('one list for both sites: market means "feeds this market"', () => {
  it('a GoApply admin and a RoboApply admin see the same shared row; each list leaves out the boards read only for the other market', async () => {
    const go = await list(GO);
    const ra = await list(RA);
    // cn = countries empty or containing CN; intl = empty or containing any other code.
    expect(go.map((i) => i.id).sort()).toEqual(['cs-cn', 'cs1']);
    expect(ra.map((i) => i.id).sort()).toEqual(['cs-us', 'cs1']);
    expect(go.find((i) => i.id === 'cs1')).toEqual(ra.find((i) => i.id === 'cs1'));
    // Either admin may ask for the other market's view.
    expect((await list(RA, '?market=cn')).map((i) => i.id).sort()).toEqual(['cs-cn', 'cs1']);
    expect((await list(GO, '?market=intl')).map((i) => i.id).sort()).toEqual(['cs-us', 'cs1']);
  });

  it('the view carries origin, countries and the sync state', async () => {
    const [view] = (await list(RA, '?enabled=true')).filter((i) => i.id === 'cs1');
    expect(view).toEqual({
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
      origin: 'admin',
      discoveredFrom: null,
      countries: [],
      failCount: 0,
      lastChangeAt: null,
      nextSyncAt: null,
      disabledAt: null,
      state: 'enabled',
    });
    expect((await harness.request('GET', '/cs?enabled=maybe', { host: RA })).status).toBe(422);
    expect((await harness.request('GET', '/cs?state=paused', { host: RA })).status).toBe(422);
    expect((await harness.request('GET', '/cs?origin=memory', { host: RA })).status).toBe(422);
  });

  it('filters by origin and by state (enabled, candidate, disabled)', async () => {
    rows('rACareerSiteSource').push(
      sourceRow({ id: 'cand', boardToken: 'acme', companyName: 'Acme', origin: 'discovered', discoveredFrom: 'jsearch:1', enabled: false, countryCode: null }),
      sourceRow({ id: 'missed', boardToken: 'othercorp', companyName: 'Other Corp', origin: 'import', enabled: false, lastSyncedAt: NOW, lastError: 'validation:name_mismatch', countryCode: null }),
      sourceRow({ id: 'failed', boardToken: 'gone', companyName: 'Gone', origin: 'seed', enabled: false, failCount: 3, disabledAt: NOW, lastError: 'board_not_found', countryCode: null }),
    );
    expect((await list(RA, '?origin=discovered')).map((i) => i.id)).toEqual(['cand']);
    expect((await list(RA, '?origin=seed')).map((i) => [i.id, i.state, i.failCount])).toEqual([['failed', 'disabled', 3]]);
    expect((await list(RA, '?state=candidate')).map((i) => i.id).sort()).toEqual(['cand', 'missed']);
    expect((await list(RA, '?state=disabled')).map((i) => i.id)).toEqual(['failed']);
    expect((await list(RA, '?state=enabled')).map((i) => i.id).sort()).toEqual(['cs-us', 'cs1']);
    expect((await list(RA, '?enabled=false&origin=import')).map((i) => [i.id, i.state, i.lastError])).toEqual([['missed', 'candidate', 'validation:name_mismatch']]);
  });
});

describe('create', () => {
  it('POST with countries TW and CN stores them; the view returns origin admin; both admins then see the row', async () => {
    const res = await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: GO, body: { ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch', countries: ['TW', 'CN'] } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ats: 'smartrecruiters', boardToken: 'BoschGroup', origin: 'admin', countries: ['CN', 'TW'], enabled: true, state: 'enabled', failCount: 0, nextSyncAt: null });
    // The market column keeps the console that added it, and decides nothing.
    expect(res.body.data.market).toBe('cn');
    expect(source(res.body.data.id)).toMatchObject({ createdBy: 'admin1', origin: 'admin', countries: ['CN', 'TW'], market: 'cn' });
    expect((await list(GO)).map((i) => i.boardToken)).toContain('BoschGroup');
    expect((await list(RA)).map((i) => i.boardToken)).toContain('BoschGroup');
    // A row with countries US stays out of the mainland list; a row with none is in both.
    expect((await list(GO, '?market=cn')).map((i) => i.id)).not.toContain('cs-us');
    expect((await list(GO, '?market=cn')).map((i) => i.id)).toContain('cs1');
  });

  it('on the RoboApply host; `market` in the body is accepted and ignored; Workday, a bad board id and bad countries are refused', async () => {
    const res = await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: RA, body: { ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countryCode: 'TW', market: 'cn' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ats: 'lever', boardToken: 'pinecloud', market: 'intl', countryCode: 'TW', countries: [], origin: 'admin' });
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'workday', boardToken: 'x', companyName: 'X' } })).status).toBe(422);
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'lever', boardToken: '../x', companyName: 'X' } })).status).toBe(422);
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'lever', boardToken: 'x', companyName: 'X', countries: ['tw'] } })).status).toBe(422);
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'lever', boardToken: 'x', companyName: 'X', origin: 'seed' } })).status).toBe(422);
  });

  it('a board already in the list answers 409; when it is read for other countries than this site\'s, the answer says so', async () => {
    const own = await harness.request<Err>('POST', '/cs', { host: GO, body: { ats: 'greenhouse', boardToken: 'formosarobotics', companyName: 'Again' } });
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: 'conflict', error: 'This job board is already in the list.', details: { field: 'boardToken' } });
    expect(own.body.details?.reason).toBeUndefined();
    // The mainland-only board is not in RoboApply's list: "already in the list" alone would mislead.
    const other = await harness.request<Err>('POST', '/cs', { host: RA, body: { ats: 'smartrecruiters', boardToken: 'MainlandCo', companyName: 'Mainland Co' } });
    expect(other.status).toBe(409);
    // With what the console needs to offer "read it for this site too": the row, its countries, this site's market.
    expect(other.body.details).toEqual({ field: 'boardToken', reason: 'board_read_for_other_countries', id: 'cs-cn', countries: ['CN'], market: 'intl' });
    expect(other.body.error).toMatch(/other countries/);
    const mainland = await harness.request<Err>('POST', '/cs', { host: GO, body: { ats: 'greenhouse', boardToken: 'usonly', companyName: 'US Only' } });
    expect(mainland.body.details).toEqual({ field: 'boardToken', reason: 'board_read_for_other_countries', id: 'cs-us', countries: ['US'], market: 'cn' });
    expect(rows('rACareerSiteSource')).toHaveLength(3);
    // The action the console offers: widen the countries of that row. It then shows in this site's list.
    const widened = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs-cn', { host: RA, body: { countries: [] } });
    expect(widened.body.data).toMatchObject({ countries: [], nextSyncAt: null });
    expect((await list(RA)).map((i) => i.id)).toContain('cs-cn');
  });
});

describe('update and remove (either host: the row is shared)', () => {
  it('changes the countries and makes the board due at once, so the next read closes what no longer belongs', async () => {
    source('cs1').nextSyncAt = new Date('2026-10-10T12:00:00Z');
    const res = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: GO, body: { countries: ['TW', 'CN'], companyName: 'Formosa Robotics Inc.' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ countries: ['CN', 'TW'], companyName: 'Formosa Robotics Inc.', nextSyncAt: null });
    // The same list again changes nothing about its schedule.
    source('cs1').nextSyncAt = new Date('2026-10-10T12:00:00Z');
    const same = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: RA, body: { countries: ['CN', 'TW'] } });
    expect(same.body.data.nextSyncAt).toBe('2026-10-10T12:00:00.000Z');
    expect((await harness.request('PATCH', '/cs/cs1', { host: RA, body: { countries: ['Taiwan'] } })).status).toBe(422);
    expect((await harness.request('PATCH', '/cs/cs1', { host: RA, body: { boardToken: 'changed' } })).status).toBe(422);
    expect((await harness.request('PATCH', '/cs/nope', { host: RA, body: { enabled: true } })).status).toBe(404);
  });

  it('changing the countries of a source that failed reads switched off leaves the time its postings are archived standing', async () => {
    const archiveAt = new Date('2026-10-11T06:00:00Z');
    Object.assign(source('cs1'), { enabled: false, failCount: 3, disabledAt: new Date('2026-10-09T06:00:00Z'), nextSyncAt: archiveAt, lastError: 'board_not_found' });
    const res = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: RA, body: { countries: ['TW'] } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ countries: ['TW'], enabled: false, nextSyncAt: archiveAt.toISOString() });
    expect(source('cs1').nextSyncAt).toEqual(archiveAt);
    // Switched back on in the same request: due at once, as for any source that is on.
    const on = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: RA, body: { countries: ['TW', 'JP'], enabled: true } });
    expect(on.body.data).toMatchObject({ countries: ['JP', 'TW'], enabled: true, nextSyncAt: null, failCount: 0 });
    // A candidate (off, never read) has nothing scheduled either way.
    rows('rACareerSiteSource').push(sourceRow({ id: 'cand', boardToken: 'acme', origin: 'import', enabled: false, nextSyncAt: new Date('2026-10-10T01:00:00Z'), failCount: 1, countryCode: null }));
    const cand = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cand', { host: RA, body: { countries: ['SG'] } });
    expect(cand.body.data.nextSyncAt).toBe('2026-10-10T01:00:00.000Z');
  });

  it('turning a board off archives its open jobs in BOTH markets and stamps it; another company\'s rows are left alone', async () => {
    const off = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: RA, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ enabled: false, state: 'disabled', disabledAt: NOW.toISOString(), nextSyncAt: null });
    expect(rows('rAJob').filter((r) => r.closeReason === 'source_removed').map((r) => r.id)).toEqual(['j1', 'j2', 'j2cn']);
    expect(rows('rAJob').find((r) => r.id === 'j3')!.archivedAt).toBeNull();
    expect(rows('rAJob').find((r) => r.id === 'j-cn')!.archivedAt).toBeNull();
  });

  it('re-enabling a source switched off by failures clears failCount and disabledAt and makes it due at once', async () => {
    Object.assign(source('cs1'), { enabled: false, failCount: 3, disabledAt: new Date('2026-10-08T00:00:00Z'), nextSyncAt: new Date('2026-10-10T00:00:00Z'), lastError: 'board_not_found', lastSyncedAt: new Date('2026-10-08T00:00:00Z') });
    const on = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: GO, body: { enabled: true } });
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({ enabled: true, state: 'enabled', failCount: 0, disabledAt: null, nextSyncAt: null, lastError: null });
    // The time of the last real read is kept.
    expect(on.body.data.lastSyncedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(source('cs1')).toMatchObject({ enabled: true, failCount: 0, disabledAt: null, nextSyncAt: null });
  });

  it('an admin may switch a candidate on by hand, whatever its list-only read said', async () => {
    rows('rACareerSiteSource').push(sourceRow({ id: 'cand', boardToken: 'othercorp', companyName: 'Other Corp', origin: 'discovered', enabled: false, lastSyncedAt: NOW, lastError: 'validation:name_mismatch', countryCode: null }));
    const on = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cand', { host: RA, body: { enabled: true } });
    expect(on.body.data).toMatchObject({ state: 'enabled', origin: 'discovered', lastError: null, nextSyncAt: null });
  });

  it('removing a board archives its open jobs in both markets and deletes the row', async () => {
    const res = await harness.request<Ok<{ archivedJobs: number }>>('DELETE', '/cs/cs1', { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ archivedJobs: 3 });
    expect(rows('rACareerSiteSource').map((r) => r.id).sort()).toEqual(['cs-cn', 'cs-us']);
    expect((await harness.request('DELETE', '/cs/cs1', { host: RA })).status).toBe(404);
  });

  it('a removed board stays removed: the next posting that links to it creates nothing, and nothing switches it back on', async () => {
    expect((await harness.request('DELETE', '/cs/cs1', { host: RA })).status).toBe(200);
    // Remembered by board id only, with the admin who removed it as the writer of the document.
    expect(await readRemovedBoards(db as never)).toEqual(['greenhouse:formosarobotics']);
    const [doc] = rows('appConfig').filter((r) => r.key === REMOVED_BOARDS_CONFIG_KEY);
    expect(doc).toMatchObject({ updatedBy: 'admin1' });
    expect(String(doc!.value)).not.toMatch(/Formosa|admin1/);
    // An aggregator posting links to that board at the next ingest tick (a fresh process: nothing remembered in memory).
    const discovery = createBoardDiscovery({ db: () => db as never, env: {} });
    const posting = { market: 'intl' as const, provider: 'jsearch', sourceBoard: 'jsearch', externalId: 'x1', companyName: 'Formosa Robotics', title: 'Engineer', atsPostingKey: 'greenhouse:FormosaRobotics:4012345' };
    expect(await discovery.note(posting, { stage: 'ingest' })).toBe('known');
    expect(rows('rACareerSiteSource').map((r) => r.id).sort()).toEqual(['cs-cn', 'cs-us']);
    // A board nobody removed is still proposed.
    expect(await discovery.note({ ...posting, atsPostingKey: 'greenhouse:acme:1' }, { stage: 'ingest' })).toBe('offered');
  });

  it('adding a removed board again, by hand or in an import, is the admin\'s decision: the removal is forgotten', async () => {
    await harness.request('DELETE', '/cs/cs1', { host: RA });
    await harness.request('DELETE', '/cs/cs-us', { host: GO });
    expect(await readRemovedBoards(db as never)).toEqual(['greenhouse:formosarobotics', 'greenhouse:usonly']);
    const again = await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: RA, body: { ats: 'greenhouse', boardToken: 'formosarobotics', companyName: 'Formosa Robotics' } });
    expect(again.status).toBe(201);
    expect(await readRemovedBoards(db as never)).toEqual(['greenhouse:usonly']);
    const imported = await harness.request<Ok<ImportCareerSourcesResult>>('POST', '/cs/import', { host: RA, body: { format: 'json', rows: [{ ats: 'greenhouse', boardToken: 'usonly' }, { ats: 'lever', boardToken: 'pinecloud' }] } });
    expect(imported.body.data).toMatchObject({ created: 2 });
    expect(await readRemovedBoards(db as never)).toEqual([]);
  });
});

describe('POST /:id/run (Check now)', () => {
  it('reads the listing once, marks the source due for the board sync, and touches neither the ingest queries nor the jobs', async () => {
    Object.assign(source('cs1'), { lastSyncedAt: new Date('2026-10-09T00:00:00Z'), nextSyncAt: new Date('2026-10-10T02:00:00Z'), lastError: 'timeout' });
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/cs1/run', { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sourceId: 'cs1', status: 'scheduled', listed: 2, queued: true, error: null });
    // Listing only: no posting texts (Greenhouse without content=true).
    expect(fetched).toEqual(['https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs']);
    // Due at the next board sync; the time of the last real read stands.
    expect(source('cs1')).toMatchObject({ nextSyncAt: null, lastError: null, lastJobCount: 2, lastSyncedAt: new Date('2026-10-09T00:00:00Z') });
    expect(rows('rAIngestQuery')[0]!.nextRunAt).toEqual(new Date('2026-10-10T00:30:00Z'));
    expect(rows('rAWorkItem')).toEqual([]);
    expect(rows('rAJob').every((r) => r.archivedAt === null)).toBe(true);
  });

  it('says who is asking as the brand of the admin\'s site: GoApply on the GoApply host, RoboApply on the RoboApply host', async () => {
    serviceEnv = { JOB_SOURCES_CONTACT: 'mailto:jobs@example.com', CN_JOB_SOURCES_CONTACT: 'mailto:zhaopin@example.cn' };
    await harness.request('POST', '/cs/cs1/run', { host: GO });
    expect(agents).toEqual(['GoApplyJobs/1.0 (+mailto:zhaopin@example.cn)']);
    agents.length = 0;
    await harness.request('POST', '/cs/cs1/run', { host: RA });
    expect(agents).toEqual(['RoboApplyJobs/1.0 (+mailto:jobs@example.com)']);
    // Without a contact address GoApply still names itself and its own site, never RoboApply.
    serviceEnv = {};
    agents.length = 0;
    await harness.request('POST', '/cs/cs1/run', { host: GO });
    expect(agents[0]).toMatch(/^GoApplyJobs\/1\.0 /);
    expect(agents[0]).not.toMatch(/roboapply/i);
  });

  it('a board that cannot be read is reported and stays as scheduled', async () => {
    Object.assign(source('cs1'), { boardToken: 'gone', nextSyncAt: new Date('2026-10-10T02:00:00Z'), failCount: 1 });
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/cs1/run', { host: RA });
    expect(res.body.data).toMatchObject({ status: 'error', error: 'board_not_found', queued: false, listed: 0 });
    // A check by hand is not a failed sync: it counts nothing and reschedules nothing.
    expect(source('cs1')).toMatchObject({ lastError: 'board_not_found', failCount: 1, nextSyncAt: new Date('2026-10-10T02:00:00Z') });
  });

  it('SmartRecruiters: the listing pages only, once per country the board is read for', async () => {
    const urls: string[] = [];
    const spy: FetchLike = async (url) => {
      urls.push(url);
      const content = Array.from({ length: 3 }, (_, i) => ({ id: `p${new URL(url).searchParams.get('country')}${i}`, name: `Role ${i}` }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ totalFound: 3, content }) };
    };
    const service = createCareerSourcesService({ db: () => db as never, fetch: spy, now: () => NOW, env: {} });
    Object.assign(source('cs-cn'), { countries: ['TW', 'CN'] });
    expect(await service.runNow('cs-cn')).toMatchObject({ status: 'scheduled', listed: 6, queued: true });
    expect(urls).toEqual([
      'https://api.smartrecruiters.com/v1/companies/MainlandCo/postings?limit=100&offset=0&country=cn',
      'https://api.smartrecruiters.com/v1/companies/MainlandCo/postings?limit=100&offset=0&country=tw',
    ]);
  });

  it('SmartRecruiters: a large board is checked from its first page per country, with the board\'s own total (never paged to its end)', async () => {
    const urls: string[] = [];
    const totals: Record<string, number> = { cn: 1322, tw: 31 };
    const spy: FetchLike = async (url) => {
      urls.push(url);
      const u = new URL(url);
      const country = u.searchParams.get('country')!;
      const offset = Number(u.searchParams.get('offset'));
      const n = Math.max(0, Math.min(100, totals[country]! - offset));
      const content = Array.from({ length: n }, (_, i) => ({ id: `${country}${offset + i}`, name: `Role ${i}` }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ totalFound: totals[country], content }) };
    };
    const service = createCareerSourcesService({ db: () => db as never, fetch: spy, now: () => NOW, env: {} });
    Object.assign(source('cs-cn'), { boardToken: 'BoschGroup', countries: ['TW', 'CN'] });
    expect(await service.runNow('cs-cn', 'cn')).toMatchObject({ status: 'scheduled', listed: 1353, queued: true });
    expect(urls).toEqual([
      'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=0&country=cn',
      'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=0&country=tw',
    ]);
    expect(source('cs-cn')).toMatchObject({ lastJobCount: 1353, nextSyncAt: null });
  });

  it('gives up after its overall time limit and reports it', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const service = createCareerSourcesService({ db: () => db as never, fetch: hanging, now: () => NOW, env: {}, runNowTimeoutMs: 20 });
    expect(await service.runNow('cs1')).toMatchObject({ status: 'error', error: 'timeout', queued: false });
  });

  it('with the kill switch on nothing is read', async () => {
    serviceEnv = { ATS_PUBLIC_SOURCES_DISABLED: 'true' };
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/cs1/run', { host: RA });
    expect(res.body.data).toEqual({ sourceId: 'cs1', status: 'error', listed: 0, queued: false, error: 'sources_off' });
    expect(fetched).toEqual([]);
  });

  it('409 for a board that is off, 404 for an unknown source', async () => {
    source('cs1').enabled = false;
    expect((await harness.request('POST', '/cs/cs1/run', { host: RA })).status).toBe(409);
    expect((await harness.request('POST', '/cs/nope/run', { host: RA })).status).toBe(404);
  });
});

describe('POST /import (bulk import)', () => {
  const importRows = (host: string, body: Record<string, unknown>) => harness.request<Ok<ImportCareerSourcesResult>>('POST', '/cs/import', { host, body });

  it('three JSON rows (one new, one existing with one more country, one with a bad board id): created 1, merged 1, invalid 1 with its line and reason', async () => {
    const res = await importRows(RA, {
      format: 'json',
      rows: [
        { ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countries: [] },
        { ats: 'smartrecruiters', boardToken: 'MainlandCo', countries: ['TW'] },
        { ats: 'greenhouse', boardToken: 'bad token', companyName: 'Bad' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ total: 3, created: 1, merged: 1, invalid: [{ line: 3, reason: 'invalid_board_id' }], invalidCount: 1 });
    // The new row is a disabled candidate with origin import.
    const created = rows('rACareerSiteSource').find((r) => r.boardToken === 'pinecloud')!;
    expect(created).toMatchObject({ ats: 'lever', companyName: 'Pine Cloud', origin: 'import', enabled: false, countries: [], market: 'intl', createdBy: 'admin1', lastSyncedAt: null });
    expect((await list(RA, '?state=candidate')).map((i) => i.boardToken)).toEqual(['pinecloud']);
    // The existing board: only its countries were merged; origin, name and on/off state are unchanged.
    expect(source('cs-cn')).toMatchObject({ countries: ['CN', 'TW'], origin: 'admin', companyName: 'Mainland Co', enabled: true, nextSyncAt: null });
  });

  it('a JSON list with rows that lack a field or hold the wrong kind of value: those rows are reported by number, the others are added', async () => {
    const res = await importRows(RA, {
      format: 'json',
      rows: [
        { ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud' },
        { ats: 'greenhouse' },
        { ats: 7, boardToken: 'acme' },
        'greenhouse,acme',
        null,
        { ats: 'ashby', boardToken: 'islandlabs', companyName: 42 },
        { ats: 'ashby', boardToken: 'islandlabs', countries: 'TW' },
        { ats: 'ashby', boardToken: 'islandlabs', countries: ['TW'], note: 'extra fields are ignored' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      total: 8,
      created: 2,
      merged: 0,
      invalid: [
        { line: 2, reason: 'invalid_board_id' },
        { line: 3, reason: 'unknown_job_board' },
        { line: 4, reason: 'unreadable_row' },
        { line: 5, reason: 'unreadable_row' },
        { line: 6, reason: 'unreadable_row' },
        { line: 7, reason: 'unreadable_row' },
      ],
      invalidCount: 6,
    });
    expect(rows('rACareerSiteSource').filter((r) => r.origin === 'import').map((r) => [r.boardToken, r.countries])).toEqual([['pinecloud', []], ['islandlabs', ['TW']]]);
  });

  it('with enable true a new row is switched on and due at the next board sync; an existing row\'s on/off state never changes', async () => {
    source('cs-us').enabled = false;
    const res = await importRows(GO, { format: 'json', enable: true, rows: [{ ats: 'ashby', boardToken: 'islandlabs' }, { ats: 'greenhouse', boardToken: 'usonly', countries: ['CA'] }] });
    expect(res.body.data).toMatchObject({ total: 2, created: 1, merged: 1, invalidCount: 0 });
    // No name in the file: the board id stands in until a sync learns the board's stated name.
    expect(rows('rACareerSiteSource').find((r) => r.boardToken === 'islandlabs')).toMatchObject({ companyName: 'islandlabs', origin: 'import', enabled: true, nextSyncAt: null, market: 'cn' });
    expect(source('cs-us')).toMatchObject({ enabled: false, countries: ['CA', 'US'] });
  });

  it('merging countries: an empty list means every country and wins; a board read for every country stays so', async () => {
    const res = await importRows(RA, {
      format: 'json',
      rows: [
        { ats: 'greenhouse', boardToken: 'usonly', countries: [] },
        { ats: 'greenhouse', boardToken: 'formosarobotics', countries: ['TW'] },
      ],
    });
    expect(res.body.data).toMatchObject({ created: 0, merged: 2 });
    expect(source('cs-us').countries).toEqual([]);
    expect(source('cs1').countries).toEqual([]);
  });

  it('a CSV with the header ats,boardToken,companyName,countries; invalid rows are reported by file line', async () => {
    const csv = [
      'ats,boardToken,companyName,countries',
      'greenhouse,acme,Acme,',
      'smartrecruiters,HarborFoods,"Harbor, Foods",TW|CN',
      'workday,acme,Acme,',
      'lever,pinecloud,Pine Cloud,Taiwan',
      'greenhouse,acme,Acme again,',
      '',
      'ashby,islandlabs',
    ].join('\n');
    const res = await importRows(RA, { format: 'csv', csv });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      total: 6,
      created: 3,
      merged: 0,
      invalid: [
        { line: 4, reason: 'unknown_job_board' },
        { line: 5, reason: 'invalid_country' },
        { line: 6, reason: 'duplicate_in_file' },
      ],
      invalidCount: 3,
    });
    expect(rows('rACareerSiteSource').find((r) => r.boardToken === 'HarborFoods')).toMatchObject({ companyName: 'Harbor, Foods', countries: ['CN', 'TW'], origin: 'import', enabled: false });
    expect(rows('rACareerSiteSource').find((r) => r.boardToken === 'islandlabs')).toMatchObject({ companyName: 'islandlabs', countries: [] });
  });

  it('refuses a body of 5,001 rows, a CSV of 5,001 rows, a CSV without the header and a body that mixes the two formats (invalid_request)', async () => {
    const one = { ats: 'greenhouse', boardToken: 'acme' };
    const tooMany = await harness.request<Err>('POST', '/cs/import', { host: RA, body: { format: 'json', rows: Array.from({ length: 5001 }, () => one) } });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe('invalid_request');
    const csv = ['ats,boardToken', ...Array.from({ length: 5001 }, (_, i) => `greenhouse,co${i}`)].join('\n');
    const csvTooMany = await harness.request<Err>('POST', '/cs/import', { host: RA, body: { format: 'csv', csv } });
    expect(csvTooMany.status).toBe(422);
    expect(csvTooMany.body.code).toBe('invalid_request');
    expect((await harness.request<Err>('POST', '/cs/import', { host: RA, body: { format: 'csv', csv: 'company,id\nAcme,acme\n' } })).body.code).toBe('invalid_request');
    expect((await harness.request('POST', '/cs/import', { host: RA, body: { format: 'json', csv: 'ats,boardToken\n' } })).status).toBe(422);
    expect((await harness.request('POST', '/cs/import', { host: RA, body: { format: 'json', rows: [one], extra: true } })).status).toBe(422);
    expect(rows('rACareerSiteSource')).toHaveLength(3);
  });

  it('5,000 rows are accepted, written in chunks, and only the first 100 rejected rows are listed', async () => {
    const good = Array.from({ length: 4850 }, (_, i) => ({ ats: 'greenhouse', boardToken: `co${i}` }));
    const bad = Array.from({ length: 150 }, () => ({ ats: 'workday', boardToken: 'x' }));
    const res = await importRows(RA, { format: 'json', rows: [...bad, ...good] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 5000, created: 4850, merged: 0, invalidCount: 150 });
    expect(res.body.data.invalid).toHaveLength(100);
    expect(res.body.data.invalid[99]).toEqual({ line: 100, reason: 'unknown_job_board' });
    expect(rows('rACareerSiteSource')).toHaveLength(3 + 4850);
  });
});

// ── MKT-5B (JI-8, JC-8): more systems, and connectors that can be switched off ──

describe('MKT-5B: the systems a board can be added for', () => {
  it('the list answer names the systems whose connector is switched on here: Workable unless its kill switch is set, 北森 only with its flag', async () => {
    const res = await harness.request<Ok<CareerSourceView[]> & { data: unknown }>('GET', '/cs', { host: RA });
    expect((res.body.data as unknown as { systems: string[] }).systems).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu']);
    serviceEnv = { ATS_WORKABLE_DISABLED: 'true', CN_ATS_BEISEN_ENABLED: 'true' };
    const other = await harness.request<Ok<CareerSourceView[]> & { data: unknown }>('GET', '/cs', { host: GO });
    expect((other.body.data as unknown as { systems: string[] }).systems).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'personio', 'lever_eu', 'beisen']);
  });

  it('a Workable, Recruitee, Personio or Lever EU board is added like any other; an upper-case Personio id is refused', async () => {
    for (const body of [
      { ats: 'workable', boardToken: 'tidewater', companyName: 'Tidewater Analytics' },
      { ats: 'recruitee', boardToken: 'poldermobility', companyName: 'Polder Mobility' },
      { ats: 'personio', boardToken: 'alpenwerk', companyName: 'Alpenwerk' },
      { ats: 'personio', boardToken: 'bergwerk.com', companyName: 'Bergwerk' },
      { ats: 'lever_eu', boardToken: 'nordwind', companyName: 'Nordwind' },
    ]) {
      const res = await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: RA, body });
      expect(res.status, body.ats).toBe(201);
      expect(res.body.data).toMatchObject({ ...body, enabled: true, origin: 'admin', state: 'enabled' });
    }
    const upper = await harness.request<Err>('POST', '/cs', { host: RA, body: { ats: 'personio', boardToken: 'Alpenwerk2', companyName: 'Alpenwerk' } });
    expect(upper.status).toBe(422);
    expect(JSON.stringify(upper.body)).toContain('invalid_board_id');
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'recruitee', boardToken: 'polder.com', companyName: 'X' } })).status).toBe(422);
    expect(rows('rACareerSiteSource').some((r) => r.boardToken === 'Alpenwerk2')).toBe(false);
  });

  it('a system whose connector is switched off cannot be added: 北森 without its flag, Workable under its kill switch (connector_disabled)', async () => {
    const off = await harness.request<Err>('POST', '/cs', { host: GO, body: { ats: 'beisen', boardToken: 'shili', companyName: '示例科技' } });
    expect(off.status).toBe(422);
    expect(off.body).toMatchObject({ code: 'invalid_request', details: { field: 'ats', reason: 'connector_disabled' } });
    expect(rows('rACareerSiteSource').some((r) => r.ats === 'beisen')).toBe(false);
    serviceEnv = { ATS_WORKABLE_DISABLED: 'true' };
    const killed = await harness.request<Err>('POST', '/cs', { host: RA, body: { ats: 'workable', boardToken: 'tidewater', companyName: 'Tidewater' } });
    expect(killed.body).toMatchObject({ code: 'invalid_request', details: { reason: 'connector_disabled' } });
    // With the flag on the tenant is added (and an id that is not a sub-domain label is still refused).
    serviceEnv = { CN_ATS_BEISEN_ENABLED: 'true' };
    const on = await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: GO, body: { ats: 'beisen', boardToken: 'shili', companyName: '示例科技' } });
    expect(on.status).toBe(201);
    expect(on.body.data).toMatchObject({ ats: 'beisen', boardToken: 'shili', market: 'cn', enabled: true });
    expect((await harness.request('POST', '/cs', { host: GO, body: { ats: 'beisen', boardToken: 'Shili', companyName: 'X' } })).status).toBe(422);
    expect(fetched).toEqual([]);
  });

  it('an import refuses a row of a switched-off system by its own reason, and a tenant id that cannot be a host label', async () => {
    const res = await harness.request<Ok<ImportCareerSourcesResult>>('POST', '/cs/import', {
      host: GO,
      body: {
        format: 'json',
        rows: [
          { ats: 'beisen', boardToken: 'shili', companyName: '示例科技' },
          { ats: 'recruitee', boardToken: 'poldermobility', companyName: 'Polder Mobility' },
          { ats: 'personio', boardToken: 'Alpenwerk', companyName: 'Alpenwerk' },
          { ats: 'workable', boardToken: 'tidewater' },
        ],
      },
    });
    expect(res.body.data).toEqual({ total: 4, created: 2, merged: 0, invalid: [{ line: 1, reason: 'connector_disabled' }, { line: 3, reason: 'invalid_board_id' }], invalidCount: 2 });
    expect(rows('rACareerSiteSource').filter((r) => r.origin === 'import').map((r) => r.ats).sort()).toEqual(['recruitee', 'workable']);
    // The same file as CSV, with the flag on: the tenant is a candidate like any imported board.
    serviceEnv = { CN_ATS_BEISEN_ENABLED: 'true' };
    const csv = await harness.request<Ok<ImportCareerSourcesResult>>('POST', '/cs/import', { host: GO, body: { format: 'csv', csv: 'ats,boardToken,companyName,countries\nbeisen,shili,示例科技,\nbeisen,Shi Li,x,\n' } });
    expect(csv.body.data).toMatchObject({ total: 2, created: 1, invalid: [{ line: 3, reason: 'invalid_board_id' }] });
    expect(rows('rACareerSiteSource').find((r) => r.ats === 'beisen')).toMatchObject({ boardToken: 'shili', enabled: false, origin: 'import' });
  });
});

describe('MKT-5B: "Check now" on a source that is passed over, and the 30-minute floor of a tenant board', () => {
  const add = (over: Record<string, unknown>) => {
    rows('rACareerSiteSource').push(sourceRow({ id: 'extra', countryCode: null, ...over }));
  };

  it('a Workable source under the kill switch is not asked: the check reports connector_disabled and makes no request', async () => {
    add({ ats: 'workable', boardToken: 'tidewater', companyName: 'Tidewater', lastJobCount: 3 });
    serviceEnv = { ATS_WORKABLE_DISABLED: 'true' };
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: RA });
    expect(res.body.data).toEqual({ sourceId: 'extra', status: 'error', listed: 0, queued: false, error: 'connector_disabled' });
    expect(fetched).toEqual([]);
    // Left as it was, apart from the reason.
    expect(source('extra')).toMatchObject({ lastError: 'connector_disabled', lastJobCount: 3, lastSyncedAt: null, enabled: true });
  });

  it('a 北森 source without the flag makes no request; with it, the tenant is asked as GoApply even from the RoboApply host, and at most once in 30 minutes', async () => {
    add({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技', market: 'cn' });
    const off = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: GO });
    expect(off.body.data).toMatchObject({ status: 'error', error: 'connector_disabled' });
    expect(fetched).toEqual([]);
    expect(source('extra').lastSyncedAt).toBeNull();

    serviceEnv = { CN_ATS_BEISEN_ENABLED: 'true' };
    // The fake board answers 404 for this host: a request was made, and the time of it counts.
    const first = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: RA });
    expect(first.body.data).toMatchObject({ status: 'error', error: 'board_not_found' });
    expect(fetched).toEqual(['https://shili.zhiye.com/api/Jobad/GetJobAdPageList']);
    expect(agents[0]).toMatch(/^GoApplyJobs\//);
    expect(source('extra')).toMatchObject({ lastSyncedAt: NOW, lastError: 'board_not_found' });
    // Asked again at once: refused without a request.
    const again = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: GO });
    expect(again.body.data).toEqual({ sourceId: 'extra', status: 'error', listed: 0, queued: false, error: 'tenant_floor' });
    expect(fetched).toHaveLength(1);
    // 29 minutes later: still refused. 31 minutes later: asked.
    Object.assign(source('extra'), { lastSyncedAt: new Date(NOW.getTime() - 29 * 60_000) });
    expect((await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: GO })).body.data.error).toBe('tenant_floor');
    Object.assign(source('extra'), { lastSyncedAt: new Date(NOW.getTime() - 31 * 60_000) });
    expect((await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: GO })).body.data.error).toBe('board_not_found');
    expect(fetched).toHaveLength(2);
  });

  it('the time a tenant is asked is on the source BEFORE the request leaves, so the floor holds when the check is cut off by its time limit', async () => {
    add({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技', market: 'cn', lastSyncedAt: new Date(NOW.getTime() - 5 * 3_600_000) });
    const seenAtRequest: unknown[] = [];
    // A board that never answers; what the source row says when the request is made.
    const hanging: FetchLike = (_url, init) => {
      seenAtRequest.push(source('extra').lastSyncedAt);
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const service = createCareerSourcesService({ db: () => db as never, fetch: hanging, now: () => NOW, env: { CN_ATS_BEISEN_ENABLED: 'true' }, runNowTimeoutMs: 20 });
    expect(await service.runNow('extra', 'intl')).toMatchObject({ status: 'error', error: 'timeout', queued: false });
    expect(seenAtRequest).toEqual([NOW]);
    expect(source('extra')).toMatchObject({ lastSyncedAt: NOW, lastError: 'timeout' });
    // Asked again: refused, no second request.
    expect(await service.runNow('extra', 'cn')).toMatchObject({ status: 'error', error: 'tenant_floor' });
    expect(seenAtRequest).toHaveLength(1);
    // A check that reads the board leaves the time too and marks the tenant due; the board sync's lease holds the 30 minutes.
    const answering: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ Count: 1, Data: [{ Id: 'a', JobAdName: '合成岗位', LocNames: ['上海'] }] }) });
    Object.assign(source('extra'), { lastSyncedAt: new Date(NOW.getTime() - 31 * 60_000) });
    const ok = createCareerSourcesService({ db: () => db as never, fetch: answering, now: () => NOW, env: { CN_ATS_BEISEN_ENABLED: 'true' } });
    expect(await ok.runNow('extra', 'cn')).toMatchObject({ status: 'scheduled', listed: 1, queued: true });
    expect(source('extra')).toMatchObject({ lastSyncedAt: NOW, nextSyncAt: null, lastJobCount: 1, lastError: null });
    expect(await ok.runNow('extra', 'cn')).toMatchObject({ status: 'error', error: 'tenant_floor' });
  });

  it('a tenant that was only ever asked as a candidate keeps the time before which it must not be asked again, when an admin switches it on', async () => {
    // A candidate whose check was cut off 10 minutes ago: it carries the end of its 30 minutes, and no read time.
    const until = new Date(NOW.getTime() + 20 * 60_000);
    add({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技', market: 'cn', origin: 'import', enabled: false, nextSyncAt: until });
    serviceEnv = { CN_ATS_BEISEN_ENABLED: 'true' };
    const on = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/extra', { host: GO, body: { enabled: true } });
    expect(on.body.data).toMatchObject({ enabled: true, state: 'enabled', nextSyncAt: until.toISOString(), lastSyncedAt: null });
    // "Check now" inside that time makes no request either.
    expect((await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: GO })).body.data).toMatchObject({ status: 'error', error: 'tenant_floor' });
    expect(fetched).toEqual([]);
    // A candidate waiting for a retry two hours away is read 30 minutes after it is switched on, not two hours.
    Object.assign(source('extra'), { enabled: false, nextSyncAt: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect((await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/extra', { host: GO, body: { enabled: true } })).body.data.nextSyncAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    // A board of another system is due at once, as before.
    Object.assign(source('cs1'), { enabled: false, nextSyncAt: until, origin: 'import' });
    expect((await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: GO, body: { enabled: true } })).body.data.nextSyncAt).toBeNull();
  });

  it('a 北森 board feeds the mainland site only: it is in GoApply\'s list and not in RoboApply\'s, whatever countries it carries', async () => {
    add({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技', market: 'cn' });
    expect((await list(GO)).map((v) => v.id)).toContain('extra');
    expect((await list(RA)).map((v) => v.id)).not.toContain('extra');
    // A RoboApply admin can still look at the mainland site's boards.
    expect((await list(RA, '?market=cn')).map((v) => v.id)).toContain('extra');
  });

  it('a tenant on the denylist is never asked by a check either', async () => {
    add({ ats: 'beisen', boardToken: 'shili', companyName: '示例科技', market: 'cn' });
    serviceEnv = { CN_ATS_BEISEN_ENABLED: 'true', CN_ATS_TENANT_DENYLIST: 'shili' };
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/extra/run', { host: GO });
    expect(res.body.data).toMatchObject({ status: 'error', error: 'tenant_denied' });
    expect(fetched).toEqual([]);
    // Not a request: the 30 minutes do not start.
    expect(source('extra').lastSyncedAt).toBeNull();
  });
});
