// components/features/account-v2 — public surface (WP-79). Other areas import
// from here only (TASK_PLAN.md §2.1 rule 4).
//
//   TwoFactorSettings     two-step sign-in in /settings#security (INT mounts it)
//   StudentVerification   school-email confirmation (mounted in BillingView)
//   TwoFactorChallenge    the /login/2fa page body

export { TwoFactorSettings } from './TwoFactorSettings';
export { StudentVerification } from './StudentVerification';
export { TwoFactorChallenge } from './TwoFactorChallenge';
export { useStudentStatus, useTwoFactorStatus } from './queries';
