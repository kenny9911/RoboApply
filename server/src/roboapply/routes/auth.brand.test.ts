// @vitest-environment node
//
// Legacy signup/login vs the FND-2a brand gate (requireAuth answers 401
// auth_other_brand for a session whose User.brand differs from the host's
// brand). Until WP-10 rewrites signup, the legacy routes must:
//   - stamp User.brand with the request brand on signup (else a GoApply-host
//     signup creates a 'roboapply' account the very next call rejects);
//   - refuse an other-brand login with 409 account_other_brand AFTER the
//     password checks out, without minting a session (ARCH §1 rule 5).
// Route level: the request brand reaches the service. Service level: the
// brand is written and compared (Prisma and bcrypt mocked).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  userCreate: vi.fn(),
  profileCreate: vi.fn(),
  createSession: vi.fn(async () => ({ token: 'opaque-session-token' })),
  activity: vi.fn(async () => ({ id: 'a1' })),
}));

vi.mock('../../lib/prisma.js', () => {
  const client = {
    user: { findUnique: m.findUnique },
    seekerProfile: { upsert: vi.fn() },
    userActivity: { create: m.activity },
    roboApplyMission: { create: vi.fn(async () => ({})) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
        user: { create: m.userCreate },
        seekerProfile: { create: m.profileCreate },
        seekerConsentRecord: { createMany: vi.fn(async () => ({ count: 2 })) },
      }),
  };
  return { default: client, prisma: client };
});
vi.mock('bcryptjs', () => ({
  default: { hash: async () => 'hashed', compare: async (pw: string) => pw === 'right-password' },
}));
vi.mock('../engine/lib/seekerSession.js', () => ({
  createSeekerSession: m.createSession,
  generateJwt: () => 'jwt-token',
  invalidateSeekerSession: vi.fn(),
}));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../middleware/auth.js', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => res.status(401).json({}),
}));
vi.mock('../engine/services/SeekerProfileService.js', () => ({ default: { getByUserId: vi.fn() } }));
vi.mock('../engine/middleware/seekerAuth.js', () => ({ requireSeekerProfile: (_req: unknown, _res: unknown, next: () => void) => next() }));

import seekerAuthService, { SeekerAccountOtherBrandError } from '../engine/services/SeekerAuthService.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { getBrand } from '../../platform/brand/registry.js';
import { findConsentDefinition, resolveConsentProse } from '../../features/compliance/consents.js';

const ENV = { NODE_ENV: 'development' };
const GOAPPLY = 'goapply.localhost:3621';
const ROBOAPPLY = 'localhost:3621';

function storedUser(brand: string, role = 'seeker') {
  return {
    id: 'u1',
    email: 'u@example.test',
    name: null,
    role,
    isActive: true,
    passwordHash: 'hashed',
    subscriptionTier: 'free',
    market: 'intl',
    brand,
    seekerProfile: { id: 'p1', source: 'organic', readinessScore: 0, locale: 'en', deletedAt: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.userCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'u1',
    email: data.email,
    name: null,
    role: 'seeker',
    subscriptionTier: 'free',
    market: data.market,
  }));
  m.profileCreate.mockResolvedValue({ id: 'p1', source: 'organic', readinessScore: 0, locale: 'en' });
});

// WP-10 signup rules: the age agreement is required and the password needs a digit.
const AGE = [{ type: 'age_16_plus', granted: true, proseVersion: 'v1' }];
/** GoApply's required signup consents while data is processed outside the mainland (CN-0). */
const CN0 = ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'].map((type) => ({
  type,
  granted: true,
  proseVersion: 'v1',
  // The hash of the text the form shows beside the box (the compliance catalog prose in Chinese).
  proseHash: resolveConsentProse(findConsentDefinition('goapply', type)!, getBrand('goapply'), 'zh').hash,
}));
/** The default: sign-up is open with no CN_SIGNUP_MODE. */
const OPEN_ENV = { NODE_ENV: 'test' };

