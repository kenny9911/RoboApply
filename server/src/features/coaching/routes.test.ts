// @vitest-environment node
//
// WP-72 route tests: auth (401), capability off (404 feature_disabled),
// validation (422), brand scoping (each host sees its own roster), the
// per-user request limit (429), admin-only roster management, and
// /coaching/bookings answering 404 (no bookings data in V2).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { flagEnvName, setFlagOverrideLoader } from '../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { rateLimit } from '../../platform/ratelimit/index.js';
import { createCoachingRouter, COACHING_REQUEST_WINDOWS } from './routes.js';
import { createCoachingAdminRouter } from './adminRoutes.js';
import { createCoachingService, type CoachingDb, type CoachingService } from './service.js';
import type { AdminCoachView, CoachView } from './contract.js';

const BASE = '/api/v1/roboapply/coaching';
const ADMIN_BASE = '/api/v1/roboapply/admin/coaching';
const RA = 'localhost:3621';
const GA = 'goapply.localhost:3621';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

// GoApply's registry default is off; turn it on so brand scoping can be tested on both hosts.
const ENV_ON = { NODE_ENV: 'development', [flagEnvName('goapply', 'coaching')]: 'true', RESEND_API_KEY: 're_test', CN_EMAIL_TRANSPORT: 'resend', CN_EMAIL_FROM: 'noreply@example.test' };
const ENV_OFF = { NODE_ENV: 'development', [flagEnvName('roboapply', 'coaching')]: 'false', [flagEnvName('goapply', 'coaching')]: 'false' };

const NOW = new Date('2026-10-10T00:00:00.000Z');
const row = (extra: Record<string, unknown>) => ({
  userId: null,
  headline: 'Coach',
  bio: 'Real bio.',
  photoUrl: null,
  languages: ['en'],
  specialties: [],
  sessionLengths: [30],
  rates: {},
  bookingUrl: null,
  requestEmail: 'coach@example.test',
  introVideoUrl: null,
  active: true,
  status: 'approved',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

let db: ReturnType<typeof createFakePrisma>;
let sent: unknown[];
const service = new Proxy({} as CoachingService, {
  get: (_t, prop) => {
    const real = createCoachingService({
      db: db as unknown as CoachingDb,
      send: async (input) => {
        sent.push(input);
        return { status: 'sent' };
      },
    });
    return (real as unknown as Record<PropertyKey, unknown>)[prop];
  },
});

const seeker = fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: String(req.headers['x-test-user'] ?? 'u1'), role: 'seeker' }));
const admin = fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: 'admin1', role: req.headers['x-test-seeker'] ? 'seeker' : 'admin' }));
const adminOnly: RequestHandler = (req, res, next) => {
  if ((req as unknown as { user?: { role?: string } }).user?.role === 'admin') return next();
  res.status(403).json({ success: false, code: 'forbidden', error: 'Admins only.' });
};

// A small in-memory limiter with the production windows.
function memoryRateDb() {
  const counters = new Map<string, number>();
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = String(values[0]) + String(values[1]);
      const count = (counters.get(key) ?? 0) + Number(values.find((v) => typeof v === 'number') ?? 1);
      counters.set(key, count);
      void strings;
      return [{ count }];
    },
    rARateCounter: {},
  };
}

