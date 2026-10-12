// @vitest-environment node
//
// Bearer JWT cut-off (INT-01; readiness path `auth.bearerJwt`). A JWT is
// stateless, so signing out sessions does not end it. When two-step sign-in
// is turned on or off, `User.tokensValidAfter` is set; the auth middleware
// then refuses any JWT issued before it:
//   - an old token → 401 (or the request falls back to its session cookie);
//   - a token issued after the cut-off → accepted;
//   - no cut-off (null column) → accepted, as before;
//   - the cut-off cannot be read → refused (fails closed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const m = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUserById: vi.fn(),
  validateSession: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(async () => ({ id: 'u1' })),
}));

vi.mock('../../../services/AuthService.js', () => ({
  default: { verifyToken: m.verifyToken, getUserById: m.getUserById, validateSession: m.validateSession },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: { user: { findUnique: m.findUnique, update: m.update }, apiKey: { findUnique: vi.fn() } } }));
vi.mock('../../../middleware/usageMeter.js', () => ({ withUserUsageLimits: async (u: unknown) => u }));
vi.mock('../../../lib/subscriptionGraceConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/subscriptionGraceConfig.js')>()),
  resolveGraceDaysForUser: async () => 7,
}));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setRequestUserId: vi.fn() },
}));

import {
  isJwtBeforeCutoff,
  optionalAuth,
  requireAuth,
  resetLastActiveTouchesForTests,
  resolveUserFromTokens,
  setTokenCutoffReaderForTests,
} from '../../../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../../../lib/cookieOptions.js';

const CUTOFF = new Date('2026-10-10T12:00:00.500Z');
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const BEFORE = sec('2026-10-10T11:59:00Z');
const AFTER = sec('2026-10-10T12:00:01Z');
const USER = { id: 'u1', email: 'ana@example.test', name: 'Ana', role: 'seeker', isActive: true, subscriptionTier: 'free', lastActiveAt: new Date() };

