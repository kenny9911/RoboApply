// server/src/features/auth/errors.ts
//
// Area error for the auth surface (WP-10). The shared envelope's ErrorCode
// list (platform/http.ts) covers the cross-area codes; auth adds a few of its
// own (`age_consent_required`, `token_expired`, `last_identity`, …) that the
// client maps to specific copy. `AuthError` carries one of those codes and
// its HTTP status; `authRoute()` writes it as the usual envelope and hands
// everything else to `route()`'s mapping.

import type { Request, RequestHandler, Response } from 'express';
import { route } from '../../platform/http.js';
import type { AuthErrorCode } from './contract.js';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: AuthErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const authErrors = {
  invalidCredentials: () => new AuthError('invalid_credentials', 401, 'Invalid email or password.'),
  tokenInvalid: () => new AuthError('token_invalid', 400, 'This link is not valid.'),
  tokenExpired: () => new AuthError('token_expired', 400, 'This link has expired.'),
  lastIdentity: () => new AuthError('last_identity', 409, 'This is your only way to sign in, so it cannot be removed.'),
  ageConsentRequired: () => new AuthError('age_consent_required', 422, 'Confirm that you are 16 or older.'),
  pdpaConsentRequired: () => new AuthError('pdpa_consent_required', 422, 'Read and accept the personal data notice.'),
  unknownConsent: (type: string) => new AuthError('unknown_consent', 422, `Unknown consent type "${type}".`, { type }),
  weakPassword: () =>
    new AuthError('weak_password', 422, 'Use at least 8 characters with at least one letter and one digit.'),
  oauthStateInvalid: () => new AuthError('oauth_state_invalid', 400, 'This sign-in attempt expired. Start again.'),
  oauthFailed: (reason: string) => new AuthError('oauth_failed', 400, 'Sign-in with this provider did not finish.', { reason }),
  emailUnverified: () => new AuthError('email_unverified', 403, 'Verify your email first.'),
  emailTaken: () => new AuthError('email_taken', 409, 'An account with this email already exists.'),
  accountDisabled: () =>
    new AuthError('account_disabled', 403, 'This account has been suspended. Contact support if you believe this is an error.'),
  accountDeleted: () => new AuthError('account_deleted', 403, 'This account has been deleted.'),
  notSeekerAccount: () => new AuthError('not_a_seeker_account', 403, 'This account is not a job-seeker account.'),
  consentLocked: (type: string) =>
    new AuthError('consent_locked', 422, 'This agreement is part of having an account and cannot be withdrawn here.', { type }),
};

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}

/** `route()` plus AuthError → `{ success:false, code, error, details? }` with its status. */
export function authRoute<T>(
  handler: (req: Request, res: Response) => Promise<T> | T,
  options: { status?: number } = {},
): RequestHandler {
  return route(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      if (isAuthError(err)) {
        const body: Record<string, unknown> = { success: false, code: err.code, error: err.message };
        if (err.details !== undefined) body.details = err.details;
        res.status(err.status).json(body);
        return undefined as T;
      }
      throw err;
    }
  }, options);
}
