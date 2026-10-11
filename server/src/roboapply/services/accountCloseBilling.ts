// server/src/roboapply/services/accountCloseBilling.ts
//
// A person who closes their account is not charged again (M4 gate; MKT-4A
// review finding 3, the half at the request).
//
// Closing an account (`POST /account/delete`) only soft-closes the profile;
// the hard purge runs ACCOUNT_PURGE_RETENTION_DAYS later (30 by default) and
// ends a subscription that still runs at the payment provider then
// (SeekerAccountPurgeService step 4). In between a monthly plan would renew
// once and a weekly plan four times, on an account nobody can sign in to. So
// the request itself turns auto-renewal off: the ordinary cancellation at the
// end of the paid period (`cancelPlan`, the same call as "Cancel plan" in
// Settings). Nothing is refunded here and nothing ends early; the purge stays
// the backstop for a plan this call could not stop.
//
// No "plan cancelled" mail (M4 cross-review). That mail says "Your paid
// features stay on until {date}" with a button "See your plan", which is false
// for a person who is signed out everywhere a moment later. The caller's
// account-deleted mail says the plan will not renew instead, and only when this
// function answered `stopped`.
//
// It never blocks the deletion: an account with nothing to cancel (Free, a
// pass that does not renew, a plan already cancelled, a GoApply account, whose
// rail is Alipay and has no renewal) is not an error; a failure at the payment
// provider is logged and left to the purge; and a payment provider that does
// not answer within `STOP_RENEWAL_TIMEOUT_MS` is not waited for (a deletion
// request is a privacy action and must not depend on the provider's speed: the
// shared Stripe client allows about 80 seconds a try, three tries).

import { logger } from '../../services/LoggerService.js';

/** `stopped`: auto-renewal was turned off now. `nothing_to_stop`: no plan that renews. `not_stopped`: it could not be done (or not in time); the purge ends it. */
export type RenewalStop = 'stopped' | 'nothing_to_stop' | 'not_stopped';

/** How long the deletion request waits for the payment provider before it goes on without it. */
export const STOP_RENEWAL_TIMEOUT_MS = 8_000;

export interface AccountCloseBillingDeps {
  /** Default: `cancelPlan` of RoboApplyBillingService (loaded on first use). */
  cancelPlan?: (userId: string, input: { source: 'in_app' }, opts: { confirmationMail: false }) => Promise<{ changed: boolean }>;
  warn?: (message: string, meta: Record<string, unknown>) => void;
  /** Default `STOP_RENEWAL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

const TIMED_OUT = Symbol('timed out');

export async function stopRenewalForClosingAccount(userId: string, deps: AccountCloseBillingDeps = {}, requestId?: string): Promise<RenewalStop> {
  const notStopped = (meta: Record<string, unknown>): RenewalStop => {
    const message = 'closing an account: auto-renewal could not be turned off now; the account purge ends the subscription';
    if (deps.warn) deps.warn(message, meta);
    else logger.warn('RA_ACCOUNT', message, meta, requestId);
    return 'not_stopped';
  };
  const timeoutMs = deps.timeoutMs ?? STOP_RENEWAL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cancelPlan = deps.cancelPlan ?? (await import('./RoboApplyBillingService.js')).cancelPlan;
    const cancelling = cancelPlan(userId, { source: 'in_app' }, { confirmationMail: false });
    // A call that outlives the wait may still succeed (the renewal is then off) or fail: neither is waited for.
    cancelling.catch(() => undefined);
    const outcome = await Promise.race([
      cancelling,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (outcome === TIMED_OUT) return notStopped({ userId, code: 'timeout', error: `the payment provider did not answer within ${timeoutMs} ms` });
    return outcome.changed ? 'stopped' : 'nothing_to_stop';
  } catch (err) {
    const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : null;
    // No paid plan, or none on a rail that renews: nothing to stop.
    if (code === 'no_subscription') return 'nothing_to_stop';
    return notStopped({ userId, code, error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
