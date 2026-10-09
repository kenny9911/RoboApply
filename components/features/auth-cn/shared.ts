'use client';

// Client helpers shared by the GoApply sign-in components (WP-11):
//   - phone/code validation mirroring the server contract (+86 only),
//   - a resend countdown,
//   - the signup policy query,
//   - one shared store for the G0 agreement / invite inputs, so the phone
//     form and the WeChat button (rendered side by side by the sign-in page)
//     use a single checkbox instead of two,
//   - error-code → message mapping,
//   - the WeChat in-app browser check (`MicroMessenger`).

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { useTranslations } from 'next-intl';

import { getSignupPolicy } from '../../../lib/api/authCn';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import { RoboApiError } from '../../../lib/api/client';
import type { SignupPolicyResponse } from '../../../lib/api/contracts/auth-cn';

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

export function useSignupPolicy(enabled = true) {
  return useQuery<SignupPolicyResponse>({
    queryKey: SIGNUP_POLICY_KEY,
    queryFn: () => getSignupPolicy(),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** True when CN-0 asks for the separate cross-border consent. */
export function needsCrossBorder(policy: SignupPolicyResponse | undefined): boolean {
  return Boolean(policy?.requiredConsents.some((c) => c.type === 'pipl_cross_border'));
}

/** The consent rows a new account sends (all required types, granted). */
export function consentsFromPolicy(policy: SignupPolicyResponse | undefined): Array<{ type: string; granted: boolean; proseVersion: string }> {
  return (policy?.requiredConsents ?? []).map((c) => ({ type: c.type, granted: true, proseVersion: c.proseVersion }));
}

// ── Shared G0 inputs ────────────────────────────────────────────────────

export interface SignupInputs {
  agreed: boolean;
  crossBorder: boolean;
  invite: string;
  /** Which component renders the checkboxes (the first one to claim it). */
  host: 'phone' | 'wechat' | null;
}

let inputs: SignupInputs = { agreed: false, crossBorder: false, invite: '', host: null };
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
    inputs = { agreed: false, crossBorder: false, invite: '', host: null };
    emit();
  },
};

export function useSignupInputs(): [SignupInputs, (patch: Partial<SignupInputs>) => void] {
  const value = useSyncExternalStore(signupInputs.subscribe, signupInputs.get, signupInputs.get);
  return [value, signupInputs.set];
}

/** The agreement is satisfied when the box is ticked, plus the cross-border box in CN-0. */
export function agreementSatisfied(value: SignupInputs, policy: SignupPolicyResponse | undefined): boolean {
  return value.agreed && (!needsCrossBorder(policy) || value.crossBorder);
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
  if (code && KNOWN.has(code)) return t(`errors.${code}`);
  if (err instanceof RoboApiError && err.code === 'network_error') return t('errors.network');
  return t('errors.generic');
}

/** Message for an error code carried in a URL (`/auth/callback/wechat?result=error&code=`). */
export function codeMessage(code: string | null | undefined, t: T): string {
  return code && KNOWN.has(code) ? t(`errors.${code}`) : t('errors.generic');
}

/** True for `403 phone_binding_required` (AI features need a bound phone). */
export function isPhoneBindingRequired(err: unknown): boolean {
  return apiErrorCode(err) === 'phone_binding_required';
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
