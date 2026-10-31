// @vitest-environment node
//
// Admin "view as" routes (POST /admin/view-as, POST /admin/view-as/stop):
// who may be viewed, where the person lands, the grant cookie, the audit rows,
// and the whole loop through the real requireAuth: start → read the app as the
// person → a write is refused → stop.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';

const m = vi.hoisted(() => ({ sessions: new Map<string, Record<string, unknown>>() }));

vi.mock('../../../services/AuthService.js', () => ({
  default: {
    validateSession: vi.fn(async (token: string) => m.sessions.get(token) ?? null),
    // One bearer JWT for the admin (a client with no session cookie).
    verifyToken: vi.fn((token: string) => (token === 'admin-jwt' ? { userId: 'admin1', email: 'admin@example.test', iat: Math.floor(Date.now() / 1000) } : null)),
    getUserById: vi.fn(async (id: string) => (id === 'admin1' ? m.sessions.get('admin-token') ?? null : null)),
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: { user: { update: vi.fn(async () => ({ id: 'x' })) } } }));
vi.mock('../../../middleware/usageMeter.js', () => ({ withUserUsageLimits: async (u: unknown) => u }));
vi.mock('../../../lib/subscriptionGraceConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/subscriptionGraceConfig.js')>()),
  resolveGraceDaysForUser: async () => 0,
}));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setRequestUserId: vi.fn() },
}));

const { requireAuth, setViewAsSubjectReaderForTests, setTokenCutoffReaderForTests } = await import('../../../middleware/auth.js');
const { startRouteHarness } = await import('../../../test/routeHarness.js');
const { createAdminConsoleRouter } = await import('../routes.js');
const { viewAsLanding, viewAsBlockedReason } = await import('../viewAs.js');
import type { ViewAsStore, ViewAsSubject } from '../viewAs.js';
import type { AdminAuditStore, StoredAdminAuditRow } from '../audit.js';

const ENV = { NODE_ENV: 'test', ALLOWED_BRANDS: 'roboapply,goapply' };
const ROBO = 'localhost:3611';
const base = { isActive: true, createdAt: new Date(), updatedAt: new Date(), subscriptionTier: 'free', lastActiveAt: new Date() };

const profile = (over: Partial<NonNullable<ViewAsSubject['profile']>> = {}) => ({ deletedAt: null, onboardingStep: 'done', onboardingPath: null, ...over });
const subjects = new Map<string, ViewAsSubject>();
const store: ViewAsStore = { findSubject: async (id) => subjects.get(id) ?? null };
const audits: StoredAdminAuditRow[] = [];
const audit: AdminAuditStore = {
  record: async (row) => {
    audits.push({ ...row, id: `al_${audits.length + 1}`, createdAt: new Date() });
  },
  list: async () => [],
};

let h: Awaited<ReturnType<typeof startRouteHarness>>;
beforeAll(async () => {
  const probe = Router();
  probe.get('/whoami', requireAuth, (req, res) => res.json({ id: req.user!.id, viewAs: req.viewAs ? req.viewAs.admin.id : null }));
  probe.post('/save', requireAuth, (_req, res) => res.json({ saved: true }));
  h = await startRouteHarness({
    env: ENV,
    mounts: [
      ['/admin', createAdminConsoleRouter({ env: ENV, viewAs: store, audit })],
      ['/app', probe],
    ],
  });
  setTokenCutoffReaderForTests(async () => null);
  // The middleware reads the viewed account's row; the fake store holds the same people.
  setViewAsSubjectReaderForTests(async (id) => {
    const s = subjects.get(id);
    return s ? { ...base, id: s.id, email: s.email, name: s.name, role: s.role, roles: s.roles, brand: s.brand } : null;
  });
});
afterAll(async () => {
  setViewAsSubjectReaderForTests(null);
  setTokenCutoffReaderForTests(null);
  await h.close();
});
beforeEach(() => {
  audits.length = 0;
  subjects.clear();
  m.sessions.clear();
  m.sessions.set('admin-token', { ...base, id: 'admin1', email: 'admin@example.test', name: 'Ada', role: 'admin', roles: ['admin'], brand: 'roboapply' });
  m.sessions.set('seeker-token', { ...base, id: 'user1', email: 'jane@example.test', role: 'seeker', roles: ['seeker'], brand: 'roboapply' });
  const person = (id: string, over: Partial<ViewAsSubject> = {}): ViewAsSubject => ({
    id, email: `${id}@example.test`, name: null, role: 'seeker', roles: ['seeker'], brand: 'roboapply', profile: profile(), ...over,
  });
  subjects.set('user1', person('user1', { name: 'Jane' }));
  subjects.set('fresh', person('fresh', { profile: profile({ onboardingStep: 'account' }) }));
  subjects.set('midway', person('midway', { profile: profile({ onboardingStep: 'resume', onboardingPath: 'urgent' }) }));
  subjects.set('admin1', person('admin1', { role: 'admin', roles: ['admin'] }));
  subjects.set('admin2', person('admin2', { role: 'admin', roles: ['admin'] }));
  subjects.set('recruiter', person('recruiter', { profile: null, role: 'user', roles: ['user'] }));
  subjects.set('gone', person('gone', { profile: profile({ deletedAt: new Date('2026-10-01T00:00:00Z') }) }));
  subjects.set('go1', person('go1', { brand: 'goapply' }));
});

