// @vitest-environment node
//
// Admin "view as" in requireAuth / optionalAuth (platform/viewAs), through the
// real middleware with a mocked session store: a valid grant answers reads as
// the viewed user, every write is refused, and a grant that no longer holds is
// dropped (cookie cleared, `X-RA-View-As: ended`) without a write ever landing
// on the admin's own account.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';

const m = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  users: new Map<string, Record<string, unknown>>(),
  update: vi.fn(async (_args: unknown) => ({ id: 'x' })),
  handled: [] as string[],
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

const { requireAuth, optionalAuth, ignoreViewAs, resetLastActiveTouchesForTests, setViewAsSubjectReaderForTests } = await import('./auth.js');
const { startRouteHarness } = await import('../test/routeHarness.js');
const { getCurrentUserId, getCurrentViewAs } = await import('../lib/requestContext.js');
const { signViewAsGrant, VIEW_AS_TTL_SECONDS } = await import('../platform/viewAs/index.js');

const base = { isActive: true, createdAt: new Date(), updatedAt: new Date(), subscriptionTier: 'free', lastActiveAt: null };
const HOST = 'localhost:3611';

function grant(over: Partial<{ adminId: string; subjectUserId: string; sessionToken: string; now: Date }> = {}) {
  return signViewAsGrant(
    { adminId: over.adminId ?? 'admin1', subjectUserId: over.subjectUserId ?? 'user1', sessionToken: over.sessionToken ?? 'admin-token' },
    { now: over.now },
  )!.token;
}

