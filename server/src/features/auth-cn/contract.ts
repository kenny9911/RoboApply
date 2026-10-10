// server/src/features/auth-cn/contract.ts
//
// GoApply sign-in: phone OTP, WeChat (web QR, 公众号 in-app, mini-program
// API), bind/change phone, invite codes (ARCHITECTURE.md §3.2; TASK_PLAN.md
// WP-11; PRODUCT_PLAN.md G0). Mounts: /auth/phone, /auth/wechat and the
// admin router /admin/auth-cn. Each route checks its capability
// (`auth.phoneOtp`, `auth.wechatWeb`, `auth.wechatInApp`, `auth.wechatMini`),
// so every method is hidden (404 feature_disabled) when its credentials are absent.
//
// SMS text carries only the code and the brand name (CN-L-07; no links).
//
// Error envelope: `{ success: false, code, error, details? }` (platform/http.ts)
// with the area codes in AUTH_CN_ERROR_CODES and their HTTP status in
// AUTH_CN_ERROR_STATUS.

import { z } from 'zod';

import type { ConsentProseLocale } from '../compliance/contract.js';

/** +86 mainland mobile numbers only (MVP): `^1[3-9]\d{9}$`, optionally prefixed with +86. */
export const CN_MOBILE_RE = /^(\+86)?1[3-9]\d{9}$/;
export const CnPhoneSchema = z.string().trim().regex(CN_MOBILE_RE, '请输入正确的手机号');
export const OtpCodeSchema = z.string().regex(/^\d{6}$/, '6 digits');

/** `13812345678` / `+8613812345678` → `+8613812345678`; null when not a mainland mobile. */
export function toCnE164(raw: string): string | null {
  const v = raw.trim();
  if (!CN_MOBILE_RE.test(v)) return null;
  return v.startsWith('+86') ? v : `+86${v}`;
}

/** `+8613812345678` → `138****5678` (display only). */
export function maskCnPhone(phoneE164: string | null | undefined): string | null {
  if (!phoneE164) return null;
  const national = phoneE164.replace(/^\+86/, '');
  if (national.length !== 11) return null;
  return `${national.slice(0, 3)}****${national.slice(7)}`;
}

/**
 * `login`: sign-in/sign-up (no session). `bind`: add a phone to the signed-in
 * account (after WeChat). `change_old` / `change_new`: the two codes of a
 * phone change (both need the session).
 */
