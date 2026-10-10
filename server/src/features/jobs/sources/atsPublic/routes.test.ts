// @vitest-environment node
//
// WP-42: admin career-source routes (/api/v1/roboapply/admin/career-sources).
// Prisma is the in-memory fake; board HTTP is a fake fetch; the work queue
// is a spy ("Check now" queues ingest's standing ats_public query).
// Parity wave (PAR-7): both brands. An admin works on the boards of the brand
// whose host they are on; the other brand's boards are never listed and answer
// 404 by id; the standing query and the queued work follow the board's market.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireAdmin } from '../../../../middleware/admin.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../../../test/routeHarness.js';
import type { CareerSourceRunResult, CareerSourceView } from './contract.js';
import type { FetchLike } from './http.js';
import { createCareerSourcesAdminRouter } from './routes.js';
import { createCareerSourcesService } from './service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_BODY = readFileSync(join(HERE, '__fixtures__', 'greenhouse.json'), 'utf8');
const RA = 'localhost:3611';
const GO = 'goapply.localhost:3611';
const ENV = { NODE_ENV: 'test', DEPLOY_REGION: '' };
const NOW = new Date('2026-10-10T00:00:00.000Z');

let harness: RouteHarness;
let admin: HarnessUser | null = { id: 'admin1', role: 'admin' };
let db: ReturnType<typeof createFakePrisma>;
const kick = vi.fn();
const enqueue = vi.fn(async () => ({}));
const fetchBoard: FetchLike = async (url) =>
  url.startsWith('https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs')
    ? { ok: true, status: 200, text: async () => GH_BODY }
    : { ok: false, status: 404, text: async () => '' };

