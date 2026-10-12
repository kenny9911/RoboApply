// @vitest-environment node
//
// WP-60: the held-rewards admin router mounted with its DEFAULT chain
// (requireAuth + requireAdmin), as the production mount will use it. Only the
// session store is mocked (no database, no network).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sessions: new Map<string, Record<string, unknown>>() }));

vi.mock('../../services/AuthService.js', () => ({
  default: {
    validateSession: vi.fn(async (token: string) => m.sessions.get(token) ?? null),
    verifyToken: vi.fn(() => null),
    getUserById: vi.fn(async () => null),
  },
}));
vi.mock('../../lib/prisma.js', () => ({ default: { user: { update: vi.fn(async () => ({ id: 'x' })) } } }));
vi.mock('../../middleware/usageMeter.js', () => ({ withUserUsageLimits: async (u: unknown) => u }));
vi.mock('../../lib/subscriptionGraceConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/subscriptionGraceConfig.js')>()),
  resolveGraceDaysForUser: async () => 0,
}));

const { createInvitesAdminRouter } = await import('./routes.js');
const { startRouteHarness } = await import('../../test/routeHarness.js');
const { SESSION_COOKIE_NAME } = await import('../../lib/cookieOptions.js');

const base = { email: 'u@example.test', isActive: true, createdAt: new Date(), updatedAt: new Date(), subscriptionTier: 'free', brand: 'roboapply', lastActiveAt: new Date() };

describe('invites admin router, default auth chain', () => {
  let h: Awaited<ReturnType<typeof startRouteHarness>>;
  const listHeld = vi.fn(async () => []);
  const reviewReferral = vi.fn(async (id: string) => ({ id, status: 'rejected' as const }));

  beforeAll(async () => {
    m.sessions.set('seeker-token', { ...base, id: 'seeker', role: 'seeker' });
    m.sessions.set('admin-token', { ...base, id: 'staff', role: 'admin' });
    h = await startRouteHarness({
      env: { NODE_ENV: 'development' },
      // No adminAuth: the router's own [requireAuth, requireAdmin].
      mounts: [['/api/v1/roboapply/admin/growth/referrals', createInvitesAdminRouter({ referrals: { listHeld, reviewReferral } })]],
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const path = '/api/v1/roboapply/admin/growth/referrals';

  it('answers 401 without a session', async () => {
    expect((await h.request('GET', `${path}/held`, { host: 'localhost:3621' })).status).toBe(401);
    expect((await h.request('POST', `${path}/r1/review`, { host: 'localhost:3621', body: { decision: 'approve' } })).status).toBe(401);
  });

  it('answers 403 for a seeker session and reviews nothing', async () => {
    const cookies = { [SESSION_COOKIE_NAME]: 'seeker-token' };
    expect((await h.request('GET', `${path}/held`, { host: 'localhost:3621', cookies })).status).toBe(403);
    expect((await h.request('POST', `${path}/r1/review`, { host: 'localhost:3621', cookies, body: { decision: 'approve' } })).status).toBe(403);
    expect(listHeld).not.toHaveBeenCalled();
    expect(reviewReferral).not.toHaveBeenCalled();
  });

  it('lets staff through', async () => {
    const cookies = { [SESSION_COOKIE_NAME]: 'admin-token' };
    const res = await h.request<{ data: { items: unknown[] } }>('GET', `${path}/held`, { host: 'localhost:3621', cookies });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(listHeld).toHaveBeenCalledWith('roboapply');
  });
});
