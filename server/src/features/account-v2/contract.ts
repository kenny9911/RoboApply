// server/src/features/account-v2/contract.ts
//
// Account V2: TOTP 2FA and student verification (TASK_PLAN.md WP-79).
// Mounts (new paths next to the legacy /account router, which has neither):
//   /api/v1/roboapply/account/2fa      (capability `totp`)
//   /api/v1/roboapply/account/student  (capability `student`)
// The login challenge step lives in the legacy auth router (WP-79 hook):
//   POST /api/v1/roboapply/auth/login      → 401 `two_factor_required` (challenge cookie set)
//   POST /api/v1/roboapply/auth/login/2fa  → the normal login response
//
// Area error reasons travel in `details.reason` (read with `apiErrorReason`).

import { z } from 'zod';

export const TotpCodeSchema = z.string().regex(/^\d{6}$/);
export const RecoveryCodeSchema = z.string().trim().regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i);

export interface TwoFactorStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesLeft: number;
  /** Enrolment started (secret shown) but not confirmed with a code yet. */
  pending: boolean;
  /**
   * Whether two-step sign-in can be turned on here now. False until every
   * sign-in path checks the second factor and the brand's sealing key is set;
   * an account that already has it on keeps it on regardless.
   */
  available: boolean;
}
/** POST /account/2fa/enrol → secret shown once (otpauth URI for a QR code). */
export interface TotpEnrolResponse {
  otpauthUri: string;
  secret: string;
  /** PNG data URL of the QR code for `otpauthUri`; null when it could not be drawn (type the secret instead). */
  qrDataUrl: string | null;
}
/** POST /account/2fa/verify — confirms enrolment; returns recovery codes once. */
export const TotpVerifyBodySchema = z.object({ code: TotpCodeSchema }).strict();
export interface TotpVerifyResponse {
  recoveryCodes: string[];
}
/** POST /account/2fa/disable — a current code or a recovery code. */
export const TotpDisableBodySchema = z
  .object({ code: TotpCodeSchema.optional(), recoveryCode: RecoveryCodeSchema.optional() })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), { message: 'Send either code or recoveryCode.' });
/** POST /account/2fa/recovery-codes — regenerate (needs a current code). */
export const RegenerateRecoveryBodySchema = z.object({ code: TotpCodeSchema }).strict();

/**
 * POST /auth/login/2fa — the second step of a password sign-in. The challenge
 * is the httpOnly cookie `ra_2fa` set by the first step (`challengeToken` in
 * the body is accepted for clients without cookies).
 */
export const LoginTwoFactorBodySchema = z
  .object({
    code: TotpCodeSchema.optional(),
    recoveryCode: RecoveryCodeSchema.optional(),
    challengeToken: z.string().min(20).max(200).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), { message: 'Send either code or recoveryCode.' });

/** 401 body `details` of POST /auth/login when a second factor is needed. */
export interface TwoFactorRequiredDetails {
  /** The web page that asks for the code. */
  next: '/login/2fa';
  methods: Array<'totp' | 'recovery'>;
  /** Seconds the challenge stays valid. */
  expiresInSec: number;
}

export interface StudentStatus {
  verified: boolean;
  schoolDomain: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  /** A code was sent and can still be entered (its school domain). */
  pendingDomain: string | null;
  /** Whether verification can run here now (false until the storage exists). */
  available: boolean;
}
/** POST /account/student/verify-email/send — school email (e.g. *.edu); a code is emailed. */
export const StudentEmailSendBodySchema = z.object({ schoolEmail: z.string().trim().toLowerCase().email().max(254) }).strict();
export const StudentEmailConfirmBodySchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
/** POST /account/student/verify-email/send → when the code stops working. */
export interface StudentCodeSentResponse {
  schoolDomain: string;
  expiresAt: string;
}

/** How long a student verification lasts before the student verifies again. */
export const STUDENT_VERIFICATION_MONTHS = 12;
export const STUDENT_CODE_TTL_MIN = 15;
export const STUDENT_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CHALLENGE_TTL_SEC = 5 * 60;
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;

export const ACCOUNT_V2_ERROR_CODES = {
  totpInvalid: 'totp_invalid',
  notEnrolled: 'totp_not_enrolled',
  alreadyEnabled: 'totp_already_enabled',
  notAvailable: 'totp_not_available',
  keyMissing: 'totp_key_missing',
  twoFactorRequired: 'two_factor_required',
  challengeInvalid: 'two_factor_challenge_invalid',
  schoolDomainNotEligible: 'school_domain_not_eligible',
  schoolEmailInUse: 'school_email_in_use',
  codeInvalid: 'student_code_invalid',
  codeExpired: 'student_code_expired',
  emailUnavailable: 'email_unavailable',
} as const;
