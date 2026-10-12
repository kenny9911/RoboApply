// @vitest-environment node
//
// WP-22 route tests: every resume-check route answers through the platform
// envelope, with auth, validation (422), credits (402), AI consent (503) and
// ownership (404).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { CreditsExhaustedError } from '../../platform/credits/index.js';
import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { ResumeCheckService } from './ResumeCheckService.js';
import { createResumeSuiteRouter } from './routes.js';
import { createMemoryResumeCheckStore, memoryVariant } from './memoryStore.js';
import { GOOD_INTL } from './check/fixtures.js';
import type { CancelGradeResponse, FixIssueResponse, GradeStartResponse, KeywordReportResponse, LatestGradeResponse } from './contract.js';

const BASE = '/api/v1/roboapply/v2/resumes';
const USER = 'u_routes';
const WEAK = '# Sam\n*sam@example.test · +1 415 555 0100*\n## Experience\n- Responsible for opening the store.\n- Helped with inventory.\n- Worked on displays.';

let h: RouteHarness;
let ai = true;
const store = createMemoryResumeCheckStore();
const kit = createCreditTestKit();
const runAiPass = vi.fn(async () => ({ spelling: [], summaryVague: false }));
const rewrite = vi.fn(async () => ({ rewrite: 'Opened the store each morning.' }));
const service = new ResumeCheckService({
  store,
  credits: kit.credits,
  aiAvailable: async () => ai,
  profile: () => 'intl',
  market: () => 'intl',
  runAiPass,
  rewrite,
  logAiLabel: async () => undefined,
});

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

beforeAll(async () => {
  store.variants.set('rv_1', memoryVariant(USER, 'rv_1', WEAK));
  store.variants.set('rv_good', memoryVariant(USER, 'rv_good', GOOD_INTL));
  store.jobs.set('job_1', { id: 'job_1', title: 'Store Assistant', descriptionPlain: 'Retail.', qualifications: null, responsibilities: null, minYears: null, educationLevel: null, skills: ['excel'] });
  h = await startRouteHarness({
    mounts: [[BASE, createResumeSuiteRouter({ seekerAuth: [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: USER }))] }, { service })]],
  });
});
afterAll(async () => {
  await h.close();
});