function call(mw: typeof requireAuth, req: Partial<Request>) {
  const res = { statusCode: 200, body: null as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  res.status = ((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as Response['status'];
  res.json = ((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as Response['json'];
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  const request = { headers: {}, cookies: {}, query: {}, ...req } as Request;
  return mw(request, res as Response, next).then(() => ({ req: request, res, next }));
}

const bearer = (extra: Partial<Request> = {}) => ({ headers: { authorization: 'Bearer jwt-token' }, ...extra }) as Partial<Request>;

beforeEach(() => {
  vi.clearAllMocks();
  resetLastActiveTouchesForTests();
  m.getUserById.mockResolvedValue(USER);
  m.validateSession.mockResolvedValue(null);
  m.findUnique.mockResolvedValue({ tokensValidAfter: CUTOFF });
});

afterEach(() => setTokenCutoffReaderForTests(null));

describe('isJwtBeforeCutoff', () => {
  it('no cut-off → never; before → yes; after → no', () => {
    expect(isJwtBeforeCutoff(BEFORE, null)).toBe(false);
    expect(isJwtBeforeCutoff(BEFORE, undefined)).toBe(false);
    expect(isJwtBeforeCutoff(BEFORE, CUTOFF)).toBe(true);
    expect(isJwtBeforeCutoff(AFTER, CUTOFF)).toBe(false);
    expect(isJwtBeforeCutoff(AFTER, CUTOFF.toISOString())).toBe(false);
  });

  it('is strict: a token from the same second as the cut-off, or without an issue time, is refused', () => {
    expect(isJwtBeforeCutoff(sec('2026-10-10T12:00:00Z'), CUTOFF)).toBe(true);
    expect(isJwtBeforeCutoff(undefined, CUTOFF)).toBe(true);
    expect(isJwtBeforeCutoff(Number.NaN, CUTOFF)).toBe(true);
    // An unreadable cut-off value is no cut-off (the column is a timestamp or null).
    expect(isJwtBeforeCutoff(BEFORE, 'not a date')).toBe(false);
  });
});

describe('requireAuth with a bearer JWT', () => {
  it('rejects a token issued before the cut-off: 401 and no user', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    const { req, res, next } = await call(requireAuth, bearer());
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_TOKEN' });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    // The cut-off is read fresh by primary key, one column.
    expect(m.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { tokensValidAfter: true } });
  });

  it('accepts a token issued after the cut-off', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: AFTER });
    const { req, res, next } = await call(requireAuth, bearer());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(req.user).toMatchObject({ id: 'u1' });
  });

  it('accepts any token while the column is null (no cut-off), and for a user row that has none', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    m.findUnique.mockResolvedValue({ tokensValidAfter: null });
    expect((await call(requireAuth, bearer())).next).toHaveBeenCalledTimes(1);
    m.findUnique.mockResolvedValue(null);
    expect((await call(requireAuth, bearer())).next).toHaveBeenCalledTimes(1);
  });

  it('an old token falls back to the session cookie of the same request (the browser that made the change stays signed in)', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    m.validateSession.mockResolvedValue({ ...USER, passwordHash: 'h' });
    const { req, next } = await call(requireAuth, bearer({ cookies: { [SESSION_COOKIE_NAME]: 'kept-session' } }));
    expect(m.validateSession).toHaveBeenCalledWith('kept-session');
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sessionToken).toBe('kept-session');
    expect(req.user).toMatchObject({ id: 'u1' });
    expect(req.user).not.toHaveProperty('passwordHash');
  });

  it('an old token with a dead session is still refused', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    const { res, next } = await call(requireAuth, bearer({ cookies: { [SESSION_COOKIE_NAME]: 'revoked' } }));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('an old token in `?token=` is refused too', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    const { res, next } = await call(requireAuth, { query: { token: 'jwt-token' } as Request['query'] });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when the cut-off cannot be read', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: AFTER });
    m.findUnique.mockRejectedValue(new Error('db down'));
    const { res, next } = await call(requireAuth, bearer());
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('a session cookie alone is not affected by the cut-off (sessions are revoked on their own)', async () => {
    m.validateSession.mockResolvedValue({ ...USER, passwordHash: 'h' });
    const { next } = await call(requireAuth, { cookies: { [SESSION_COOKIE_NAME]: 'live-session' } });
    expect(next).toHaveBeenCalledTimes(1);
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it('a token for a user that no longer exists does not fall back to a session', async () => {
    m.verifyToken.mockReturnValue({ userId: 'gone', email: 'x@example.test', iat: AFTER });
    m.getUserById.mockResolvedValue(null);
    m.validateSession.mockResolvedValue({ ...USER, passwordHash: 'h' });
    const { res } = await call(requireAuth, bearer({ cookies: { [SESSION_COOKIE_NAME]: 'someone-else' } }));
    expect(res.statusCode).toBe(401);
    expect(m.validateSession).not.toHaveBeenCalled();
  });
});

describe('the other JWT readers apply the same cut-off', () => {
  it('optionalAuth: an old token is anonymous; a new one is the user', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    const old = await call(optionalAuth, bearer());
    expect(old.next).toHaveBeenCalledTimes(1);
    expect(old.req.user).toBeUndefined();
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: AFTER });
    expect((await call(optionalAuth, bearer())).req.user).toMatchObject({ id: 'u1' });
  });

  it('resolveUserFromTokens (WebSocket upgrade): an old token resolves nobody', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    expect(await resolveUserFromTokens({ authorizationHeader: 'Bearer jwt-token' })).toBeNull();
    expect(await resolveUserFromTokens({ queryToken: 'jwt-token' })).toBeNull();
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: AFTER });
    expect(await resolveUserFromTokens({ authorizationHeader: 'Bearer jwt-token' })).toMatchObject({ user: { id: 'u1' } });
  });

  it('the reader can be replaced (tests) and restored', async () => {
    m.verifyToken.mockReturnValue({ userId: 'u1', email: USER.email, iat: BEFORE });
    setTokenCutoffReaderForTests(async () => null);
    expect((await call(requireAuth, bearer())).next).toHaveBeenCalledTimes(1);
    expect(m.findUnique).not.toHaveBeenCalled();
    setTokenCutoffReaderForTests(null);
    expect((await call(requireAuth, bearer())).res.statusCode).toBe(401);
  });
});
