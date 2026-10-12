// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import {
  EMPTY_UI_STATE,
  UI_STATE_LIMITS,
  UiStatePatchSchema,
  UiStateService,
  applyUiStatePatch,
  createUiStateRouter,
  normalizeUiState,
  type UiState,
  type UiStateResponse,
} from './index.js';

const T0 = new Date('2026-10-10T08:00:00.000Z');
const T1 = new Date('2026-10-10T09:00:00.000Z');

describe('applyUiStatePatch (pure)', () => {
  const base = normalizeUiState(EMPTY_UI_STATE);

  it('stamps tours once, counts dismissals and uses server time for the popup gate', () => {
    let s = applyUiStatePatch(base, { toursSeen: ['feed.intro'], dismiss: ['onboarding.finishBanner'], popupShown: true }, T0);
    s = applyUiStatePatch(s, { toursSeen: ['feed.intro'], dismiss: ['onboarding.finishBanner'] }, T1);
    expect(s.tours).toEqual({ 'feed.intro': T0.toISOString() });
    expect(s.dismissals).toEqual({ 'onboarding.finishBanner': { count: 2, at: T1.toISOString() } });
    expect(s.popupLastShownAt).toBe(T0.toISOString());
  });

  it('resets tours and dismissals, keeps announcement order unique and bounded, sets and deletes values', () => {
    let s = applyUiStatePatch(base, { toursSeen: ['a'], dismiss: ['b'], announcementsSeen: ['n1', 'n2'], values: { 'copilot.railOpen': true } }, T0);
    s = applyUiStatePatch(s, { toursReset: ['a'], undismiss: ['b'], announcementsSeen: ['n1'], values: { 'copilot.railOpen': null, x: 3 } }, T1);
    expect(s).toEqual({ tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: ['n2', 'n1'], values: { x: 3 } });
    const many = Array.from({ length: UI_STATE_LIMITS.announcementsSeen + 5 }, (_, i) => `a${i}`);
    let big = base;
    for (let i = 0; i < many.length; i += 50) big = applyUiStatePatch(big, { announcementsSeen: many.slice(i, i + 50) }, T0);
    expect(big.announcementsSeen).toHaveLength(UI_STATE_LIMITS.announcementsSeen);
    expect(big.announcementsSeen.at(-1)).toBe(many.at(-1));
  });

  it('caps stored values with a 422 and evicts the oldest tours', () => {
    const values = Object.fromEntries(Array.from({ length: UI_STATE_LIMITS.values }, (_, i) => [`v${i}`, i]));
    const full: UiState = { ...base, values };
    expect(() => applyUiStatePatch(full, { values: { extra: 1 } }, T0)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    const tours = Object.fromEntries(Array.from({ length: UI_STATE_LIMITS.tours }, (_, i) => [`t${i}`, new Date(T0.getTime() + i).toISOString()]));
    const next = applyUiStatePatch({ ...base, tours }, { toursSeen: ['newest'] }, T1);
    expect(Object.keys(next.tours)).toHaveLength(UI_STATE_LIMITS.tours);
    expect(next.tours.t0).toBeUndefined();
    expect(next.tours.newest).toBe(T1.toISOString());
  });

  it('reads stored JSON tolerantly', () => {
    expect(
      normalizeUiState({
        tours: { ok: T0.toISOString(), 'bad key!': T0.toISOString(), nodate: 'yesterday' },
        dismissals: { d: { count: 2, at: T0.toISOString() }, e: { count: -1, at: T0.toISOString() } },
        popupLastShownAt: 42,
        announcementsSeen: ['a', 'a', 7],
        values: { s: 'x', n: 1, b: false, o: { nested: true } },
        unknown: 'dropped',
      }),
    ).toEqual({
      tours: { ok: T0.toISOString() },
      dismissals: { d: { count: 2, at: T0.toISOString() } },
      popupLastShownAt: null,
      announcementsSeen: ['a'],
      values: { s: 'x', n: 1, b: false },
    });
    expect(normalizeUiState(null)).toEqual(normalizeUiState(EMPTY_UI_STATE));
  });

  it('the PATCH schema rejects empty bodies, unknown fields, bad keys and client timestamps', () => {
    expect(UiStatePatchSchema.safeParse({}).success).toBe(false);
    expect(UiStatePatchSchema.safeParse({ popupLastShownAt: '2020-01-01T00:00:00Z' }).success).toBe(false);
    expect(UiStatePatchSchema.safeParse({ toursSeen: ['has space'] }).success).toBe(false);
    expect(UiStatePatchSchema.safeParse({ values: { k: { nested: 1 } } }).success).toBe(false);
    expect(UiStatePatchSchema.safeParse({ toursSeen: ['ok.key:1'] }).success).toBe(true);
  });
});

describe('GET/PATCH /ui-state', () => {
  let h: RouteHarness;
  let db: ReturnType<typeof createFakePrisma>;
  let clock = T0;
  beforeAll(async () => {
    db = createFakePrisma();
    const service = new UiStateService(db as unknown as ConstructorParameters<typeof UiStateService>[0]);
    const router = createUiStateRouter({
      auth: [fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null))],
      service,
      now: () => clock,
    });
    h = await startRouteHarness({ mounts: [['/api/v1/roboapply/ui-state', router]] });
  });
  afterAll(() => h.close());
  beforeEach(() => {
    db.$rows('rAUserUiState').length = 0;
  });

  const as = (user: string) => ({ headers: { 'x-test-user': user } });

  it('requires a session', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/ui-state')).status).toBe(401);
    expect((await h.request('PATCH', '/api/v1/roboapply/ui-state', { body: { popupShown: true } })).status).toBe(401);
  });

  it('returns the empty state for a new user', async () => {
    const res = await h.request<{ success: boolean; data: UiStateResponse }>('GET', '/api/v1/roboapply/ui-state', as('u1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null },
    });
  });

  it('creates, then merges patches per user', async () => {
    clock = T0;
    const first = await h.request<{ data: UiStateResponse }>('PATCH', '/api/v1/roboapply/ui-state', {
      ...as('u1'),
      body: { toursSeen: ['feed.intro'], values: { 'copilot.railOpen': false } },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.state.tours).toEqual({ 'feed.intro': T0.toISOString() });
    clock = T1;
    const second = await h.request<{ data: UiStateResponse }>('PATCH', '/api/v1/roboapply/ui-state', {
      ...as('u1'),
      body: { popupShown: true, dismiss: ['assistant.nudge'] },
    });
    expect(second.body.data.state).toEqual({
      tours: { 'feed.intro': T0.toISOString() },
      dismissals: { 'assistant.nudge': { count: 1, at: T1.toISOString() } },
      popupLastShownAt: T1.toISOString(),
      announcementsSeen: [],
      values: { 'copilot.railOpen': false },
    });
    expect(second.body.data.updatedAt).toEqual(expect.any(String));
    const other = await h.request<{ data: UiStateResponse }>('GET', '/api/v1/roboapply/ui-state', as('u2'));
    expect(other.body.data.state.tours).toEqual({});
    expect(db.$rows('rAUserUiState')).toHaveLength(1);
  });

  it('answers 422 invalid_request for a bad body', async () => {
    const res = await h.request<{ code: string }>('PATCH', '/api/v1/roboapply/ui-state', { ...as('u1'), body: { toursSeen: 'feed' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
  });

  it('retries when another tab wrote in between, and gives up with 409 conflict', async () => {
    const svcDb = createFakePrisma({ seed: { rAUserUiState: [{ userId: 'u3', state: {}, updatedAt: T0 }] } });
    const service = new UiStateService(svcDb as unknown as ConstructorParameters<typeof UiStateService>[0]);
    const delegate = svcDb.rAUserUiState;
    const realUpdateMany = delegate.updateMany;
    let races = 1;
    delegate.updateMany = async (args) => {
      if (races > 0) {
        races -= 1;
        svcDb.$rows('rAUserUiState')[0]!.updatedAt = T1; // the other tab's write
        return { count: 0 };
      }
      return realUpdateMany(args);
    };
    const res = await service.patch('u3', { toursSeen: ['x'] }, T1);
    expect(res.state.tours).toEqual({ x: T1.toISOString() });
    races = 99;
    await expect(service.patch('u3', { toursSeen: ['y'] }, T1)).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});
