// @vitest-environment node
//
// WP-35 route tests: /jobs/import over a stub service (the service has its own
// tests): auth, capability, validation, envelopes and error mapping.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { setFlagOverrideLoader } from '../../../platform/flags.js';
import { HttpError } from '../../../platform/http.js';
import { CreditsExhaustedError } from '../../../platform/credits/index.js';
import { createJobImportRouter } from './routes.js';
import type { JobImportService } from './service.js';
import type { ImportJobResponse } from './contract.js';

const BASE = '/api/v1/roboapply/jobs/import';
const done: ImportJobResponse = { importId: 'job_j1', status: 'done', jobId: 'j1', missingFields: [], warnings: [], reason: null, draft: null, matched: null };

const svc = {
  importJob: vi.fn(async () => done),
  saveJob: vi.fn(async () => done),
  status: vi.fn(async () => ({ status: 'done' as const, jobId: 'j1', missingFields: [], warnings: [], reason: null })),
  listAdded: vi.fn(async () => ({ items: [], cursor: null })),
  removeAdded: vi.fn(async () => undefined),
} satisfies JobImportService;

let user: { id: string } | null = { id: 'u1' };
let on: RouteHarness;
let off: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const auth = [fakeAuth(() => user)];
  on = await startRouteHarness({ env: {}, mounts: [[BASE, createJobImportRouter({ seekerAuth: auth, env: {}, service: svc })]] });
  const offEnv = { FLAG_ROBOAPPLY_JOBS_IMPORT: 'false' };
  off = await startRouteHarness({ env: offEnv, mounts: [[BASE, createJobImportRouter({ seekerAuth: auth, env: offEnv, service: svc })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});
beforeEach(() => {
  user = { id: 'u1' };
  vi.clearAllMocks();
});

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };
const HOST = 'localhost:3621';

describe('/jobs/import', () => {
  it('401 without a session on every route', async () => {
    user = null;
    for (const [m, p] of [
      ['POST', BASE],
      ['GET', BASE],
      ['GET', `${BASE}/job_x`],
      ['DELETE', `${BASE}/jobs/j1`],
    ] as const) {
      const r = await on.request(m, p, { host: HOST, body: m === 'POST' ? { url: 'https://a.example/j' } : undefined });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    expect(svc.importJob).not.toHaveBeenCalled();
  });

  it('404 feature_disabled when jobs.import is off', async () => {
    const r = await off.request<Env<unknown>>('POST', BASE, { host: HOST, body: { url: 'https://a.example/j' } });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('feature_disabled');
    const list = await off.request<Env<unknown>>('GET', BASE, { host: HOST });
    expect(list.body.code).toBe('feature_disabled');
  });

  it('POST passes the body and the Idempotency-Key to the service', async () => {
    const r = await on.request<Env<ImportJobResponse>>('POST', BASE, {
      host: HOST,
      headers: { 'Idempotency-Key': 'k-1' },
      body: { manual: { title: 'Data Engineer', company: 'Acme', description: 'x'.repeat(60), applyUrl: 'https://a.example/j' } },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, data: done });
    expect(svc.importJob).toHaveBeenCalledWith('u1', { manual: expect.objectContaining({ title: 'Data Engineer' }) }, 'k-1');
  });

  it.each([
    [{ url: 'javascript:alert(1)' }],
    [{ url: 'ftp://a.example/j' }],
    [{ url: 'https://a.example/j', manual: {} }],
    [{ manual: { title: 'A', company: 'B', description: 'too short' } }],
    [{ manual: { title: 'A', company: 'B', description: 'x'.repeat(60), applyUrl: 'javascript:alert(1)' } }],
    [{ manual: { title: '', company: 'B', description: 'x'.repeat(60) } }],
    [{}],
  ])('422 invalid_request for %j', async (body) => {
    const r = await on.request<Env<unknown>>('POST', BASE, { host: HOST, body });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('invalid_request');
    expect(svc.importJob).not.toHaveBeenCalled();
  });

  it('429 rate_limited with Retry-After and the lock details', async () => {
    svc.importJob.mockRejectedValueOnce(
      new HttpError('rate_limited', 'paused', { reason: 'import_locked', retryAfterSec: 3600, lockedUntil: '2026-10-10T13:00:00.000Z' }, { 'Retry-After': '3600' }),
    );
    const r = await on.request<Env<unknown>>('POST', BASE, { host: HOST, body: { url: 'https://a.example/j' } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
    expect(r.body).toMatchObject({ code: 'rate_limited', details: { reason: 'import_locked' } });
  });

  it('402 credits_exhausted with the bucket details', async () => {
    svc.importJob.mockRejectedValueOnce(new CreditsExhaustedError({ bucket: 'job_import', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true, cap: 10, window: 'day' }));
    const r = await on.request<Env<unknown>>('POST', BASE, { host: HOST, body: { url: 'https://a.example/j' } });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: 'credits_exhausted', details: { bucket: 'job_import', upgradable: true } });
  });

  it('GET / lists added jobs with a validated limit', async () => {
    const r = await on.request<Env<unknown>>('GET', `${BASE}?limit=5&cursor=abc`, { host: HOST });
    expect(r.status).toBe(200);
    expect(svc.listAdded).toHaveBeenCalledWith('u1', { limit: 5, cursor: 'abc' });
    const bad = await on.request<Env<unknown>>('GET', `${BASE}?limit=500`, { host: HOST });
    expect(bad.status).toBe(422);
  });

  it('GET /:importId answers the status; not found is a 404 envelope', async () => {
    const r = await on.request<Env<unknown>>('GET', `${BASE}/job_j1`, { host: HOST });
    expect(r.status).toBe(200);
    expect(svc.status).toHaveBeenCalledWith('u1', 'job_j1');
    svc.status.mockRejectedValueOnce(new HttpError('not_found', 'This import was not found.', { reason: 'import_not_found' }));
    const missing = await on.request<Env<unknown>>('GET', `${BASE}/draft_x`, { host: HOST });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'not_found', details: { reason: 'import_not_found' } });
  });

  it('DELETE /jobs/:jobId removes an added job (204)', async () => {
    const r = await on.request('DELETE', `${BASE}/jobs/j1`, { host: HOST });
    expect(r.status).toBe(204);
    expect(svc.removeAdded).toHaveBeenCalledWith('u1', 'j1');
  });
});
