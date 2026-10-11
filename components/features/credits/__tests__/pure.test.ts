// WP-21b — pure helpers: pricing math, FX freshness, plan selection rules,
// subscription state, the admin caps document.

import { describe, expect, it } from 'vitest';

import {
  isFxReferenceFresh,
  monthlyEquivalentMinor,
  requiresWithdrawalWaiver,
  savingsPercent,
  twdReferenceAmount,
} from '../../../../lib/pricing';
import { plansExtras } from '../../../../lib/api/credits';
import { initialSelection, monthlyPlan, visiblePlans } from '../../../../hooks/credits/usePlans';
import { deriveSubscriptionState, summaryCancelAtPeriodEnd } from '../../../../hooks/credits/useSubscriptionState';
import { CN_VISITOR_COUNTRY, checkoutReturnPath, cnVisitorPricingUrl, offeredProPlans, offeredRails } from '../PlanPicker';
import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import { RETURN_POLL_ATTEMPTS, RETURN_POLL_MS, RETURN_RECONCILE_EVERY, isPackKey, reconcileRefusalIsFinal } from '../CheckoutReturn';
import { canResumeSubscription, renewalPeriod, resumeTerms, subscriptionIsOver } from '../ResumeSubscription';
import { RoboApiError } from '../../../../lib/api/client';
import { clientBrandFor } from '../../../../lib/brand/client';
import stagedCredits from '../../../../i18n/staging/credits.en.json';
import stagedCreditsZh from '../../../../i18n/staging/credits.zh.json';
import { checkoutRedirectUrl } from '../../../../hooks/credits/useBillingActions';
import { applyDraft, draftFromOverride, invalidCells, parseOverrideValue, revenueShare } from '../adminCatalog';
import { bucketLabelKey, calendarDaysUntil, knownTimeZone, planMonths, planNameKey, pricePeriod, refillLabel } from '../labels';
import en from '../../../../i18n/messages/en.json';
import { creditsResponse, GA_ENV, plansView, RA_ENV, railNotReadyPlansView, unpricedPlansView } from './fixtures';
import type { BillingPlanResponse } from '../../../../lib/api/account';

describe('pricing math (derived from server prices only)', () => {
  it('weekly → "about $43 a month" (52/12, whole units)', () => {
    expect(monthlyEquivalentMinor(999)).toBe(4300);
    expect(monthlyEquivalentMinor(null)).toBeNull();
    expect(monthlyEquivalentMinor(0)).toBeNull();
  });

  it('"Save N%" is computed from our own monthly price and rounded down', () => {
    // 3 × 24.99 = 74.97; 54.99 saves 26.65 % → 26. And 59.99 would save 19.98 % → 19, never rounded up to 20.
    expect(savingsPercent(5499, 2499, 3)).toBe(26);
    expect(savingsPercent(5999, 2499, 3)).toBe(19);
    expect(savingsPercent(9900, 3900, 3)).toBe(15);
    expect(savingsPercent(8000, 2499, 3)).toBeNull();
    expect(savingsPercent(5999, null, 3)).toBeNull();
    expect(savingsPercent(5999, 2499, 1)).toBeNull();
  });

  it('withdrawal waiver only for EU / UK / TW; unknown → no box', () => {
    expect(requiresWithdrawalWaiver('DE')).toBe(true);
    expect(requiresWithdrawalWaiver('gb')).toBe(true);
    expect(requiresWithdrawalWaiver('TW')).toBe(true);
    expect(requiresWithdrawalWaiver('US')).toBe(false);
    expect(requiresWithdrawalWaiver(null)).toBe(false);
    expect(requiresWithdrawalWaiver('XX')).toBe(false);
  });

  it('FX reference: needs a source, a valid date and ≤45 days', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const ref = { currency: 'TWD' as const, ratePerUsd: 32.1, source: 'Bank of Taiwan', asOf: '2026-09-01' };
    expect(isFxReferenceFresh(ref, now)).toBe(true);
    expect(isFxReferenceFresh({ ...ref, asOf: '2026-08-20' }, now)).toBe(false);
    expect(isFxReferenceFresh({ ...ref, source: ' ' }, now)).toBe(false);
    expect(isFxReferenceFresh({ ...ref, ratePerUsd: 0 }, now)).toBe(false);
    expect(isFxReferenceFresh(null, now)).toBe(false);
    expect(twdReferenceAmount(2499, 32.1)).toBe(802);
    expect(twdReferenceAmount(0, 32.1)).toBeNull();
  });

  it('plansExtras normalises the requested fields and tolerates their absence', () => {
    expect(plansExtras(plansView())).toEqual({ fxReference: null, visitorCountry: null });
    expect(plansExtras(plansView('roboapply', RA_ENV, { visitor: { country: 'de' } })).visitorCountry).toBe('DE');
    expect(plansExtras(undefined)).toEqual({ fxReference: null, visitorCountry: null });
    // WP-21a sends the edge country as checkout.country (Wave 2 gate seam fix).
    const base = plansView();
    expect(plansExtras({ ...base, checkout: { ...base.checkout, country: 'fr' } }).visitorCountry).toBe('FR');
  });
});

