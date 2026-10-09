import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { SESSION_COOKIE_NAME as FRONTEND_SESSION_COOKIE_NAME } from '../../../../lib/config.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(), signup: vi.fn(), create: vi.fn(), invalidate: vi.fn(), warn: vi.fn(),
}));
vi.mock('../../lib/prisma.js', () => ({ default: {
  userActivity: { create: mocks.create },
  roboApplyMission: { create: vi.fn() },
  rAResumeVariant: { count: vi.fn(async () => 1) },
  rACareerGoal: { findUnique: vi.fn(async () => ({ preferencesBlob: { onboarding: { completedAt: '2026-10-09' } } })) },
} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { warn: mocks.warn, error: vi.fn() } }));
vi.mock('../../middleware/auth.js', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (req: any, res: any, next: () => void) => {
    if (req.cookies?.ra_session_token !== 'opaque-session-token') return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: 'user1', email: 'u@example.test' };
    next();
  },
}));
vi.mock('../engine/services/SeekerAuthService.js', () => ({
  default: { login: mocks.login, signup: mocks.signup },
  SeekerAccountDeletedError: class extends Error {},
  SeekerAccountDisabledError: class extends Error {},
  SeekerEmailTakenError: class extends Error {},
  SeekerInvalidCredentialsError: class extends Error {},
  SeekerNotSeekerAccountError: class extends Error {},
  SeekerAccountOtherBrandError: class extends Error {},
}));
vi.mock('../engine/services/SeekerProfileService.js', () => ({ default: { getByUserId: vi.fn(async () => ({ id: 'profile1' })) } }));
vi.mock('../engine/lib/seekerSession.js', () => ({ invalidateSeekerSession: mocks.invalidate }));
vi.mock('../engine/middleware/seekerAuth.js', () => ({ requireSeekerProfile: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../services/RoboApplyMissionService.js', () => ({ getMissionForUser: vi.fn(async () => null) }));

describe('auth activity preserves login and /auth/me contracts', () => {
  let server: Server;
  let baseUrl: string;
  const result = {
    user: { id: 'user1', email: 'u@example.test', role: 'seeker', market: 'cn', locale: 'zh-CN' },
    seekerProfile: { id: 'profile1' }, token: 'jwt-token', sessionToken: 'opaque-session-token',
  };

  beforeAll(async () => {
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const router = (await import('./auth.js')).default;
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/roboapply/auth', router);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/roboapply/auth`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.login.mockResolvedValue(result);
    mocks.signup.mockResolvedValue(result);
    mocks.create.mockResolvedValue({ id: 'activity1' });
  });

  async function post(path: string) {
    return fetch(`${baseUrl}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@example.test', password: 'test-password' }),
    });
  }

  it('records successful login and preserves the cookie, JWT, and authenticated /me response', async () => {
    expect(SESSION_COOKIE_NAME).toBe(FRONTEND_SESSION_COOKIE_NAME);
    const login = await post('login');
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ success: true, data: { user: result.user, seekerProfile: result.seekerProfile, token: result.token } });
    expect(login.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=opaque-session-token`);
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'user1', eventType: 'login', path: '/api/v1/roboapply/auth/login',
      sessionId: expect.stringMatching(/^sha256:/),
      metadata: { source: 'server', method: 'POST', statusCode: 200, market: 'cn' },
    }) });
    const me = await fetch(`${baseUrl}/me`, { headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session-token` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ success: true, data: { user: { id: 'user1' }, onboardingState: { completed: true } } });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect((await fetch(`${baseUrl}/me`)).status).toBe(401);
  });

  it('keeps signup separate from returning-user login counts', async () => {
    expect((await post('signup')).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'signup' }) });
  });

  it('does not record rejected credentials as successful logins', async () => {
    const { SeekerInvalidCredentialsError } = await import('../engine/services/SeekerAuthService.js');
    mocks.login.mockRejectedValueOnce(new SeekerInvalidCredentialsError());
    expect((await post('login')).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['SeekerAccountDisabledError', 'SeekerAccountDeletedError', 'SeekerNotSeekerAccountError'] as const)('does not issue a cookie or record a successful login for %s', async (errorType) => {
    const errors = await import('../engine/services/SeekerAuthService.js');
    mocks.login.mockRejectedValueOnce(new errors[errorType]());
    const response = await post('login');
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not break login when analytics cannot be recorded', async () => {
    mocks.create.mockRejectedValueOnce(new Error('analytics unavailable'));
    const response = await post('login');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
