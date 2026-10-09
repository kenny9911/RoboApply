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

import { z } from 'zod';

/** +86 mainland mobile numbers only (MVP): `^1[3-9]\d{9}$`, optionally prefixed with +86. */
export const CN_MOBILE_RE = /^(\+86)?1[3-9]\d{9}$/;
export const CnPhoneSchema = z.string().trim().regex(CN_MOBILE_RE, '请输入正确的手机号');
export const OtpCodeSchema = z.string().regex(/^\d{6}$/, '6 digits');

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
} as const;

/** POST /auth/phone/send-code → `{ resendInSec }` */
export const SendCodeBodySchema = z.object({ phone: CnPhoneSchema, purpose: z.enum(OTP_PURPOSES) }).strict();
export interface SendCodeResponse {
  resendInSec: number;
}

const ConsentInput = z.object({ type: z.string().min(1).max(60), granted: z.boolean(), proseVersion: z.string().min(1).max(40) }).strict();

/** POST /auth/phone/verify — one flow for sign-in and sign-up; new users must send the required consents. */
export const VerifyCodeBodySchema = z
  .object({
    phone: CnPhoneSchema,
    code: OtpCodeSchema,
    consents: z.array(ConsentInput).max(20).optional(),
    /** Required on signup when CN_SIGNUP_MODE=invite (CN-0). */
    inviteCode: z.string().trim().min(4).max(32).optional(),
    next: z.string().max(512).regex(/^\/(?!\/)/).optional(),
  })
  .strict();
export interface PhoneSessionResponse {
  userId: string;
  isNewUser: boolean;
  /** Where to go next (onboarding stage route or `next`). */
  nextRoute: string;
}

/** POST /auth/phone/bind (after WeChat sign-in; real-name requirement). */
export const BindPhoneBodySchema = z.object({ phone: CnPhoneSchema, code: OtpCodeSchema }).strict();

/** POST /auth/phone/change: OTP to the old number (or identity re-verification when it is lost) + OTP to the new one; revokes other sessions. */
export const ChangePhoneBodySchema = z
  .object({
    oldCode: OtpCodeSchema.optional(),
    /** When the old number is lost: re-verification through another bound method. */
    identityProof: z.object({ method: z.enum(['password', 'wechat']), value: z.string().min(1).max(512) }).strict().optional(),
    newPhone: CnPhoneSchema,
    newCode: OtpCodeSchema,
  })
  .strict()
  .refine((v) => Boolean(v.oldCode) !== Boolean(v.identityProof), { message: 'Send either oldCode or identityProof.' });

/** GET /auth/wechat/qr?next= → 302 open.weixin.qq.com (snsapi_login); GET /auth/wechat/mp/start → 302 公众号 OAuth. */
export const WechatStartQuerySchema = z.object({ next: z.string().max(512).regex(/^\/(?!\/)/).optional() });
export const WechatCallbackQuerySchema = z.object({ code: z.string().max(512).optional(), state: z.string().max(512).optional() });

/** POST /auth/wechat/mini/login (API only; mini-program seam). */
export const WechatMiniLoginBodySchema = z
  .object({ code: z.string().min(1).max(512), encryptedData: z.string().max(8192).optional(), iv: z.string().max(64).optional() })
  .strict();

// ── Admin: invite codes (/admin/auth-cn/invites) ─────────────────────────

export const ListInvitesQuerySchema = z.object({
  status: z.enum(['active', 'used', 'expired']).optional(),
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
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
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
} as const;
