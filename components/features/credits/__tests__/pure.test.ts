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
import { checkoutReturnPath, offeredRails } from '../PlanPicker';
import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import { isPackKey } from '../CheckoutReturn';
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
