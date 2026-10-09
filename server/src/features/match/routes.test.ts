// @vitest-environment node
// WP-18 — MATCH routes: fit analysis (credit + Idempotency-Key), keyword check,
// the score handler WP-34 mounts, auth and the competitiveness flag.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Router } from 'express';
import { getBrand } from '../../platform/brand/registry.js';
import { CreditsExhaustedError } from '../../platform/credits/errors.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createMatchService, type MatchService } from './MatchService.js';
import { createMatchRouter, createScoreJobHandler } from './routes.js';
import { createMemoryRepo } from './testkit.js';

const scorerRun = vi.fn();
let exhausted = false;

function service(): MatchService {
  return createMatchService({
    repo: createMemoryRepo({ keywords: { job1: [{ keyword: 'Kubernetes', importance: 'high' }] } }),
    scorer: { run: scorerRun },
    resolveModel: () => 'test/model',
    aiAllowed: async () => true,
    consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 10, windows: [] }),
    withCredit: async (_opts, fn) => {
      if (exhausted) throw new CreditsExhaustedError({ bucket: 'fit_analysis', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true, cap: 10, window: 'day' });
      return fn();
    },
    costLog: async () => undefined,
    profileSnapshot: async () => null,
    brand: () => getBrand('roboapply'),
    env: {},
  });
}

let h: RouteHarness;
const svc = service();
const get = async () => svc;
const auth = fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null));

function jobsRouter() {
  const r = Router();
  r.post('/:id/score', auth, createScoreJobHandler(get));
  return r;
}

beforeAll(async () => {
  h = await startRouteHarness({
    mounts: [
      ['/api/v1/roboapply/match', createMatchRouter({ seekerAuth: [auth], env: {} }, get)],
      ['/api/v1/roboapply/jobs', jobsRouter()],
    ],
  });
});
afterAll(() => h.close());

const U = { 'x-test-user': 'u1' };

describe('POST /match/jobs/:id/fit-analysis', () => {
  it('401 without a session', async () => {
    const res = await h.request('POST', '/api/v1/roboapply/match/jobs/job1/fit-analysis', { body: {}, headers: { 'Idempotency-Key': 'key-12345678' } });
    expect(res.status).toBe(401);
  });

  it('422 without an Idempotency-Key, or with an unknown body field', async () => {
    const res = await h.request<{ code: string; details: { reason: string } }>('POST', '/api/v1/roboapply/match/jobs/job1/fit-analysis', { body: {}, headers: U });
    expect(res.status).toBe(422);
    expect(res.body.details.reason).toBe('idempotency_key_required');
    const bad = await h.request('POST', '/api/v1/roboapply/match/jobs/job1/fit-analysis', { body: { nope: 1 }, headers: { ...U, 'Idempotency-Key': 'key-12345678' } });
    expect(bad.status).toBe(422);
  });

  it('answers the card; 402 credits_exhausted with the bucket details; 404 for an unknown job', async () => {
    scorerRun.mockResolvedValue({
      dimensions: { title_level: { score: 90, evidence: [] }, skills: { score: 70, evidence: [] }, industry: { score: null, evidence: [] }, career_path: { score: 60, evidence: [] } },
      strengths: ['Your Go services'],
      gaps: [],
      keywordsMatched: [],
      keywordsMissing: [],
      summary: 'Your Go work fits this role.',
    });
    exhausted = true;
    const out = await h.request<{ code: string; details: { bucket: string; upgradable: boolean } }>('POST', '/api/v1/roboapply/match/jobs/job1/fit-analysis', {
      body: {},
      headers: { ...U, 'Idempotency-Key': 'key-12345678' },
    });
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ code: 'credits_exhausted', details: { bucket: 'fit_analysis', upgradable: true } });

    exhausted = false;
    const res = await h.request<{ success: boolean; data: { kind: string; charged: boolean; summary: string } }>('POST', '/api/v1/roboapply/match/jobs/job1/fit-analysis', {
      body: {},
      headers: { ...U, 'Idempotency-Key': 'key-12345679' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'ai', charged: true, summary: 'Your Go work fits this role.' });

    const missing = await h.request<{ code: string }>('POST', '/api/v1/roboapply/match/jobs/nope/fit-analysis', { body: {}, headers: { ...U, 'Idempotency-Key': 'key-12345670' } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });
});

describe('GET /match/jobs/:id/keyword-check', () => {
  it('answers the rows; 401 without a session; 422 for an unknown query field', async () => {
    const res = await h.request<{ data: { rows: Array<{ key: string; status: string }> } }>('GET', '/api/v1/roboapply/match/jobs/job1/keyword-check', { headers: U });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r) => r.key)).toEqual(['title', 'years', 'education', 'skills', 'keywords']);
    expect((await h.request('GET', '/api/v1/roboapply/match/jobs/job1/keyword-check')).status).toBe(401);
    expect((await h.request('GET', '/api/v1/roboapply/match/jobs/job1/keyword-check?x=1', { headers: U })).status).toBe(422);
  });
});

describe('competitiveness (WP-77) is still a stub', () => {
  it('answers 501 not_implemented with a session', async () => {
    const res = await h.request<{ code: string }>('GET', '/api/v1/roboapply/match/competitiveness/latest', { headers: U });
    expect([501, 404]).toContain(res.status);
  });
});

describe('POST /jobs/:id/score handler (mounted by WP-34)', () => {
  it('answers { fit } with the server-computed total', async () => {
    const res = await h.request<{ data: { fit: { kind: string; score: number; tier: string } } }>('POST', '/api/v1/roboapply/jobs/job1/score', { body: { force: true }, headers: U });
    expect(res.status).toBe(200);
    expect(res.body.data.fit.kind).toBe('ai');
    expect(typeof res.body.data.fit.score).toBe('number');
    expect((await h.request('POST', '/api/v1/roboapply/jobs/job1/score', { body: { bogus: 1 }, headers: U })).status).toBe(422);
  });
});