const adminCookies = { ra_session_token: 'admin-token' };
const start = (userId: string, cookies: Record<string, string> = adminCookies, host = ROBO) =>
  h.request<{ success: boolean; code?: string; data?: Record<string, any>; details?: Record<string, unknown> }>('POST', '/admin/view-as', { host, cookies, body: { userId } });
const grantCookie = (setCookie: string | null) => /ra_view_as=([^;]+)/.exec(setCookie ?? '')?.[1];

describe('POST /admin/view-as', () => {
  it('starts a read-only view: the grant cookie, the landing page and an audit row', async () => {
    const res = await start('user1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      admin: { id: 'admin1', email: 'admin@example.test', name: 'Ada' },
      subject: { id: 'user1', email: 'user1@example.test', name: 'Jane' },
      landing: '/jobs',
    });
    expect(Date.parse(res.body.data!.expiresAt) - Date.parse(res.body.data!.startedAt)).toBe(60 * 60 * 1000);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(grantCookie(setCookie)).toBeTruthy();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(audits).toEqual([
      expect.objectContaining({ adminId: 'admin1', subjectUserId: 'user1', eventType: 'admin_view_as_started', payload: expect.objectContaining({ brand: 'roboapply' }) }),
    ]);
  });

  it.each([
    ['admin1', 409, 'self'],
    ['admin2', 403, 'admin_account'],
    ['recruiter', 409, 'not_seeker'],
    ['gone', 409, 'deleted'],
    ['go1', 409, 'other_brand'],
  ])('refuses %s (%i %s) and writes nothing', async (userId, status, reason) => {
    const res = await start(userId);
    expect(res.status).toBe(status);
    expect(res.body.details?.reason).toBe(reason);
    expect(grantCookie(res.headers.get('set-cookie'))).toBeUndefined();
    expect(audits).toEqual([]);
  });

  it('points an other-brand account to that brand\'s admin console', async () => {
    const res = await start('go1');
    expect(res.body.details).toEqual({ reason: 'other_brand', brand: 'goapply', adminUrl: 'https://www.goapply.top/admin' });
  });

  it('views a GoApply account from the GoApply host', async () => {
    const res = await start('go1', adminCookies, 'goapply.localhost:3621');
    expect(res.status).toBe(200);
  });

  it('answers 404 for an unknown id and 422 without one', async () => {
    expect((await start('nobody')).status).toBe(404);
    expect((await h.request('POST', '/admin/view-as', { host: ROBO, cookies: adminCookies, body: {} })).status).toBe(422);
  });

  it('is admin only', async () => {
    expect((await start('user1', {})).status).toBe(401);
    expect((await start('fresh', { ra_session_token: 'seeker-token' })).status).toBe(403);
    expect(audits).toEqual([]);
  });

  it('ties the grant to a session: X-Session-Token works, a bare bearer token does not', async () => {
    const header = await start('user1', {});
    expect(header.status).toBe(401);
    const viaHeader = await h.request('POST', '/admin/view-as', { host: ROBO, headers: { 'x-session-token': 'admin-token' }, body: { userId: 'user1' } });
    expect(viaHeader.status).toBe(200);
    const bearer = await h.request<{ details?: { reason?: string } }>('POST', '/admin/view-as', {
      host: ROBO,
      headers: { authorization: 'Bearer admin-jwt' },
      body: { userId: 'user1' },
    });
    expect(bearer.status).toBe(409);
    expect(bearer.body.details?.reason).toBe('needs_session');
  });
});

