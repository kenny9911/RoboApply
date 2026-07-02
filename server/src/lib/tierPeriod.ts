/**
 * tierPeriod — the single rule for "what subscription period dates should a
 * user have for their tier?". Used at signup, on admin tier-change, and by the
 * one-time backfill so every user has a coherent start/end (+ trial) by tier:
 *
 *   - free        → 14-day trial: start=now, end=trialEnd=now+14d, status trialing
 *   - paid monthly→ start=now, end=now+1mo,  no trialEnd, status active
 *   - paid annual → start=now, end=now+1yr,  no trialEnd, status active
 *
 * The END date (currentPeriodEnd) is the single field the subscription gate /
 * grace / anniversary logic reads. For free users it equals trialEnd so the
 * gate can lock the trial once it lapses (see lib/subscriptionGate.ts rule 3).
 * Admins can still overwrite any of these via set-billing-period.
 */

export const FREE_TRIAL_DAYS = 14;

export type BillingInterval = 'monthly' | 'quarterly' | 'annual';

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Add N months/years with end-of-month clamping (Jan 31 + 1mo → Feb 28). */
export function addBillingInterval(d: Date, interval: BillingInterval): Date {
  const x = new Date(d);
  const day = x.getUTCDate();
  if (interval === 'annual') x.setUTCFullYear(x.getUTCFullYear() + 1);
  else if (interval === 'quarterly') x.setUTCMonth(x.getUTCMonth() + 3);
  else x.setUTCMonth(x.getUTCMonth() + 1);
  if (x.getUTCDate() !== day) x.setUTCDate(0); // overflowed → clamp to month end
  return x;
}

/**
 * Compute the new `currentPeriodEnd` for a self-service RENEWAL. Extends from
 * the LATER of (now, existing currentPeriodEnd) so an early renewal never burns
 * the customer's remaining days — it stacks one full interval onto whatever is
 * left. Mirrors the admin record-external-payment stacking math. End-of-month
 * clamped via addBillingInterval.
 */
export function renewPeriodEnd(
  currentPeriodEnd: Date | null | undefined,
  interval: BillingInterval,
  now: Date = new Date(),
): Date {
  const base =
    currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime() ? currentPeriodEnd : now;
  return addBillingInterval(base, interval);
}

export interface TierPeriod {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  subscriptionStatus: 'trialing' | 'active';
  billingInterval: BillingInterval | null;
}

export function computeTierPeriod(
  tier: string,
  interval: BillingInterval | null | undefined,
  now: Date = new Date(),
): TierPeriod {
  if ((tier || 'free').toLowerCase() === 'free') {
    const end = addDays(now, FREE_TRIAL_DAYS);
    return {
      currentPeriodStart: now,
      currentPeriodEnd: end,
      trialEnd: end,
      subscriptionStatus: 'trialing',
      billingInterval: null,
    };
  }
  const bi: BillingInterval = (interval as BillingInterval) || 'monthly';
  return {
    currentPeriodStart: now,
    currentPeriodEnd: addBillingInterval(now, bi),
    trialEnd: null,
    subscriptionStatus: 'active',
    billingInterval: bi,
  };
}
