// @vitest-environment node
//
// Verification finding: GET /auth/me returned the whole User row minus the
// password hash, so `data.user` carried `passwordResetToken` and
// `emailVerificationToken` (null for most accounts, the stored hash while a
// reset or a verification is pending), their expiries, the provider subject
// id and payment ids. A response of this router carries PUBLIC_USER_FIELDS
// only (route level: /me and login; unit level: the reducer).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  reqUser: null as null | Record<string, unknown>,
}));

vi.mock('../../lib/prisma.js', () => {
  const client = {
    user: { findUnique: m.findUnique },
    seekerProfile: { upsert: vi.fn() },
    userActivity: { create: vi.fn(async () => ({ id: 'a1' })) },
    rAResumeVariant: { count: vi.fn(async () => 0) },
    rACareerGoal: { findUnique: vi.fn(async () => null) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  };
  return { default: client, prisma: client };
});
vi.mock('bcryptjs', () => ({
  default: { hash: async () => 'hashed', compare: async (pw: string) => pw === 'right-password' },
}));
vi.mock('../engine/lib/seekerSession.js', () => ({
  createSeekerSession: vi.fn(async () => ({ token: 'opaque-session-token' })),
  generateJwt: () => 'jwt-token',
  invalidateSeekerSession: vi.fn(),
}));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../middleware/auth.js', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!m.reqUser) return res.status(401).json({});
    req.user = m.reqUser;
    next();
  },
}));
vi.mock('../engine/services/SeekerProfileService.js', () => ({ default: { getByUserId: vi.fn(async () => ({ id: 'p1', userId: 'u1', locale: 'en' })) } }));
vi.mock('../engine/middleware/seekerAuth.js', () => ({ requireSeekerProfile: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { PUBLIC_USER_FIELDS, publicUserOf } from './auth.js';

/** A User row as AuthService.buildPublicUser returns it: everything but the password hash. */
function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'mara@example.test',
    name: 'Mara Lindqvist',
    avatar: null,
    role: 'seeker',
    roles: ['seeker'],
    isActive: true,
    brand: 'roboapply',
    market: 'intl',
    provider: 'email',
    providerId: 'google-oauth2|1234567890',
    emailVerified: false,
    emailVerifiedAt: null,
    emailIsPlaceholder: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    subscriptionTier: 'free',
    subscriptionStatus: 'active',
    currentPeriodEnd: null,
    // What must never leave the server.
    passwordResetToken: 'sha256-of-a-reset-token',
    passwordResetExpiry: '2026-10-11T01:00:00.000Z',
    emailVerificationToken: 'sha256-of-a-verify-token',
    emailVerificationExpiry: '2026-10-12T00:00:00.000Z',
    emailVerificationIssuedAt: '2026-10-11T00:00:00.000Z',
    tokensValidAfter: null,
    stripeCustomerId: 'cus_test_123',
    subscriptionId: 'sub_test_123',
    assignedSalesId: 'staff-7',
    matchingPreferences: { internal: true },
    topUpBalance: 0,
    maxInterviews: 5,
    ...over,
  };
}

const SECRET_KEYS = [
  'passwordHash',
  'passwordResetToken',
  'passwordResetExpiry',
  'emailVerificationToken',
  'emailVerificationExpiry',
  'emailVerificationIssuedAt',
  'tokensValidAfter',
  'providerId',
  'stripeCustomerId',
  'subscriptionId',
  'assignedSalesId',
  'matchingPreferences',
];

describe('publicUserOf', () => {
  it('keeps the public fields and nothing else', () => {
    const out = publicUserOf(userRow({ passwordHash: 'bcrypt-hash' }))!;
    expect(out).toMatchObject({ id: 'u1', email: 'mara@example.test', name: 'Mara Lindqvist', role: 'seeker', roles: ['seeker'], brand: 'roboapply', emailVerified: false });
    for (const key of Object.keys(out)) expect(PUBLIC_USER_FIELDS as readonly string[]).toContain(key);
    for (const key of SECRET_KEYS) expect(out).not.toHaveProperty(key);
  });

  it('a token column is not sent even when it is null', () => {
    const out = publicUserOf(userRow({ passwordResetToken: null, emailVerificationToken: null }))!;
    expect(Object.keys(out)).not.toContain('passwordResetToken');
    expect(Object.keys(out)).not.toContain('emailVerificationToken');
  });

  it('no column whose name says token, secret, hash or expiry is on the public list', () => {
    for (const key of PUBLIC_USER_FIELDS) expect(key).not.toMatch(/token|secret|hash|expiry|password/i);
  });

  it('null for no user; absent fields stay absent', () => {
    expect(publicUserOf(null)).toBeNull();
    expect(publicUserOf(undefined)).toBeNull();
    expect(publicUserOf({ id: 'u1', email: 'a@example.test' })).toEqual({ id: 'u1', email: 'a@example.test' });
  });
});

describe('the auth routes send public user fields only', () => {
  let h: RouteHarness;
  beforeAll(async () => {
    const cookieParser = (await import('cookie-parser')).default;
    const router = (await import('./auth.js')).default;
    h = await startRouteHarness({ env: { NODE_ENV: 'development' }, before: [cookieParser()], mounts: [['/api/v1/roboapply/auth', router]] });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    m.reqUser = null;
    m.findUnique.mockReset();
  });

  it('GET /me: no token fields in data.user', async () => {
    m.reqUser = userRow();
    const res = await h.request<{ data: { user: Record<string, unknown> } }>('GET', '/api/v1/roboapply/auth/me', { host: 'localhost:3621' });
    expect(res.status).toBe(200);
    const user = res.body.data.user;
    expect(user).toMatchObject({ id: 'u1', email: 'mara@example.test', name: 'Mara Lindqvist', role: 'seeker' });
    for (const key of SECRET_KEYS) expect(user).not.toHaveProperty(key);
    expect(JSON.stringify(res.body)).not.toMatch(/sha256-of-a|cus_test_123|sub_test_123|google-oauth2/);
  });

  it('POST /login: no token fields in data.user either', async () => {
    m.findUnique.mockResolvedValue({
      ...userRow({ passwordHash: 'hashed' }),
      seekerProfile: { id: 'p1', source: 'organic', readinessScore: 0, locale: 'en', deletedAt: null },
    });
    const res = await h.request<{ data: { user: Record<string, unknown> } }>('POST', '/api/v1/roboapply/auth/login', {
      host: 'localhost:3621',
      body: { email: 'mara@example.test', password: 'right-password' },
    });
    expect(res.status).toBe(200);
    for (const key of SECRET_KEYS) expect(res.body.data.user).not.toHaveProperty(key);
    expect(res.body.data.user).toMatchObject({ id: 'u1', email: 'mara@example.test' });
  });
});