let on: RouteHarness;
let off: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  on = await startRouteHarness({
    env: ENV_ON,
    mounts: [
      [BASE, createCoachingRouter({ seekerAuth: [seeker], env: ENV_ON }, { service, requestLimit: (_q, _s, n) => n() })],
      [ADMIN_BASE, createCoachingAdminRouter({ adminAuth: [admin, adminOnly], env: ENV_ON }, { service })],
    ],
  });
  off = await startRouteHarness({ env: ENV_OFF, mounts: [[BASE, createCoachingRouter({ seekerAuth: [seeker], env: ENV_OFF }, { service })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});
beforeEach(() => {
  sent = [];
  db = createFakePrisma({
    seed: {
      rACoach: [
        row({ id: 'ra1', brand: 'roboapply', displayName: 'Dana Lee' }),
        row({ id: 'ga1', brand: 'goapply', displayName: '王老师', languages: ['zh'] }),
        row({ id: 'ra-off', brand: 'roboapply', displayName: 'Paused', active: false }),
      ],
    },
  });
});

const reqBody = { topic: 'Mock interview', contactEmail: 'u@example.test' };

describe('seeker routes', () => {
  it('require a session (401)', async () => {
    for (const [m, p] of [['GET', '/coaches'], ['GET', '/coaches/ra1'], ['POST', '/coaches/ra1/request'], ['GET', '/bookings']] as const) {
      const res = await on.request(m, `${BASE}${p}`, { host: RA, headers: { 'x-test-anon': '1' }, body: m === 'POST' ? reqBody : undefined });
      expect(res.status, `${m} ${p}`).toBe(401);
    }
  });

  it('answer 404 feature_disabled with the capability off, before touching the roster', async () => {
    for (const [m, p] of [['GET', '/coaches'], ['GET', '/coaches/ra1'], ['POST', '/coaches/ra1/request']] as const) {
      const res = await off.request<Env<unknown>>(m, `${BASE}${p}`, { host: RA, body: m === 'POST' ? reqBody : undefined });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
    expect(sent).toHaveLength(0);
  });

  it('each host sees only its own roster', async () => {
    const ra = await on.request<Env<{ items: CoachView[] }>>('GET', `${BASE}/coaches`, { host: RA });
    expect(ra.status).toBe(200);
    expect(ra.body.data.items.map((c) => c.id)).toEqual(['ra1']);
    const ga = await on.request<Env<{ items: CoachView[] }>>('GET', `${BASE}/coaches`, { host: GA });
    expect(ga.body.data.items.map((c) => c.id)).toEqual(['ga1']);
    const cross = await on.request<Env<unknown>>('GET', `${BASE}/coaches/ga1`, { host: RA });
    expect(cross.status).toBe(404);
    expect(cross.body.details).toMatchObject({ reason: 'coach_not_found' });
  });

  it('GoApply coaching is off by default (registry), so its routes 404', async () => {
    const h = await startRouteHarness({ env: { NODE_ENV: 'development' }, mounts: [[BASE, createCoachingRouter({ seekerAuth: [seeker], env: { NODE_ENV: 'development' } }, { service })]] });
    try {
      const ga = await h.request<Env<unknown>>('GET', `${BASE}/coaches`, { host: GA });
      expect(ga.status).toBe(404);
      expect(ga.body.code).toBe('feature_disabled');
      const ra = await h.request<Env<unknown>>('GET', `${BASE}/coaches`, { host: RA });
      expect(ra.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('a booking request is validated (422) and sent (200)', async () => {
    const bad = await on.request<Env<unknown>>('POST', `${BASE}/coaches/ra1/request`, { host: RA, body: { topic: '', contactEmail: 'nope' } });
    expect(bad.status).toBe(422);
    const okRes = await on.request<Env<{ received: boolean }>>('POST', `${BASE}/coaches/ra1/request`, { host: RA, body: reqBody });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data).toEqual({ received: true });
    expect(sent).toHaveLength(2);
  });

  it('GoApply asks for the separate consent to share with the coach (422 without it)', async () => {
    const res = await on.request<Env<unknown>>('POST', `${BASE}/coaches/ga1/request`, { host: GA, body: reqBody });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: 'share_consent_required' });
    expect(sent).toHaveLength(0);
    const ok = await on.request<Env<unknown>>('POST', `${BASE}/coaches/ga1/request`, { host: GA, body: { ...reqBody, shareConsent: true } });
    expect(ok.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it('/coaching/bookings 404s (no bookings data in V2)', async () => {
    for (const [m, p] of [['GET', '/bookings'], ['POST', '/bookings'], ['GET', '/bookings/b1']] as const) {
      const res = await on.request<Env<unknown>>(m, `${BASE}${p}`, { host: RA, body: m === 'POST' ? {} : undefined });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(res.body.code).toBe('not_found');
    }
  });

  it('limits booking requests per user per day (429 after 5)', async () => {
    expect(COACHING_REQUEST_WINDOWS).toEqual([{ limit: 5, windowSec: 86400 }]);
    const limited = rateLimit({ name: 'coachingRequestPerUser', windows: COACHING_REQUEST_WINDOWS, by: 'user', db: memoryRateDb() as never });
    const h = await startRouteHarness({ env: ENV_ON, mounts: [[BASE, createCoachingRouter({ seekerAuth: [seeker], env: ENV_ON }, { service, requestLimit: limited })]] });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await h.request('POST', `${BASE}/coaches/ra1/request`, { host: RA, body: reqBody })).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      // Another user is not affected.
      expect((await h.request('POST', `${BASE}/coaches/ra1/request`, { host: RA, headers: { 'x-test-user': 'u2' }, body: reqBody })).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe('admin routes', () => {
  it('refuse to add a coach without the "agreed to be listed" attestation (422)', async () => {
    const body = { brand: 'roboapply', displayName: 'Lin', headline: 'Coach', bio: 'Bio.', bookingUrl: 'https://cal.example.test/lin', active: true };
    const before = (await db.rACoach.findMany({})).length;
    for (const extra of [{}, { listingConsent: false }, { listingConsent: 'yes' }]) {
      const res = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/coaches`, { body: { ...body, ...extra } });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.code).toBe('invalid_request');
    }
    expect((await db.rACoach.findMany({})).length).toBe(before);
  });

  it('an unknown linked account ID is a 422 coach_user_not_found, not a 500', async () => {
    const res = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/coaches`, {
      body: { brand: 'roboapply', displayName: 'Lin', headline: 'Coach', bio: 'Bio.', userId: 'ghost', listingConsent: true },
    });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: 'coach_user_not_found' });
  });

  it('are admin only (401 / 403)', async () => {
    expect((await on.request('GET', `${ADMIN_BASE}/coaches`, { headers: { 'x-test-anon': '1' } })).status).toBe(401);
    expect((await on.request('GET', `${ADMIN_BASE}/coaches`, { headers: { 'x-test-seeker': '1' } })).status).toBe(403);
    expect((await on.request('POST', `${ADMIN_BASE}/coaches`, { headers: { 'x-test-seeker': '1' }, body: {} })).status).toBe(403);
  });

  it('list, create (201), update and delete', async () => {
    const list = await on.request<Env<{ items: AdminCoachView[] }>>('GET', `${ADMIN_BASE}/coaches?brand=roboapply`);
    expect(list.body.data.items.map((c) => c.id).sort()).toEqual(['ra-off', 'ra1']);

    const invalid = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/coaches`, { body: { brand: 'roboapply', displayName: 'X' } });
    expect(invalid.status).toBe(422);
    const unreachable = await on.request<Env<unknown>>('POST', `${ADMIN_BASE}/coaches`, {
      body: { brand: 'roboapply', displayName: 'X', headline: 'Y', bio: 'Z', active: true, listingConsent: true },
    });
    expect(unreachable.status).toBe(422);
    expect(unreachable.body.details).toMatchObject({ reason: 'no_booking_path' });

    const created = await on.request<Env<AdminCoachView>>('POST', `${ADMIN_BASE}/coaches`, {
      body: { brand: 'roboapply', displayName: 'Lin', headline: 'Coach', bio: 'Bio.', bookingUrl: 'https://cal.example.test/lin', active: true, listingConsent: true },
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const patched = await on.request<Env<AdminCoachView>>('PATCH', `${ADMIN_BASE}/coaches/${id}`, { body: { active: false } });
    expect(patched.status).toBe(200);
    expect(patched.body.data.active).toBe(false);

    const del = await on.request<Env<{ deleted: boolean }>>('DELETE', `${ADMIN_BASE}/coaches/${id}`);
    expect(del.body.data).toEqual({ deleted: true });
    expect((await on.request('DELETE', `${ADMIN_BASE}/coaches/${id}`)).status).toBe(404);
  });
});
