// @vitest-environment node
// WP-18 — MATCH routes: fit analysis (credit + Idempotency-Key), keyword check,
// the score handler WP-34 mounts, auth and the competitiveness flag.
// WP-77 — the competitiveness report routes (credit, Idempotency-Key, flag, latest).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Router } from 'express';
import { getBrand } from '../../platform/brand/registry.js';
import { CreditsExhaustedError } from '../../platform/credits/errors.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createCompetitivenessService, type CompetitivenessService } from './CompetitivenessService.js';
import { FitAnalysisBodySchema, KeywordCheckQuerySchema, ScoreJobBodySchema } from './contract.js';
import { createMatchService, type MatchService } from './MatchService.js';
import { createMemoryFitReportStore } from './reportStore.js';
import { createMatchRouter, createScoreJobHandler } from './routes.js';
import { createMemoryReportInventory, createMemoryRepo, matchUser, reportJobs } from './testkit.js';

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

let reportExhausted = false;
const reportJobRows = reportJobs(22, () => ({ educationLevel: 'bachelor' }));
function reports(): CompetitivenessService {
  return createCompetitivenessService({
    inventory: createMemoryReportInventory({ samples: { sp1: reportJobRows.map((j) => j.id) } }),
    store: createMemoryFitReportStore(),
    userContext: async () => matchUser(),
    getJobs: async (ids) => reportJobRows.filter((j) => ids.includes(j.id)),
    withCredit: async (_opts, fn) => {
      if (reportExhausted) throw new CreditsExhaustedError({ bucket: 'competitiveness', resetsAt: new Date('2026-10-17T00:00:00Z'), upgradable: true, cap: 1, window: 'week' });
      return fn({ id: 'ledger_1' });
    },
    entitlements: async () => ({ full: false, upgradable: true }),
    brand: () => getBrand('roboapply'),
  });
}

let h: RouteHarness;
const svc = service();
const get = async () => svc;
const reportSvc = reports();
const getReports = async () => reportSvc;
const auth = fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null));

function jobsRouter() {
  const r = Router();
  r.post('/:id/score', auth, createScoreJobHandler(get));
  return r;
}