describe('resume check routes', () => {
  it('401 without a session', async () => {
    const res = await h.request('POST', `${BASE}/rv_1/grade`, { headers: { 'x-test-anon': '1' }, body: {} });
    expect(res.status).toBe(401);
  });

  it('POST /:id/grade → report; GET /:id/grade/latest → the same check', async () => {
    const res = await h.request<Env<GradeStartResponse>>('POST', `${BASE}/rv_1/grade`, { body: { targetTitle: 'Store lead' }, headers: { 'Idempotency-Key': 'r1' } });
    expect(res.status).toBe(200);
    expect(res.body.data.grade!.status).toBe('done');
    expect(res.body.data.grade!.targetTitle).toBe('Store lead');
    // Nothing is stamped by running the check: only the owner opening it does.
    expect(store.grades.find((g) => g.id === res.body.data.gradeId)!.viewedAt).toBeNull();
    const latest = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest`);
    expect(latest.body.data.grade!.id).toBe(res.body.data.gradeId);
    expect(latest.body.data.aiAvailable).toBe(true);
  });

  it('a plain GET /:id/grade/latest never stamps viewedAt (the editor, tailoring and the onboarding dock read it too)', async () => {
    const row = () => store.grades.find((g) => g.variantId === 'rv_1' && g.status === 'done')!;
    expect(row().viewedAt).toBeNull();
    for (const path of [`${BASE}/rv_1/grade/latest`, `${BASE}/rv_1/grade/latest?opened=0`, `${BASE}/rv_1/grade/latest?opened=true`, `${BASE}/rv_1/grade/latest?opened=`]) {
      const res = await h.request<Env<LatestGradeResponse>>('GET', path);
      expect(res.status).toBe(200);
      expect(res.body.data.grade!.status).toBe('done');
    }
    expect(row().viewedAt).toBeNull();
  });

  it('GET /:id/grade/latest?opened=1 (the report page) stamps viewedAt on the finished check, on the first view only', async () => {
    const row = () => store.grades.find((g) => g.variantId === 'rv_1' && g.status === 'done')!;
    const opened = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest?opened=1`);
    expect(opened.status).toBe(200);
    expect(opened.body.data.grade!.id).toBe(row().id);
    const first = row().viewedAt;
    expect(first).toBeInstanceOf(Date);
    const again = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest?opened=1`);
    expect(again.status).toBe(200);
    expect(row().viewedAt).toBe(first);
  });

  it('does not stamp viewedAt for a signed-out request, a running check, or a server-side read', async () => {
    store.variants.set('rv_view', memoryVariant(USER, 'rv_view', WEAK));
    const running = await store.createGrade({ userId: USER, variantId: 'rv_view', contentHash: 'h', targetTitle: null, creditLedgerId: null });
    await h.request('GET', `${BASE}/rv_view/grade/latest?opened=1`);
    expect(store.grades.find((g) => g.id === running.id)!.viewedAt).toBeNull();

    await store.updateGrade(running.id, { status: 'done', grade: 'B', score: 80, counts: {}, issues: [], completedAt: new Date() });
    const anon = await h.request('GET', `${BASE}/rv_view/grade/latest?opened=1`, { headers: { 'x-test-anon': '1' } });
    expect(anon.status).toBe(401);
    // Another area reading the check (the Assistant) is not the owner opening it.
    await service.latest(USER, 'rv_view');
    expect(store.grades.find((g) => g.id === running.id)!.viewedAt).toBeNull();

    await h.request('GET', `${BASE}/rv_view/grade/latest?opened=1`);
    expect(store.grades.find((g) => g.id === running.id)!.viewedAt).toBeInstanceOf(Date);
  });

  it('never stamps a check that belongs to someone else', async () => {
    store.variants.set('rv_other', memoryVariant('user_other', 'rv_other', WEAK));
    const theirs = await store.createGrade({ userId: 'user_other', variantId: 'rv_other', contentHash: 'h', targetTitle: null, creditLedgerId: null });
    await store.updateGrade(theirs.id, { status: 'done', grade: 'B', score: 80, counts: {}, issues: [], completedAt: new Date() });
    const res = await h.request('GET', `${BASE}/rv_other/grade/latest?opened=1`);
    expect(res.status).toBe(404);
    expect(store.grades.find((g) => g.id === theirs.id)!.viewedAt).toBeNull();
  });

  it('a stamp that cannot be written never fails the read', async () => {
    store.variants.set('rv_soft', memoryVariant(USER, 'rv_soft', WEAK));
    const g = await store.createGrade({ userId: USER, variantId: 'rv_soft', contentHash: 'h', targetTitle: null, creditLedgerId: null });
    await store.updateGrade(g.id, { status: 'done', grade: 'B', score: 80, counts: {}, issues: [], completedAt: new Date() });
    const spy = vi.spyOn(store, 'markGradeViewed').mockRejectedValueOnce(new Error('db down'));
    const res = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_soft/grade/latest?opened=1`);
    expect(res.status).toBe(200);
    expect(res.body.data.grade!.id).toBe(g.id);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('422 on an invalid body', async () => {
    const res = await h.request<Env<unknown>>('POST', `${BASE}/rv_1/grade`, { body: { targetTitle: 'x'.repeat(200) } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
  });

  it('once the daily check is used: 200 with a rules-only report (the AI pass is skipped)', async () => {
    runAiPass.mockClear();
    const res = await h.request<Env<GradeStartResponse>>('POST', `${BASE}/rv_good/grade`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.body.data.grade!.status).toBe('done');
    expect(res.body.data.grade!.method).toBe('rules');
    expect(res.body.data.grade!.aiSkipped).toBe('credits_exhausted');
    expect(runAiPass).not.toHaveBeenCalled();
  });

  it('402 credits_exhausted when a fix has no rewrite credit left', async () => {
    const latest = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest`);
    const issue = latest.body.data.grade!.issues.find((i) => i.fixable)!;
    vi.spyOn(kit.credits, 'withCredit').mockRejectedValueOnce(
      new CreditsExhaustedError({ bucket: 'rewrite', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true, cap: 5, window: 'day' }),
    );
    rewrite.mockClear();
    const res = await h.request<Env<unknown>>('POST', `${BASE}/rv_1/issues/${issue.id}/fix`, { body: { variant: 'ai' }, headers: { 'Idempotency-Key': 'fx402' } });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('credits_exhausted');
    expect(res.body.details).toMatchObject({ bucket: 'rewrite', upgradable: true });
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('404 for an unknown resume', async () => {
    const res = await h.request<Env<unknown>>('GET', `${BASE}/nope/grade/latest`);
    expect(res.status).toBe(404);
  });

  it('POST /:id/issues/:issueId/fix and /apply', async () => {
    const latest = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest`);
    const issue = latest.body.data.grade!.issues.find((i) => i.type === 'weak_verb')!;
    const fix = await h.request<Env<FixIssueResponse>>('POST', `${BASE}/rv_1/issues/${issue.id}/fix`, { body: { variant: 'ai' }, headers: { 'Idempotency-Key': 'fx1' } });
    expect(fix.status).toBe(200);
    expect(fix.body.data.suggestions[0]).toEqual({ text: 'Opened the store each morning.', aiWritten: true });
    const bad = await h.request<Env<unknown>>('POST', `${BASE}/rv_1/issues/${issue.id}/fix`, { body: { variant: 'louder' } });
    expect(bad.status).toBe(422);
    const applied = await h.request<Env<{ applied: boolean }>>('POST', `${BASE}/rv_1/issues/${issue.id}/apply`, { body: { text: fix.body.data.suggestions[0]!.text } });
    expect(applied.status).toBe(200);
    expect(store.variants.get('rv_1')!.resumeMarkdown).toContain('- Opened the store each morning.');
    // AI-written text landed in the resume: the variant is stamped (exports then carry the AI marks).
    expect(store.aiAssisted.has('rv_1')).toBe(true);
    expect(store.aiAssisted.has('rv_good')).toBe(false);
  });

  it('503 ai_unavailable for fixes without AI consent (no LLM call)', async () => {
    const latest = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest`);
    const issue = latest.body.data.grade!.issues.find((i) => i.type === 'weak_verb' && i.target !== 'Responsible for opening the store.') ?? latest.body.data.grade!.issues[0]!;
    ai = false;
    rewrite.mockClear();
    const res = await h.request<Env<unknown>>('POST', `${BASE}/rv_1/issues/${issue.id}/fix`, { body: { variant: 'shorter' } });
    ai = true;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('POST /grades/:gradeId/cancel → 409 for a finished check, 404 for an unknown one', async () => {
    const latest = await h.request<Env<LatestGradeResponse>>('GET', `${BASE}/rv_1/grade/latest`);
    const done = await h.request<Env<CancelGradeResponse>>('POST', `${BASE}/grades/${latest.body.data.grade!.id}/cancel`);
    expect(done.status).toBe(409);
    const missing = await h.request<Env<unknown>>('POST', `${BASE}/grades/nope/cancel`);
    expect(missing.status).toBe(404);
  });

  it('POST /:id/keyword-report with a job id or a pasted posting (free)', async () => {
    const byJob = await h.request<Env<KeywordReportResponse>>('POST', `${BASE}/rv_good/keyword-report`, { body: { jobId: 'job_1' } });
    expect(byJob.status).toBe(200);
    expect(byJob.body.data.rows.map((r) => r.key)).toEqual(['title', 'years', 'education', 'skills', 'keywords']);
    const byJd = await h.request<Env<KeywordReportResponse>>('POST', `${BASE}/rv_good/keyword-report`, {
      body: { jd: { title: 'Backend Engineer', company: 'Acme', text: 'We need Python, Kafka and Kubernetes experience for our payments platform team.' } },
    });
    expect(byJd.status).toBe(200);
    expect(byJd.body.data.keywordSource).toBe('posting');
    const neither = await h.request<Env<unknown>>('POST', `${BASE}/rv_good/keyword-report`, { body: {} });
    expect(neither.status).toBe(422);
  });

  // PATCH /:id/layout and the WP-65 routes: routes.wp65.test.ts.
});
