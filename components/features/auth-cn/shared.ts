'use client';

// Client helpers shared by the GoApply sign-in components (WP-11):
//   - phone/code validation mirroring the server contract (+86 only),
//   - a resend countdown,
//   - the signup policy query,
//   - one shared store for the G0 agreement / invite inputs, so the phone
//     form, the WeChat button and the email form (rendered together by the
//     sign-in page) use one set of boxes instead of three. There is one box
//     per required consent, and the text beside it is the text the sign-up
//     policy serves (compliance catalog prose), shown verbatim: every form
//     sends that text's hash back, so the stored consent record names
//     exactly what was on screen (INT-01; phone and WeChat since Wave FIX),
//   - error-code → message mapping,
//   - the WeChat in-app browser check (`MicroMessenger`),
//   - the two codes a sign-up link can carry: the invite-friends code
//     (`?ref=`, from /r/<code>) that says who invited the visitor, and the
//     access code (`?invite=`) that the invite field asks for while sign-up
//     is invite-only.
//
// Wire shapes (audited against the server, INT-01): the auth-cn routes and
// the `requirePhoneBound()` gate write their reason in `code`
// (`invite_invalid`, `phone_binding_required`, …; features/auth-cn/errors.ts),
// and other areas that pass an auth-cn error through keep it there. Areas
// that wrap a reason in a platform code put it in `details.reason`, so
// `isPhoneBindingRequired` reads both.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, type useTranslations } from 'next-intl';

import { getSignupPolicy } from '../../../lib/api/authCn';
import { apiErrorCode, apiErrorDetails, apiErrorReason } from '../../../lib/api/contracts/wire';
import { RoboApiError } from '../../../lib/api/client';
import type { SignupPolicyConsent, SignupPolicyResponse } from '../../../lib/api/contracts/auth-cn';

/** Same rule as the server (`CN_MOBILE_RE`): 11 digits starting 1[3-9], optional +86. */
export const CN_MOBILE_INPUT_RE = /^(\+86)?1[3-9]\d{9}$/;
export const OTP_RE = /^\d{6}$/;

export function normalizePhoneInput(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

export function isValidCnPhone(raw: string): boolean {
  return CN_MOBILE_INPUT_RE.test(normalizePhoneInput(raw));
}

/** `13812345678` → `138****5678` for messages. */
export function maskPhoneInput(raw: string): string {
  const n = normalizePhoneInput(raw).replace(/^\+86/, '');
  return n.length === 11 ? `${n.slice(0, 3)}****${n.slice(7)}` : n;
}

/** Seconds left before another code may be requested. */
export function useCountdown(): { left: number; start: (seconds: number) => void } {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until, now]);
  const start = useCallback((seconds: number) => {
    const t = Date.now();
    setNow(t);
    setUntil(t + seconds * 1000);
  }, []);
  return { left: Math.max(0, Math.ceil((until - now) / 1000)), start };
}

export const SIGNUP_POLICY_KEY = ['authCn', 'signupPolicy'] as const;

