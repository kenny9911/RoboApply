// @vitest-environment node
//
// WP-42: admin career-source routes (/api/v1/roboapply/admin/career-sources).
// Prisma is the in-memory fake; board HTTP is a fake fetch; the work queue
// is a spy ("Check now" queues ingest's standing ats_public query).

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
      rACareerSiteSource: [sourceRow()],
      rAJob: [
        { id: 'j1', sourceBoard: 'greenhouse', externalId: 'formosarobotics:4012345', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
        { id: 'j2', sourceBoard: 'greenhouse', externalId: 'formosarobotics:111', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
        { id: 'j3', sourceBoard: 'greenhouse', externalId: 'otherco:111', archivedAt: null, closedAt: null, closeReason: null, visibility: 'public' },
      ],
      rAIngestQuery: [
        { id: 'q-rapid', provider: 'jsearch', market: 'intl', enabled: true, nextRunAt: new Date('2026-10-11T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') },
        { id: 'q-ats', provider: 'ats_public', market: 'intl', enabled: true, nextRunAt: new Date('2026-10-10T00:30:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') },
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

  it.each([
    ['GET', '/cs'],
    ['POST', '/cs/cs1/run'],
  ])('%s %s → 404 feature_disabled on the GoApply host', async (method, path) => {
    const res = await harness.request<{ code: string }>(method, path, { host: GO });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
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

  it('adds a board for the international site, refuses mainland and duplicates', async () => {
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
    expect(rows('rACareerSiteSource')).toHaveLength(0);
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
    expect(await service.runNow('cs-sr')).toMatchObject({ status: 'scheduled', listed: 3 });
    expect(await service.runNow('cs1')).toMatchObject({ status: 'scheduled', listed: 2 });
    expect(urls).toEqual([
      'https://api.smartrecruiters.com/v1/companies/HarborFoods/postings?limit=100&offset=0',
      'https://boards-api.greenhouse.io/v1/boards/formosarobotics/jobs',
    ]);
  });

  it('gives up after its overall time limit and reports it', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const service = createCareerSourcesService({ db: () => db as never, fetch: hanging, now: () => NOW, kick, enqueue, runNowTimeoutMs: 20 });
    expect(await service.runNow('cs1')).toMatchObject({ status: 'error', error: 'timeout', queued: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 for a board that is off, 404 for an unknown source', async () => {
    rows('rACareerSiteSource')[0]!.enabled = false;
    expect((await harness.request('POST', '/cs/cs1/run', { host: RA })).status).toBe(409);
    expect((await harness.request('POST', '/cs/nope/run', { host: RA })).status).toBe(404);
  });
});