beforeAll(async () => {
  const service = createCareerSourcesService({ db: () => db as never, fetch: fetchBoard, now: () => NOW, kick, enqueue });
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
    createdBy: 'admin1',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  admin = { id: 'admin1', role: 'admin' };
  kick.mockClear();
  enqueue.mockClear();
  db = createFakePrisma({
    seed: {
      rACareerSiteSource: [sourceRow(), sourceRow({ id: 'cs-cn', market: 'cn', boardToken: 'cnboard', companyName: 'Mainland Co', countryCode: 'CN' })],
      rAJob: [
        { id: 'j1', market: 'intl', sourceBoard: 'greenhouse', externalId: 'formosarobotics:4012345', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
        { id: 'j2', market: 'intl', sourceBoard: 'greenhouse', externalId: 'formosarobotics:111', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
        { id: 'j3', market: 'intl', sourceBoard: 'greenhouse', externalId: 'otherco:111', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
        { id: 'j-cn', market: 'cn', sourceBoard: 'greenhouse', externalId: 'cnboard:1', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
      ],
      rAIngestQuery: [
        { id: 'q-rapid', provider: 'jsearch', market: 'intl', enabled: true, nextRunAt: new Date('2026-10-11T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') },
        { id: 'q-ats', provider: 'ats_public', market: 'intl', enabled: true, nextRunAt: new Date('2026-10-10T00:30:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') },
        { id: 'q-ats-cn', provider: 'ats_public', market: 'cn', enabled: true, nextRunAt: new Date('2026-10-10T00:30:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') },
      ],
    },
    uniqueFields: { rACareerSiteSource: ['boardToken'] },
    defaults: { rACareerSiteSource: { lastSyncedAt: null, lastJobCount: null, lastError: null, companyId: null, countryCode: null } },
  });
});

type Ok<T> = { success: true; data: T };
const rows = (model: string) => db.$rows(model);

describe('access', () => {
  it.each([
    ['GET', '/cs'],
    ['POST', '/cs'],
    ['PATCH', '/cs/cs1'],
    ['DELETE', '/cs/cs1'],
    ['POST', '/cs/cs1/run'],
  ])('%s %s → 401 without a session, 403 for a non-admin', async (method, path) => {
    const init = { host: RA, ...(method === 'GET' ? {} : { body: {} }) };
    admin = null;
    expect((await harness.request(method, path, init)).status).toBe(401);
    admin = { id: 'u1', role: 'seeker' };
    expect((await harness.request(method, path, init)).status).toBe(403);
  });

  it('the GoApply host is served too: its admin sees GoApply\'s boards and never RoboApply\'s', async () => {
    const go = await harness.request<Ok<{ items: CareerSourceView[] }>>('GET', '/cs', { host: GO });
    expect(go.status).toBe(200);
    expect(go.body.data.items.map((i) => [i.id, i.market])).toEqual([['cs-cn', 'cn']]);
    const ra = await harness.request<Ok<{ items: CareerSourceView[] }>>('GET', '/cs', { host: RA });
    expect(ra.body.data.items.map((i) => [i.id, i.market])).toEqual([['cs1', 'intl']]);
    // Asking for the other market's list answers an empty list, on either host.
    expect((await harness.request<Ok<{ items: CareerSourceView[] }>>('GET', '/cs?market=intl', { host: GO })).body.data.items).toEqual([]);
    expect((await harness.request<Ok<{ items: CareerSourceView[] }>>('GET', '/cs?market=cn', { host: RA })).body.data.items).toEqual([]);
  });

  it.each([
    ['PATCH', '/cs/cs1', GO],
    ['DELETE', '/cs/cs1', GO],
    ['POST', '/cs/cs1/run', GO],
    ['PATCH', '/cs/cs-cn', RA],
    ['DELETE', '/cs/cs-cn', RA],
    ['POST', '/cs/cs-cn/run', RA],
  ])('%s %s on the other brand\'s host → 404, and nothing changes', async (method, path, host) => {
    const res = await harness.request(method, path, { host, ...(method === 'PATCH' ? { body: { enabled: false } } : {}) });
    expect(res.status).toBe(404);
    expect(rows('rACareerSiteSource')).toHaveLength(2);
    expect(rows('rACareerSiteSource').every((r) => r.enabled === true)).toBe(true);
    expect(rows('rAJob').every((r) => r.archivedAt === null)).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('GoApply admin: add and check a public board', () => {
  it('adds a board with market cn (the default on that host) and refuses naming the other market', async () => {
    const res = await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: GO, body: { ats: 'lever', boardToken: 'veeva', companyName: 'veeva', countryCode: 'CN' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ats: 'lever', boardToken: 'veeva', market: 'cn', enabled: true, countryCode: 'CN' });
    expect((await harness.request<Ok<CareerSourceView>>('POST', '/cs', { host: GO, body: { ats: 'ashby', boardToken: 'airwallex', companyName: 'airwallex', market: 'cn' } })).body.data.market).toBe('cn');
    expect((await harness.request('POST', '/cs', { host: GO, body: { ats: 'lever', boardToken: 'x', companyName: 'X', market: 'intl' } })).status).toBe(422);
    expect(rows('rACareerSiteSource').filter((r) => r.market === 'cn')).toHaveLength(3);
  });

  it('a board the other site already reads answers 409 with a reason that says so; a board in this site\'s own list answers the plain duplicate', async () => {
    // Review case: the seed registers global boards for market cn; a RoboApply admin who adds one must not be told "already in the list".
    type Err = { success: false; error: string; code: string; details?: { field?: string; reason?: string } };
    const taken = await harness.request<Err>('POST', '/cs', { host: RA, body: { ats: 'greenhouse', boardToken: 'cnboard', companyName: 'Mainland Co' } });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ success: false, code: 'conflict', details: { field: 'boardToken', reason: 'board_on_other_site' } });
    expect(taken.body.error).toMatch(/other site/);
    // The same from the GoApply host for a board RoboApply reads.
    const reverse = await harness.request<Err>('POST', '/cs', { host: GO, body: { ats: 'greenhouse', boardToken: 'formosarobotics', companyName: 'Formosa' } });
    expect(reverse.status).toBe(409);
    expect(reverse.body.details).toMatchObject({ reason: 'board_on_other_site' });
    // A board already in this site's own list: no reason, the plain message.
    const own = await harness.request<Err>('POST', '/cs', { host: GO, body: { ats: 'greenhouse', boardToken: 'cnboard', companyName: 'Again' } });
    expect(own.status).toBe(409);
    expect(own.body.error).toBe('This job board is already in the list.');
    expect(own.body.details?.reason).toBeUndefined();
    expect(rows('rACareerSiteSource')).toHaveLength(2);
  });

  it('"Check now" counts the board\'s mainland postings, re-times the cn standing query and queues the work for GoApply', async () => {
    const jobs = [
      { id: 1, title: '数据分析师', absolute_url: 'https://boards.greenhouse.io/cnboard/jobs/1', location: { name: '上海' } },
      { id: 2, title: 'Data Analyst', absolute_url: 'https://boards.greenhouse.io/cnboard/jobs/2', location: { name: 'Singapore' } },
      { id: 3, title: '后端工程师', absolute_url: 'https://boards.greenhouse.io/cnboard/jobs/3', location: { name: 'Shenzhen, China' } },
    ];
    const cnFetch: FetchLike = async (url) =>
      url === 'https://boards-api.greenhouse.io/v1/boards/cnboard/jobs' ? { ok: true, status: 200, text: async () => JSON.stringify({ jobs }) } : { ok: false, status: 404, text: async () => '' };
    const service = createCareerSourcesService({ db: () => db as never, fetch: cnFetch, now: () => NOW, kick, enqueue });
    expect(await service.runNow('cs-cn', 'cn')).toEqual({ sourceId: 'cs-cn', status: 'scheduled', listed: 2, queued: true, error: null });
    expect(rows('rAIngestQuery').find((q) => q.id === 'q-ats-cn')!.nextRunAt).toEqual(NOW);
    expect(rows('rAIngestQuery').find((q) => q.id === 'q-ats')!.nextRunAt).toEqual(new Date('2026-10-10T00:30:00Z'));
    expect(enqueue).toHaveBeenCalledWith('ingest.query', { queryId: 'q-ats-cn' }, expect.objectContaining({ brand: 'goapply' }));
  });

  it('turning a GoApply board off archives only its own market\'s open jobs', async () => {
    const off = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs-cn', { host: GO, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(rows('rAJob').filter((r) => r.closeReason === 'source_removed').map((r) => r.id)).toEqual(['j-cn']);
  });
});

describe('list / create / update / delete', () => {
  it('lists sources', async () => {
    const res = await harness.request<Ok<{ items: CareerSourceView[] }>>('GET', '/cs?market=intl&enabled=true', { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      {
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
      },
    ]);
    expect((await harness.request('GET', '/cs?enabled=maybe', { host: RA })).status).toBe(422);
  });

  it('adds a board for the international site on the RoboApply host, refuses the other market and duplicates', async () => {
    const res = await harness.request<Ok<CareerSourceView>>('POST', '/cs', {
      host: RA,
      body: { ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countryCode: 'TW' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ats: 'lever', boardToken: 'pinecloud', market: 'intl', enabled: true, countryCode: 'TW' });
    expect(rows('rACareerSiteSource').find((r) => r.boardToken === 'pinecloud')).toMatchObject({ createdBy: 'admin1' });

    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'lever', boardToken: 'x', companyName: 'X', market: 'cn' } })).status).toBe(422);
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'workday', boardToken: 'x', companyName: 'X' } })).status).toBe(422);
    expect((await harness.request('POST', '/cs', { host: RA, body: { ats: 'lever', boardToken: 'pinecloud', companyName: 'Again' } })).status).toBe(409);
  });

  it('turning a board off archives its open jobs; turning it on re-reads it next run', async () => {
    const off = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: RA, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(off.body.data.enabled).toBe(false);
    expect(rows('rAJob').filter((r) => r.closeReason === 'source_removed').map((r) => r.id)).toEqual(['j1', 'j2']);
    expect(rows('rAJob').find((r) => r.id === 'j3')!.archivedAt).toBeNull();

    rows('rACareerSiteSource')[0]!.lastSyncedAt = NOW;
    const on = await harness.request<Ok<CareerSourceView>>('PATCH', '/cs/cs1', { host: RA, body: { enabled: true, companyName: 'Formosa Robotics Inc.' } });
    expect(on.body.data).toMatchObject({ enabled: true, companyName: 'Formosa Robotics Inc.', lastSyncedAt: null });
    expect((await harness.request('PATCH', '/cs/nope', { host: RA, body: { enabled: true } })).status).toBe(404);
    expect((await harness.request('PATCH', '/cs/cs1', { host: RA, body: { boardToken: 'changed' } })).status).toBe(422);
  });

  it('removing a board archives its open jobs and deletes the row', async () => {
    const res = await harness.request<Ok<{ archivedJobs: number }>>('DELETE', '/cs/cs1', { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ archivedJobs: 2 });
    expect(rows('rACareerSiteSource').map((r) => r.id)).toEqual(['cs-cn']);
    expect((await harness.request('DELETE', '/cs/cs1', { host: RA })).status).toBe(404);
  });
});