/** The policy in the language the page is read in (it decides which consent text is served). */
export function useSignupPolicy(enabled = true) {
  const locale = useLocale();
  return useQuery<SignupPolicyResponse>({
    queryKey: [...SIGNUP_POLICY_KEY, locale],
    queryFn: () => getSignupPolicy(locale),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * The key a tick is remembered under: the consent and the text it was given
 * for. When the served text changes (a new hash), the box is unticked again.
 */
export function consentKey(consent: SignupPolicyConsent): string {
  return consent.prose ? `${consent.type}:${consent.prose.hash}` : consent.type;
}

/** The required consents the form can show: every one has its text. Empty while the policy loads. */
export function shownConsents(policy: SignupPolicyResponse | undefined): SignupPolicyConsent[] {
  const required = policy?.requiredConsents ?? [];
  return required.every((c) => c.prose?.text) ? required : [];
}

/**
 * The consent rows every sign-up form sends (phone, WeChat and email): each
 * required consent with the version and hash of the text shown beside its
 * box. The server writes the record only when that hash is the hash of a text
 * it serves, so the stored consent names exactly what was on screen and the
 * consent ledger can later tell whether the text has changed since.
 */
export function shownConsentsFromPolicy(
  policy: SignupPolicyResponse | undefined,
): Array<{ type: string; granted: boolean; proseVersion: string; proseHash: string }> {
  return shownConsents(policy).map((c) => ({ type: c.type, granted: true, proseVersion: c.prose!.version, proseHash: c.prose!.hash }));
}

// ── Shared G0 inputs ────────────────────────────────────────────────────

export interface SignupInputs {
  /** Ticked boxes by `consentKey` (never pre-ticked). */
  granted: Record<string, boolean>;
  invite: string;
  /** Which component renders the checkboxes (`useSignupInputsHost`). */
  host: 'phone' | 'wechat' | 'email' | null;
}

let inputs: SignupInputs = { granted: {}, invite: '', host: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const signupInputs = {
  get: (): SignupInputs => inputs,
  set(patch: Partial<SignupInputs>) {
    inputs = { ...inputs, ...patch };
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Tests and unmounts: back to unchecked. */
  reset() {
    inputs = { granted: {}, invite: '', host: null };
    emit();
  },
};

export function useSignupInputs(): [SignupInputs, (patch: Partial<SignupInputs>) => void] {
  const value = useSyncExternalStore(signupInputs.subscribe, signupInputs.get, signupInputs.get);
  return [value, signupInputs.set];
}

type SignupInputsHost = NonNullable<SignupInputs['host']>;

/**
 * Who renders the one set of boxes when several askers are on the page: a
 * form before the WeChat button, and the phone form (which needs them for
 * sign-in too) before the email form.
 */
const HOST_RANK: Record<SignupInputsHost, number> = { wechat: 1, email: 2, phone: 3 };

/**
 * Asks to render the shared agreement boxes (and the invite field). Returns
 * true while `who` holds the role. One set of boxes per page: the role goes to
 * the highest-ranked asker that is mounted, whatever the order the components
 * mount in, and moves on when that component leaves (a tab change on the
 * sign-in card). A component that leaves while holding the role clears the
 * ticks, so a box is never found ticked by a page opened later.
 */
export function useSignupInputsHost(who: SignupInputsHost, wanted = true): boolean {
  const [value] = useSignupInputs();
  useEffect(() => {
    if (!wanted) return;
    const current = signupInputs.get().host;
    if (current === who) return;
    if (current === null || HOST_RANK[current] < HOST_RANK[who]) {
      signupInputs.set({ host: who });
      // An access code in the link (`?invite=`) starts the invite field.
      prefillAccessCode();
    }
  }, [wanted, who, value.host]);
  useEffect(() => {
    if (!wanted) return undefined;
    return () => {
      if (signupInputs.get().host === who) signupInputs.reset();
    };
  }, [wanted, who]);
  return wanted && value.host === who;
}

/** Satisfied when the policy has loaded with its texts and every required box is ticked for the text now shown. */
export function agreementSatisfied(value: SignupInputs, policy: SignupPolicyResponse | undefined): boolean {
  const shown = shownConsents(policy);
  return Boolean(policy) && shown.length === (policy?.requiredConsents.length ?? 0) && shown.every((c) => value.granted[consentKey(c)] === true);
}

/** `422 consent_required` because the consent text changed (or its hash was not sent): reload the text and ask again. */
export function isConsentOutdated(err: unknown): boolean {
  if (apiErrorCode(err) !== 'consent_required') return false;
  const outdated = apiErrorDetails<{ outdated?: unknown }>(err)?.outdated;
  return Array.isArray(outdated) && outdated.length > 0;
}

// ── Errors ──────────────────────────────────────────────────────────────

type T = ReturnType<typeof useTranslations>;

const KNOWN = new Set([
  'otp_invalid',
  'otp_expired',
  'otp_locked',
  'rate_limited',
  'sms_daily_cap',
  'sms_send_failed',
  'invite_invalid',
  'signup_closed',
  'consent_required',
  'phone_taken',
  'phone_mismatch',
  'identity_proof_invalid',
  'phone_binding_required',
  'oauth_state_invalid',
  'wechat_failed',
  'wechat_denied',
  'feature_disabled',
  'forbidden',
  'unauthorized',
]);

/** A localized message for a failed call (`t` bound to the `authCn` namespace). */
export function errorMessage(err: unknown, t: T): string {
  const code = apiErrorCode(err);
  const details = apiErrorDetails<{ attemptsLeft?: number | null; retryAfterSec?: number; missing?: unknown }>(err) ?? {};
  if (code === 'otp_invalid' && typeof details.attemptsLeft === 'number') return t('errors.otp_invalid_left', { count: details.attemptsLeft });
  if (code === 'otp_locked') return t('errors.otp_locked', { minutes: Math.max(1, Math.ceil((details.retryAfterSec ?? 1800) / 60)) });
  if (code === 'rate_limited') return t('errors.rate_limited', { seconds: Math.max(1, Math.ceil(details.retryAfterSec ?? 60)) });
  if (code === 'invite_invalid' && details.missing === true) return t('errors.invite_missing');
  if (isConsentOutdated(err)) return t('errors.consent_outdated');
  if (code && KNOWN.has(code)) return t(`errors.${code}`);
  if (err instanceof RoboApiError && err.code === 'network_error') return t('errors.network');
  return t('errors.generic');
}

/** Message for an error code carried in a URL (`/auth/callback/wechat?result=error&code=`). */
export function codeMessage(code: string | null | undefined, t: T): string {
  return code && KNOWN.has(code) ? t(`errors.${code}`) : t('errors.generic');
}

/**
 * True for `403 phone_binding_required` (AI features need a bound phone):
 * the auth-cn code, or the same reason under a platform code
 * (`{ code: 'forbidden', details: { reason: 'phone_binding_required' } }`).
 */
export function isPhoneBindingRequired(err: unknown): boolean {
  return apiErrorCode(err) === 'phone_binding_required' || apiErrorReason(err) === 'phone_binding_required';
}

/** True for `422 invite_invalid` (a missing, used, expired or unknown access code), in either wire shape. */
export function isInviteInvalid(err: unknown): boolean {
  return apiErrorCode(err) === 'invite_invalid' || apiErrorReason(err) === 'invite_invalid';
}

// ── Codes carried by a sign-up link ─────────────────────────────────────

/** An invite-friends code: 8 characters of Crockford base32, dashes and spaces allowed (server twin: growth/referralCodes.ts). */
const FRIEND_CODE_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{8}$/;

function looksLikeFriendCode(value: string): boolean {
  return FRIEND_CODE_RE.test(value.replace(/[\s-]/g, ''));
}

type Query = { get(name: string): string | null } | null | undefined;

/**
 * What a GoApply sign-up link carries:
 *   - `ref`: the invite-friends code (`?ref=<code>`; `?invite=<code>` when it
 *     reads as one). Sent with the sign-up so the friend who shared the link
 *     is credited; the server checks it and ignores anything else.
 *   - `accessCode`: an access code in `?invite=` (the other shape; needed
 *     only while sign-up is invite-only), offered as the starting value of
 *     the invite field.
 */
export function signupLinkCodes(query: Query): { ref: string | null; accessCode: string | null } {
  const ref = (query?.get('ref') ?? '').trim().slice(0, 64);
  const invite = (query?.get('invite') ?? '').trim().slice(0, 64);
  if (invite && looksLikeFriendCode(invite)) return { ref: ref || invite, accessCode: null };
  return { ref: ref || null, accessCode: /^[0-9A-Za-z-]{4,32}$/.test(invite) ? invite.toUpperCase() : null };
}

/** `signupLinkCodes` for the current address (client only; nulls during SSR). */
export function currentSignupLinkCodes(): { ref: string | null; accessCode: string | null } {
  if (typeof window === 'undefined') return { ref: null, accessCode: null };
  return signupLinkCodes(new URLSearchParams(window.location.search));
}

/** Put an access code from the link into the shared invite field, unless the visitor already typed one. */
export function prefillAccessCode(): void {
  const { accessCode } = currentSignupLinkCodes();
  if (accessCode && !signupInputs.get().invite) signupInputs.set({ invite: accessCode });
}

// ── WeChat in-app browser ───────────────────────────────────────────────

/** WeChat's built-in browser identifies itself with `MicroMessenger`. */
export function isWechatBrowser(userAgent?: string | null): boolean {
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /MicroMessenger/i.test(ua);
}

/** Client-only check (false during SSR, then the real value after mount). */
export function useIsWechatBrowser(): boolean {
  const [inWechat, setInWechat] = useState(false);
  useEffect(() => setInWechat(isWechatBrowser()), []);
  return inWechat;
}

/** A same-site relative path or null. */
export function safeNextPath(next: string | null | undefined): string | null {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : null;
}