export const OTP_PURPOSES = ['login', 'bind', 'change_old', 'change_new'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** Limits enforced by WP-11 (persisted in RARateCounter / RAPhoneOtp). */
export const OTP_POLICY = {
  codeTtlSec: 300,
  resendAfterSec: 60,
  perPhonePerDay: 10,
  perIpPerHour: 10,
  perIpPerDay: 30,
  wrongAttemptsBeforeLock: 5,
  lockMinutes: 30,
  /** Default for `SMS_DAILY_MAX` (all codes per brand per UTC day) when unset. */
  defaultSmsDailyMax: 1000,
} as const;

/** POST /auth/phone/send-code → `{ resendInSec }` */
export const SendCodeBodySchema = z.object({ phone: CnPhoneSchema, purpose: z.enum(OTP_PURPOSES) }).strict();
export interface SendCodeResponse {
  resendInSec: number;
}

/**
 * A consent the client reports as given, with the hash of the text the form
 * showed beside its box (`SignupPolicyConsent.prose.hash`, from GET
 * /auth/phone/policy). `type`, `granted` and `proseHash` count. The stored
 * record names the served text that hash belongs to (its catalog version and
 * hash), never the client's `proseVersion`. A required consent sent without a
 * hash, or with the hash of a text no longer served, is refused with 422
 * `consent_required` and `details.outdated`; the form reloads the policy and
 * asks again (the same rule as the email form, features/auth/goapplySignup.ts).
 */
export const ConsentInputSchema = z
  .object({
    type: z.string().min(1).max(60),
    granted: z.boolean(),
    proseVersion: z.string().min(1).max(40),
    proseHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type ConsentInput = z.infer<typeof ConsentInputSchema>;
const ConsentInput = ConsentInputSchema;

/**
 * The invite-friends code the visitor arrived with (`/r/<code>` → `?ref=`).
 * Separate from `inviteCode` (the access code of `CN_SIGNUP_MODE=invite`): it only says who
 * invited this person, and is read when the account turns out to be new.
 * An unreadable value is ignored, never an error.
 */
const FriendRef = z.string().trim().max(64).optional();

/** POST /auth/phone/verify — one flow for sign-in and sign-up; new users must send the required consents. */
export const VerifyCodeBodySchema = z
  .object({
    phone: CnPhoneSchema,
    code: OtpCodeSchema,
    consents: z.array(ConsentInput).max(20).optional(),
    /** Required on signup only when CN_SIGNUP_MODE=invite (the default mode is `open`). */
    inviteCode: z.string().trim().min(4).max(32).optional(),
    next: z.string().max(512).regex(/^\/(?!\/)/).optional(),
    ref: FriendRef,
  })
  .strict();
export interface PhoneSessionResponse {
  userId: string;
  isNewUser: boolean;
  /** Where to go next (onboarding stage route or `next`). */
  nextRoute: string;
}

/** POST /auth/phone/bind (after WeChat sign-in; real-name requirement). */
export const BindPhoneBodySchema = z
  .object({ phone: CnPhoneSchema, code: OtpCodeSchema, next: z.string().max(512).regex(/^\/(?!\/)/).optional() })
  .strict();
export interface BindPhoneResponse {
  userId: string;
  /** Masked number now on the account (`138****5678`). */
  phoneMasked: string;
  /**
   * True when the number already had an account on this brand and the new
   * WeChat-only account was empty: the WeChat sign-in moved onto the existing
   * account (which now has the session) and the empty account was removed.
   */
  merged: boolean;
  nextRoute: string;
}

/** POST /auth/phone/change: OTP to the old number (or identity re-verification when it is lost) + OTP to the new one; revokes other sessions. */
export const ChangePhoneBodySchema = z
  .object({
    oldCode: OtpCodeSchema.optional(),
    /**
     * When the old number is lost: re-verification through another bound
     * method. `password`: the account password. `wechat`: the one-time token a
     * WeChat round trip (`GET /auth/wechat/qr?purpose=reverify`) returns.
     */
    identityProof: z.object({ method: z.enum(['password', 'wechat']), value: z.string().min(1).max(512) }).strict().optional(),
    newPhone: CnPhoneSchema,
    newCode: OtpCodeSchema,
  })
  .strict()
  .refine((v) => Boolean(v.oldCode) !== Boolean(v.identityProof), { message: 'Send either oldCode or identityProof.' });
export interface ChangePhoneResponse {
  phoneMasked: string;
  /** Other sessions signed out. */
  sessionsRevoked: number;
}

/** GET /auth/phone/me — the signed-in account's phone status (settings #security). */
export interface PhoneStatusResponse {
  /** `138****5678`, or null when no number is bound. */
  phoneMasked: string | null;
  /** A password exists (re-verification option when the old number is lost). */
  hasPassword: boolean;
  /** A WeChat identity exists (the other re-verification option). */
  hasWechat: boolean;
}

/** The text of one signup consent as the form shows it (compliance catalog prose). */
export interface SignupConsentProse {
  /** Shown verbatim beside the checkbox. */
  text: string;
  /** Language of `text` (English when the catalog has no text in the language asked for). */
  locale: ConsentProseLocale;
  /** Catalog prose version (`CONSENT_PROSE_VERSION`). */
  version: string;
  /** sha256 over brand, type, version, locale and text (compliance `consentProseHash`). */
  hash: string;
}

export interface SignupPolicyConsent {
  type: string;
  /**
   * The legal-documents version (`CN_LEGAL_DOCS_VERSION`, else the area
   * default). Recorded only for a required type the compliance catalog has no
   * text for; every other row records `prose.version` and `prose.hash`.
   */
  proseVersion: string;
  /** Absent only for a type the compliance catalog has no text for. */
  prose?: SignupConsentProse;
}

/** GET /auth/phone/policy?locale= — what the G0 form needs before the first code. GoApply only. */
export interface SignupPolicyResponse {
  /** True unless the operator closed sign-up (`CN_SIGNUP_MODE=closed`). Email + password needs no other method. */
  signupOpen: boolean;
  /** `CN_SIGNUP_MODE=invite` only: new accounts need an invite code. False in the default (`open`) mode. */
  inviteRequired: boolean;
  /**
   * Consents a NEW account must grant at signup (existing accounts send none),
   * in display order. `prose` is the exact text the form shows beside the box,
   * from the compliance catalog in the language asked for (`?locale=`), with
   * its version and sha256. The email form sends `prose.hash` back, and the
   * stored consent record carries that hash: the record names the text the
   * person was shown, never a different wording.
   */
  requiredConsents: SignupPolicyConsent[];
  /** Live sign-in methods (credentials configured). */
  methods: { phoneOtp: boolean; wechatWeb: boolean; wechatInApp: boolean };
  /** Linkable legal documents. */
  legal: { termsPath: string; privacyPath: string };
}

/** Prose version of the WP-11 signup consent rows (bump with the copy). */
export const AUTH_CN_CONSENT_PROSE_VERSION = 'authCn.2026-10-10.v1';

/**
 * Consents every new GoApply account grants at signup (G0 agreement checkbox):
 * the user agreement + privacy policy (`pipl_basic_processing`) with the age
 * attestation (`age_16_plus`), plus the separate cross-border consent while
 * GoApply data is processed outside the mainland: an offshore deployment, or
 * the shared stack in use (`crossBorderConsentRequired`, signupPolicy.ts; H6,
 * GOAPPLY_PARITY_PLAN.md §3.6).
 */
export function requiredSignupConsentTypes(crossBorder: boolean): string[] {
  return crossBorder ? ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'] : ['pipl_basic_processing', 'age_16_plus'];
}

/**
 * GET /auth/wechat/qr?next= → 302 open.weixin.qq.com (snsapi_login); GET /auth/wechat/mp/start → 302 公众号 OAuth.
 * A GET start never carries consents: it serves returning WeChat users and
 * `purpose=reverify`. A NEW account started this way ends with
 * consent_required — new accounts start with `POST /auth/wechat/start`.
 * Every start sets a short-lived httpOnly cookie that binds the OAuth state
 * to this browser; the callback refuses a state without it.
 */
export const WechatStartQuerySchema = z
  .object({
    next: z.string().max(512).regex(/^\/(?!\/)/).optional(),
    /** Invite code for a NEW account in invite mode. */
    invite: z.string().trim().min(4).max(32).optional(),
    /** `reverify`: a signed-in user proves the WeChat identity for a phone change (returns a one-time token). */
    purpose: z.enum(['signin', 'reverify']).optional(),
  })
  .strict();

/**
 * POST /auth/wechat/start → `{ url }` (the browser then navigates to it).
 * The sign-in the web form uses: the G0 consents travel in this body and are
 * validated before the round trip (422 consent_required when incomplete);
 * they are recorded only if the WeChat account is new. `flow` picks the
 * capability (`web` → auth.wechatWeb, `mp` → auth.wechatInApp).
 */
export const WechatStartBodySchema = z
  .object({
    flow: z.enum(['web', 'mp']),
    next: z.string().max(512).regex(/^\/(?!\/)/).optional(),
    consents: z.array(ConsentInput).max(20).optional(),
    /** Invite code for a NEW account in invite mode. */
    inviteCode: z.string().trim().min(4).max(32).optional(),
    ref: FriendRef,
  })
  .strict();
export interface WechatStartResponse {
  /** open.weixin.qq.com authorize URL. */
  url: string;
}
export const WechatCallbackQuerySchema = z.object({ code: z.string().max(512).optional(), state: z.string().max(512).optional() });

/**
 * Where the API sends the browser after a WeChat callback (relative, same
 * origin): `/auth/callback/wechat?result=ok|error&…`.
 *   result=ok     `next`, `bind=1` when a phone must be bound first, `new=1` for a new account
 *                 (an account with two-step sign-in on is sent to /login/2fa instead, with the
 *                 challenge cookie; no session exists until the code is entered)
 *   result=error  `code` (an AUTH_CN_ERROR_CODES value or `wechat_denied`)
 *   reverify      `reverify=<one-time token>` (purpose=reverify)
 */
export const WECHAT_RETURN_PATH = '/auth/callback/wechat';
export interface WechatReturnQuery {
  result: 'ok' | 'error';
  code?: string;
  next?: string;
  bind?: '1';
  new?: '1';
  reverify?: string;
}

/** POST /auth/wechat/mini/login (API only; mini-program seam). */
export const WechatMiniLoginBodySchema = z
  .object({
    /** wx.login() code. */
    code: z.string().min(1).max(512),
    /** getPhoneNumber() code; when present the verified number is bound. */
    phoneCode: z.string().min(1).max(512).optional(),
    consents: z.array(ConsentInput).max(20).optional(),
    inviteCode: z.string().trim().min(4).max(32).optional(),
    ref: FriendRef,
  })
  .strict();
export interface WechatMiniLoginResponse extends PhoneSessionResponse {
  /** Session token for the `X-Session-Token` header (mini programs have no cookie jar). */
  sessionToken: string;
  phoneBound: boolean;
}

// ── Admin: invite codes (/admin/auth-cn/invites) ─────────────────────────

export const INVITE_STATUSES = ['active', 'used', 'expired'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const ListInvitesQuerySchema = z.object({
  status: z.enum(INVITE_STATUSES).optional(),
  cursor: z.string().max(64).optional(),
});
export const CreateInvitesBodySchema = z
  .object({
    count: z.number().int().min(1).max(500),
    maxUses: z.number().int().min(1).max(1000).default(1),
    expiresAt: z.iso.datetime().optional(),
    note: z.string().max(200).optional(),
  })
  .strict();
export interface InviteView {
  id: string;
  /**
   * The raw code. Present ONLY in the create response: the database keeps a
   * hash, so a code is shown once (null in lists).
   */
  code: string | null;
  maxUses: number;
  usedCount: number;
  status: InviteStatus;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
}

/** Invite codes: 10 characters from an unambiguous alphabet, shown as `XXXXX-XXXXX`. */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 10;

/** Canonical form for hashing and lookup: uppercase, no spaces or dashes. */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export const AUTH_CN_ERROR_CODES = {
  /** WeChat user without a phone tried an AI feature (WP-11). */
  phoneBindingRequired: 'phone_binding_required',
  otpInvalid: 'otp_invalid',
  otpExpired: 'otp_expired',
  otpLocked: 'otp_locked',
  smsDailyCap: 'sms_daily_cap',
  inviteInvalid: 'invite_invalid',
  signupClosed: 'signup_closed',
  /** A new account did not grant a required signup consent (422). */
  consentRequired: 'consent_required',
  /** The number belongs to another account on this brand (bind/change). */
  phoneTaken: 'phone_taken',
  /** The SMS provider refused or failed ("验证码发送失败，请稍后重试"). */
  smsSendFailed: 'sms_send_failed',
  /** The WeChat OAuth state is missing, expired or used. */
  oauthStateInvalid: 'oauth_state_invalid',
  /** WeChat rejected the code or did not answer. */
  wechatFailed: 'wechat_failed',
  /** Password or WeChat re-verification failed (phone change). */
  identityProofInvalid: 'identity_proof_invalid',
  /** The number given for `change_old` is not the account's number. */
  phoneMismatch: 'phone_mismatch',
} as const;
export type AuthCnErrorCode = (typeof AUTH_CN_ERROR_CODES)[keyof typeof AUTH_CN_ERROR_CODES];

export const AUTH_CN_ERROR_STATUS: Record<AuthCnErrorCode, number> = {
  phone_binding_required: 403,
  otp_invalid: 422,
  otp_expired: 422,
  otp_locked: 429,
  sms_daily_cap: 503,
  invite_invalid: 422,
  signup_closed: 403,
  consent_required: 422,
  phone_taken: 409,
  sms_send_failed: 502,
  oauth_state_invalid: 400,
  wechat_failed: 502,
  identity_proof_invalid: 422,
  phone_mismatch: 422,
};
