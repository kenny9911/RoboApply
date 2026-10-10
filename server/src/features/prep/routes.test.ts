// @vitest-environment node
//
// WP-59 route tests: every question-bank route answers through the platform
// envelope — auth (401), capability off (404 feature_disabled), validation
// (422), AI off (503, zero model calls), the GoApply phone gate (403), daily
// limits (429) — and admin routes are admin only.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { setFlagOverrideLoader, flagEnvName } from '../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createInterviewBankRouter } from './routes.js';
import { createPrepAdminRouter } from './adminRoutes.js';
import { createPrepFixture, FIXTURE_USER as U, FIXTURE_ADMIN as ADMIN, type PrepFixture } from './fixtures.js';
import type {
  AdminQuestionListResponse,
  CompaniesResponse,
  CompanyQuestionsResponse,
  ContributionListResponse,
  JobQuestionSetResponse,
  QuestionDetail,
  QuestionListResponse,
  QuestionView,
} from './contract.js';

const BASE = '/api/v1/roboapply/interview-bank';
const ADMIN_BASE = '/api/v1/roboapply/admin/prep';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

const ENV_ON = { NODE_ENV: 'test' };
const ENV_OFF = { NODE_ENV: 'test', [flagEnvName('roboapply', 'interviewBank')]: 'false', [flagEnvName('goapply', 'interviewBank')]: 'false' };

let on: RouteHarness;
let off: RouteHarness;
let f: PrepFixture;
let phoneBound = true;
const phoneGate: RequestHandler = (_req, res, next) => {
  if (phoneBound) return next();
  res.status(403).json({ success: false, code: 'phone_binding_required', error: 'Bind a phone first.' });
};
const seeker = fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: U, role: 'seeker' }));
const admin = fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: req.headers['x-test-seeker'] ? U : ADMIN, role: req.headers['x-test-seeker'] ? 'seeker' : 'admin' }));
const adminOnly: RequestHandler = (req, res, next) => {
  if ((req as unknown as { user?: { role?: string } }).user?.role === 'admin') return next();
  res.status(403).json({ success: false, code: 'forbidden', error: 'Admins only.' });
};

