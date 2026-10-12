// @vitest-environment node
//
// WP-36a route tests: tailor sessions answer through the platform envelope,
// with auth (401), validation (422), AI consent (503, zero model calls),
// the GoApply phone-binding gate (403 phone_binding_required), ownership (404)
// and finalize's 409 `unverified_claims`.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { assertPhoneBound, requirePhoneBound } from '../../auth-cn/index.js';
import { createResumeSuiteRouter } from '../routes.js';
import type { TailorSessionView } from '../contract.js';
import { TailorService } from './TailorService.js';
import { createMemoryTailorStore, memoryTailorJob, memoryTailorVariant } from './memoryStore.js';

const BASE_PATH = '/api/v1/roboapply/v2/resumes';
/** A second mount with no route-level phone gate: the service's own check must answer. */
const SEAM_PATH = '/seam/resumes';
const USER = 'u_routes';
const WECHAT_USER = 'u_wechat';
const BASE_MD = '# Sam\n*sam@example.test*\n## Experience\n- Built weekly sales reports in SQL.\n## Skills\nSQL\n';
const TAILORED = '## Experience\n- Built weekly sales reports in SQL.\n- Cut report time by 40%.\n## Skills\nSQL, Tableau\n';

let h: RouteHarness;
let ai = true;
const store = createMemoryTailorStore();
const kit = createCreditTestKit();
const tailor = vi.fn(async () => ({ tailoredResumeMarkdown: TAILORED, changeSummary: '', citationsByLine: {}, citationGuardPassed: true, citationGuardViolations: [] }));
const markChecklist = vi.fn(async () => undefined);
const fitAt = (score: number, scoredAt: string) => ({ score, tier: 'good' as const, kind: 'ai' as const, rubric: 'fit_v3' as const, estimator: 'est_v2', model: 'test/model', scoredAt });
/** What MATCH answers; null (the default) is "cannot run", as in the other route tests. */
const fits: { canonical: ReturnType<typeof fitAt> | null; variant: ReturnType<typeof fitAt> | null } = { canonical: null, variant: null };
const serviceDeps = {
  store,
  credits: kit.credits,
  aiAvailable: async () => ai,
  market: () => 'intl',
  tailor,
  profileContext: async () => null,
  // "Your fit" (the canonical fit of the job) and "With this version" (the tailored version's own fit).
  canonicalFit: async () => fits.canonical,
  variantFit: async () => fits.variant,
  markChecklist,
  logAiLabel: async () => undefined,
  assertPhoneBound: async () => undefined,
} satisfies ConstructorParameters<typeof TailorService>[0];
const service = new TailorService(serviceDeps);

// The real auth-cn gate over a fake user table: a GoApply WeChat account without a phone.
const authCnDb = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === WECHAT_USER ? { brand: 'goapply', phoneE164: null, phoneVerifiedAt: null } : { brand: 'roboapply', phoneE164: null, phoneVerifiedAt: null },
  },
  rAAuthIdentity: { findFirst: async ({ where }: { where: { userId: string } }) => (where.userId === WECHAT_USER ? { id: 'idn' } : null) },
};

// Parity wave (plan §3.7): a phone is asked for only where one can be bound, so
// both gates run with an SMS provider live; SMS_OFF is the opposite case.
const SMS_ON = { NODE_ENV: 'test', SMS_DEV_CONSOLE: 'true' };
const SMS_OFF = { NODE_ENV: 'test' };

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };
const BODY = { baseVariantId: 'rv_1', jobId: 'job_1', mode: 'guided', sections: ['experience', 'skills'], keywords: ['Tableau'] };

beforeAll(async () => {
  store.variants.set('rv_1', memoryTailorVariant(USER, 'rv_1', BASE_MD));
  store.variants.set('rv_w', memoryTailorVariant(WECHAT_USER, 'rv_w', BASE_MD));
  store.jobs.set('job_1', memoryTailorJob('job_1'));
  const auth = { seekerAuth: [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: String(req.headers['x-test-user'] ?? USER) }))] };
  const seamService = new TailorService({
    ...serviceDeps,
    assertPhoneBound: (userId) => assertPhoneBound(userId, authCnDb as never, SMS_ON),
  });
  h = await startRouteHarness({
    mounts: [
      [BASE_PATH, createResumeSuiteRouter(auth, { tailor: service, phoneGate: requirePhoneBound(authCnDb as never, SMS_ON) })],
      [SEAM_PATH, createResumeSuiteRouter(auth, { tailor: seamService, phoneGate: (_req, _res, next) => next() })],
    ],
  });
});
afterAll(async () => {
  await h.close();
});

