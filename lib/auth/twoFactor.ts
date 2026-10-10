// lib/auth/twoFactor.ts — the second step of signing in (F-TRUST-07).
//
// Every sign-in route (password, password reset, email link, Google / LINE,
// phone code, WeChat) answers 401 `two_factor_required` when the account has
// two-step sign-in on: no session exists yet, and an httpOnly challenge
// cookie is set. The form that got that answer sends the person to
// /login/2fa, carrying where they were going.

import { RoboApiError } from '../api/client';
import { safeNext } from './entry';

export const TWO_FACTOR_PAGE = '/login/2fa';
export const TWO_FACTOR_REQUIRED_CODE = 'two_factor_required';

interface Payload {
  code?: unknown;
  details?: { next?: unknown } | null;
}

/** True for the 401 `two_factor_required` answer of a sign-in call. */
export function isTwoFactorRequired(err: unknown): boolean {
  if (!(err instanceof RoboApiError)) return false;
  return (err.payload as Payload | undefined)?.code === TWO_FACTOR_REQUIRED_CODE;
}

/**
 * The code page to go to after `two_factor_required`. The server's
 * `details.next` is used only when it is the code page itself; the place to
 * continue to comes from it when present (the server knows the onboarding
 * screen or the job the person was opening), else from `fallbackNext`.
 * Always a same-site path.
 */
export function twoFactorHref(err: unknown, fallbackNext?: string | null): string {
  let next: string | null = null;
  if (err instanceof RoboApiError) {
    const raw = (err.payload as Payload | undefined)?.details?.next;
    if (typeof raw === 'string' && (raw === TWO_FACTOR_PAGE || raw.startsWith(`${TWO_FACTOR_PAGE}?`))) {
      next = safeNext(new URLSearchParams(raw.slice(TWO_FACTOR_PAGE.length + 1)).get('next'));
    }
  }
  const to = next ?? safeNext(fallbackNext);
  return to ? `${TWO_FACTOR_PAGE}?next=${encodeURIComponent(to)}` : TWO_FACTOR_PAGE;
}