// The routers resolve the service lazily; give them a stable proxy over the current fixture.
const service = new Proxy({} as PrepFixture['service'], {
  get: (_t, prop) => {
    const value = (f.service as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(f.service) : value;
  },
});

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  on = await startRouteHarness({
    env: ENV_ON,
    mounts: [
      [BASE, createInterviewBankRouter({ seekerAuth: [seeker], env: ENV_ON }, { service, phoneGate })],
      [ADMIN_BASE, createPrepAdminRouter({ adminAuth: [admin, adminOnly], env: ENV_ON }, { service })],
    ],
  });
  off = await startRouteHarness({ env: ENV_OFF, mounts: [[BASE, createInterviewBankRouter({ seekerAuth: [seeker], env: ENV_OFF }, { service, phoneGate })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});
beforeEach(() => {
  f = createPrepFixture();
  phoneBound = true;
});

async function seedReport(company = 'Acme') {
  const receipt = await f.service.contribute(U, { company, question: 'Tell me about a time you changed your mind.', period: '2026-08' });
  return f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Changing your mind', body: 'Tell me about a time you changed your mind.' });
}

describe('seeker routes', () => {
  it('401 without a session; 404 feature_disabled with interviewBank off', async () => {
    expect((await on.request('GET', `${BASE}/companies`, { headers: { 'x-test-anon': '1' } })).status).toBe(401);
    const disabled = await off.request<Env<unknown>>('GET', `${BASE}/companies`);
    expect(disabled.status).toBe(404);
    expect(disabled.body.code).toBe('feature_disabled');
    const disabledPost = await off.request<Env<unknown>>('POST', `${BASE}/jobs/job_1/questions`);
    expect(disabledPost.body.code).toBe('feature_disabled');
    expect(f.calls.set).toHaveLength(0);
  });

  it('GET /companies and /companies/:slug/questions', async () => {
    f.store.companies.push({ id: 'co_acme', slug: 'acme', displayName: 'Acme', nameNormalized: 'acme', market: 'intl' });
    await seedReport();
    const list = await on.request<Env<CompaniesResponse>>('GET', `${BASE}/companies?q=ac`);
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({ slug: 'acme', name: 'Acme', questionCount: { value: 1 } });
    const page = await on.request<Env<CompanyQuestionsResponse>>('GET', `${BASE}/companies/acme/questions`);
    expect(page.body.data.items[0]).toMatchObject({ sourceKind: 'user_report', reportedPeriod: '2026-08' });
    const bad = await on.request<Env<unknown>>('GET', `${BASE}/companies/acme/questions?category=trivia`);
    expect(bad.status).toBe(422);
  });

  it('GoApply host scopes to the cn market', async () => {
    await seedReport();
    f.state.market = 'cn';
    const list = await on.request<Env<CompaniesResponse>>('GET', `${BASE}/companies`, { host: 'goapply.localhost:3621' });
    expect(list.body.data.items).toEqual([]);
  });

  it('GET /questions lists staff-written questions', async () => {
    await f.service.createCurated({ title: 'Plans', body: 'Where do you want to be in three years?', category: 'behavioral', locale: 'en' });
    const res = await on.request<Env<QuestionListResponse>>('GET', `${BASE}/questions`, { headers: { 'x-robo-locale': 'en' } });
    expect(res.body.data.items[0]).toMatchObject({ sourceKind: 'curated', sourceLabelKey: 'source.curated' });
  });

  it('GET /questions uses the request language (English when there are none in it)', async () => {
    await f.service.createCurated({ title: 'Plans', body: 'Where do you want to be in three years?', category: 'behavioral', locale: 'en' });
    await f.service.createCurated({ title: '計畫', body: '你三年後想在哪裡？', category: 'behavioral', locale: 'zh-TW' });
    const zhTw = await on.request<Env<QuestionListResponse>>('GET', `${BASE}/questions`, { headers: { 'x-robo-locale': 'zh-TW' } });
    expect(zhTw.body.data.items.map((q) => q.title)).toEqual(['計畫']);
    const ja = await on.request<Env<QuestionListResponse>>('GET', `${BASE}/questions`, { headers: { 'x-robo-locale': 'ja' } });
    expect(ja.body.data.items.map((q) => q.title)).toEqual(['Plans']);
  });

  it('GET /questions/:id then POST /questions/:id/guide writes the AI guide once', async () => {
    const q = await f.service.createCurated({ title: 'Plans', body: 'Where do you want to be in three years?', category: 'behavioral', locale: 'en' });
    const first = await on.request<Env<QuestionDetail>>('GET', `${BASE}/questions/${q.id}`);
    expect(first.body.data.guideStatus).toBe('not_generated');
    const guide = await on.request<Env<QuestionDetail>>('POST', `${BASE}/questions/${q.id}/guide`);
    expect(guide.status).toBe(200);
    expect(guide.body.data.guideStatus).toBe('ready');
    expect((await on.request('GET', `${BASE}/questions/nope`)).status).toBe(404);
  });

  it('AI off → 503 ai_unavailable with zero model calls; phone gate → 403', async () => {
    const q = await f.service.createCurated({ title: 'Plans', body: 'Where do you want to be in three years?', category: 'behavioral', locale: 'en' });
    f.state.ai = false;
    const guide = await on.request<Env<unknown>>('POST', `${BASE}/questions/${q.id}/guide`);
    expect(guide.status).toBe(503);
    expect(guide.body.code).toBe('ai_unavailable');
    const set = await on.request<Env<unknown>>('POST', `${BASE}/jobs/job_1/questions`);
    expect(set.status).toBe(503);
    expect(f.calls.guide).toHaveLength(0);
    expect(f.calls.set).toHaveLength(0);
    f.state.ai = true;
    phoneBound = false;
    const gated = await on.request<Env<unknown>>('POST', `${BASE}/jobs/job_1/questions`);
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe('phone_binding_required');
    expect(f.calls.set).toHaveLength(0);
  });

  it('GET/POST /jobs/:jobId/questions', async () => {
    const before = await on.request<Env<JobQuestionSetResponse>>('GET', `${BASE}/jobs/job_1/questions`);
    expect(before.body.data).toMatchObject({ status: 'not_generated', aiQuestions: [], jobTitle: 'Backend Engineer', companySlug: 'acme' });
    const made = await on.request<Env<JobQuestionSetResponse>>('POST', `${BASE}/jobs/job_1/questions`);
    expect(made.status).toBe(200);
    expect(made.body.data.aiQuestions.every((q: QuestionView) => q.sourceKind === 'ai_practice' && q.companySlug === null)).toBe(true);
    expect((await on.request('GET', `${BASE}/jobs/unknown/questions`)).status).toBe(404);
  });

  it('429 with Retry-After when the daily set limit is used', async () => {
    f.state.budgetLeft.jobSet = 0;
    const res = await on.request<Env<unknown>>('POST', `${BASE}/jobs/job_1/questions`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(res.body.details).toMatchObject({ reason: 'job_set_daily_limit' });
  });

  it('POST /contributions → 201 pending; 422 without a month; phone gate on GoApply', async () => {
    const ok = await on.request<Env<{ id: string; status: string }>>('POST', `${BASE}/contributions`, {
      body: { company: 'Acme', role: 'Analyst', question: 'Why do you want to work here?', period: '2026-09' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('pending');
    const missing = await on.request<Env<unknown>>('POST', `${BASE}/contributions`, { body: { company: 'Acme', question: 'Why do you want to work here?' } });
    expect(missing.status).toBe(422);
    const extra = await on.request<Env<unknown>>('POST', `${BASE}/contributions`, {
      body: { company: 'Acme', question: 'Why do you want to work here?', period: '2026-09', sourceKind: 'curated' },
    });
    expect(extra.status).toBe(422);
    phoneBound = false;
    expect((await on.request('POST', `${BASE}/contributions`, { body: { company: 'Acme', question: 'Why do you want to work here?', period: '2026-09' } })).status).toBe(403);
  });

  it('POST /questions/:id/report', async () => {
    const q = await f.service.createCurated({ title: 'Plans', body: 'Where do you want to be in three years?', category: 'behavioral', locale: 'en' });
    const res = await on.request<Env<{ reported: boolean; hidden: boolean }>>('POST', `${BASE}/questions/${q.id}/report`, { body: { reason: 'duplicate' } });
    expect(res.body.data).toEqual({ reported: true, hidden: false });
    expect((await on.request('POST', `${BASE}/questions/${q.id}/report`, { body: { reason: 'spam' } })).status).toBe(422);
  });
});

describe('admin routes', () => {
  it('401 without a session; 403 for a seeker', async () => {
    expect((await on.request('GET', `${ADMIN_BASE}/contributions`, { headers: { 'x-test-anon': '1' } })).status).toBe(401);
    expect((await on.request('GET', `${ADMIN_BASE}/contributions`, { headers: { 'x-test-seeker': '1' } })).status).toBe(403);
  });

  it('queue → approve → published; reject with a reason; 409 when already decided', async () => {
    const a = await f.service.contribute(U, { company: 'Acme', question: 'Why do you want to work here?', period: '2026-09' });
    const b = await f.service.contribute(U, { company: 'Acme', question: 'Copied from the Codility test: sort this?', period: '2026-09' });
    const queue = await on.request<Env<ContributionListResponse>>('GET', `${ADMIN_BASE}/contributions?status=pending`);
    expect(queue.body.data.items.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(queue.body.data.items[1]?.flags).toContain('nda_or_test_content');

    const approved = await on.request<Env<QuestionView>>('POST', `${ADMIN_BASE}/contributions/${a.id}/approve`, {
      body: { category: 'behavioral', title: 'Why here', body: 'Why do you want to work here?' },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ sourceKind: 'user_report', companyName: 'Acme', reportedPeriod: '2026-09' });

    const flagged = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/contributions/${b.id}/approve`, {
      body: { category: 'coding', title: 'Sort', body: 'Copied from the Codility test: sort this?' },
    });
    expect(flagged.status).toBe(409);
    expect(flagged.body.details).toMatchObject({ reason: 'screen_not_confirmed' });
    const rejected = await on.request<Env<{ status: string }>>('POST', `${ADMIN_BASE}/contributions/${b.id}/reject`, { body: { reason: 'nda_or_test_content' } });
    expect(rejected.body.data.status).toBe('rejected');
    const again = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/contributions/${b.id}/reject`, { body: { reason: 'other' } });
    expect(again.status).toBe(409);
    expect((await on.request('POST', `${ADMIN_BASE}/contributions/${b.id}/reject`, { body: { reason: 'Duplicate' } })).status).toBe(422);
  });

  it('staff questions: create (no company fields), hide, restore, list', async () => {
    const created = await on.request<Env<QuestionView>>('POST', `${ADMIN_BASE}/questions`, {
      body: { title: 'Your plans', body: '你未来三年的职业规划是什么？', category: 'hr', locale: 'zh' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ sourceKind: 'curated', companySlug: null });
    const withCompany = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/questions`, {
      body: { title: 'Your plans', body: 'Where do you see yourself?', category: 'hr', locale: 'en', companyId: 'co_acme' },
    });
    expect(withCompany.status).toBe(422);
    const id = created.body.data.id;
    expect((await on.request('POST', `${ADMIN_BASE}/questions/${id}/hide`)).status).toBe(200);
    const hidden = await on.request<Env<AdminQuestionListResponse>>('GET', `${ADMIN_BASE}/questions?filter=hidden`);
    expect(hidden.body.data.items.map((q) => q.id)).toEqual([id]);
    expect((await on.request('POST', `${ADMIN_BASE}/questions/${id}/restore`)).status).toBe(200);
    const curated = await on.request<Env<AdminQuestionListResponse>>('GET', `${ADMIN_BASE}/questions?filter=curated`);
    expect(curated.body.data.items[0]).toMatchObject({ id, status: 'published' });
  });
});