describe('plan selection rules', () => {
  it('Monthly is preselected; weekly and the pass never are', () => {
    const view = plansView();
    expect(initialSelection(view)).toBe('pro_monthly');
    expect(initialSelection({ ...view, defaultSelection: 'pro_weekly' })).toBeNull();
    expect(initialSelection({ ...view, defaultSelection: 'pro_week_pass' })).toBeNull();
  });

  it('an explicit link may choose the pass (the cancel-time alternative)', () => {
    expect(initialSelection(plansView(), 'pro_week_pass')).toBe('pro_week_pass');
    expect(initialSelection(plansView(), 'nope')).toBe('pro_monthly');
  });

  it('nothing is preselected when no default-eligible plan is sellable', () => {
    expect(initialSelection(unpricedPlansView())).toBeNull();
    // The card rail not ready: every plan has its amount, none is on sale, so none is preselected,
    // whatever default the response names.
    expect(initialSelection(railNotReadyPlansView())).toBeNull();
    expect(initialSelection({ ...railNotReadyPlansView(), defaultSelection: 'pro_monthly' })).toBeNull();
  });

  it('visiblePlans hides free and V2 student plans, and a plan the API sends with no amount', () => {
    const keys = visiblePlans(plansView().plans).map((p) => p.key);
    expect(keys).toEqual(['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15']);
    expect(visiblePlans(unpricedPlansView().plans)).toEqual([]);
  });

  it('the default fixtures are the MARKET_STRATEGY §4 catalog, in the wire shape', () => {
    expect(visiblePlans(plansView().plans).map((p) => [p.key, p.amountMinor, p.currency, p.sellable])).toEqual([
      ['pro_weekly', 999, 'USD', true],
      ['pro_monthly', 2499, 'USD', true],
      ['pro_quarterly', 5499, 'USD', true],
      ['pro_week_pass', 999, 'USD', true],
      ['practice_pack_5', 999, 'USD', true],
      ['practice_pack_15', 2499, 'USD', true],
    ]);
    expect(plansView().plans.some((p) => p.unsellableReason === 'price_unset')).toBe(false);
    expect(plansView().defaultSelection).toBe('pro_monthly');
    // The card rail not ready: the same amounts, none on sale, and the reason is never a missing price.
    const closed = railNotReadyPlansView();
    expect(visiblePlans(closed.plans).map((p) => [p.key, p.amountMinor])).toEqual(visiblePlans(plansView().plans).map((p) => [p.key, p.amountMinor]));
    expect(visiblePlans(closed.plans).every((p) => !p.sellable && p.unsellableReason === 'payments_disabled')).toBe(true);
    expect(closed.paymentsOpen).toBe(false);
    expect(closed.checkout.rails).toEqual([]);
  });

  it('GoApply passes are listed at their catalog prices and on sale with an empty env; the 30-day pass is preselected', () => {
    expect(GA_ENV).toEqual({});
    const plans = visiblePlans(plansView('goapply').plans);
    expect(plans.map((p) => [p.key, p.amountMinor])).toEqual([
      ['pro_week_pass', 1200],
      ['pro_monthly', 3900],
      ['pro_quarterly', 9900],
      ['practice_pack_5', 2900],
      ['practice_pack_15', 7900],
    ]);
    expect(plans.every((p) => p.sellable && p.unsellableReason === null)).toBe(true);
    expect(initialSelection(plansView('goapply'))).toBe('pro_monthly');
    // An override the server ignored never reaches the sheet as a price.
    expect(visiblePlans(plansView('goapply', { CN_PRICE_PRO_MONTHLY_FEN: '3990' }).plans).find((p) => p.key === 'pro_monthly')?.amountMinor).toBe(3900);
  });

  it('GoApply kill switch (CN_PAYMENTS_ENABLED=false): passes stay listed with prices, none sellable, nothing preselected', () => {
    const killed = plansView('goapply', { CN_PAYMENTS_ENABLED: 'false' });
    const plans = visiblePlans(killed.plans);
    expect(plans.map((p) => p.key)).toEqual(['pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15']);
    expect(plans.every((p) => !p.sellable && p.unsellableReason === 'payments_disabled' && p.amountMinor !== null)).toBe(true);
    expect(initialSelection(killed)).toBeNull();
  });

  it('GoApply student passes are hidden unless the buyer is a verified student, and are never preselected', () => {
    const { plans, defaultSelection } = buildPlanViews('goapply', { env: GA_ENV, studentEnabled: true });
    expect(visiblePlans(plans).some((p) => p.requiresFlag === 'student')).toBe(false);
    const shown = visiblePlans(plans, { studentEnabled: true }).filter((p) => p.requiresFlag === 'student');
    expect(shown.map((p) => [p.key, p.amountMinor, p.passDays, p.studentDiscountPercent])).toEqual([
      ['student_monthly', 2900, 30, 25],
      ['student_quarterly', 6900, 90, 30],
    ]);
    expect(initialSelection({ plans, defaultSelection: 'student_monthly' })).toBeNull();
    expect(planNameKey('goapply', 'student_monthly')).toBe('plans.goapply.student_monthly');
    expect(planNameKey('goapply', 'student_quarterly')).toBe('plans.goapply.student_quarterly');
    // RoboApply has a renewing weekly plan; GoApply does not.
    expect(planNameKey('goapply', 'pro_weekly')).toBeNull();
  });

  it('offeredRails: the server order, the first is the default; WeChat Pay only while its sheet can open', () => {
    expect(offeredRails(['alipay', 'wechatpay'], true)).toEqual(['alipay', 'wechatpay']);
    expect(offeredRails(['alipay', 'wechatpay'], false)).toEqual(['alipay']);
    expect(offeredRails(['wechatpay'], true)).toEqual(['wechatpay']);
    expect(offeredRails(['wechatpay'], false)).toEqual([]);
    expect(offeredRails(['stripe'], false)).toEqual(['stripe']);
    expect(offeredRails([], true)).toEqual([]);
    expect(offeredRails(null, true)).toEqual([]);
    expect(offeredRails(undefined, false)).toEqual([]);
    // Unknown values and repeats are dropped; nothing is invented from the brand.
    expect(offeredRails(['paypal', 'alipay', 'alipay'], true)).toEqual(['alipay']);
  });

  it('monthlyPlan finds the priced monthly plan', () => {
    expect(monthlyPlan(plansView().plans)?.amountMinor).toBe(2499);
    expect(monthlyPlan(unpricedPlansView().plans)).toBeNull();
  });
});

