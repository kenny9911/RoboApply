// server/src/platform/viewAs/viewAs.ts — admin "view as" (the god's-eye view).
//
// An admin opens the app as one of its users, read-only, to see what that
// person sees (admin console → Users → View as). The admin's own session stays
// as it is; a second httpOnly cookie, `ra_view_as`, carries a short-lived grant
// signed with a key derived from JWT_SECRET, so a grant is never a valid
// sign-in token and a sign-in token is never a grant:
//
//   { adminId, subjectUserId, sid, iat, exp }   sid = fingerprint of the admin's session token
//
// middleware/auth.ts checks the grant on every request against the signed-in
// admin (same id, still an admin, same session) and then answers as the
// person. While a grant is applied:
//   - only reads reach a route: GET, HEAD and OPTIONS, plus the few reads sent
//     as POST (VIEW_AS_READ_POSTS, e.g. the jobs feed query). Anything else is
//     refused with 403 `view_as_read_only` before it runs, so nothing is
//     changed, sent, bought or spent in the person's name;
//   - nothing counts as the person's own activity (lastActiveAt, UserActivity
//     rows, the /auth/me region stamp), and a credit reservation refuses
//     (platform/credits), so a read that would spend fails closed;
//   - the request context carries the grant (`getCurrentViewAs()`) and log
//     lines name both people.
// A grant that no longer holds (expired, another admin, signed out, the person
// gone) is dropped: the cookie is cleared, the answer carries
// `X-RA-View-As: ended`, a read continues as the admin and a write is refused.
// Grants start and end at /api/v1/roboapply/admin/view-as (features/admin),
// each with an RAAdminAuditLog row.

import { createHash, createHmac } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import jwt from 'jsonwebtoken';
import { buildClearCookieOptions, buildCookieOptions, SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import type { EnvSource } from '../brand/brandEnv.js';

/** The grant cookie (httpOnly, next to the session cookie). */
export const VIEW_AS_COOKIE = 'ra_view_as';
/** Response header set when a grant was dropped, so the page can reload as the admin. */
export const VIEW_AS_ENDED_HEADER = 'X-RA-View-As';
/** How long one grant lasts. Start again from the admin console for more. */
export const VIEW_AS_TTL_SECONDS = 60 * 60;

/** The refusal of a write while viewing as someone (403; platform/http `view_as_read_only`). */
export const VIEW_AS_READ_ONLY = {
  code: 'view_as_read_only',
  error: 'You are viewing this account as an admin. View mode is read-only, so nothing was changed.',
} as const;

/** Thrown by code that would act in the viewed person's name (a credit reservation); maps to 403 `view_as_read_only`. */
export class ViewAsReadOnlyError extends Error {
  readonly code = VIEW_AS_READ_ONLY.code;
  readonly status = 403;
  constructor() {
    super(VIEW_AS_READ_ONLY.error);
    this.name = 'ViewAsReadOnlyError';
  }
}

const AUDIENCE = 'roboapply:view-as';
const KEY_LABEL = 'roboapply:view-as:v1';
/** The sign-in tokens' development fallback (roboapply/engine/lib/seekerSession.ts). */
const DEVELOPMENT_SECRET = 'development-secret-change-in-production';

export interface ViewAsGrant {
  adminId: string;
  subjectUserId: string;
  /** Fingerprint of the admin's session token when the grant was issued. */
  sid: string;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
}

/** What a request knows about the grant it runs under (`req.viewAs`, `/auth/me.viewAs`). */
export interface ViewAsOnRequest {
  admin: { id: string; email: string; name: string | null };
  subjectUserId: string;
  startedAt: Date;
  expiresAt: Date;
}

interface Options {
  env?: EnvSource;
  now?: Date;
}

/**
 * The grant signing key, derived from JWT_SECRET. Production without
 * JWT_SECRET has no key: view-as is off rather than signed with a known
 * development secret.
 */
function signingKey(env: EnvSource): string | null {
  const secret = env.JWT_SECRET;
  if (!secret && env.NODE_ENV === 'production') return null;
  return createHmac('sha256', secret || DEVELOPMENT_SECRET).update(KEY_LABEL).digest('hex');
}

/** False when this deployment cannot sign grants (production without JWT_SECRET). */
export function viewAsAvailable(env: EnvSource = process.env): boolean {
  return signingKey(env) !== null;
}

/** A short one-way fingerprint of a session token (never the token itself). */
export function sessionFingerprint(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex').slice(0, 32);
}

/** Sign a grant for `adminId` to view as `subjectUserId` from the session `sessionToken`. Null when view-as is off. */
export function signViewAsGrant(
  input: { adminId: string; subjectUserId: string; sessionToken: string },
  options: Options = {},
): { token: string; grant: ViewAsGrant } | null {
  const key = signingKey(options.env ?? process.env);
  if (!key) return null;
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const grant: ViewAsGrant = {
    adminId: input.adminId,
    subjectUserId: input.subjectUserId,
    sid: sessionFingerprint(input.sessionToken),
    iat,
    exp: iat + VIEW_AS_TTL_SECONDS,
  };
  const token = jwt.sign(
    { adminId: grant.adminId, subjectUserId: grant.subjectUserId, sid: grant.sid, iat, exp: grant.exp },
    key,
    { algorithm: 'HS256', audience: AUDIENCE },
  );
  return { token, grant };
}

/** The grant in `token`, or null when it is forged, expired or malformed. */
export function verifyViewAsGrant(token: string, options: Options = {}): ViewAsGrant | null {
  const key = signingKey(options.env ?? process.env);
  if (!key || !token) return null;
  try {
    const payload = jwt.verify(token, key, {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      clockTimestamp: Math.floor((options.now ?? new Date()).getTime() / 1000),
    });
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : null);
    const adminId = text(p.adminId);
    const subjectUserId = text(p.subjectUserId);
    const sid = text(p.sid);
    if (!adminId || !subjectUserId || !sid || typeof p.iat !== 'number' || typeof p.exp !== 'number') return null;
    return { adminId, subjectUserId, sid, iat: p.iat, exp: p.exp };
  } catch {
    return null;
  }
}