describe('tailor session routes', () => {
  it('401 without a session on every tailor route', async () => {
    const anon = { 'x-test-anon': '1' };
    const create = await h.request('POST', `${BASE_PATH}/tailor-sessions`, { headers: anon, body: BODY });
    expect(create.status).toBe(401);
    const get = await h.request('GET', `${BASE_PATH}/tailor-sessions/ts_1`, { headers: anon });
    expect(get.status).toBe(401);
    const patch = await h.request('PATCH', `${BASE_PATH}/tailor-sessions/ts_1/claims/c1`, { headers: anon, body: { status: 'kept' } });
    expect(patch.status).toBe(401);
    const finalize = await h.request('POST', `${BASE_PATH}/tailor-sessions/ts_1/finalize`, { headers: anon });
    expect(finalize.status).toBe(401);
  });

  it('422 on an invalid body (both jobId and jd, instruction over 1000 chars)', async () => {
    const both = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: { ...BODY, jd: { title: 'A', company: 'B', text: 'x'.repeat(60) } } });
    expect(both.status).toBe(422);
    const long = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: { ...BODY, customPrompt: 'x'.repeat(1001) } });
    expect(long.status).toBe(422);
  });

  it('the target step\'s body: jd { title, company, text } with no jobId is accepted; neither, or a short posting, is 422 (INT-10)', async () => {
    // Its own account, so the credits of the other cases are untouched.
    const asUser = { 'x-test-user': 'u_jd' };
    store.variants.set('rv_jd', memoryTailorVariant('u_jd', 'rv_jd', BASE_MD));
    const { jobId: _jobId, ...rest } = BODY;
    const noJob = { ...rest, baseVariantId: 'rv_jd' };
    const jd = { title: 'Sales Analyst', company: '', text: 'We need an analyst who builds Tableau dashboards and SQL reports for sales.' };
    tailor.mockClear();
    const ok = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, { body: { ...noJob, jd }, headers: { ...asUser, 'Idempotency-Key': 'jd-route-1' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ jobId: null, status: 'review', target: { title: 'Sales Analyst', company: null } });
    expect(tailor).toHaveBeenCalledTimes(1);

    tailor.mockClear();
    const neither = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: noJob, headers: asUser });
    expect(neither.status).toBe(422);
    const short = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: { ...noJob, jd: { ...jd, text: 'Too short.' } }, headers: asUser });
    expect(short.status).toBe(422);
    const untitled = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: { ...noJob, jd: { ...jd, title: '  ' } }, headers: asUser });
    expect(untitled.status).toBe(422);
    expect(tailor).not.toHaveBeenCalled();
  });

  it('503 ai_unavailable without AI consent, zero model calls', async () => {
    ai = false;
    tailor.mockClear();
    const res = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: BODY, headers: { 'Idempotency-Key': 'r0' } });
    ai = true;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
    expect(tailor).not.toHaveBeenCalled();
  });

  it('403 phone_binding_required for a GoApply WeChat account without a phone', async () => {
    tailor.mockClear();
    const res = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions`, { body: { ...BODY, baseVariantId: 'rv_w' }, headers: { 'x-test-user': WECHAT_USER } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('phone_binding_required');
    expect(tailor).not.toHaveBeenCalled();
  });

  it('the service gates the phone itself: 403 phone_binding_required even without the route gate', async () => {
    tailor.mockClear();
    const res = await h.request<Env<unknown>>('POST', `${SEAM_PATH}/tailor-sessions`, { body: { ...BODY, baseVariantId: 'rv_w' }, headers: { 'x-test-user': WECHAT_USER } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('phone_binding_required');
    expect(tailor).not.toHaveBeenCalled();
  });

  it('no SMS provider: nobody can bind a phone, so the same WeChat account is not held by either gate (D5)', async () => {
    await expect(assertPhoneBound(WECHAT_USER, authCnDb as never, SMS_OFF)).resolves.toBeUndefined();
    await expect(assertPhoneBound(WECHAT_USER, authCnDb as never, SMS_ON)).rejects.toMatchObject({ code: 'phone_binding_required' });
    const next = vi.fn();
    await requirePhoneBound(authCnDb as never, SMS_OFF)({ user: { id: WECHAT_USER } } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('create → claims → finalize (409 unverified_claims until every claim is checked)', async () => {
    const created = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, { body: BODY, headers: { 'Idempotency-Key': 'r1' } });
    expect(created.status).toBe(200);
    const view = created.body.data;
    expect(view.status).toBe('review');
    expect(view.pendingClaims).toBeGreaterThan(0);

    const got = await h.request<Env<TailorSessionView>>('GET', `${BASE_PATH}/tailor-sessions/${view.id}`);
    expect(got.body.data.id).toBe(view.id);

    const blocked = await h.request<Env<unknown>>('POST', `${BASE_PATH}/tailor-sessions/${view.id}/finalize`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ success: false, code: 'unverified_claims', details: { pending: view.pendingClaims } });

    const badClaim = await h.request<Env<unknown>>('PATCH', `${BASE_PATH}/tailor-sessions/${view.id}/claims/${view.claims[0]!.id}`, { body: { status: 'edited' } });
    expect(badClaim.status).toBe(422);

    for (const c of view.claims) {
      const r = await h.request<Env<TailorSessionView>>('PATCH', `${BASE_PATH}/tailor-sessions/${view.id}/claims/${c.id}`, { body: { status: 'kept' } });
      expect(r.status).toBe(200);
    }
    const done = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions/${view.id}/finalize`);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('finalized');
    expect(markChecklist).toHaveBeenCalledTimes(1);
  });

  it('MKT-2F: the session view carries the two named measures, and the older before / after aliases with the same values', async () => {
    fits.canonical = fitAt(66, '2026-10-09T09:30:00.000Z');
    fits.variant = fitAt(78, '2026-10-10T10:00:00.000Z');
    try {
      const created = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, { body: BODY, headers: { 'Idempotency-Key': 'r-fit' } });
      const view = created.body.data;
      // "Your fit" is there from the start; "With this version" only once every detail is checked.
      expect(view.fit.canonical).toEqual({ value: 66, kind: 'ai', tier: 'good', scoredAt: '2026-10-09T09:30:00.000Z', version: { rubric: 'fit_v3', estimator: 'est_v2', model: 'test/model' } });
      expect(view.fit.variant).toBeNull();
      expect(view).toMatchObject({ scoreBefore: 66, scoreAfter: null, fit: { before: { value: 66, source: 'ai' }, after: null } });
      for (const c of view.claims) await h.request('PATCH', `${BASE_PATH}/tailor-sessions/${view.id}/claims/${c.id}`, { body: { status: 'kept' } });
      const done = (await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions/${view.id}/finalize`)).body.data;
      expect(done.fit.canonical).toMatchObject({ value: 66, scoredAt: '2026-10-09T09:30:00.000Z' });
      expect(done.fit.variant).toMatchObject({ value: 78, kind: 'ai', scoredAt: '2026-10-10T10:00:00.000Z' });
      expect(done).toMatchObject({ scoreBefore: 66, scoreAfter: 78, fit: { before: { value: 66 }, after: { value: 78, asOf: '2026-10-10T10:00:00.000Z' } } });
      const got = (await h.request<Env<TailorSessionView>>('GET', `${BASE_PATH}/tailor-sessions/${view.id}`)).body.data;
      expect(got.fit).toEqual(done.fit);
    } finally {
      fits.canonical = null;
      fits.variant = null;
      // Give the tailor credit back to the tests that follow (the kit holds one day's allowance).
      kit.store.ledger.length = 0;
      kit.store.windows.length = 0;
    }
  });

  it('404 for an unknown session or another user session', async () => {
    const created = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, { body: BODY, headers: { 'Idempotency-Key': 'r2' } });
    const other = await h.request<Env<unknown>>('GET', `${BASE_PATH}/tailor-sessions/${created.body.data.id}`, { headers: { 'x-test-user': 'intruder' } });
    expect(other.status).toBe(404);
    const missing = await h.request<Env<unknown>>('GET', `${BASE_PATH}/tailor-sessions/nope`);
    expect(missing.status).toBe(404);
  });
});
