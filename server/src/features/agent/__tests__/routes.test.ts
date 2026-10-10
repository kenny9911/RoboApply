// @vitest-environment node
//
// WP-52 route tests: the agent router behind the route harness with injected
// auth and an injected service (fake database, fake seams). Covers auth,
// the `agent` capability (404 feature_disabled; 503 ai_unavailable on a
// brand without a model), validation, the envelope, and domain errors.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// No real database in unit tests: a seam left at its default fails loudly.
vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw new Error(`no real DB in unit tests (prisma.${String(prop)})`);
      },
    },
  ),
}));

import { setFlagOverrideLoader } from '../../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { createAgentRouter } from '../routes.js';
import type { AgentDeps } from '../deps.js';
import { feedItem, makeDb, makeDeps, seedItem } from './testkit.js';

const BASE = '/api/v1/roboapply/agent';
const RA = 'localhost:3621';
const GA = 'goapply.localhost:3621';

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

const state = vi.hoisted(() => ({ userId: 'u1' as string | null, overrides: {} as Partial<AgentDeps> }));
let db = makeDb();
let h: RouteHarness;
let off: RouteHarness;

function serviceNow() {
  return makeDeps(db, 'roboapply', state.overrides).service;
}

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const auth = [fakeAuth(() => (state.userId ? { id: state.userId } : null))];
  // The service is resolved per request so each test's fake database and seams apply.
  const lazy = new Proxy({}, { get: (_t, prop) => (serviceNow() as unknown as Record<string | symbol, unknown>)[prop] });
  h = await startRouteHarness({ env: {}, mounts: [[BASE, createAgentRouter({ seekerAuth: auth, env: {} }, { service: lazy as never })]] });
  const envOff = { FLAG_ROBOAPPLY_AGENT: 'false' };
  off = await startRouteHarness({ env: envOff, mounts: [[BASE, createAgentRouter({ seekerAuth: auth, env: envOff }, { service: lazy as never })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([h.close(), off.close()]);
});
beforeEach(() => {
  db = makeDb();
  state.userId = 'u1';
  state.overrides = {};
});

/** Every route of the router (method, path); `:id` / `:key` are filled with sample values. */
const ROUTES: Array<[string, string]> = [
  ['GET', '/settings'],
  ['PUT', '/settings'],
  ['GET', '/setup'],
  ['POST', '/setup/calibration'],
  ['POST', '/setup/step'],
  ['GET', '/suggestions'],
  ['POST', '/list/generate'],
  ['POST', '/search/save-to-main'],
  ['GET', '/badge'],
  ['GET', '/queue'],
  ['POST', '/queue'],
  ['POST', '/queue/prepare'],
  ['GET', '/queue/q1'],
  ['GET', '/queue/q1/history'],
  ['POST', '/queue/q1/prepare'],
  ['POST', '/queue/q1/confirm'],
  ['POST', '/queue/q1/open'],
  ['POST', '/queue/q1/undo-applied'],
  ['POST', '/queue/q1/applied'],
  ['POST', '/queue/q1/skip'],
  ['POST', '/queue/q1/restore'],
  ['DELETE', '/queue/q1'],
  ['GET', '/answers'],
  ['PUT', '/answers'],
  ['GET', '/answers/questions'],
  ['DELETE', '/answers/notice_period'],
];

describe('agent router: auth and capability', () => {
  it.each(ROUTES)('401 without a session: %s %s', async (method, path) => {
    state.userId = null;
    expect((await h.request(method, `${BASE}${path}`, { host: RA, body: method === 'GET' || method === 'DELETE' ? undefined : {} })).status).toBe(401);
  });

  it.each(ROUTES)('404 feature_disabled with the capability off: %s %s', async (method, path) => {
    const res = await off.request<Env<unknown>>(method, `${BASE}${path}`, { host: RA, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });

  it('503 ai_unavailable on GoApply without a domestic model (the whole area is AI-dependent)', async () => {
    const res = await h.request<Env<unknown>>('GET', `${BASE}/settings`, { host: GA });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
  });
});

describe('agent router: endpoints', () => {
  it('settings: defaults, then a saved patch; invalid values are 422', async () => {
    const get = await h.request<Env<{ weeklyTarget: number }>>('GET', `${BASE}/settings`, { host: RA });
    expect(get.status).toBe(200);
    expect(get.body.data.weeklyTarget).toBe(10);
    const put = await h.request<Env<{ weeklyTarget: number }>>('PUT', `${BASE}/settings`, { host: RA, body: { weeklyTarget: 20 } });
    expect(put.body.data.weeklyTarget).toBe(20);
    expect((await h.request('PUT', `${BASE}/settings`, { host: RA, body: { weeklyTarget: 7 } })).status).toBe(422);
  });

  it('settings carry which search the lists come from; `filterOverrides: null` forgets Ready-only changes (SR-52-1)', async () => {
    type S = { listFilters: { searchProfileId: string | null; overrides: Record<string, unknown> | null } };
    state.overrides = { feedPreview: async () => [feedItem('j1', 'great')] };
    await h.request('POST', `${BASE}/list/generate`, { host: RA, body: { overrides: { workModels: ['remote'] }, more: true } });
    const kept = await h.request<Env<S>>('GET', `${BASE}/settings`, { host: RA });
    expect(kept.body.data.listFilters).toEqual({ searchProfileId: null, overrides: { workModels: ['remote'] } });
    // Only null is accepted here: the filters themselves are set through the list request.
    expect((await h.request('PUT', `${BASE}/settings`, { host: RA, body: { filterOverrides: { workModels: ['onsite'] } } })).status).toBe(422);
    const cleared = await h.request<Env<S>>('PUT', `${BASE}/settings`, { host: RA, body: { filterOverrides: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.listFilters).toEqual({ searchProfileId: null, overrides: null });
  });

  it('setup, calibration and the step endpoint', async () => {
    const s = await h.request<Env<{ step: string; checks: { calibrationCount: number } }>>('GET', `${BASE}/setup`, { host: RA });
    expect(s.body.data.step).toBe('profile');
    const c = await h.request<Env<{ checks: { calibrationCount: number } }>>('POST', `${BASE}/setup/calibration`, { host: RA, body: { jobId: 'j1', verdict: 'up' } });
    expect(c.body.data.checks.calibrationCount).toBe(1);
    // Steps are finished in order: 'calibrate' from 'profile' is out of order.
    const early = await h.request<Env<unknown>>('POST', `${BASE}/setup/step`, { host: RA, body: { step: 'calibrate' } });
    expect(early.status).toBe(409);
    expect(early.body.details?.reason).toBe('setup_step_out_of_order');
    const step = await h.request<Env<{ step: string; firstList: unknown }>>('POST', `${BASE}/setup/step`, { host: RA, body: { step: 'profile' } });
    expect(step.status).toBe(200);
    expect(step.body).toMatchObject({ success: true, data: { step: 'calibrate', firstList: null } });
    const short = await h.request<Env<unknown>>('POST', `${BASE}/setup/step`, { host: RA, body: { step: 'calibrate' } });
    expect(short.status).toBe(409);
    expect(short.body.details?.reason).toBe('calibration_incomplete');
  });

  it('queue: add, list, prepare (proposal, then confirm), history', async () => {
    const add = await h.request<Env<{ items: Array<{ id: string; state: string }> }>>('POST', `${BASE}/queue`, { host: RA, body: { jobIds: ['j1', 'j2'], addedVia: 'feed' } });
    expect(add.status).toBe(200);
    expect(add.body.data.items.map((i) => i.state)).toEqual(['picked', 'picked']);
    const ids = add.body.data.items.map((i) => i.id);
    const list = await h.request<Env<{ items: unknown[]; counts: Record<string, number> }>>('GET', `${BASE}/queue?tab=to_prepare`, { host: RA });
    expect(list.body.data.counts.to_prepare).toBe(2);
    const proposal = await h.request<Env<{ confirmed: boolean; credits: Array<{ bucket: string; cost: number }> }>>('POST', `${BASE}/queue/prepare`, { host: RA, body: { ids } });
    expect(proposal.body.data.confirmed).toBe(false);
    expect(proposal.body.data.credits).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: 'tailor', cost: 2 }), expect.objectContaining({ bucket: 'cover_letter', cost: 1 })]));
    const one = await h.request<Env<{ confirmed: boolean; started: string[] }>>('POST', `${BASE}/queue/${ids[0]}/prepare`, { host: RA, body: { confirm: true } });
    expect(one.body.data).toMatchObject({ confirmed: true, started: [ids[0]] });
    const hist = await h.request<Env<{ items: Array<{ toState: string }> }>>('GET', `${BASE}/queue/${ids[0]}/history`, { host: RA });
    expect(hist.body.data.items.map((e) => e.toState)).toEqual(['picked', 'preparing']);
    const badge = await h.request<Env<{ readyNotOpened: number }>>('GET', `${BASE}/badge`, { host: RA });
    expect(badge.body.data.readyNotOpened).toBe(0);
  });

  it('an illegal step is 409 queue_invalid_transition; an unknown item is 404', async () => {
    const add = await h.request<Env<{ items: Array<{ id: string }> }>>('POST', `${BASE}/queue`, { host: RA, body: { jobIds: ['j1'] } });
    const id = add.body.data.items[0]!.id;
    const open = await h.request<Env<unknown>>('POST', `${BASE}/queue/${id}/open`, { host: RA });
    expect(open.status).toBe(409);
    expect(open.body.details?.reason).toBe('kit_not_ready');
    const undo = await h.request<Env<unknown>>('POST', `${BASE}/queue/${id}/undo-applied`, { host: RA });
    expect(undo.status).toBe(409);
    expect((await h.request('POST', `${BASE}/queue/nope/skip`, { host: RA })).status).toBe(404);
    expect((await h.request('POST', `${BASE}/queue/${id}/confirm`, { host: RA, body: { part: 'cv', decision: 'use' } })).status).toBe(422);
  });

  it('domain errors keep their own code: GoApply phone binding (403) on a revise', async () => {
    state.overrides = {
      assertPhoneBound: async () => {
        throw Object.assign(new Error('Bind a phone first.'), { code: 'phone_binding_required', status: 403 });
      },
    };
    const kit = makeDeps(db, 'roboapply', state.overrides);
    const id = (await kit.service.addToQueue('u1', { jobIds: ['j1'] })).items[0]!.id;
    await (db as unknown as { rAAgentQueueItem: { updateMany: (a: unknown) => Promise<unknown> } }).rAAgentQueueItem.updateMany({ where: { id }, data: { state: 'ready_for_review' } });
    const res = await h.request<Env<unknown>>('POST', `${BASE}/queue/${id}/confirm`, { host: RA, body: { part: 'resume', decision: 'revise' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('phone_binding_required');
  });

  it('weekly list on demand, save-to-main and suggestions', async () => {
    state.overrides = { feedPreview: async () => [feedItem('j1', 'great'), feedItem('j2', 'good')] };
    const gen = await h.request<Env<{ added: number; filtersDiffer: boolean }>>('POST', `${BASE}/list/generate`, { host: RA, body: { overrides: { workModels: ['remote'] } } });
    expect(gen.body.data).toMatchObject({ added: 2, filtersDiffer: true });
    const save = await h.request<Env<{ id: string }>>('POST', `${BASE}/search/save-to-main`, { host: RA, body: { filters: { workModels: ['remote'] }, version: 3 } });
    expect(save.body.data.id).toBe('sp_main');
    const sug = await h.request<Env<{ items: unknown[] }>>('GET', `${BASE}/suggestions?limit=3`, { host: RA });
    expect(sug.body.data.items).toEqual([]); // both already in the list
    expect((await h.request('GET', `${BASE}/suggestions?limit=99`, { host: RA })).status).toBe(422);
  });

  it('answer bank: questions, put, delete; unknown keys are 422', async () => {
    const q = await h.request<Env<{ items: Array<{ key: string }> }>>('GET', `${BASE}/answers/questions`, { host: RA });
    expect(q.body.data.items.map((i) => i.key)).toContain('notice_period');
    const put = await h.request<Env<{ items: Array<{ questionKey: string }> }>>('PUT', `${BASE}/answers`, {
      host: RA,
      body: { answers: [{ questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks', locale: 'en' }] },
    });
    expect(put.body.data.items.map((i) => i.questionKey)).toEqual(['notice_period']);
    const bad = await h.request<Env<unknown>>('PUT', `${BASE}/answers`, { host: RA, body: { answers: [{ questionKey: 'nope', questionText: 'x', answer: 'y', locale: 'en' }] } });
    expect(bad.status).toBe(422);
    const del = await h.request<Env<{ items: unknown[] }>>('DELETE', `${BASE}/answers/notice_period`, { host: RA });
    expect(del.body.data.items).toEqual([]);
  });
});

describe('agent router: one kit through review, open, undo and the list actions', () => {
  /** A kit prepared and approved through the service (the same fake database the router reads). */
  async function approvedKit(): Promise<string> {
    const kit = makeDeps(db, 'roboapply', state.overrides);
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    await kit.service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    await kit.service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    return id;
  }

  it('GET /queue/:id: the kit review screen', async () => {
    const id = await approvedKit();
    const res = await h.request<Env<{ item: { id: string; state: string }; kit: { resume: { variantId: string }; revisionCost: unknown; fileName: string }; history: unknown[] }>>(
      'GET',
      `${BASE}/queue/${id}`,
      { host: RA },
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.item).toMatchObject({ id, state: 'approved' });
    expect(res.body.data.kit.resume.variantId).toBe('rv_tailored1');
    expect(res.body.data.kit.revisionCost).toMatchObject({ resume: { bucket: 'tailor', cost: 1 }, letter: { bucket: 'cover_letter', cost: 1 } });
    expect(res.body.data.history.length).toBeGreaterThan(0);
    expect((await h.request('GET', `${BASE}/queue/nope`, { host: RA })).status).toBe(404);
  });

  it('POST /queue/:id/open returns the employer URL and the handoff; undo-applied puts it back', async () => {
    const id = await approvedKit();
    const res = await h.request<Env<{ applyUrl: string; handoff: Record<string, unknown>; trackerEntryId: string; alreadyApplied: boolean; item: { state: string } }>>(
      'POST',
      `${BASE}/queue/${id}/open`,
      { host: RA },
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      applyUrl: 'https://jobs.example.test/j1',
      handoff: { jobId: 'j1', variantId: 'rv_tailored1', coverLetterId: null },
      trackerEntryId: 'trk_j1',
      alreadyApplied: false,
      item: { state: 'opened' },
    });
    const undo = await h.request<Env<{ state: string }>>('POST', `${BASE}/queue/${id}/undo-applied`, { host: RA });
    expect(undo.status).toBe(200);
    expect(undo.body.data.state).toBe('approved');
  });

  it('undo-applied the tracker can no longer revert is 409 kit_undo_expired', async () => {
    state.overrides = { undoApplyClick: async () => ({ reverted: false }) };
    const id = await approvedKit();
    await h.request('POST', `${BASE}/queue/${id}/open`, { host: RA });
    const undo = await h.request<Env<unknown>>('POST', `${BASE}/queue/${id}/undo-applied`, { host: RA });
    expect(undo.status).toBe(409);
    expect(undo.body.details?.reason).toBe('kit_undo_expired');
  });

  it('POST /queue/:id/applied: "I applied" without a link', async () => {
    const id = await approvedKit();
    const res = await h.request<Env<{ state: string; trackerEntryId: string }>>('POST', `${BASE}/queue/${id}/applied`, { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'applied', trackerEntryId: 'trk_j1' });
  });

  it('POST /queue/:id/skip, /restore and DELETE /queue/:id', async () => {
    const add = await h.request<Env<{ items: Array<{ id: string }> }>>('POST', `${BASE}/queue`, { host: RA, body: { jobIds: ['j3'] } });
    const id = add.body.data.items[0]!.id;
    const skipped = await h.request<Env<{ state: string; tab: string }>>('POST', `${BASE}/queue/${id}/skip`, { host: RA });
    expect(skipped.status).toBe(200);
    expect(skipped.body.data).toMatchObject({ state: 'skipped', tab: 'done' });
    const restored = await h.request<Env<{ state: string }>>('POST', `${BASE}/queue/${id}/restore`, { host: RA });
    expect(restored.status).toBe(200);
    expect(restored.body.data.state).toBe('picked');
    const del = await h.request<Env<null>>('DELETE', `${BASE}/queue/${id}`, { host: RA });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ success: true, data: null });
    expect((await h.request('GET', `${BASE}/queue/${id}`, { host: RA })).status).toBe(404);
  });

  it('GET /queue pages with a cursor; a bad cursor is 400-class invalid_request', async () => {
    await h.request('POST', `${BASE}/queue`, { host: RA, body: { jobIds: ['j1', 'j2', 'j3'] } });
    const first = await h.request<Env<{ items: unknown[]; nextCursor: string | null; counts: Record<string, number> }>>('GET', `${BASE}/queue?limit=2`, { host: RA });
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.counts.to_prepare).toBe(3);
    const next = await h.request<Env<{ items: unknown[]; nextCursor: string | null }>>('GET', `${BASE}/queue?limit=2&cursor=${first.body.data.nextCursor}`, { host: RA });
    expect(next.body.data.items).toHaveLength(1);
    expect(next.body.data.nextCursor).toBeNull();
    const bad = await h.request<Env<unknown>>('GET', `${BASE}/queue?cursor=bm9wZQ`, { host: RA });
    expect(bad.body.code).toBe('invalid_request');
  });

  it('GET /answers lists the saved answers', async () => {
    await h.request('PUT', `${BASE}/answers`, { host: RA, body: { answers: [{ questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks', locale: 'en' }] } });
    const res = await h.request<Env<{ items: Array<{ questionKey: string; answer: string }> }>>('GET', `${BASE}/answers`, { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([expect.objectContaining({ questionKey: 'notice_period', answer: 'Two weeks' })]);
  });
});