/** Methods that only read. Every other method is refused while a grant is applied. */
export function isReadOnlyMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

/**
 * Reads sent as POST because their filters do not fit in a URL. They still
 * answer while viewing as someone, and their services leave out what would
 * count as the person's own visit (the feed: the "last visit" stamp behind
 * the New badge, and the one-off ingest of a thin saved search). Exact paths.
 */
export const VIEW_AS_READ_POSTS: readonly string[] = [
  '/api/v1/roboapply/feed/query',
  '/api/v1/roboapply/search-profiles/count',
];

/** The request only reads: GET, HEAD or OPTIONS, or a POST in VIEW_AS_READ_POSTS. */
export function isViewAsRead(method: string, path: string): boolean {
  if (isReadOnlyMethod(method)) return true;
  if (method.toUpperCase() !== 'POST') return false;
  const bare = path.split('?')[0]!.replace(/\/+$/, '');
  return VIEW_AS_READ_POSTS.includes(bare);
}

interface RequestLike {
  cookies?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/** The view-as cookie on the request, if any. */
export function requestViewAsToken(req: RequestLike): string | null {
  const token = req.cookies?.[VIEW_AS_COOKIE];
  return typeof token === 'string' && token ? token : null;
}

/** The session token the browser holds (the cookie, else `X-Session-Token`), even when a bearer JWT authenticated the request. */
export function requestSessionToken(req: RequestLike): string | null {
  const cookie = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof cookie === 'string' && cookie) return cookie;
  const header = req.headers['x-session-token'];
  return typeof header === 'string' && header ? header : null;
}

type CookieRequest = Pick<Request, 'headers'> & { brand?: { id?: string } };

/** Set-Cookie options for a grant: httpOnly, the session cookie's domain, gone when the grant ends. */
export function viewAsCookieOptions(req?: CookieRequest): CookieOptions {
  const extra: CookieOptions = { sameSite: 'lax', maxAge: VIEW_AS_TTL_SECONDS * 1000 };
  return req ? buildCookieOptions(req, extra) : buildCookieOptions(extra);
}

/** Options that clear the grant cookie set by `viewAsCookieOptions` for the same host. */
export function clearViewAsCookieOptions(req?: CookieRequest): CookieOptions {
  return req ? buildClearCookieOptions(req) : buildClearCookieOptions();
}

/** A grant names an admin account (role or roles): never viewable, so admin screens never open in someone else's name. */
export function isAdminAccount(user: { role?: unknown; roles?: unknown }): boolean {
  if (user.role === 'admin') return true;
  return Array.isArray(user.roles) && user.roles.includes('admin');
}
