// @vitest-environment node
//
// FND-5 acceptance (R-19 risk): after `mountFeatures`, POST /auth/login,
// POST /auth/signup and GET /auth/me still return exactly the legacy
// responses (same status, body and session cookie) — the feature routers
// mounted after the legacy routers never shadow a live path.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ login: vi.fn(), signup: vi.fn(), activity: vi.fn() }));

vi.mock('../lib/prisma.js', () => ({
  default: {
    userActivity: { create: mocks.activity },
    roboApplyMission: { create: vi.fn() },
    rAResumeVariant: { count: vi.fn(async () => 2) },
    rACareerGoal: { findUnique: vi.fn(async () => ({ preferencesBlob: { onboarding: { completedAt: '2026-10-09' } } })) },
  },
}));
vi.mock('../services/LoggerService.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../middleware/auth.js', () => {
  const requireAuth = function requireAuth(req: any, res: any, next: () => void) {
    if (req.cookies?.ra_session_token !== 'opaque-session-token') {
      res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }
    req.user = { id: 'user1', email: 'u@example.test', role: 'seeker' };
    next();
  };
  return {
    rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAuth,
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});
vi.mock('../roboapply/engine/services/SeekerAuthService.js', () => ({
  default: { login: mocks.login, signup: mocks.signup },
  SeekerAccountDeletedError: class extends Error {},
  SeekerAccountDisabledError: class extends Error {},
  SeekerEmailTakenError: class extends Error {},
  SeekerInvalidCredentialsError: class extends Error {},
  SeekerNotSeekerAccountError: class extends Error {},
  SeekerAccountOtherBrandError: class extends Error {},
}));
vi.mock('../roboapply/engine/services/SeekerProfileService.js', () => ({ default: { getByUserId: vi.fn(async () => ({ id: 'profile1' })) } }));
vi.mock('../roboapply/engine/lib/seekerSession.js', () => ({ invalidateSeekerSession: vi.fn() }));
vi.mock('../roboapply/engine/middleware/seekerAuth.js', async () => {
  const auth = await import('../middleware/auth.js');
  const requireSeekerProfile = (_req: unknown, _res: unknown, next: () => void) => next();
  return { requireSeekerProfile, seekerAuth: [auth.requireAuth, requireSeekerProfile], default: [auth.requireAuth, requireSeekerProfile] };
});

interface Running {
  server: Server;
  base: string;
}

async function listen(app: import('express').Express): Promise<Running> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function buildApp(withFeatures: boolean): Promise<import('express').Express> {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const legacyAuth = (await import('../roboapply/routes/auth.js')).default;
  const { mountFeatures } = await import('./index.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/roboapply/auth', legacyAuth);
  if (withFeatures) mountFeatures(app, { env: { NODE_ENV: 'development' } });
  return app;
}

describe('legacy auth routes keep precedence after mountFeatures', () => {
  let legacyOnly: Running;
  let withFeatures: Running;
  const result = {
    user: { id: 'user1', email: 'u@example.test', role: 'seeker', market: 'intl', locale: 'en' },
    seekerProfile: { id: 'profile1' },
    token: 'jwt-token',
    sessionToken: 'opaque-session-token',
  };

  beforeAll(async () => {
    const { setFlagOverrideLoader } = await import('../platform/flags.js');
    setFlagOverrideLoader(async () => []);
    legacyOnly = await listen(await buildApp(false));
    withFeatures = await listen(await buildApp(true));
    // Loads the whole feature registry once; allow for a busy machine.
  }, 120_000);

  afterAll(async () => {
    const { setFlagOverrideLoader } = await import('../platform/flags.js');
    setFlagOverrideLoader(null);
    await Promise.all(
      [legacyOnly, withFeatures]
        .filter((r): r is Running => Boolean(r))
        .map((r) => new Promise<void>((resolve, reject) => r.server.close((e) => (e ? reject(e) : resolve())))),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.login.mockResolvedValue(result);
    mocks.signup.mockResolvedValue(result);
    mocks.activity.mockResolvedValue({ id: 'a1' });
  });

  async function both(path: string, init: RequestInit = {}) {
    const a = await fetch(`${legacyOnly.base}${path}`, init);
    const b = await fetch(`${withFeatures.base}${path}`, init);
    return { a: { status: a.status, body: await a.text(), cookie: a.headers.get('set-cookie') }, b: { status: b.status, body: await b.text(), cookie: b.headers.get('set-cookie') } };
  }

  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('POST /auth/login returns the legacy response', async () => {
    const { a, b } = await both('/api/v1/roboapply/auth/login', json({ email: 'u@example.test', password: 'test-password' }));
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(JSON.parse(b.body)).toEqual({ success: true, data: { user: result.user, seekerProfile: result.seekerProfile, token: result.token } });
  });

  it('POST /auth/signup returns the legacy response', async () => {
    const { a, b } = await both('/api/v1/roboapply/auth/signup', json({ email: 'u@example.test', password: 'test-password1' }));
    expect(a.status).toBe(201);
    expect(b).toEqual(a);
  });

  it('GET /auth/me returns the legacy response (authenticated and not)', async () => {
    const authed = await both('/api/v1/roboapply/auth/me', { headers: { cookie: 'ra_session_token=opaque-session-token' } });
    expect(authed.a.status).toBe(200);
    expect(authed.b).toEqual(authed.a);
    expect(JSON.parse(authed.b.body)).toMatchObject({ success: true, data: { user: { id: 'user1' }, onboardingState: { completed: true } } });

    const anon = await both('/api/v1/roboapply/auth/me');
    expect(anon.a.status).toBe(401);
    expect(anon.b).toEqual(anon.a);
  });

  it('serves the new feature paths next to the legacy ones', async () => {
    // Served by the feature router (501 while WP-10's stub, its own answer after).
    const methods = await fetch(`${withFeatures.base}/api/v1/roboapply/auth/methods`);
    expect(methods.status).not.toBe(404);
    // Legacy-only app: the new path does not exist at all.
    expect((await fetch(`${legacyOnly.base}/api/v1/roboapply/auth/methods`)).status).toBe(404);
  });
});