beforeAll(async () => {
  h = await startRouteHarness({
    mounts: [
      ['/api/v1/roboapply/match', createMatchRouter({ seekerAuth: [auth], env: {} }, get, getReports)],
      ['/api/v1/off/match', createMatchRouter({ seekerAuth: [auth], env: { FLAG_ROBOAPPLY_COMPETITIVENESS: 'false' } }, get, getReports)],
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

describe('MKT-2F: the canonical routes take no resume version (strategy 2.2: the fit is always the main resume)', () => {
  it('POST /jobs/:id/score with a resumeVariantId is refused; no model runs and nothing is stored for a version', async () => {
    scorerRun.mockClear();
    const res = await h.request<{ code: string }>('POST', '/api/v1/roboapply/jobs/job1/score', { body: { resumeVariantId: 'v1' }, headers: U });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
    // Refused together with fields the route does take.
    expect((await h.request('POST', '/api/v1/roboapply/jobs/job1/score', { body: { force: true, resumeVariantId: 'v1' }, headers: U })).status).toBe(422);
    expect(scorerRun).not.toHaveBeenCalled();
    expect(ScoreJobBodySchema.safeParse({ resumeVariantId: 'v1' }).success).toBe(false);
    expect(ScoreJobBodySchema.safeParse({ force: true, regenerateExplanation: true }).success).toBe(true);
  });

  it('POST /match/jobs/:id/fit-analysis with a resumeVariantId is refused before any credit or model call', async () => {
    scorerRun.mockClear();
    const res = await h.request<{ code: string }>('POST', '/api/v1/roboapply/match/jobs/job1/fit-analysis', {
      body: { resumeVariantId: 'v1' },
      headers: { ...U, 'Idempotency-Key': 'key-variant-01' },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
    expect(scorerRun).not.toHaveBeenCalled();
    expect(FitAnalysisBodySchema.safeParse({ resumeVariantId: 'v1' }).success).toBe(false);
    expect(FitAnalysisBodySchema.safeParse({}).success).toBe(true);
  });

  it('the answer of both routes is for the main resume', async () => {
    const score = await h.request<{ data: { fit: { resumeVariantId: string } } }>('POST', '/api/v1/roboapply/jobs/job1/score', { body: {}, headers: U });
    expect(score.status).toBe(200);
    expect(score.body.data.fit.resumeVariantId).toBe('v1');
  });

  it('the keyword check keeps its version parameter (tailoring reads the report per version) and names the version it read', async () => {
    const primary = await h.request<{ data: { resumeVariantId: string } }>('GET', '/api/v1/roboapply/match/jobs/job1/keyword-check', { headers: U });
    expect(primary.body.data.resumeVariantId).toBe('v1');
    const named = await h.request<{ data: { resumeVariantId: string } }>('GET', '/api/v1/roboapply/match/jobs/job1/keyword-check?resumeVariantId=v1', { headers: U });
    expect(named.status).toBe(200);
    expect(named.body.data.resumeVariantId).toBe('v1');
    // A version that is not the person's: not found, as before.
    expect((await h.request('GET', '/api/v1/roboapply/match/jobs/job1/keyword-check?resumeVariantId=nope', { headers: U })).status).toBe(404);
    expect(KeywordCheckQuerySchema.safeParse({ resumeVariantId: 'v1' }).success).toBe(true);
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

describe('competitiveness report (WP-77)', () => {
  const KEY = { ...U, 'Idempotency-Key': 'report-key-0001' };

  it('401 without a session; 422 without an Idempotency-Key or with an unknown field', async () => {
    expect((await h.request('POST', '/api/v1/roboapply/match/competitiveness', { body: { searchProfileId: 'sp1' } })).status).toBe(401);
    expect((await h.request('GET', '/api/v1/roboapply/match/competitiveness/latest')).status).toBe(401);
    const noKey = await h.request<{ details: { reason: string } }>('POST', '/api/v1/roboapply/match/competitiveness', { body: { searchProfileId: 'sp1' }, headers: U });
    expect(noKey.status).toBe(422);
    expect(noKey.body.details.reason).toBe('idempotency_key_required');
    expect((await h.request('POST', '/api/v1/roboapply/match/competitiveness', { body: { searchProfileId: 'sp1', x: 1 }, headers: KEY })).status).toBe(422);
    expect((await h.request('GET', '/api/v1/roboapply/match/competitiveness/latest?x=1', { headers: U })).status).toBe(422);
  });

  it('latest is null first; POST answers the report (402 when out of credits, 404 for an unknown search); latest then returns it', async () => {
    const empty = await h.request<{ data: unknown }>('GET', '/api/v1/roboapply/match/competitiveness/latest', { headers: U });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    reportExhausted = true;
    const out = await h.request<{ code: string; details: { bucket: string } }>('POST', '/api/v1/roboapply/match/competitiveness', { body: { searchProfileId: 'sp1' }, headers: KEY });
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ code: 'credits_exhausted', details: { bucket: 'competitiveness' } });
    reportExhausted = false;

    const res = await h.request<{ data: { id: string; charged: boolean; sample: { size: number }; meetsRequirements: { sampleSize: number } } }>(
      'POST',
      '/api/v1/roboapply/match/competitiveness',
      { body: { searchProfileId: 'sp1' }, headers: KEY },
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ charged: true, sample: { size: 22 }, meetsRequirements: { sampleSize: 22 } });

    const missing = await h.request<{ code: string }>('POST', '/api/v1/roboapply/match/competitiveness', { body: { searchProfileId: 'nope' }, headers: KEY });
    expect(missing.status).toBe(404);

    const latest = await h.request<{ data: { id: string; stale: boolean } }>('GET', '/api/v1/roboapply/match/competitiveness/latest?searchProfileId=sp1', { headers: U });
    expect(latest.body.data).toMatchObject({ id: res.body.data.id, stale: false });
  });

  it('404 feature_disabled with the competitiveness flag off', async () => {
    const res = await h.request<{ code: string }>('POST', '/api/v1/off/match/competitiveness', { body: { searchProfileId: 'sp1' }, headers: KEY });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
    const latest = await h.request<{ code: string }>('GET', '/api/v1/off/match/competitiveness/latest', { headers: U });
    expect(latest.body.code).toBe('feature_disabled');
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
