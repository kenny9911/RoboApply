// server/src/features/account-v2/challengeResponse.ts
//
// How a sign-in route answers when the account has two-step sign-in on
// (F-TRUST-07). Every route that mints a seeker session calls the gate
// (loginChallenge.ts) and, on `kind: 'challenge'`, answers with one of these:
// the same answer whichever way the person signed in.
//
//   JSON routes     401 `two_factor_required`, details { next, methods,
//                   expiresInSec }, and the short-lived httpOnly challenge
//                   cookie (`ra_2fa`). No session cookie, token or JWT.
//   redirect routes 302 to /login/2fa (with the place to continue to) and
//                   the same cookie.
//   gate failed     503 `two_factor_unavailable` (sign-in fails closed).
//
// POST /auth/login/2fa (roboapply/routes/auth.ts) reads the cookie and mints
// the real session after a valid code.

import type { Request, Response } from 'express';
import { buildClearCookieOptions, buildCookieOptions } from '../../lib/cookieOptions.js';
import { ACCOUNT_V2_ERROR_CODES } from './contract.js';
import { CHALLENGE_COOKIE } from './loginChallenge.js';

/** The challenge cookie is sent only to the auth routes. */
export const CHALLENGE_COOKIE_PATH = '/api/v1/roboapply/auth';
/** The web page that asks for the code. */
export const TWO_FACTOR_PAGE = '/login/2fa';
export const TWO_FACTOR_UNAVAILABLE_CODE = 'two_factor_unavailable';

const REQUIRED_MESSAGE = 'Enter the code from your authenticator app to finish signing in.';
const UNAVAILABLE_MESSAGE = 'Sign-in is not available right now. Try again in a minute.';

export interface IssuedChallenge {
  token: string;
  expiresInSec: number;
}

/** A same-site path or null (never an absolute or protocol-relative URL). */
function safeNext(next: string | null | undefined): string | null {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && next.length <= 512 ? next : null;
}

/** `/login/2fa`, carrying where to continue to after the code. */
export function twoFactorPagePath(next?: string | null): string {
  const to = safeNext(next);
  return to ? `${TWO_FACTOR_PAGE}?next=${encodeURIComponent(to)}` : TWO_FACTOR_PAGE;
}

export function setChallengeCookie(req: Request, res: Response, challenge: IssuedChallenge): void {
  res.cookie(
    CHALLENGE_COOKIE,
    challenge.token,
    buildCookieOptions(req, { sameSite: 'lax', maxAge: challenge.expiresInSec * 1000, path: CHALLENGE_COOKIE_PATH }),
  );
}

export function clearChallengeCookie(req: Request, res: Response): void {
  res.clearCookie(CHALLENGE_COOKIE, buildClearCookieOptions(req, { path: CHALLENGE_COOKIE_PATH }));
}

export interface TwoFactorRequiredBody {
  success: false;
  code: typeof ACCOUNT_V2_ERROR_CODES.twoFactorRequired;
  error: string;
  details: { next: string; methods: Array<'totp' | 'recovery'>; expiresInSec: number };
}

export function twoFactorRequiredBody(challenge: IssuedChallenge, next?: string | null): TwoFactorRequiredBody {
  return {
    success: false,
    code: ACCOUNT_V2_ERROR_CODES.twoFactorRequired,
    error: REQUIRED_MESSAGE,
    details: { next: twoFactorPagePath(next), methods: ['totp', 'recovery'], expiresInSec: challenge.expiresInSec },
  };
}

/** JSON answer: the challenge cookie and 401 `two_factor_required`. */
export function sendTwoFactorRequired(req: Request, res: Response, challenge: IssuedChallenge, next?: string | null): void {
  setChallengeCookie(req, res, challenge);
  res.status(401).json(twoFactorRequiredBody(challenge, next));
}

/** Redirect answer: the challenge cookie and 302 to the code page. */
export function redirectToTwoFactor(req: Request, res: Response, challenge: IssuedChallenge, next?: string | null): void {
  setChallengeCookie(req, res, challenge);
  res.redirect(302, twoFactorPagePath(next));
}

/** The gate itself could not run: nobody is signed in. */
export function sendTwoFactorUnavailable(res: Response): void {
  res.status(503).json({ success: false, code: TWO_FACTOR_UNAVAILABLE_CODE, error: UNAVAILABLE_MESSAGE });
}

/**
 * Thrown by a session helper that cannot answer the request itself (auth-cn
 * `issueSessionCookie`): the route turns it into one of the answers above.
 */
export class TwoFactorChallengeError extends Error {
  readonly code = ACCOUNT_V2_ERROR_CODES.twoFactorRequired;
  readonly status = 401;
  constructor(readonly challenge: IssuedChallenge) {
    super(REQUIRED_MESSAGE);
    this.name = 'TwoFactorChallengeError';
  }
}

/** Thrown when the second-factor check could not run (fail closed). */
export class TwoFactorUnavailableError extends Error {
  readonly code = TWO_FACTOR_UNAVAILABLE_CODE;
  readonly status = 503;
  constructor(cause?: unknown) {
    super(UNAVAILABLE_MESSAGE);
    this.name = 'TwoFactorUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