describe('labels', () => {
  it('every plan/bucket key the UI can ask for exists in the English bundle', () => {
    const credits = (en as { credits: Record<string, unknown> }).credits;
    const has = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], credits) !== undefined;
    for (const brand of ['roboapply', 'goapply'] as const) {
      for (const p of plansView(brand).plans) expect(has(planNameKey(brand, p.key)!)).toBe(true);
    }
    for (const b of Object.keys(creditsResponse().summary.buckets)) expect(has(bucketLabelKey(b))).toBe(true);
    expect(has(bucketLabelKey('practice'))).toBe(true);
    expect(bucketLabelKey('mystery')).toBe('buckets.unknown');
    expect(planNameKey('roboapply', 'starter')).toBe('plans.legacy');
    expect(planNameKey('roboapply', 'nope')).toBeNull();
  });

  it('copy never says "unlimited"', () => {
    expect(JSON.stringify(en).toLowerCase()).not.toContain('unlimited');
  });

  it('price periods and months', () => {
    const plans = plansView().plans;
    const by = (k: string) => plans.find((p) => p.key === k)!;
    expect(pricePeriod(by('pro_weekly'))).toBe('week');
    expect(pricePeriod(by('pro_quarterly'))).toBe('quarter');
    expect(pricePeriod(by('pro_week_pass'))).toBe('once');
    expect(planMonths(by('pro_quarterly'))).toBe(3);
    expect(planMonths(by('pro_monthly'))).toBe(0);
  });
});

