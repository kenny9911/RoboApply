// lib/api/accountV2.ts — Account V2: TOTP two-factor, student verification.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-79.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/account/2fa
//   POST   /api/v1/roboapply/account/2fa/enrol
//   POST   /api/v1/roboapply/account/2fa/verify
//   POST   /api/v1/roboapply/account/2fa/disable
//   POST   /api/v1/roboapply/account/2fa/recovery-codes
//   GET    /api/v1/roboapply/account/student
//   POST   /api/v1/roboapply/account/student/verify-email/send
//   POST   /api/v1/roboapply/account/student/verify-email/confirm

import { call, type CallOptions, type In } from './contracts/wire';
import type * as AV from './contracts/account-v2';

/** `twoFactor.status` — GET /api/v1/roboapply/account/2fa */
export function getTwoFactorStatus(opts?: CallOptions): Promise<AV.TwoFactorStatus> {
  return call<AV.TwoFactorStatus>('GET', `/api/v1/roboapply/account/2fa`, opts);
}

/** `twoFactor.enrol` — POST /api/v1/roboapply/account/2fa/enrol */
export function enrolTwoFactor(opts?: CallOptions): Promise<AV.TotpEnrolResponse> {
  return call<AV.TotpEnrolResponse>('POST', `/api/v1/roboapply/account/2fa/enrol`, opts);
}

/** `twoFactor.verify` — POST /api/v1/roboapply/account/2fa/verify */
export function verifyTwoFactor(body: In<typeof AV.TotpVerifyBodySchema>, opts?: CallOptions): Promise<AV.TotpVerifyResponse> {
  return call<AV.TotpVerifyResponse>('POST', `/api/v1/roboapply/account/2fa/verify`, { ...opts, body });
}

/** `twoFactor.disable` — POST /api/v1/roboapply/account/2fa/disable */
export function disableTwoFactor(body: In<typeof AV.TotpDisableBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/account/2fa/disable`, { ...opts, body });
}

/** `twoFactor.recoveryCodes` — POST /api/v1/roboapply/account/2fa/recovery-codes */
export function regenerateRecoveryCodes(body: In<typeof AV.RegenerateRecoveryBodySchema>, opts?: CallOptions): Promise<AV.TotpVerifyResponse> {
  return call<AV.TotpVerifyResponse>('POST', `/api/v1/roboapply/account/2fa/recovery-codes`, { ...opts, body });
}

/** `student.status` — GET /api/v1/roboapply/account/student */
export function getStudentStatus(opts?: CallOptions): Promise<AV.StudentStatus> {
  return call<AV.StudentStatus>('GET', `/api/v1/roboapply/account/student`, opts);
}

/** `student.sendCode` — POST /api/v1/roboapply/account/student/verify-email/send */
export function sendStudentEmailCode(body: In<typeof AV.StudentEmailSendBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/account/student/verify-email/send`, { ...opts, body });
}

/** `student.confirm` — POST /api/v1/roboapply/account/student/verify-email/confirm */
export function confirmStudentEmail(body: In<typeof AV.StudentEmailConfirmBodySchema>, opts?: CallOptions): Promise<AV.StudentStatus> {
  return call<AV.StudentStatus>('POST', `/api/v1/roboapply/account/student/verify-email/confirm`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const accountV2Api = {
  getTwoFactorStatus,
  enrolTwoFactor,
  verifyTwoFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
  getStudentStatus,
  sendStudentEmailCode,
  confirmStudentEmail,
};
