// server/src/features/account-v2/contract.ts
//
// Account V2: TOTP 2FA and student verification (TASK_PLAN.md WP-79).
// Mounts (new paths next to the legacy /account router, which has neither):
//   /api/v1/roboapply/account/2fa      (capability `totp`)
//   /api/v1/roboapply/account/student  (capability `student`)
// The login challenge step lives in the legacy auth router (WP-79 hook).

import { z } from 'zod';

export const TotpCodeSchema = z.string().regex(/^\d{6}$/);
export const RecoveryCodeSchema = z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i);

export interface TwoFactorStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesLeft: number;
}
/** POST /account/2fa/enrol → secret shown once (otpauth URI for a QR code). */
export interface TotpEnrolResponse {
  otpauthUri: string;
  secret: string;
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

export interface StudentStatus {
  verified: boolean;
  schoolDomain: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
}
/** POST /account/student/verify-email/send — school email (e.g. *.edu); a code is emailed. */
export const StudentEmailSendBodySchema = z.object({ schoolEmail: z.string().trim().toLowerCase().email().max(254) }).strict();
export const StudentEmailConfirmBodySchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

export const ACCOUNT_V2_ERROR_CODES = {
  totpInvalid: 'totp_invalid',
  notEnrolled: 'totp_not_enrolled',
  schoolDomainNotEligible: 'school_domain_not_eligible',
} as const;
