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
const serviceDeps = {
  store,
  credits: kit.credits,
  aiAvailable: async () => ai,
  market: () => 'intl',
  tailor,
  profileContext: async () => null,
  score: async () => null,
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

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };
const BODY = { baseVariantId: 'rv_1', jobId: 'job_1', mode: 'guided', sections: ['experience', 'skills'], keywords: ['Tableau'] };

beforeAll(async () => {
  store.variants.set('rv_1', memoryTailorVariant(USER, 'rv_1', BASE_MD));
  store.variants.set('rv_w', memoryTailorVariant(WECHAT_USER, 'rv_w', BASE_MD));
  store.jobs.set('job_1', memoryTailorJob('job_1'));
  const auth = { seekerAuth: [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: String(req.headers['x-test-user'] ?? USER) }))] };
  const seamService = new TailorService({
    ...serviceDeps,
    assertPhoneBound: (userId) => assertPhoneBound(userId, authCnDb as never),
  });
  h = await startRouteHarness({
    mounts: [
      [BASE_PATH, createResumeSuiteRouter(auth, { tailor: service, phoneGate: requirePhoneBound(authCnDb as never) })],
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

  it('404 for an unknown session or another user session', async () => {
    const created = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, { body: BODY, headers: { 'Idempotency-Key': 'r2' } });
    const other = await h.request<Env<unknown>>('GET', `${BASE_PATH}/tailor-sessions/${created.body.data.id}`, { headers: { 'x-test-user': 'intruder' } });
    expect(other.status).toBe(404);
    const missing = await h.request<Env<unknown>>('GET', `${BASE_PATH}/tailor-sessions/nope`);
    expect(missing.status).toBe(404);
  });
});
