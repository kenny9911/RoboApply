// @vitest-environment node
//
// The WP-79 hook in the legacy password route (server/src/roboapply/routes/
// auth.ts). Acceptance "2FA bypass impossible on login": with two-step
// sign-in on, POST /auth/login sends NO session cookie, NO session token and
// NO JWT, and revokes the session it just minted; only POST /auth/login/2fa
// with a valid factor signs the browser in. Prisma, bcrypt and sessions are
// mocked; the gate runs on memory stores.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  createSession: vi.fn(async () => ({ token: 'minted-session-token' })),
  invalidate: vi.fn(async () => undefined),
  activity: vi.fn(async () => ({ id: 'a1' })),
}));

vi.mock('../../../lib/prisma.js', () => {
  const client = {
    user: { findUnique: m.findUnique },
    seekerProfile: { upsert: vi.fn() },
    userActivity: { create: m.activity },
  };
  return { default: client, prisma: client };
});
vi.mock('bcryptjs', () => ({
  default: { hash: async () => 'hashed', compare: async (pw: string) => pw === 'right-password' },
}));
vi.mock('../../../roboapply/engine/lib/seekerSession.js', () => ({
  createSeekerSession: m.createSession,
  generateJwt: () => 'jwt-token',
  invalidateSeekerSession: m.invalidate,
}));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../middleware/auth.js', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => res.status(401).json({}),
}));
vi.mock('../../../platform/ratelimit/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../platform/ratelimit/index.js')>()),
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../roboapply/engine/services/SeekerProfileService.js', () => ({ default: { getByUserId: vi.fn() } }));
vi.mock('../../../roboapply/engine/middleware/seekerAuth.js', () => ({
  requireSeekerProfile: (_req: unknown, _res: unknown, next: () => void) => next(),
  seekerAuth: [],
}));
vi.mock('../../../roboapply/services/RoboApplyMissionService.js', () => ({ getMissionForUser: vi.fn(async () => null) }));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { getBrand } from '../../../platform/brand/registry.js';
import { createMemoryChallengeStore, type LoginChallengeDeps } from '../loginChallenge.js';
import { SIGN_IN_PATHS } from '../readiness.js';
import { createMemoryTwoFactorStore } from '../store.js';
import { totpAt } from '../totp.js';
import { TwoFactorService } from '../twoFactor.js';

const ROBOAPPLY = 'localhost:3621';
const GOAPPLY = 'goapply.localhost:3621';
const BODY = { email: 'u@example.test', password: 'right-password' };

function storedUser() {
  return {
    id: 'u1',
    email: 'u@example.test',
    name: null,
    role: 'seeker',
    isActive: true,
    passwordHash: 'hashed',
    subscriptionTier: 'free',
    market: 'intl',
    brand: 'roboapply',
    seekerProfile: { id: 'p1', source: 'organic', readinessScore: 0, locale: 'en', deletedAt: null },
  };
}

let now = new Date('2026-10-10T12:00:05Z');
const store = createMemoryTwoFactorStore();
const svc = new TwoFactorService({
  store,
  env: () => ({ TOTP_ENCRYPTION_KEY: 'c'.repeat(64) }),
  now: () => now,
  revokeOtherSessions: async () => undefined,
  qrDataUrl: async () => null,
  signInPaths: SIGN_IN_PATHS.map((p) => ({ ...p, gated: true })),
});
let challenges = createMemoryChallengeStore();
let failGate = false;
let issued = 0;

function deps(): LoginChallengeDeps {
  return {
    twoFactor: {
      requiresChallenge: async (userId) => {
        if (failGate) throw new Error('database unreachable');
        return svc.requiresChallenge(userId);
      },
      checkSecondFactor: (userId, brand, factor) => svc.checkSecondFactor(userId, brand, factor),
    },
    challenges,
    now: () => now,
    invalidateSession: m.invalidate,
    createSession: async () => {
      issued += 1;
      return { token: `second-step-session-${issued}` };
    },
    accountAllowed: async () => true,
    userAttemptAllowed: async () => true,
  };
}

function cookies(res: { headers: Headers }): string[] {
  return res.headers.getSetCookie();
}

function cookieValue(res: { headers: Headers }, name: string): string | null {
  const c = cookies(res).find((x) => x.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(';')[0]!) : null;
}

let h: RouteHarness;
let secret = '';
let recoveryCodes: string[] = [];

beforeAll(async () => {
  const cookieParser = (await import('cookie-parser')).default;
  const auth = await import('../../../roboapply/routes/auth.js');
  auth.setLoginChallengeDepsForTests(deps);
  h = await startRouteHarness({ env: { NODE_ENV: 'development' }, before: [cookieParser()], mounts: [['/api/v1/roboapply/auth', auth.default]] });
});

afterAll(async () => {
  const auth = await import('../../../roboapply/routes/auth.js');
  auth.setLoginChallengeDepsForTests(null);
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  m.findUnique.mockResolvedValue(storedUser());
  challenges = createMemoryChallengeStore();
  failGate = false;
});