describe('deriveSubscriptionState', () => {
  const legacyPlan = (status = 'active', over: Partial<BillingPlanResponse['current']> = {}): BillingPlanResponse =>
    ({
      region: { market: 'other', currency: 'USD', method: 'stripe', source: 'brand' },
      current: { tier: 'starter', status, amountMinor: 1500, currency: 'USD', currentPeriodEnd: '2026-11-01T00:00:00Z', cancelAtPeriodEnd: false, hasStripeCustomer: true, manualRenewal: false, ...over },
      credits: { balance: 4, periodAllotment: 10, tier: 'starter' },
      plans: [],
      stripeConfigured: true,
      alipayConfigured: false,
    }) as BillingPlanResponse;

  it('loading → unknown, never "Free"', () => {
    const s = deriveSubscriptionState({ summary: null });
    expect(s.status).toBe('loading');
    expect(s.profile).toBeNull();
    expect(s.practiceBalance).toBeNull();
  });

  it('monthly Pro auto-renews; past_due is a payment failure', () => {
    const s = deriveSubscriptionState({
      summary: creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z' }).summary,
      legacyPlan: legacyPlan('past_due', { tier: 'free' }),
    });
    expect(s.autoRenews).toBe(true);
    expect(s.paymentFailed).toBe(true);
    expect(s.hasPortal).toBe(true);
  });

  it('a pass does not renew; a legacy Stripe plan does', () => {
    const pass = deriveSubscriptionState({ summary: creditsResponse({ planKey: 'pro_week_pass', planProfile: 'pro', interval: 'pass' }).summary });
    expect(pass.autoRenews).toBe(false);
    expect(pass.isPass).toBe(true);
    const legacy = deriveSubscriptionState({ summary: creditsResponse({ planKey: 'starter', legacyPlan: true }).summary, legacyPlan: legacyPlan() });
    expect(legacy.legacy).toBe(true);
    expect(legacy.autoRenews).toBe(true);
    expect(legacy.periodEnd).toBe('2026-11-01T00:00:00Z');
  });

  it('error state surfaces', () => {
    expect(deriveSubscriptionState({ summary: null, summaryError: true }).status).toBe('error');
  });

  it('a cancelled subscription is still an auto-renewing plan type but will NOT renew', () => {
    const monthly = creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }).summary;
    const cancelled = deriveSubscriptionState({ summary: { ...monthly, cancelAtPeriodEnd: true }, legacyPlan: legacyPlan('active', { tier: 'free' }) });
    expect(cancelled.autoRenews).toBe(true);
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    expect(cancelled.willRenew).toBe(false);
    const running = deriveSubscriptionState({ summary: monthly, legacyPlan: legacyPlan('active', { tier: 'free' }) });
    expect(running.willRenew).toBe(true);
  });

  it('cancel-at-period-end is read from the summary only; the legacy plan is not a second opinion', () => {
    const base = creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }).summary;
    // The summary says cancelled, the legacy plan (stale) says renewing: cancelled.
    const cancelled = deriveSubscriptionState({ summary: { ...base, cancelAtPeriodEnd: true }, legacyPlan: legacyPlan('active', { cancelAtPeriodEnd: false }) });
    expect([cancelled.cancelAtPeriodEnd, cancelled.willRenew]).toEqual([true, false]);
    // The summary says it renews, the legacy plan says cancelled: it renews.
    const renewing = deriveSubscriptionState({ summary: { ...base, cancelAtPeriodEnd: false }, legacyPlan: legacyPlan('active', { cancelAtPeriodEnd: true }) });
    expect([renewing.cancelAtPeriodEnd, renewing.willRenew]).toEqual([false, true]);
    // No legacy plan at all: the summary is enough.
    expect(deriveSubscriptionState({ summary: { ...base, cancelAtPeriodEnd: true } }).cancelAtPeriodEnd).toBe(true);
  });

  it('summaryCancelAtPeriodEnd keeps "the server did not say" apart from false', () => {
    const summary = creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }).summary;
    expect(summaryCancelAtPeriodEnd({ ...summary, cancelAtPeriodEnd: true })).toBe(true);
    expect(summaryCancelAtPeriodEnd(summary)).toBe(false);
    // An older server during a deploy sends no field.
    const { cancelAtPeriodEnd: _dropped, ...older } = summary;
    expect(summaryCancelAtPeriodEnd(older as typeof summary)).toBeUndefined();
    expect(summaryCancelAtPeriodEnd(null)).toBeUndefined();
    expect(deriveSubscriptionState({ summary: older as typeof summary, legacyPlan: legacyPlan('active', { cancelAtPeriodEnd: true }) }).cancelAtPeriodEnd).toBe(false);
  });
});

describe('deriveSubscriptionState: what the subscription is charged', () => {
  const billing = (amountMinor: number | null, currency: string | null): BillingPlanResponse =>
    ({
      region: { market: 'other', currency: 'USD', method: 'stripe', source: 'brand' },
      current: { tier: 'free', status: 'active', amountMinor, currency, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasStripeCustomer: true, manualRenewal: false },
      credits: { balance: 0, periodAllotment: null, tier: 'free' },
      plans: [],
      stripeConfigured: true,
      alipayConfigured: false,
    }) as BillingPlanResponse;
  const summary = creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }).summary;
  const charged = (amountMinor: number | null, currency: string | null) => {
    const s = deriveSubscriptionState({ summary, legacyPlan: billing(amountMinor, currency) });
    return [s.chargedAmountMinor, s.chargedCurrency];
  };

  it('the billing plan\'s amount and currency, in upper case; both or neither', () => {
    expect(charged(2499, 'usd')).toEqual([2499, 'USD']);
    expect(charged(74900, 'TWD')).toEqual([74900, 'TWD']);
    expect(charged(2499, null)).toEqual([null, null]);
    expect(charged(null, 'USD')).toEqual([null, null]);
    expect(charged(0, 'USD')).toEqual([null, null]);
    expect(charged(24.99, 'USD')).toEqual([null, null]);
    expect(charged(2499, 'dollars')).toEqual([null, null]);
  });

  it('unknown while the billing plan has not arrived', () => {
    const s = deriveSubscriptionState({ summary });
    expect([s.chargedAmountMinor, s.chargedCurrency]).toEqual([null, null]);
  });
});