describe('the whole loop through requireAuth', () => {
  it('start → read as the person → writes refused → stop → back to the admin', async () => {
    const started = await start('user1');
    const token = grantCookie(started.headers.get('set-cookie'))!;
    const cookies = { ra_session_token: 'admin-token', ra_view_as: decodeURIComponent(token) };

    const who = await h.request<{ id: string; viewAs: string | null }>('GET', '/app/whoami', { host: ROBO, cookies });
    expect(who.body).toEqual({ id: 'user1', viewAs: 'admin1' });

    const save = await h.request<{ code?: string }>('POST', '/app/save', { host: ROBO, cookies });
    expect(save.status).toBe(403);
    expect(save.body.code).toBe('view_as_read_only');

    // Starting another view from inside one replaces it (the route acts as the admin).
    const again = await start('midway', cookies);
    expect(again.status).toBe(200);

    const stop = await h.request<{ data: { ended: boolean } }>('POST', '/admin/view-as/stop', { host: ROBO, cookies });
    expect(stop.status).toBe(200);
    expect(stop.body.data).toEqual({ ended: true });
    expect(stop.headers.get('set-cookie')).toMatch(/ra_view_as=;/);
    expect(audits.map((a) => [a.eventType, a.subjectUserId])).toEqual([
      ['admin_view_as_started', 'user1'],
      ['admin_view_as_started', 'midway'],
      ['admin_view_as_ended', 'user1'],
    ]);

    const back = await h.request<{ id: string }>('GET', '/app/whoami', { host: ROBO, cookies: adminCookies });
    expect(back.body.id).toBe('admin1');
  });

  it('stop without a grant only clears the cookie', async () => {
    const res = await h.request<{ data: { ended: boolean } }>('POST', '/admin/view-as/stop', { host: ROBO, cookies: adminCookies });
    expect(res.body.data).toEqual({ ended: false });
    expect(audits).toEqual([]);
  });
});

describe('who may be viewed, and where they land', () => {
  it('blocks the cases the route refuses', () => {
    const p = (over: Partial<ViewAsSubject> = {}) => ({ id: 'u', role: 'seeker', roles: ['seeker'], brand: 'roboapply', profile: profile(), ...over });
    expect(viewAsBlockedReason({ id: 'a' }, p(), 'roboapply')).toBeNull();
    expect(viewAsBlockedReason({ id: 'a' }, p({ brand: null }), 'goapply')).toBeNull();
    expect(viewAsBlockedReason({ id: 'u' }, p(), 'roboapply')).toBe('self');
    expect(viewAsBlockedReason({ id: 'a' }, p({ roles: ['seeker', 'admin'] }), 'roboapply')).toBe('admin_account');
  });

  it('lands on the onboarding screen the person left, else the first-value page', () => {
    expect(viewAsLanding('roboapply', profile({ onboardingStep: 'account' }), ENV)).toBe('/onboarding/situation');
    expect(viewAsLanding('roboapply', profile({ onboardingStep: 'resume' }), ENV)).toBe('/onboarding/resume');
    expect(viewAsLanding('roboapply', profile({ onboardingStep: 'done' }), ENV)).toBe('/jobs');
    expect(viewAsLanding('roboapply', profile({ onboardingStep: 'tour' }), ENV)).toBe('/jobs');
    expect(viewAsLanding('goapply', profile({ onboardingStep: 'account' }), ENV)).toBe('/onboarding/consent');
  });
});