async function turnOn() {
  store.rows.clear();
  const enrol = await svc.enrol('u1', getBrand('roboapply'), 'u@example.test');
  secret = enrol.secret;
  recoveryCodes = (await svc.verify('u1', getBrand('roboapply'), totpAt(secret, now), null)).recoveryCodes;
  now = new Date(now.getTime() + 60_000);
}

async function firstStep() {
  return h.request<{ success: boolean; code: string; details?: unknown; data?: unknown }>('POST', '/api/v1/roboapply/auth/login', { host: ROBOAPPLY, body: BODY });
}

describe('POST /auth/login with two-step sign-in off', () => {
  it('signs in as before', async () => {
    store.rows.clear();
    const res = await firstStep();
    expect(res.status).toBe(200);
    expect(cookieValue(res, 'ra_session_token')).toBe('minted-session-token');
    expect(m.invalidate).not.toHaveBeenCalled();
  });
});

describe('POST /auth/login with two-step sign-in on', () => {
  beforeAll(turnOn);

  it('answers 401 two_factor_required: no session cookie, token or JWT; the minted session is revoked', async () => {
    const res = await firstStep();
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'two_factor_required', details: { next: '/login/2fa', methods: ['totp', 'recovery'] } });
    expect(res.text).not.toContain('minted-session-token');
    expect(res.text).not.toContain('jwt-token');
    expect(cookieValue(res, 'ra_session_token')).toBeNull();
    const challenge = cookies(res).find((c) => c.startsWith('ra_2fa='))!;
    expect(challenge).toMatch(/HttpOnly/i);
    expect(challenge).toMatch(/Path=\/api\/v1\/roboapply\/auth/);
    expect(m.invalidate).toHaveBeenCalledWith('minted-session-token');
  });

  it('fails closed (503, no cookie) when the check cannot run', async () => {
    failGate = true;
    const res = await firstStep();
    expect([res.status, res.body.code]).toEqual([503, 'two_factor_unavailable']);
    expect(cookies(res)).toEqual([]);
    expect(m.invalidate).toHaveBeenCalledWith('minted-session-token');
  });

  it('a wrong code does not sign in; the right one does, once', async () => {
    const first = await firstStep();
    const token = cookieValue(first, 'ra_2fa')!;
    const wrong = await h.request<{ code: string; details: { attemptsLeft: number } }>('POST', '/api/v1/roboapply/auth/login/2fa', {
      host: ROBOAPPLY,
      cookies: { ra_2fa: token },
      body: { code: '000000' },
    });
    expect([wrong.status, wrong.body.code, wrong.body.details.attemptsLeft]).toEqual([401, 'totp_invalid', 4]);
    expect(cookieValue(wrong, 'ra_session_token')).toBeNull();

    const ok = await h.request<{ data: { user: { id: string }; token: string; twoFactor: { method: string } } }>('POST', '/api/v1/roboapply/auth/login/2fa', {
      host: ROBOAPPLY,
      cookies: { ra_2fa: token },
      body: { code: totpAt(secret, now) },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ user: { id: 'u1' }, token: 'jwt-token', twoFactor: { method: 'totp' } });
    expect(cookieValue(ok, 'ra_session_token')).toMatch(/^second-step-session-/);
    expect(cookies(ok).some((c) => c.startsWith('ra_2fa=;'))).toBe(true);

    now = new Date(now.getTime() + 30_000);
    const again = await h.request<{ code: string }>('POST', '/api/v1/roboapply/auth/login/2fa', {
      host: ROBOAPPLY,
      cookies: { ra_2fa: token },
      body: { code: totpAt(secret, now) },
    });
    expect([again.status, again.body.code]).toEqual([401, 'two_factor_challenge_invalid']);
  });

  it('accepts a recovery code (body challenge token for cookie-less clients)', async () => {
    const first = await firstStep();
    const res = await h.request<{ data: { twoFactor: { method: string; recoveryCodesLeft: number } } }>('POST', '/api/v1/roboapply/auth/login/2fa', {
      host: ROBOAPPLY,
      body: { recoveryCode: recoveryCodes[0], challengeToken: cookieValue(first, 'ra_2fa') },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.twoFactor).toEqual({ method: 'recovery', recoveryCodesLeft: 9 });
  });

  it('cannot be completed without a challenge, on another brand, or with a bad body', async () => {
    const none = await h.request<{ code: string }>('POST', '/api/v1/roboapply/auth/login/2fa', { host: ROBOAPPLY, body: { code: totpAt(secret, now) } });
    expect([none.status, none.body.code]).toEqual([401, 'two_factor_challenge_invalid']);

    const first = await firstStep();
    const token = cookieValue(first, 'ra_2fa')!;
    const other = await h.request<{ code: string }>('POST', '/api/v1/roboapply/auth/login/2fa', {
      host: GOAPPLY,
      cookies: { ra_2fa: token },
      body: { code: totpAt(secret, now) },
    });
    expect([other.status, other.body.code]).toEqual([401, 'two_factor_challenge_invalid']);

    const both = await h.request('POST', '/api/v1/roboapply/auth/login/2fa', { host: ROBOAPPLY, cookies: { ra_2fa: token }, body: { code: '123456', recoveryCode: recoveryCodes[1] } });
    expect(both.status).toBe(400);
  });
});