describe('"Keep my plan": when it is offered and what the box says (ST-6)', () => {
  const NOW = new Date('2026-10-11T12:00:00Z');
  const base = { status: 'ready' as const, profile: 'pro' as const, autoRenews: true, cancelAtPeriodEnd: true, periodEnd: '2026-10-25T00:00:00Z', isPass: false, legacy: false };

  it('only a renewing plan that was cancelled and whose period still runs, on a brand whose plans renew', () => {
    expect(canResumeSubscription(base, 'intl', NOW)).toBe(true);
    expect(canResumeSubscription({ ...base, cancelAtPeriodEnd: false }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, autoRenews: false }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, isPass: true }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, periodEnd: '2026-10-11T11:59:59Z' }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, periodEnd: '2026-10-11T12:00:00Z' }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, periodEnd: null }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, periodEnd: 'not a date' }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...base, status: 'loading' }, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription(base, 'cn', NOW)).toBe(false);
  });

  it('never a grandfathered practice plan: the server keeps no renewal terms for one and refuses the call', () => {
    expect(canResumeSubscription({ ...base, legacy: true }, 'intl', NOW)).toBe(false);
    // As the page derives it: a cancelled legacy Stripe plan renews by itself, has a month interval and a charged amount.
    const legacy = deriveSubscriptionState({
      summary: { ...creditsResponse({ planKey: 'starter', legacyPlan: true, interval: 'month', periodEnd: '2026-10-25T00:00:00Z' }).summary, cancelAtPeriodEnd: true },
      legacyPlan: {
        region: { market: 'other', currency: 'USD', method: 'stripe', source: 'brand' },
        current: { tier: 'starter', status: 'active', amountMinor: 900, currency: 'usd', currentPeriodEnd: '2026-10-25T00:00:00Z', cancelAtPeriodEnd: true, hasStripeCustomer: true, manualRenewal: false },
        credits: { balance: 3, periodAllotment: null, tier: 'starter' },
        plans: [],
        stripeConfigured: true,
        alipayConfigured: false,
      },
    });
    expect([legacy.legacy, legacy.autoRenews, legacy.cancelAtPeriodEnd, legacy.chargedAmountMinor]).toEqual([true, true, true, 900]);
    expect(canResumeSubscription(legacy, 'intl', NOW)).toBe(false);
    expect(canResumeSubscription({ ...legacy, legacy: false }, 'intl', NOW)).toBe(true);
  });

  it('the period is the plan\'s; a pass or an unknown interval has none', () => {
    expect([renewalPeriod('week'), renewalPeriod('month'), renewalPeriod('quarter')]).toEqual(['week', 'month', 'quarter']);
    expect([renewalPeriod('pass'), renewalPeriod(null), renewalPeriod('year'), renewalPeriod(undefined)]).toEqual([null, null, null, null]);
  });

  it('the price is what billing says is charged, and nothing else: no charged price, no sentence (the catalog is never asked)', () => {
    const sub = { interval: 'month' as string | null, chargedAmountMinor: 1999 as number | null, chargedCurrency: 'USD' as string | null };
    expect(resumeTerms(sub)).toEqual({ period: 'month', amountMinor: 1999, currency: 'USD' });
    expect(resumeTerms({ interval: 'quarter', chargedAmountMinor: 164900, chargedCurrency: 'TWD' })).toEqual({ period: 'quarter', amountMinor: 164900, currency: 'TWD' });
    // The billing plan has not answered, failed, or states no amount: all read as "no charged price".
    expect(resumeTerms({ ...sub, chargedAmountMinor: null, chargedCurrency: null })).toBeNull();
    expect(resumeTerms({ ...sub, chargedCurrency: null })).toBeNull();
    // A pass or no period: no sentence.
    expect(resumeTerms({ ...sub, interval: 'pass' })).toBeNull();
    expect(resumeTerms({ ...sub, interval: null })).toBeNull();
    // The function takes no catalog at all.
    expect(resumeTerms.length).toBe(1);
  });

  it('after a refusal, "already ended" is claimed only for a plan that is over: free, a pass, or past its period end', () => {
    const free = { ...base, profile: 'free' as const, autoRenews: false, cancelAtPeriodEnd: false, periodEnd: null };
    expect(subscriptionIsOver(free, NOW)).toBe(true);
    expect(subscriptionIsOver({ ...base, isPass: true, autoRenews: false, cancelAtPeriodEnd: false }, NOW)).toBe(true);
    expect(subscriptionIsOver({ ...base, periodEnd: '2026-10-11T11:59:59Z' }, NOW)).toBe(true);
    expect(subscriptionIsOver({ ...base, periodEnd: '2026-10-11T12:00:00Z' }, NOW)).toBe(true);
    // It renews again (kept in another tab): not over.
    expect(subscriptionIsOver({ ...base, cancelAtPeriodEnd: false }, NOW)).toBe(false);
    // Still cancelled and running: not over.
    expect(subscriptionIsOver(base, NOW)).toBe(false);
    // Not known: no claim.
    expect(subscriptionIsOver({ ...free, status: 'loading' }, NOW)).toBe(false);
    expect(subscriptionIsOver({ ...free, status: 'error' }, NOW)).toBe(false);
    expect(subscriptionIsOver({ ...base, periodEnd: null }, NOW)).toBe(false);
    expect(subscriptionIsOver({ ...base, periodEnd: 'not a date' }, NOW)).toBe(false);
    // A paid plan with a period the page does not know is not called ended.
    expect(subscriptionIsOver({ ...base, autoRenews: false, cancelAtPeriodEnd: false }, NOW)).toBe(false);
  });
});

