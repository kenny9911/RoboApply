// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import { z } from 'zod';
import {
  ERROR_STATUS,
  HttpError,
  MIN_SAMPLE,
  NotImplementedError,
  errorHandler,
  fail,
  mapError,
  meetsMinSample,
  notImplemented,
  parseBody,
  parseQuery,
  route,
  sourced,
  sourcedAggregate,
} from './http.js';
import { startRouteHarness, type RouteHarness } from '../test/routeHarness.js';

describe('error codes', () => {
  it('declares every code the plan names, with its status', () => {
    expect(ERROR_STATUS).toMatchObject({
      invalid_request: 422,
      credits_exhausted: 402,
      feature_disabled: 404,
      ai_unavailable: 503,
      version_conflict: 409,
      account_other_brand: 409,
      auth_other_brand: 401,
      rate_limited: 429,
      provider_not_configured: 501,
      not_implemented: 501,
      content_blocked: 422,
      brand_policy: 500,
      brand_unavailable: 404,
      storage_unavailable: 503,
      brand_context_missing: 500,
      credits_busy: 503,
    });
  });

  it('maps the WP-15 residency errors (storage_unavailable → 503, brand_context_missing → 500)', async () => {
    const { StorageUnavailableError } = await import('./residency/uploadPolicy.js');
    const { WriteBrandUnknownError } = await import('./residency/writeBrand.js');
    expect(mapError(new StorageUnavailableError('goapply')).status).toBe(503);
    expect(mapError(new StorageUnavailableError('goapply')).body.code).toBe('storage_unavailable');
    const missing = mapError(new WriteBrandUnknownError('saveFile'));
    expect([missing.status, missing.body.code]).toEqual([500, 'brand_context_missing']);
  });

  it('maps duck-typed domain errors by code and lifts their details', () => {
    const credits = Object.assign(new Error('Out of tailor credits'), {
      code: 'credits_exhausted',
      bucket: 'tailor',
      resetsAt: new Date('2026-10-11T00:00:00Z'),
      upgradable: true,
    });
    const mapped = mapError(credits);
    expect(mapped.status).toBe(402);
    expect(mapped.body).toEqual({
      success: false,
      code: 'credits_exhausted',
      error: 'Out of tailor credits',
      details: { bucket: 'tailor', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true },
    });
    expect(mapError(Object.assign(new Error('x'), { code: 'version_conflict', currentVersion: 4 })).body.details).toEqual({
      currentVersion: 4,
    });
  });

  it('never leaks an unexpected error message', () => {
    const mapped = mapError(new Error('password=hunter2 in SQL'));
    expect(mapped).toMatchObject({ status: 500, unexpected: true });
    expect(JSON.stringify(mapped.body)).not.toContain('hunter2');
  });

  it('maps NotImplementedError to 501 not_implemented', () => {
    expect(mapError(new NotImplementedError('Tailoring'))).toMatchObject({
      status: 501,
      body: { code: 'not_implemented', error: 'Tailoring is not implemented yet.' },
    });
  });

  it('adds Retry-After for rate_limited', () => {
    expect(mapError(new HttpError('rate_limited', undefined, { retryAfterSec: 12.2 })).headers).toEqual({ 'Retry-After': '13' });
  });
});