describe('POST /:id/run (Check now)', () => {
  it('reads the board, marks the source due and queues the standing ats_public ingest query', async () => {
    rows('rACareerSiteSource')[0]!.lastSyncedAt = new Date('2026-10-09T00:00:00Z');
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/cs1/run', { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sourceId: 'cs1', status: 'scheduled', listed: 2, queued: true, error: null });
    expect(rows('rACareerSiteSource')[0]).toMatchObject({ lastSyncedAt: null, lastError: null, lastJobCount: 2 });
    expect(rows('rAIngestQuery').find((q) => q.id === 'q-ats')!.nextRunAt).toEqual(NOW);
    expect(rows('rAIngestQuery').find((q) => q.id === 'q-rapid')!.nextRunAt).toEqual(new Date('2026-10-11T00:00:00Z'));
    expect(enqueue).toHaveBeenCalledWith('ingest.query', { queryId: 'q-ats' }, expect.objectContaining({ brand: 'roboapply' }));
    await vi.waitFor(() => expect(kick).toHaveBeenCalledWith(['ingest.query']));
    // Nothing is written to jobs by the check itself.
    expect(rows('rAJob').every((r) => r.archivedAt === null)).toBe(true);
  });

  it('without a standing query yet, the board waits for the next scheduled run', async () => {
    db.$rows('rAIngestQuery').splice(0);
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/cs1/run', { host: RA });
    expect(res.body.data).toEqual({ sourceId: 'cs1', status: 'scheduled', listed: 2, queued: false, error: null });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a board that cannot be read is reported and nothing is queued', async () => {
    rows('rACareerSiteSource')[0]!.boardToken = 'gone';
    const res = await harness.request<Ok<CareerSourceRunResult>>('POST', '/cs/cs1/run', { host: RA });
    expect(res.body.data).toMatchObject({ status: 'error', error: 'board_not_found', queued: false });
    expect(enqueue).not.toHaveBeenCalled();
    expect(rows('rACareerSiteSource')[0]).toMatchObject({ lastError: 'board_not_found' });
  });

  it('reads the listing only: no posting texts (SmartRecruiters details, Greenhouse content)', async () => {
    const urls: string[] = [];
    const spy: FetchLike = async (url) => {
      urls.push(url);
      if (url.startsWith('https://api.smartrecruiters.com/v1/companies/HarborFoods/postings?')) {
        const content = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, name: `Role ${i}` }));
        return { ok: true, status: 200, text: async () => JSON.stringify({ totalFound: 3, content }) };
      }
      return fetchBoard(url, {});
    };
    const service = createCareerSourcesService({ db: () => db as never, fetch: spy, now: () => NOW, kick, enqueue });
    rows('rACareerSiteSource').push(sourceRow({ id: 'cs-sr', ats: 'smartrecruiters', boardToken: 'HarborFoods', companyName: 'Harbor Foods' }));
    expect(await service.runNow('cs-sr', 'intl')).toMatchObject({ status: 'scheduled', listed: 3 });
    expect(await service.runNow('cs1', 'intl')).toMatchObject({ status: 'scheduled', listed: 2 });
    expect(urls).toEqual([
      'https://api.smartrecruiters.com/v1/companies/HarborFoods/postings?limit=100&offset=0',
      'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs',
    ]);
  });

  it('gives up after its overall time limit and reports it', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const service = createCareerSourcesService({ db: () => db as never, fetch: hanging, now: () => NOW, kick, enqueue, runNowTimeoutMs: 20 });
    expect(await service.runNow('cs1', 'intl')).toMatchObject({ status: 'error', error: 'timeout', queued: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 for a board that is off, 404 for an unknown source', async () => {
    rows('rACareerSiteSource')[0]!.enabled = false;
    expect((await harness.request('POST', '/cs/cs1/run', { host: RA })).status).toBe(409);
    expect((await harness.request('POST', '/cs/nope/run', { host: RA })).status).toBe(404);
  });
});