describe('the plan sheet for a subscriber (ST-5) and for a mainland visitor (AL-6)', () => {
  const plans = visiblePlans(plansView().plans);
  const keys = (list: ReturnType<typeof offeredProPlans>) => list.map((p) => p.key);
  const state = (over: Partial<Parameters<typeof offeredProPlans>[1]> = {}) => ({ onProSubscription: false, cancelAtPeriodEnd: false, currentKey: null, ...over });

  it('no renewing Pro subscription: every subscription and pass', () => {
    expect(keys(offeredProPlans(plans, state(), null))).toEqual(['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass']);
  });

  it('a Pro subscription that renews: every subscription (theirs and the switches); a pass only by link', () => {
    const on = state({ onProSubscription: true, currentKey: 'pro_monthly' });
    expect(keys(offeredProPlans(plans, on, null))).toEqual(['pro_weekly', 'pro_monthly', 'pro_quarterly']);
    expect(keys(offeredProPlans(plans, on, 'pro_week_pass'))).toEqual(['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass']);
  });

  it('a cancelled Pro subscription that still runs: the passes only', () => {
    const cancelled = state({ onProSubscription: true, cancelAtPeriodEnd: true, currentKey: 'pro_monthly' });
    expect(keys(offeredProPlans(plans, cancelled, null))).toEqual(['pro_week_pass']);
    expect(keys(offeredProPlans(plans, cancelled, 'pro_quarterly'))).toEqual(['pro_week_pass']);
  });

  it('packs are never part of the Pro options', () => {
    expect(offeredProPlans(plans, state(), null).some((p) => p.kind === 'pack')).toBe(false);
  });

  it('the mainland line: only country CN on the international brand, to the other brand\'s own origin', () => {
    const ra = clientBrandFor('roboapply');
    const ga = clientBrandFor('goapply');
    expect(CN_VISITOR_COUNTRY).toBe('CN');
    expect(cnVisitorPricingUrl(ra, 'CN')).toBe(`${ra.otherBrand.canonicalOrigin}/pricing`);
    expect(cnVisitorPricingUrl(ra, 'CN')).toBe('https://www.goapply.top/pricing');
    for (const country of ['TW', 'HK', 'MO', 'US', 'cn', 'CHN', '', null, undefined]) expect(cnVisitorPricingUrl(ra, country), String(country)).toBeNull();
    expect(cnVisitorPricingUrl(ga, 'CN')).toBeNull();
    // The address comes from the brand payload: another origin gives another link, a broken one gives none.
    expect(cnVisitorPricingUrl({ market: 'intl', otherBrand: { canonicalOrigin: 'https://cn.example.test/' } }, 'CN')).toBe('https://cn.example.test/pricing');
    for (const origin of ['', 'javascript:alert(1)', 'http://www.goapply.top', 'https://www.goapply.top/path', '//www.goapply.top']) {
      expect(cnVisitorPricingUrl({ market: 'intl', otherBrand: { canonicalOrigin: origin } }, 'CN'), origin).toBeNull();
    }
  });

  it('the staged line names the other brand by token, in English and in Chinese, with one link', () => {
    const enLine = stagedCredits.credits.planSheet.cnVisitor;
    const zhLine = stagedCreditsZh.credits.planSheet.cnVisitor;
    expect(enLine).toBe('In mainland China? <link>You can pay in RMB with Alipay on %OTHER_BRAND%.</link>');
    expect(zhLine).toBe('在中国大陆？<link>可在 %OTHER_BRAND% 用支付宝以人民币付款。</link>');
    for (const line of [enLine, zhLine]) {
      expect(line).not.toMatch(/GoApply|RoboApply|goapply\.top|roboapply\.io|https?:/i);
      expect(line.match(/<link>/g)).toHaveLength(1);
    }
  });

  it('the new lifecycle copy states no amount, date or plan name (they come from the API)', () => {
    const { planSheet, quote, resume } = stagedCredits.credits;
    for (const text of [planSheet.portalScope, planSheet.cnVisitor, ...Object.values(quote), ...Object.values(resume)]) {
      expect(text).not.toMatch(/[0-9$¥€£]/);
      expect(text).not.toMatch(/—|Weekly|Monthly|Quarterly/);
    }
  });
});

describe('return-page reconcile: which refusals end the calls (ST-3)', () => {
  const err = (code: string, status: number) => new RoboApiError('failed', { code, status, payload: { success: false, code } });

  it('the page re-reads every 3 s, 10 times, and hands the session over again on every third', () => {
    expect([RETURN_POLL_MS, RETURN_POLL_ATTEMPTS, RETURN_RECONCILE_EVERY]).toEqual([3000, 10, 3]);
  });

  it('an answer asking again cannot change is final; a passing one is not', () => {
    for (const [code, status] of [['forbidden', 403], ['not_found', 404], ['invalid_request', 422], ['stripe_not_configured', 503]] as const) {
      expect(reconcileRefusalIsFinal(err(code, status)), code).toBe(true);
    }
    for (const [code, status] of [['rate_limited', 429], ['payment_provider_error', 502], ['server_error', 500]] as const) {
      expect(reconcileRefusalIsFinal(err(code, status)), code).toBe(false);
    }
    // A route that is not there yet (the server half not deployed) answers 404 with any code, or none.
    expect(reconcileRefusalIsFinal(new RoboApiError('nope', { status: 404 }))).toBe(true);
    expect(reconcileRefusalIsFinal(new Error('network'))).toBe(false);
    expect(reconcileRefusalIsFinal(null)).toBe(false);
  });
});

