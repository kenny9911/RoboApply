// @vitest-environment node
//
// FND-2a: the brand gate and the lastActiveAt stamp in requireAuth /
// optionalAuth, driven through the real middleware with a mocked session store.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';

const m = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  update: vi.fn(async (_args: unknown) => ({ id: "x" })),
}));

vi.mock('../services/AuthService.js', () => ({
  default: {
    validateSession: vi.fn(async (token: string) => m.sessions.get(token) ?? null),
    verifyToken: vi.fn(() => null),
    getUserById: vi.fn(async () => null),
  },
}));
vi.mock('../lib/prisma.js', () => ({ default: { user: { update: m.update } } }));
vi.mock('./usageMeter.js', () => ({ withUserUsageLimits: async (u: unknown) => u }));
vi.mock('../lib/subscriptionGraceConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/subscriptionGraceConfig.js')>()),
  resolveGraceDaysForUser: async () => 0,
}));
vi.mock('../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setRequestUserId: vi.fn() },
}));

const { requireAuth, optionalAuth, isOtherBrandSession, shouldTouchLastActive, resetLastActiveTouchesForTests, LAST_ACTIVE_TOUCH_INTERVAL_MS } =
  await import('./auth.js');
const { startRouteHarness } = await import('../test/routeHarness.js');
const { getCurrentUserId, getCurrentBrandId } = await import('../lib/requestContext.js');

const base = { email: 'u@example.test', isActive: true, createdAt: new Date(), updatedAt: new Date(), subscriptionTier: 'free' };

describe('requireAuth brand gate', () => {
  let h: Awaited<ReturnType<typeof startRouteHarness>>;
  beforeAll(async () => {
    const router = Router();
    router.get('/me', requireAuth, (req, res) => {
      res.json({ id: req.user!.id, ctxUser: getCurrentUserId(), ctxBrand: getCurrentBrandId() });
    });
    router.get('/maybe', optionalAuth, (req, res) => {
      res.json({ id: req.user?.id ?? null });
    });
    h = await startRouteHarness({ env: { NODE_ENV: 'development' }, mounts: [['/a', router]] });
  });
  afterAll(() => h.close());
  beforeEach(() => {
    m.sessions.clear();
    m.update.mockClear();
    resetLastActiveTouchesForTests();
    m.sessions.set('go-token', { ...base, id: 'go-user', role: 'seeker', brand: 'goapply', lastActiveAt: null });
    m.sessions.set('robo-token', { ...base, id: 'robo-user', role: 'seeker', brand: 'roboapply', lastActiveAt: new Date() });
    m.sessions.set('admin-token', { ...base, id: 'admin-user', role: 'admin', brand: 'goapply', lastActiveAt: new Date() });
    m.sessions.set('legacy-token', { ...base, id: 'legacy-user', role: 'seeker', lastActiveAt: new Date() });
  });

  const get = (path: string, host: string, token: string) =>
    h.request<Record<string, unknown>>('GET', path, { host, cookies: { ra_session_token: token } });

  it('rejects a GoApply session on a RoboApply host with 401 auth_other_brand', async () => {
    const res = await get('/a/me', 'localhost:3621', 'go-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth_other_brand');
  });

  it('accepts the same session on its own host and sets the request context', async () => {
    const res = await get('/a/me', 'goapply.localhost:3621', 'go-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'go-user', ctxUser: 'go-user', ctxBrand: 'goapply' });
  });

  it('rejects a RoboApply session on a GoApply host', async () => {
    const res = await get('/a/me', 'goapply.localhost:3621', 'robo-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth_other_brand');
  });

  it('exempts admins and users with no stored brand', async () => {
    expect((await get('/a/me', 'localhost:3621', 'admin-token')).status).toBe(200);
    expect((await get('/a/me', 'goapply.localhost:3621', 'legacy-token')).status).toBe(200);
  });

  it('keeps the legacy 401 codes', async () => {
    const none = await h.request<Record<string, unknown>>('GET', '/a/me', { host: 'localhost:3621' });
    expect(none.body.code).toBe('AUTH_REQUIRED');
    const bad = await get('/a/me', 'localhost:3621', 'nope');
    expect(bad.body.code).toBe('INVALID_TOKEN');
  });

  it('optionalAuth treats an other-brand session as anonymous', async () => {
    expect((await get('/a/maybe', 'localhost:3621', 'go-token')).body).toEqual({ id: null });
    expect((await get('/a/maybe', 'goapply.localhost:3621', 'go-token')).body).toEqual({ id: 'go-user' });
  });

  it('stamps lastActiveAt at most hourly and never for a fresh stamp', async () => {
    await get('/a/me', 'goapply.localhost:3621', 'go-token');
    await get('/a/me', 'goapply.localhost:3621', 'go-token');
    await new Promise((r) => setTimeout(r, 10));
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.update.mock.calls[0]![0]).toMatchObject({ where: { id: 'go-user' }, data: { lastActiveAt: expect.any(Date) } });
    await get('/a/me', 'localhost:3621', 'robo-token');
    await new Promise((r) => setTimeout(r, 10));
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  it('a failing stamp never fails the request', async () => {
    m.update.mockRejectedValueOnce(new Error('column does not exist'));
    expect((await get('/a/me', 'goapply.localhost:3621', 'go-token')).status).toBe(200);
  });
});

describe('pure helpers', () => {
  it('isOtherBrandSession', () => {
    expect(isOtherBrandSession({ brand: 'goapply', role: 'seeker' }, 'roboapply')).toBe(true);
    expect(isOtherBrandSession({ brand: 'goapply', role: 'admin' }, 'roboapply')).toBe(false);
    expect(isOtherBrandSession({ brand: 'goapply' }, undefined)).toBe(false);
    expect(isOtherBrandSession({}, 'roboapply')).toBe(false);
  });
  it('shouldTouchLastActive', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(shouldTouchLastActive(null, undefined, now)).toBe(true);
    expect(shouldTouchLastActive(new Date(now - 10 * 60_000), undefined, now)).toBe(false);
    expect(shouldTouchLastActive(new Date(now - LAST_ACTIVE_TOUCH_INTERVAL_MS), undefined, now)).toBe(true);
    expect(shouldTouchLastActive(null, now - 1000, now)).toBe(false);
  });
});