describe('route() and validation over HTTP', () => {
  let h: RouteHarness;
  const logError = vi.fn();
  beforeAll(async () => {
    const r = Router();
    const Body = z.object({ name: z.string().min(1), count: z.number().int() });
    r.post('/echo', route(async (req) => parseBody(req, Body)));
    r.get('/q', route(async (req) => parseQuery(req, z.object({ page: z.coerce.number().int().min(1) }))));
    r.post('/created', route(async () => ({ id: 'x' }), { status: 201 }));
    r.get('/boom', route(async () => {
      throw new Error('secret detail');
    }, { logError }));
    r.get('/limited', route(async () => {
      throw new HttpError('rate_limited', undefined, { retryAfterSec: 30 });
    }));
    // FIX-9: what a route answers when a credit reserve finds the database busy.
    r.post('/reserve-busy', route(async () => {
      const { CreditStoreBusyError } = await import('./credits/errors.js');
      throw new CreditStoreBusyError({ cause: new Error('Transaction API error: P2028 on db.internal:5432') });
    }, { logError }));
    r.get('/stub', (_req, res) => notImplemented(res, 'Feed'));
    r.get('/fail', (_req, res) => fail(res, 'feature_disabled'));
    r.get('/next-error', (_req, _res, next) => next(new HttpError('forbidden')));
    r.use(errorHandler(() => undefined));
    h = await startRouteHarness({ mounts: [['/t', r]] });
  });
  afterAll(() => h.close());

  it('wraps a returned value in the success envelope', async () => {
    const res = await h.request('POST', '/t/echo', { body: { name: 'a', count: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { name: 'a', count: 2 } });
    expect((await h.request('POST', '/t/created')).status).toBe(201);
  });

  it('answers 422 invalid_request with the zod issues', async () => {
    const res = await h.request<{ code: string; details: { where: string; issues: Array<{ path: unknown[] }> } }>('POST', '/t/echo', {
      body: { name: '', count: 1.5 },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
    expect(res.body.details.where).toBe('body');
    expect(res.body.details.issues.map((i) => i.path[0]).sort()).toEqual(['count', 'name']);
    const q = await h.request<{ details: { where: string } }>('GET', '/t/q?page=0');
    expect(q.status).toBe(422);
    expect(q.body.details.where).toBe('query');
  });

  it('turns unexpected errors into a 500 without the message and logs them', async () => {
    const res = await h.request('GET', '/t/boom');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret detail');
    expect(logError).toHaveBeenCalledOnce();
  });

  it('sets Retry-After on 429', async () => {
    const res = await h.request('GET', '/t/limited');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('a busy credit store answers 503 credits_busy with Retry-After, never a bare 500 or the database error (FIX-9)', async () => {
    logError.mockClear();
    const res = await h.request<{ success: boolean; code: string; error: string; details: { retryAfterSec: number } }>('POST', '/t/reserve-busy');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.body).toEqual({
      success: false,
      code: 'credits_busy',
      error: 'We could not start this right now. Try again in a moment.',
      details: { retryAfterSec: 5 },
    });
    expect(res.text).not.toContain('P2028');
    // An expected, retryable answer: the store logs the cause itself; the route does not log it as a crash.
    expect(logError).not.toHaveBeenCalled();
    expect(mapError(new HttpError('credits_busy', undefined, { retryAfterSec: 5 })).headers).toEqual({ 'Retry-After': '5' });
  });

  it('stubs answer 501 and fail() writes the envelope; errorHandler maps next(err)', async () => {
    expect(await h.request('GET', '/t/stub')).toMatchObject({ status: 501, body: { success: false, code: 'not_implemented' } });
    expect(await h.request('GET', '/t/fail')).toMatchObject({ status: 404, body: { code: 'feature_disabled' } });
    expect(await h.request('GET', '/t/next-error')).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  });
});

describe('D3 provenance helpers', () => {
  it('MIN_SAMPLE is 20 and aggregates below it are withheld', () => {
    expect(MIN_SAMPLE).toBe(20);
    expect(meetsMinSample(19)).toBe(false);
    expect(meetsMinSample(20)).toBe(true);
    expect(meetsMinSample(undefined)).toBe(false);
    const asOf = new Date('2026-10-01T00:00:00Z');
    expect(sourcedAggregate(120000, { source: 'aggregate', sampleSize: 19, asOf })).toBeNull();
    expect(sourcedAggregate(120000, { source: 'aggregate', sampleSize: 25, asOf })).toEqual({
      value: 120000,
      source: 'aggregate',
      sampleSize: 25,
      asOf: '2026-10-01T00:00:00.000Z',
    });
  });

  it('unknown values stay null (rendered as "—"), never 0', () => {
    expect(sourced(null, { source: 'posting', asOf: new Date() })).toBeNull();
    expect(sourced(0, { source: 'posting', asOf: '2026-10-01T00:00:00Z' })).toMatchObject({ value: 0 });
  });
});