describe('SeekerAuthService brand stamping and gate', () => {
  it('signup writes User.brand from the request brand; no brand → column default', async () => {
    m.findUnique.mockResolvedValue(null);
    // GoApply's own signup rules apply (features/auth/goapplySignup.ts); open mode is the default.
    await seekerAuthService.signup({ email: 'new@example.test', password: 'long-password1', brand: 'goapply', consents: CN0, env: OPEN_ENV });
    expect(m.userCreate.mock.calls[0]![0].data).toMatchObject({ brand: 'goapply', market: 'cn' });
    await seekerAuthService.signup({ email: 'new2@example.test', password: 'long-password1', consents: AGE });
    expect(m.userCreate.mock.calls[1]![0].data).not.toHaveProperty('brand');
  });

  it('login on the other brand throws only after the password matches, and mints no session', async () => {
    m.findUnique.mockResolvedValue(storedUser('roboapply'));
    await expect(seekerAuthService.login({ email: 'u@example.test', password: 'wrong', brand: 'goapply' })).rejects.toThrow('Invalid email or password');
    await expect(seekerAuthService.login({ email: 'u@example.test', password: 'right-password', brand: 'goapply' })).rejects.toBeInstanceOf(
      SeekerAccountOtherBrandError,
    );
    expect(m.createSession).not.toHaveBeenCalled();
    await expect(seekerAuthService.login({ email: 'u@example.test', password: 'right-password', brand: 'roboapply' })).resolves.toMatchObject({
      sessionToken: 'opaque-session-token',
    });
  });

  it('admins are exempt (as in requireAuth)', async () => {
    m.findUnique.mockResolvedValue(storedUser('roboapply', 'admin'));
    await expect(seekerAuthService.login({ email: 'u@example.test', password: 'right-password', brand: 'goapply' })).resolves.toMatchObject({
      sessionToken: 'opaque-session-token',
    });
  });
});

describe('legacy /auth routes pass the host brand', () => {
  let h: RouteHarness;
  beforeAll(async () => {
    const cookieParser = (await import('cookie-parser')).default;
    const router = (await import('./auth.js')).default;
    h = await startRouteHarness({ env: ENV, before: [cookieParser()], mounts: [['/api/v1/roboapply/auth', router]] });
  });
  afterAll(async () => {
    await h.close();
  });

  const body = { email: 'u@example.test', password: 'right-password' };

  it('email signup on the GoApply host goes through GoApply’s rules: its consents create a GoApply account with no invite; RoboApply’s agreement alone → 422', async () => {
    // Open is the default. The full flow (consent rows with the prose hash, the
    // invite and closed modes) is covered on an in-memory database in
    // features/auth/legacyAuth.test.ts.
    m.findUnique.mockResolvedValue(null);
    const ageOnly = await h.request<{ code: string }>('POST', '/api/v1/roboapply/auth/signup', {
      host: GOAPPLY,
      body: { ...body, password: 'long-password1', consents: AGE },
    });
    expect([ageOnly.status, ageOnly.body.code]).toEqual([422, 'consent_required']);
    expect(m.userCreate).not.toHaveBeenCalled();
    expect(ageOnly.headers.get('set-cookie')).toBeNull();

    const created = await h.request<{ code?: string }>('POST', '/api/v1/roboapply/auth/signup', {
      host: GOAPPLY,
      body: { ...body, password: 'long-password1', consents: CN0 },
    });
    expect(created.status).toBe(201);
    expect(m.userCreate.mock.calls[0]![0].data).toMatchObject({ brand: 'goapply', market: 'cn' });
  });

  it('CN_SIGNUP_MODE=invite on the GoApply host: no invite code → 422 invite_invalid (missing), nothing created', async () => {
    vi.stubEnv('CN_SIGNUP_MODE', 'invite');
    try {
      m.findUnique.mockResolvedValue(null);
      const noInvite = await h.request<{ code: string; details?: { missing?: boolean } }>('POST', '/api/v1/roboapply/auth/signup', {
        host: GOAPPLY,
        body: { ...body, password: 'long-password1', consents: CN0 },
      });
      expect([noInvite.status, noInvite.body.code, noInvite.body.details?.missing]).toEqual([422, 'invite_invalid', true]);
      expect(m.userCreate).not.toHaveBeenCalled();
      expect(noInvite.headers.get('set-cookie')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('email signup on the RoboApply host still creates a RoboApply account', async () => {
    m.findUnique.mockResolvedValue(null);
    const res = await h.request('POST', '/api/v1/roboapply/auth/signup', { host: ROBOAPPLY, body: { ...body, password: 'long-password1', consents: AGE } });
    expect(res.status).toBe(201);
    expect(m.userCreate.mock.calls[0]![0].data).toMatchObject({ brand: 'roboapply' });
  });

  it('login with a RoboApply account on the GoApply host → 409 account_other_brand, no cookie', async () => {
    m.findUnique.mockResolvedValue(storedUser('roboapply'));
    const res = await h.request<{ code: string; details: { otherBrandUrl: string } }>('POST', '/api/v1/roboapply/auth/login', { host: GOAPPLY, body });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account_other_brand');
    expect(res.body.details.otherBrandUrl).toBe('https://www.roboapply.io/login');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('login on the account’s own brand still works', async () => {
    m.findUnique.mockResolvedValue(storedUser('roboapply'));
    const res = await h.request('POST', '/api/v1/roboapply/auth/login', { host: ROBOAPPLY, body });
    expect(res.status).toBe(200);
  });
});
