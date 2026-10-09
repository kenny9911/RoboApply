// server/src/features/auth-cn/errors.ts — area error type and the route wrapper.
//
// The platform envelope (platform/http.ts) knows the shared codes; the
// sign-in codes (otp_invalid, phone_binding_required, …) are this area's and
// are written with the same `{ success: false, code, error, details? }` shape.

import type { Request, RequestHandler, Response } from 'express';
import { route } from '../../platform/http.js';
import { AUTH_CN_ERROR_STATUS, type AuthCnErrorCode } from './contract.js';

const DEFAULT_MESSAGES: Record<AuthCnErrorCode, string> = {
  phone_binding_required: 'Bind a phone number to use this feature.',
  otp_invalid: 'The code is not correct.',
  otp_expired: 'The code has expired. Request a new one.',
  otp_locked: 'Too many wrong codes. Try again later.',
  sms_daily_cap: 'Codes are not available right now. Try again later.',
  invite_invalid: 'The invite code is not valid.',
  signup_closed: 'Sign-up is not open yet.',
  consent_required: 'Required agreements were not accepted.',
  phone_taken: 'This number is used by another account.',
  sms_send_failed: 'The code could not be sent. Try again later.',
  oauth_state_invalid: 'The sign-in link expired. Start again.',
  wechat_failed: 'WeChat sign-in did not complete. Try again.',
  identity_proof_invalid: 'The verification did not match.',
  phone_mismatch: 'This is not the number on your account.',
};

export class AuthCnError extends Error {
  readonly status: number;
  constructor(
    readonly code: AuthCnErrorCode,
    readonly details?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AuthCnError';
    this.status = AUTH_CN_ERROR_STATUS[code];
  }
}

export function sendAuthCnError(res: Response, err: AuthCnError): void {
  const retry = err.details && typeof err.details.retryAfterSec === 'number' ? err.details.retryAfterSec : undefined;
  if (retry !== undefined) res.setHeader('Retry-After', String(Math.ceil(retry)));
  res.status(err.status).json({ success: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
}

/** `route()` that also maps AuthCnError (everything else: platform mapping). */
export function cnRoute<T>(handler: (req: Request, res: Response) => Promise<T> | T, options: { status?: number } = {}): RequestHandler {
  return route(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      if (err instanceof AuthCnError) {
        sendAuthCnError(res, err);
        return undefined as T;
      }
      throw err;
    }
  }, options);
}
