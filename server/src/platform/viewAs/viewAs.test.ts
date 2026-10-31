// @vitest-environment node
//
// Admin "view as" grants (platform/viewAs): signed with a key derived from
// JWT_SECRET, bound to one admin session, short-lived, and never
// interchangeable with a sign-in token.
import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  VIEW_AS_READ_POSTS,
  VIEW_AS_TTL_SECONDS,
  isAdminAccount,
  isReadOnlyMethod,
  isViewAsRead,
  requestSessionToken,
  requestViewAsToken,
  sessionFingerprint,
  signViewAsGrant,
  verifyViewAsGrant,
  viewAsAvailable,
  viewAsCookieOptions,
} from './index.js';

const ENV = { NODE_ENV: 'test', JWT_SECRET: 'test-secret' };
const NOW = new Date('2026-10-21T10:00:00Z');
const input = { adminId: 'admin1', subjectUserId: 'user1', sessionToken: 'session-abc' };

describe('signViewAsGrant / verifyViewAsGrant', () => {
  it('round-trips a grant bound to the admin session, valid for the TTL', () => {
    const signed = signViewAsGrant(input, { env: ENV, now: NOW })!;
    expect(signed.grant).toEqual({
      adminId: 'admin1',
      subjectUserId: 'user1',
      sid: sessionFingerprint('session-abc'),
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + VIEW_AS_TTL_SECONDS,
    });
    expect(verifyViewAsGrant(signed.token, { env: ENV, now: NOW })).toEqual(signed.grant);
    const almost = new Date(NOW.getTime() + (VIEW_AS_TTL_SECONDS - 1) * 1000);
    expect(verifyViewAsGrant(signed.token, { env: ENV, now: almost })).not.toBeNull();
  });

  it('refuses an expired grant', () => {
    const signed = signViewAsGrant(input, { env: ENV, now: NOW })!;
    const later = new Date(NOW.getTime() + (VIEW_AS_TTL_SECONDS + 1) * 1000);
    expect(verifyViewAsGrant(signed.token, { env: ENV, now: later })).toBeNull();
  });

  it('refuses a grant signed with another secret, or edited', () => {
    const signed = signViewAsGrant(input, { env: ENV, now: NOW })!;
    expect(verifyViewAsGrant(signed.token, { env: { ...ENV, JWT_SECRET: 'other' }, now: NOW })).toBeNull();
    const [head, , sig] = signed.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...signed.grant, subjectUserId: 'someone-else' })).toString('base64url');
    expect(verifyViewAsGrant(`${head}.${forged}.${sig}`, { env: ENV, now: NOW })).toBeNull();
    expect(verifyViewAsGrant('not-a-token', { env: ENV, now: NOW })).toBeNull();
    expect(verifyViewAsGrant('', { env: ENV, now: NOW })).toBeNull();
  });

  it('is never a sign-in token, and a sign-in token is never a grant', () => {
    // A sign-in JWT is signed with JWT_SECRET itself; grants use a derived key and their own audience.
    const signIn = jwt.sign({ userId: 'admin1', email: 'a@example.test', adminId: 'admin1', subjectUserId: 'user1', sid: 'x' }, ENV.JWT_SECRET);
    expect(verifyViewAsGrant(signIn, { env: ENV })).toBeNull();
    const signed = signViewAsGrant(input, { env: ENV })!;
    expect(() => jwt.verify(signed.token, ENV.JWT_SECRET)).toThrow();
  });

  it('is off in production without JWT_SECRET (never signed with the development secret)', () => {
    const prod = { NODE_ENV: 'production' };
    expect(viewAsAvailable(prod)).toBe(false);
    expect(signViewAsGrant(input, { env: prod })).toBeNull();
    const devSigned = signViewAsGrant(input, { env: { NODE_ENV: 'development' } })!;
    expect(verifyViewAsGrant(devSigned.token, { env: prod })).toBeNull();
    expect(viewAsAvailable({ NODE_ENV: 'production', JWT_SECRET: 's' })).toBe(true);
  });
});

describe('helpers', () => {
  it('fingerprints a session token one way and stably', () => {
    expect(sessionFingerprint('abc')).toBe(sessionFingerprint('abc'));
    expect(sessionFingerprint('abc')).not.toBe(sessionFingerprint('abd'));
    expect(sessionFingerprint('abc')).toHaveLength(32);
    expect(sessionFingerprint('abc')).not.toContain('abc');
  });

  it('treats only GET, HEAD and OPTIONS as reads', () => {
    for (const m of ['GET', 'head', 'OPTIONS']) expect(isReadOnlyMethod(m)).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']) expect(isReadOnlyMethod(m)).toBe(false);
  });

  it('lets through only the listed reads sent as POST, by exact path', () => {
    expect(isViewAsRead('GET', '/api/v1/roboapply/feed/jobs/1')).toBe(true);
    expect(isViewAsRead('POST', '/api/v1/roboapply/feed/query')).toBe(true);
    expect(isViewAsRead('POST', '/api/v1/roboapply/feed/query/?x=1')).toBe(true);
    expect(isViewAsRead('POST', '/api/v1/roboapply/search-profiles/count')).toBe(true);
    for (const path of ['/api/v1/roboapply/feed/jobs/1/hide', '/api/v1/roboapply/feed/query-x', '/api/v1/roboapply/feed/impressions', '/api/v1/public/events', '/api/v1/roboapply/search-profiles']) {
      expect(isViewAsRead('POST', path)).toBe(false);
    }
    expect(isViewAsRead('PUT', '/api/v1/roboapply/feed/query')).toBe(false);
    expect(VIEW_AS_READ_POSTS.every((p) => p.startsWith('/api/v1/'))).toBe(true);
  });

  it('recognises admin accounts by role or roles', () => {
    expect(isAdminAccount({ role: 'admin' })).toBe(true);
    expect(isAdminAccount({ role: 'seeker', roles: ['seeker', 'admin'] })).toBe(true);
    expect(isAdminAccount({ role: 'seeker', roles: ['seeker'] })).toBe(false);
    expect(isAdminAccount({})).toBe(false);
  });

  it('reads the grant and the session token from the request', () => {
    expect(requestViewAsToken({ cookies: { ra_view_as: 'g' }, headers: {} })).toBe('g');
    expect(requestViewAsToken({ cookies: {}, headers: {} })).toBeNull();
    expect(requestSessionToken({ cookies: { ra_session_token: 's' }, headers: { 'x-session-token': 'h' } })).toBe('s');
    expect(requestSessionToken({ cookies: {}, headers: { 'x-session-token': 'h' } })).toBe('h');
    expect(requestSessionToken({ headers: {} })).toBeNull();
  });

  it('sets an httpOnly cookie that ends with the grant', () => {
    const options = viewAsCookieOptions({ headers: { host: 'localhost:3611' } });
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', maxAge: VIEW_AS_TTL_SECONDS * 1000 });
    expect(viewAsCookieOptions()).toMatchObject({ httpOnly: true, maxAge: VIEW_AS_TTL_SECONDS * 1000 });
  });
});
