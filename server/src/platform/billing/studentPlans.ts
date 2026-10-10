// server/src/platform/billing/studentPlans.ts
//
// Who may buy a student plan (WP-79; F-ACCT-02; MARKET_STRATEGY PC-2). One
// rule for every rail and every route that opens a checkout:
//
//   - the `student` capability must be on for this user on this brand, and
//   - the buyer must hold a live school-email verification
//     (features/account-v2 `studentService.isVerified`).
//
// RoboApply's student plans are Stripe subscriptions; GoApply's are passes
// (学生月卡 30 days, 学生季卡 90 days) bought through Alipay or WeChat Pay. The
// rule is the same on both.
//
// The same rule decides who is SHOWN a student plan (`studentPlansListedFor`,
// used by `GET /billing/plans`): the plans list carries the student plans only
// for a signed-in, verified student (GOAPPLY_PARITY_PLAN §7 step 6).
//
// It fails closed: a capability or verification lookup that errors counts as
// "no". The caller runs it BEFORE anything is recorded, so an unverified buyer
// leaves no acknowledgement and no order behind.

import { logger } from '../../services/LoggerService.js';
import type { ProductBrand } from '../brand/registry.js';
import { BillingError } from './errors.js';
import { isStudentPlan, type PlanDefinition } from './planCatalog.js';

export interface StudentGateDeps {
  /** The `student` capability for this user on this brand. */
  studentEnabled: (userId: string, brand: ProductBrand) => Promise<boolean>;
  /** A live school-email verification. */
  isStudentVerified: (userId: string) => Promise<boolean>;
}

type StudentPlanRef = Pick<PlanDefinition, 'key' | 'requiresFlag'>;

/**
 * `true` when `plan` is a student plan and this buyer may buy it; `undefined`
 * for every other plan (nothing to check). Throws `plan_not_sellable` while
 * the capability is off and `student_verification_required` for a buyer who
 * is not verified.
 */
export async function studentVerifiedForPlan(userId: string, brand: ProductBrand, plan: StudentPlanRef, deps: StudentGateDeps): Promise<boolean | undefined> {
  if (!isStudentPlan(plan)) return undefined;
  if (!(await deps.studentEnabled(userId, brand).catch(() => false))) {
    throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key, reason: 'student_off' });
  }
  const verified = await deps.isStudentVerified(userId).catch((err: unknown) => {
    logger.warn('RA_BILLING', 'student verification lookup failed; treating as not verified', { userId, error: err instanceof Error ? err.message : String(err) });
    return false;
  });
  if (verified !== true) {
    throw new BillingError('student_verification_required', 'Verify your school email to get the student price', { planKey: plan.key });
  }
  return true;
}

/**
 * Whether the student plans are LISTED for this caller (`GET /billing/plans`):
 * the same two conditions as buying one, answered as yes or no. A visitor with
 * no session, a buyer who is not verified, and any lookup that fails all get
 * "no", so a plan is never shown to someone the checkout would refuse.
 */
export async function studentPlansListedFor(userId: string | null, brand: ProductBrand, deps: StudentGateDeps): Promise<boolean> {
  if (!userId) return false;
  if (!(await deps.studentEnabled(userId, brand).catch(() => false))) return false;
  const verified = await deps.isStudentVerified(userId).catch((err: unknown) => {
    logger.warn('RA_BILLING', 'student verification lookup failed; student plans not listed', { userId, error: err instanceof Error ? err.message : String(err) });
    return false;
  });
  return verified === true;
}

/**
 * The rail's own check, behind the caller's: a student plan is charged only
 * when the order says the buyer is verified (`studentVerified === true`).
 */
export function assertStudentOrder(order: { plan: StudentPlanRef; studentVerified?: boolean }): void {
  if (isStudentPlan(order.plan) && order.studentVerified !== true) {
    throw new BillingError('student_verification_required', 'Verify your school email to get the student price', { planKey: order.plan.key });
  }
}
