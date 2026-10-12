// @vitest-environment node
//
// M4 gate (MKT-4A review finding 3, the half at the request): closing an account turns auto-renewal off and never
// blocks the deletion. The billing service is a fake: nothing here reaches Stripe or a database.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STOP_RENEWAL_TIMEOUT_MS, stopRenewalForClosingAccount } from './accountCloseBilling.js';

class BillingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

describe('stopRenewalForClosingAccount', () => {
  it('a plan that renews is cancelled at the end of its paid period, as "Cancel plan" in Settings does, without its mail', async () => {
    const cancelPlan = vi.fn(async () => ({ changed: true, status: 'cancelled' }));
    expect(await stopRenewalForClosingAccount('u1', { cancelPlan })).toBe('stopped');
    // `confirmationMail: false`: the "Your paid features stay on until {date}" mail (billing.cancel_confirmed) is
    // never sent to a person who is signed out everywhere a moment later (M4 cross-review). The real `cancelPlan`
    // honours the option: platform/billing/integration/stripeWebhook.events.test.ts.
    expect(cancelPlan.mock.calls).toEqual([['u1', { source: 'in_app' }, { confirmationMail: false }]]);
  });

  it('a payment provider that does not answer is not waited for: the deletion goes on and the purge ends the subscription', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      // A Stripe call that never resolves (the shared client allows about 80 seconds a try, three tries).
      const cancelPlan = vi.fn(() => new Promise<{ changed: boolean }>(() => undefined));
      const pending = stopRenewalForClosingAccount('u1', { cancelPlan, warn });
      let settled: string | null = null;
      void pending.then((answer) => {
        settled = answer;
      });
      await vi.advanceTimersByTimeAsync(STOP_RENEWAL_TIMEOUT_MS - 1);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('not_stopped');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({ userId: 'u1', code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a call that fails after the wait ended is not an unhandled rejection, and an answer in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      let fail: (err: Error) => void = () => undefined;
      const late = vi.fn(() => new Promise<{ changed: boolean }>((_resolve, reject) => (fail = reject)));
      const pending = stopRenewalForClosingAccount('u1', { cancelPlan: late, warn: vi.fn(), timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe('not_stopped');
      fail(new Error('stripe gave up'));
      await vi.advanceTimersByTimeAsync(0);
      expect(await stopRenewalForClosingAccount('u1', { cancelPlan: async () => ({ changed: true }) })).toBe('stopped');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing to stop is not an error: no paid plan, a pass, a plan already cancelled, a GoApply account', async () => {
    const warn = vi.fn();
    // A pass or an already cancelled plan: the service answers "already cancelled" and changes nothing.
    expect(await stopRenewalForClosingAccount('u1', { cancelPlan: async () => ({ changed: false }), warn })).toBe('nothing_to_stop');
    // Free, or GoApply (its rail is Alipay; there is no subscription to cancel): the service refuses with `no_subscription`.
    const none = vi.fn(async () => {
      throw new BillingError('no_subscription', 'There is no paid plan to cancel');
    });
    expect(await stopRenewalForClosingAccount('u1', { cancelPlan: none, warn })).toBe('nothing_to_stop');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failure never throws: it is logged, and the account purge ends the subscription', async () => {
    for (const [code, message] of [
      ['payment_provider_error', 'The cancellation could not be sent to the payment provider. Try again.'],
      ['rail_not_configured', 'Card payments are not set up'],
      [null, 'the database is down'],
    ] as const) {
      const warn = vi.fn();
      const failing = async () => {
        throw code ? new BillingError(code, message) : new Error(message);
      };
      expect(await stopRenewalForClosingAccount('u1', { cancelPlan: failing, warn })).toBe('not_stopped');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({ userId: 'u1', code, error: message });
    }
  });
});

describe('POST /account/delete', () => {
  it('turns auto-renewal off before it closes the account, and awaits it', () => {
    // The route has no harness of its own (session middleware, the seeker auth service): its order is pinned as text.
    const source = readFileSync(path.join(process.cwd(), 'server/src/roboapply/routes/account.ts'), 'utf8');
    const route = source.slice(source.indexOf("router.post('/delete'"), source.indexOf("router.post('/wipe-data'"));
    const stop = route.indexOf('await stopRenewalForClosingAccount(userId');
    const close = route.indexOf('await seekerAuthService.softDeleteAccount(userId)');
    expect(stop).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(stop);
  });

  it('the account-deleted mail says the plan will not renew only when the renewal was really turned off', () => {
    const source = readFileSync(path.join(process.cwd(), 'server/src/roboapply/routes/account.ts'), 'utf8');
    const route = source.slice(source.indexOf("router.post('/delete'"), source.indexOf("router.post('/wipe-data'"));
    expect(route).toContain('const renewal = await stopRenewalForClosingAccount(userId');
    expect(route).toContain("renewalStopped: renewal === 'stopped'");
  });
});