describe('requireAuth / optionalAuth with a view-as grant', () => {
  let h: Awaited<ReturnType<typeof startRouteHarness>>;
  beforeAll(async () => {
    const router = Router();
    const probe = (req: import('express').Request, res: import('express').Response) => {
      m.handled.push(`${req.method} ${req.path}`);
      res.json({
        id: req.user?.id ?? null,
        role: req.user?.role ?? null,
        ctxUser: getCurrentUserId() ?? null,
        ctxViewAs: getCurrentViewAs() ?? null,
        viewAs: req.viewAs ? { adminId: req.viewAs.admin.id, subjectUserId: req.viewAs.subjectUserId } : null,
      });
    };
    router.get('/me', requireAuth, probe);
    router.post('/me', requireAuth, probe);
    router.delete('/me', requireAuth, probe);
    router.get('/maybe', optionalAuth, probe);
    router.post('/maybe', optionalAuth, probe);
    router.post('/manage', ignoreViewAs, requireAuth, probe);
    // A read sent as POST (platform/viewAs VIEW_AS_READ_POSTS) and a write next to it.
    const feed = Router();
    feed.post('/query', requireAuth, probe);
    feed.post('/jobs/:id/hide', requireAuth, probe);
    h = await startRouteHarness({ env: { NODE_ENV: 'development' }, mounts: [['/a', router], ['/api/v1/roboapply/feed', feed]] });
    setViewAsSubjectReaderForTests(async (id) => m.users.get(id) ?? null);
  });
  afterAll(async () => {
    setViewAsSubjectReaderForTests(null);
    await h.close();
  });
  beforeEach(() => {
    m.sessions.clear();
    m.users.clear();
    m.update.mockClear();
    m.handled.length = 0;
    resetLastActiveTouchesForTests();
    const admin = { ...base, id: 'admin1', email: 'admin@example.test', name: 'Ada Admin', role: 'admin', roles: ['admin'], brand: 'roboapply' };
    m.sessions.set('admin-token', admin);
    m.sessions.set('admin2-token', { ...admin, id: 'admin2', email: 'other@example.test' });
    m.sessions.set('seeker-token', { ...base, id: 'seeker9', email: 's@example.test', role: 'seeker', brand: 'roboapply' });
    m.users.set('user1', { ...base, id: 'user1', email: 'jane@example.test', name: 'Jane', role: 'seeker', roles: ['seeker'], brand: 'roboapply', passwordHash: 'hash' });
    m.users.set('go1', { ...base, id: 'go1', email: 'li@example.test', role: 'seeker', roles: ['seeker'], brand: 'goapply' });
    m.users.set('admin3', { ...base, id: 'admin3', email: 'third@example.test', role: 'seeker', roles: ['seeker', 'admin'], brand: 'roboapply' });
  });

  const send = (method: string, path: string, cookies: Record<string, string>) =>
    h.request<Record<string, unknown>>(method, path, { host: HOST, cookies });
  const viewing = (token = grant()) => ({ ra_session_token: 'admin-token', ra_view_as: token });
  const clearsGrant = (res: { headers: Headers }) =>
    /ra_view_as=;/.test(res.headers.get('set-cookie') ?? '') && res.headers.get('x-ra-view-as') === 'ended';

  it('answers a read as the viewed user, with the grant on the request and in the context', async () => {
    const res = await send('GET', '/a/me', viewing());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'user1',
      role: 'seeker',
      ctxUser: 'user1',
      ctxViewAs: { adminId: 'admin1', subjectUserId: 'user1' },
      viewAs: { adminId: 'admin1', subjectUserId: 'user1' },
    });
    expect(clearsGrant(res)).toBe(false);
  });

  it('stamps the admin as active, never the viewed user', async () => {
    await send('GET', '/a/me', viewing());
    await new Promise((r) => setTimeout(r, 10));
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.update.mock.calls[0]![0]).toMatchObject({ where: { id: 'admin1' } });
  });

  it.each(['POST', 'DELETE'])('refuses a %s before the route runs (403 view_as_read_only)', async (method) => {
    const res = await send(method, '/a/me', viewing());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('view_as_read_only');
    expect(m.handled).toEqual([]);
  });

  it('refuses writes on optional-auth routes too, and reads there as the viewed user', async () => {
    expect((await send('GET', '/a/maybe', viewing())).body.id).toBe('user1');
    const res = await send('POST', '/a/maybe', viewing());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('view_as_read_only');
    expect(m.handled).toEqual(['GET /maybe']);
  });

  it('answers a listed read sent as POST (the jobs feed) as the viewed user, and still refuses the writes beside it', async () => {
    const read = await send('POST', '/api/v1/roboapply/feed/query', viewing());
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: 'user1', viewAs: { adminId: 'admin1', subjectUserId: 'user1' } });
    const write = await send('POST', '/api/v1/roboapply/feed/jobs/j1/hide', viewing());
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('view_as_read_only');
  });

  it('lets a view-as management route act as the admin (ignoreViewAs)', async () => {
    const res = await send('POST', '/a/manage', viewing());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'admin1', viewAs: null, ctxViewAs: null });
  });

  it('without a grant, nothing changes', async () => {
    const res = await send('POST', '/a/me', { ra_session_token: 'admin-token' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'admin1', viewAs: null });
  });

  describe('a grant that no longer holds is dropped', () => {
    // The grant itself fails: dropped on any request.
    const grantCases: Array<[string, () => Record<string, string>]> = [
      ['forged', () => viewing('not-a-grant')],
      ['expired', () => viewing(grant({ now: new Date(Date.now() - (VIEW_AS_TTL_SECONDS + 5) * 1000) }))],
      ['another admin\'s', () => ({ ra_session_token: 'admin2-token', ra_view_as: grant() })],
      ['tied to another session', () => viewing(grant({ sessionToken: 'an-older-session' }))],
      ['held by someone who is not an admin', () => ({ ra_session_token: 'seeker-token', ra_view_as: grant({ adminId: 'seeker9', sessionToken: 'seeker-token' }) })],
    ];
    // The grant holds but the account cannot be viewed: a write is refused before the account is read.
    const accountCases: Array<[string, () => Record<string, string>]> = [
      ['for an account that is gone', () => viewing(grant({ subjectUserId: 'nobody' }))],
      ['for an admin account', () => viewing(grant({ subjectUserId: 'admin3' }))],
      ['for the other brand\'s account', () => viewing(grant({ subjectUserId: 'go1' }))],
    ];

    it.each([...grantCases, ...accountCases])('%s: a read continues as the signed-in person and the cookie is cleared', async (_label, cookies) => {
      const res = await send('GET', '/a/me', cookies());
      expect(res.status).toBe(200);
      expect(res.body.viewAs).toBeNull();
      expect(res.body.id).not.toBe('user1');
      expect(clearsGrant(res)).toBe(true);
    });

    it.each(grantCases)('%s: a write is refused and the cookie cleared, never applied to the signed-in account', async (_label, cookies) => {
      const res = await send('POST', '/a/me', cookies());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('view_as_read_only');
      expect(clearsGrant(res)).toBe(true);
      expect(m.handled).toEqual([]);
    });

    it.each(accountCases)('%s: a write is refused, never applied to the signed-in account', async (_label, cookies) => {
      const res = await send('POST', '/a/me', cookies());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('view_as_read_only');
      expect(m.handled).toEqual([]);
    });
  });
});