describe('checkout return path', () => {
  it('names the plan; a pack also carries the practice balance before checkout', () => {
    expect(checkoutReturnPath({ key: 'pro_monthly', kind: 'subscription' }, 3)).toBe('/settings/billing/return?plan=pro_monthly');
    expect(checkoutReturnPath({ key: 'practice_pack_5', kind: 'pack' }, 3)).toBe('/settings/billing/return?plan=practice_pack_5&practiceBefore=3');
    expect(checkoutReturnPath({ key: 'practice_pack_5', kind: 'pack' }, null)).toBe('/settings/billing/return?plan=practice_pack_5');
    expect(isPackKey('practice_pack_15')).toBe(true);
    expect(isPackKey('pro_week_pass')).toBe(false);
    expect(isPackKey(null)).toBe(false);
  });
});

describe('credits copy makes no claims the server does not back', () => {
  it('no fixed refill time and no hard-coded practice length', () => {
    const json = JSON.stringify({ usage: en.credits.usage, outOfCredits: en.credits.outOfCredits });
    expect(json).not.toMatch(/midnight/i);
    expect(json).not.toMatch(/\d+ minutes/);
    expect(en.credits.outOfCredits.practiceTitle).not.toMatch(/today|refill/i);
  });
});

describe('checkout redirect (the shared CheckoutResponse contract)', () => {
  it('a redirect answer gives its page address, whichever rail took the order', () => {
    expect(checkoutRedirectUrl({ kind: 'redirect', url: 'https://checkout.stripe.com/x', orderId: 'cs_1', rail: 'stripe' })).toBe('https://checkout.stripe.com/x');
    expect(checkoutRedirectUrl({ kind: 'redirect', url: 'https://pay.example/x', orderId: null, rail: 'alipay' })).toBe('https://pay.example/x');
    expect(checkoutRedirectUrl({ kind: 'redirect', url: 'https://wx.tenpay.com/checkmweb?prepay_id=1', orderId: 'GAWX1', rail: 'wechatpay' })).toBe('https://wx.tenpay.com/checkmweb?prepay_id=1');
  });

  it('a payment code or in-app cashier answer is never somewhere to navigate', () => {
    expect(checkoutRedirectUrl({ kind: 'qr', qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc', orderId: 'GAWX1', rail: 'wechatpay' })).toBeNull();
    expect(checkoutRedirectUrl({ kind: 'jsapi', jsapiParams: { appId: 'wx' }, orderId: 'GAWX1', rail: 'wechatpay' })).toBeNull();
    expect(checkoutRedirectUrl(null)).toBeNull();
    expect(checkoutRedirectUrl(undefined)).toBeNull();
  });

  it('only http(s) pages are opened', () => {
    expect(checkoutRedirectUrl({ kind: 'redirect', url: 'weixin://wxpay/bizpayurl?pr=abc', orderId: 'GAWX1', rail: 'wechatpay' })).toBeNull();
    expect(checkoutRedirectUrl({ kind: 'redirect', url: 'javascript:alert(1)', orderId: null, rail: 'stripe' })).toBeNull();
    expect(checkoutRedirectUrl({ kind: 'redirect', url: '', orderId: null, rail: 'stripe' })).toBeNull();
  });
});

describe('admin caps document', () => {
  const stored = {
    version: 1,
    brands: {
      roboapply: { buckets: { tailor: { free: { cap: 3, window: 'day' }, grantable: true } }, entitlements: { pro: { saved_searches: 12 } } },
      goapply: { buckets: { tailor: { free: { cap: 4 } } } },
    },
  };

  it('reads caps into a draft', () => {
    const d = draftFromOverride(stored, 'roboapply');
    expect(d.tailor).toEqual({ free: '3', pro: '' });
    expect(d.fit_analysis).toEqual({ free: '', pro: '' });
    expect(draftFromOverride('garbage', 'roboapply').tailor).toEqual({ free: '', pro: '' });
  });

  it('applies a draft, keeping windows, grantable, entitlements and the other brand', () => {
    const d = draftFromOverride(stored, 'roboapply');
    d.tailor.pro = '60';
    d.fit_analysis.free = '12';
    const next = applyDraft(stored, 'roboapply', d) as typeof stored & { brands: { roboapply: { buckets: Record<string, unknown> } } };
    expect(next.brands.roboapply.buckets.tailor).toEqual({ free: { cap: 3, window: 'day' }, pro: { cap: 60 }, grantable: true });
    expect(next.brands.roboapply.buckets.fit_analysis).toEqual({ free: { cap: 12 } });
    expect(next.brands.roboapply.entitlements).toEqual({ pro: { saved_searches: 12 } });
    expect(next.brands.goapply).toEqual(stored.brands.goapply);
    // input untouched
    expect(stored.brands.roboapply.buckets.tailor).toEqual({ free: { cap: 3, window: 'day' }, grantable: true });
  });

  it('an emptied cell returns to the default and empty objects are pruned', () => {
    const d = draftFromOverride(stored, 'goapply');
    d.tailor.free = '';
    const next = applyDraft(stored, 'goapply', d) as { brands: Record<string, unknown> };
    expect(next.brands.goapply).toBeUndefined();
    expect(applyDraft(undefined, 'roboapply', draftFromOverride(undefined, 'roboapply'))).toEqual({ version: 1, brands: {} });
  });

  it('validates caps and override values', () => {
    const d = draftFromOverride(undefined, 'roboapply');
    d.tailor.free = '1.5';
    d.rewrite.pro = '10001';
    d.assistant.free = '40';
    expect(invalidCells(d).sort()).toEqual(['rewrite.pro', 'tailor.free']);
    expect(parseOverrideValue('true')).toBe(true);
    expect(parseOverrideValue('25')).toBe(25);
    expect(parseOverrideValue('deeplinks_only')).toBe('deeplinks_only');
    expect(parseOverrideValue('-1')).toBeNull();
    expect(revenueShare(420000, 600000)).toBe(70);
    expect(revenueShare(null, 600000)).toBeNull();
  });
});

describe('refill times say which day they mean (FIX-9)', () => {
  const SUNDAY_MORNING = new Date('2026-10-11T02:00:00.000Z'); // Sunday 10:00 in Shanghai
  const MONDAY_MIDNIGHT = new Date('2026-10-11T16:00:00.000Z'); // Monday 00:00 in Shanghai

  it('counts calendar days on the wall clock of the given zone', () => {
    expect(calendarDaysUntil(MONDAY_MIDNIGHT, SUNDAY_MORNING, 'Asia/Shanghai')).toBe(1);
    // The same two instants are the same calendar day in UTC.
    expect(calendarDaysUntil(MONDAY_MIDNIGHT, SUNDAY_MORNING, 'UTC')).toBe(0);
    expect(calendarDaysUntil(new Date('2026-11-01T00:00:00Z'), new Date('2026-10-31T23:59:00Z'), 'UTC')).toBe(1);
    expect(calendarDaysUntil(new Date('2027-01-01T00:00:00Z'), new Date('2026-12-25T12:00:00Z'), 'UTC')).toBe(7);
  });

  it('the next day reads "tomorrow" with the time; a daily refill is midnight in the account zone', () => {
    const base = { at: MONDAY_MIDNIGHT, now: SUNDAY_MORNING, timeZone: 'Asia/Shanghai' };
    expect(refillLabel({ ...base, locale: 'en' })).toBe('tomorrow 12:00 AM');
    expect(refillLabel({ ...base, locale: 'zh' })).toMatch(/^明天 0?0:00$/);
    expect(refillLabel({ ...base, locale: 'ja' })).toMatch(/^明日 0:00$/);
    // New York: local midnight is 04:00 UTC; shown as midnight, not "4:00 AM".
    expect(refillLabel({ at: new Date('2026-10-12T04:00:00Z'), now: new Date('2026-10-11T15:00:00Z'), locale: 'en', timeZone: 'America/New_York' })).toBe(
      'tomorrow 12:00 AM',
    );
  });

  it('a later refill carries the weekday WITH its date; later the same day is a bare time', () => {
    expect(refillLabel({ at: new Date('2026-10-18T16:00:00Z'), now: SUNDAY_MORNING, locale: 'en', timeZone: 'Asia/Shanghai' })).toBe('Mon, Oct 19, 12:00 AM');
    expect(refillLabel({ at: new Date('2026-10-18T16:00:00Z'), now: SUNDAY_MORNING, locale: 'zh', timeZone: 'Asia/Shanghai' })).toMatch(/10月19日周一/);
    expect(refillLabel({ at: new Date('2026-10-11T15:30:00Z'), now: SUNDAY_MORNING, locale: 'en', timeZone: 'Asia/Shanghai' })).toBe('11:30 PM');
  });

  it('a time that has already passed never reads "tomorrow": it is shown with its date', () => {
    expect(refillLabel({ at: new Date('2026-10-10T16:00:00Z'), now: SUNDAY_MORNING, locale: 'en', timeZone: 'Asia/Shanghai' })).toBe('Sun, Oct 11, 12:00 AM');
  });

  it('an unknown zone falls back instead of throwing', () => {
    expect(knownTimeZone('Asia/Shanghai', 'UTC')).toBe('Asia/Shanghai');
    expect(knownTimeZone('Not/AZone', 'UTC')).toBe('UTC');
    expect(knownTimeZone(null, undefined)).toBeUndefined();
    expect(() => refillLabel({ at: MONDAY_MIDNIGHT, now: SUNDAY_MORNING, locale: 'en', timeZone: 'Not/AZone' })).not.toThrow();
  });
});
