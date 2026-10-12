// @vitest-environment node
//
// Billing V2 (WP-79): Taiwan prices from env (hidden until an amount is set),
// student plans (computed discount; checkout only for verified students),
// Stripe promotion codes (off by default, never on student plans), the
// TWD-only revenue line, and the one winback email (30 days after churn,
// marketing consent only, once ever).

import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../brand/registry.js';
import { createEmailTranslator, resetEmailI18nCache, setEmailI18nDirForTests } from '../email/i18n.js';
import { createBudget } from '../queue/runForBudget.js';
import { getPlan, getPlanCatalog, planKeyForStripePrice, studentDiscountPercent, twdPriceFor } from './planCatalog.js';
import { buyerCountryFromRequest } from './buyerCountry.js';
import { acceptsPromotionCode, buildPlanViews, usesTwdPrice } from './planViews.js';
import { createStripeRail } from './rails/stripe.js';
import type { CheckoutOrder } from './rails/types.js';
import { computeTwRevenue } from './twRevenue.js';
import { quoteSwitch, switchPriceFor, type BillingAccount, type BillingDb } from './subscriptions.js';
import { WINBACK_TEMPLATE, createWinbackSweep, winbackEmail, winbackPrice, type WinbackDb } from './winback.js';

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd',
  STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '74900',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
  STRIPE_PRICE_PRO_QUARTERLY_TWD: 'price_q_twd',
  STRIPE_PRICE_PRO_QUARTERLY_TWD_CENTS: '179000',
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  // Weekly has a TWD pin but no amount: not configured (the amount is what makes a Taiwan price).
  STRIPE_PRICE_PRO_WEEKLY_TWD: 'price_w_twd',
  STRIPE_PRICE_STUDENT_MONTHLY: 'price_sm',
  STRIPE_PRICE_STUDENT_MONTHLY_CENTS: '1749',
  STRIPE_PRICE_STUDENT_QUARTERLY: 'price_sq',
  STRIPE_PRICE_STUDENT_QUARTERLY_CENTS: '5999',
};

describe('Taiwan prices', () => {
  it('are hidden until a TWD amount is set; the price id is an optional pin', () => {
    expect(twdPriceFor('pro_monthly', ENV)).toEqual({ currency: 'TWD', amountMinor: 74900, stripePriceId: 'price_m_twd' });
    expect(twdPriceFor('pro_weekly', ENV)).toBeNull();
    expect(twdPriceFor('pro_monthly', {})).toBeNull();
    // The amount alone is a Taiwan price: its Stripe price is resolved by the catalog sync at checkout.
    expect(twdPriceFor('pro_monthly', { PRICE_PRO_MONTHLY_TWD_CENTS: '74900' })).toEqual({ currency: 'TWD', amountMinor: 74900, stripePriceId: null });
    expect(getPlan('roboapply', 'pro_monthly', { ...ENV, STRIPE_PRICE_PRO_MONTHLY_TWD: '' })!.twdPrice).toEqual({ currency: 'TWD', amountMinor: 74900, stripePriceId: null });
    // The price list does not depend on the rail: a plan that cannot be bought now still lists its Taiwan price.
    expect(getPlan('roboapply', 'pro_monthly', { STRIPE_PRICE_PRO_MONTHLY_TWD: 'x', STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '74900' })).toMatchObject({
      sellable: false,
      unsellableReason: 'payments_disabled',
      twdPrice: { currency: 'TWD', amountMinor: 74900, stripePriceId: 'x' },
    });
    // GoApply never sells in TWD.
    expect(getPlanCatalog('goapply', ENV).every((p) => p.twdPrice === null)).toBe(true);
  });

  it('a TWD plan view with a null price id: the amount alone shows the Taiwan price, with savings computed in TWD', () => {
    const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', PRICE_PRO_MONTHLY_TWD_CENTS: '74900', PRICE_PRO_QUARTERLY_TWD_CENTS: '165000' };
    const tw = buildPlanViews('roboapply', { env, country: 'TW' }).plans;
    const q = tw.find((p) => p.key === 'pro_quarterly')!;
    expect(q.twdPrice).toEqual({ currency: 'TWD', amountMinor: 165000, stripePriceId: null });
    expect(q.localPrice).toEqual({ currency: 'TWD', amountMinor: 165000, savingsPercent: 26, monthlyEquivalentMinor: null, studentDiscountPercent: null });
    expect(usesTwdPrice(q, 'TW')).toBe(true);
    expect(usesTwdPrice(q, 'US')).toBe(false);
    expect(tw.find((p) => p.key === 'pro_weekly')!.localPrice).toBeNull();
  });

  it('show only to Taiwan buyers, with savings computed in TWD', () => {
    const tw = buildPlanViews('roboapply', { env: ENV, country: 'tw' }).plans;
    const us = buildPlanViews('roboapply', { env: ENV, country: 'US' }).plans;
    const q = tw.find((p) => p.key === 'pro_quarterly')!;
    expect(q.localPrice).toEqual({ currency: 'TWD', amountMinor: 179000, savingsPercent: 20, monthlyEquivalentMinor: null, studentDiscountPercent: null });
    expect(tw.find((p) => p.key === 'pro_weekly')!.localPrice).toBeNull();
    expect(us.every((p) => p.localPrice === null)).toBe(true);
    expect(buildPlanViews('roboapply', { env: ENV }).plans.every((p) => p.localPrice === null)).toBe(true);
  });

  it('reconcile in the webhook by either price id', () => {
    expect(planKeyForStripePrice('price_m_twd', ENV)).toBe('pro_monthly');
    expect(planKeyForStripePrice('price_m', ENV)).toBe('pro_monthly');
  });

  it('count exactly in the TW revenue monitor without a USD rate when every charge is TWD', async () => {
    const r = await computeTwRevenue({
      stripe: {
        charges: {
          list: async () => ({
            data: [{ id: 'ch_1', amount: 74900, currency: 'twd', created: 1, payment_method_details: { card: { country: 'TW' } } }],
            has_more: false,
          }),
        },
      },
      fx: null,
      now: new Date('2026-10-10T00:00:00Z'),
    });
    expect([r.revenueTwd, r.revenueTwdChargesWhole, r.warning]).toEqual([749, 749, false]);
  });
});

describe('student plans', () => {
  it('show a discount computed from the configured prices, rounded down', () => {
    const catalog = getPlanCatalog('roboapply', ENV);
    expect(studentDiscountPercent(getPlan('roboapply', 'student_monthly', ENV)!, catalog)).toBe(30); // 1749 vs 2499 = 30.01%
    expect(studentDiscountPercent(getPlan('roboapply', 'student_quarterly', ENV)!, catalog)).toBeNull(); // same price: no saving claimed
    // With no price variable the catalog defaults answer: 1749 vs 2499.
    expect(studentDiscountPercent(getPlan('roboapply', 'student_monthly', {})!, getPlanCatalog('roboapply', {}))).toBe(30);
  });

  it('are listed only with the student capability on', () => {
    expect(buildPlanViews('roboapply', { env: ENV }).plans.some((p) => p.key.startsWith('student_'))).toBe(false);
    const views = buildPlanViews('roboapply', { env: ENV, studentEnabled: true }).plans;
    expect(views.find((p) => p.key === 'student_monthly')!.studentDiscountPercent).toBe(30);
    expect(views.find((p) => p.key === 'pro_monthly')!.studentDiscountPercent).toBeNull();
  });

  it('compute the Taiwan discount from the two TWD prices, not the USD ratio', () => {
    const env = { ...ENV, STRIPE_PRICE_STUDENT_MONTHLY_TWD: 'price_sm_twd', STRIPE_PRICE_STUDENT_MONTHLY_TWD_CENTS: '59900' };
    const views = buildPlanViews('roboapply', { env, studentEnabled: true, country: 'TW' }).plans;
    const student = views.find((p) => p.key === 'student_monthly')!;
    expect(student.studentDiscountPercent).toBe(30); // USD: 1749 vs 2499
    expect(student.localPrice).toMatchObject({ currency: 'TWD', amountMinor: 59900, studentDiscountPercent: 20 }); // 599 vs 749 = 20.03%
    // A TWD student price with no TWD regular price: no percentage claimed in TWD.
    const noBase = { ...env, STRIPE_PRICE_PRO_MONTHLY_TWD: '', STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '' };
    const lone = buildPlanViews('roboapply', { env: noBase, studentEnabled: true, country: 'TW' }).plans.find((p) => p.key === 'student_monthly')!;
    expect(lone.localPrice).toMatchObject({ currency: 'TWD', studentDiscountPercent: null });
  });
});

describe('promotion codes', () => {
  it('are off by default and never on student plans', () => {
    const monthly = getPlan('roboapply', 'pro_monthly', ENV)!;
    const student = getPlan('roboapply', 'student_monthly', ENV)!;
    expect(acceptsPromotionCode(monthly, ENV)).toBe(false);
    const on = { ...ENV, STRIPE_PROMOTION_CODES: 'true' };
    expect(acceptsPromotionCode(monthly, on)).toBe(true);
    expect(acceptsPromotionCode(student, on)).toBe(false);
    expect(acceptsPromotionCode(getPlan('goapply', 'pro_monthly', on)!, on)).toBe(false);
    expect(buildPlanViews('roboapply', { env: on }).plans.find((p) => p.key === 'pro_monthly')!.promotionCodes).toBe(true);
  });
});

describe('Stripe checkout (V2 rules)', () => {
  function stripe() {
    return {
      customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
      checkout: { sessions: { create: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })) } },
    };
  }
  function order(planKey: string, env: Record<string, string>, over: Partial<CheckoutOrder> = {}): CheckoutOrder {
    return {
      brand: getBrand('roboapply'),
      plan: getPlan('roboapply', planKey as never, env)!,
      user: { id: 'u1', email: 'u@example.test', name: null },
      seekerProfileId: 'sp_1',
      stripeCustomerId: 'cus_1',
      acknowledgements: { autoRenewAck: true, withdrawalWaiver: false },
      ...over,
    };
  }

  it('refuses a student plan unless the buyer is a verified student', async () => {
    const s = stripe();
    const rail = createStripeRail({ getStripe: () => s as never, env: ENV });
    await expect(rail.createCheckout(order('student_monthly', ENV))).rejects.toMatchObject({ code: 'student_verification_required', status: 409 });
    await expect(rail.createCheckout(order('student_monthly', ENV, { studentVerified: false }))).rejects.toMatchObject({ code: 'student_verification_required' });
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
    await rail.createCheckout(order('student_monthly', ENV, { studentVerified: true }));
    const params = s.checkout.sessions.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.line_items).toEqual([{ price: 'price_sm', quantity: 1 }]);
  });

  it('charges the TWD price to a Taiwan buyer only when it is configured', async () => {
    const s = stripe();
    const rail = createStripeRail({ getStripe: () => s as never, env: ENV });
    await rail.createCheckout(order('pro_monthly', ENV, { country: 'TW' }));
    await rail.createCheckout(order('pro_weekly', ENV, { country: 'TW' }));
    await rail.createCheckout(order('pro_monthly', ENV, { country: 'US' }));
    const calls = s.checkout.sessions.create.mock.calls.map((c) => c[0] as { line_items: unknown; metadata: Record<string, string> });
    expect(calls.map((c) => c.line_items)).toEqual([[{ price: 'price_m_twd', quantity: 1 }], [{ price: 'price_w', quantity: 1 }], [{ price: 'price_m', quantity: 1 }]]);
    expect(calls.map((c) => c.metadata.currency)).toEqual(['twd', 'usd', 'usd']);
    expect(usesTwdPrice(getPlan('roboapply', 'pro_monthly', ENV)!, null)).toBe(false);
  });

  it('allows promotion codes only when switched on, and not for students', async () => {
    const on = { ...ENV, STRIPE_PROMOTION_CODES: 'true' };
    const s = stripe();
    const rail = createStripeRail({ getStripe: () => s as never, env: on });
    await rail.createCheckout(order('pro_monthly', on));
    await rail.createCheckout(order('student_monthly', on, { studentVerified: true }));
    const flags = s.checkout.sessions.create.mock.calls.map((c) => (c[0] as { allow_promotion_codes: boolean }).allow_promotion_codes);
    expect(flags).toEqual([true, false]);
    const off = stripe();
    await createStripeRail({ getStripe: () => off as never, env: ENV }).createCheckout(order('pro_monthly', ENV));
    expect((off.checkout.sessions.create.mock.calls[0]![0] as { allow_promotion_codes: boolean }).allow_promotion_codes).toBe(false);
  });
});

describe('switching plans (V2 rules)', () => {
  const NOW_S = new Date('2026-10-10T12:00:00Z');
  function account(): BillingAccount {
    return {
      userId: 'u1',
      email: 'u@example.test',
      name: null,
      brand: 'roboapply',
      seekerProfileId: 'sp_1',
      locale: 'en',
      market: 'intl',
      subscription: {
        id: 's1', tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', rail: 'stripe', brand: 'roboapply', market: null,
        currency: 'USD', amountMinor: 2499, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripePriceId: 'price_m',
        currentPeriodEnd: new Date(NOW_S.getTime() + 10 * 86_400_000), cancelAtPeriodEnd: false, startedAt: null, billingCountry: null,
      },
    };
  }
  function stripe(currency: string) {
    return {
      subscriptions: { retrieve: vi.fn(async () => ({ id: 'sub_1', currency, customer: 'cus_1', items: { data: [{ id: 'si_1', current_period_end: 1_800_000_000 }] } })) },
      invoices: { createPreview: vi.fn(async () => ({ currency, amount_due: 100, lines: { data: [] } })) },
    };
  }
  const deps = (s: ReturnType<typeof stripe>, studentVerified?: boolean) => ({ getStripe: () => s as never, db: {} as BillingDb, now: () => NOW_S, studentVerified });

  it('refuses a switch to a student plan unless the student is verified', async () => {
    const target = getPlan('roboapply', 'student_monthly', ENV)!;
    const s = stripe('usd');
    await expect(quoteSwitch(account(), target, deps(s))).rejects.toMatchObject({ code: 'student_verification_required' });
    expect(s.subscriptions.retrieve).not.toHaveBeenCalled();
    await expect(quoteSwitch(account(), target, deps(s, true))).resolves.toMatchObject({ planKey: 'student_monthly', newRenewalPriceMinor: 1749 });
  });

  it('keeps a Taiwan subscription in TWD, or refuses when the target has no TWD price', async () => {
    const s = stripe('twd');
    const quote = await quoteSwitch(account(), getPlan('roboapply', 'pro_quarterly', ENV)!, deps(s));
    expect(quote).toMatchObject({ currency: 'TWD', newRenewalPriceMinor: 179000 });
    expect(s.invoices.createPreview.mock.calls[0]![0]).toMatchObject({ subscription_details: { items: [{ id: 'si_1', price: 'price_q_twd' }] } });
    // Pinned prices: no Stripe call is made to find them.
    await expect(switchPriceFor(s as never, { currency: 'twd' }, getPlan('roboapply', 'pro_weekly', ENV)!)).rejects.toMatchObject({ code: 'switch_not_available', message: expect.stringMatching(/Taiwan price/) });
    await expect(switchPriceFor(s as never, { currency: 'usd' }, getPlan('roboapply', 'pro_quarterly', ENV)!)).resolves.toEqual({ priceId: 'price_q', amountMinor: 5999, currency: 'USD' });
    await expect(switchPriceFor(s as never, { currency: 'twd' }, getPlan('roboapply', 'pro_monthly', ENV)!)).resolves.toEqual({ priceId: 'price_m_twd', amountMinor: 74900, currency: 'TWD' });
  });
});

describe('buyerCountryFromRequest (the country that decides a price)', () => {
  const from = (headers: Record<string, string | string[]>) => buyerCountryFromRequest({ headers });

  it('the edge\'s own header wins over headers a client can send', () => {
    expect(from({ 'x-vercel-ip-country': 'US', 'cf-ipcountry': 'TW', 'x-country': 'TW', 'x-geo-country': 'TW' })).toBe('US');
    expect(from({ 'x-vercel-ip-country': ' tw ', 'cf-ipcountry': 'US' })).toBe('TW');
    expect(from({ 'x-vercel-ip-country': ['DE', 'TW'] })).toBe('DE');
  });

  it('an unknown edge country is no signal, not a fallback to the client headers', () => {
    expect(from({ 'x-vercel-ip-country': 'XX', 'cf-ipcountry': 'TW' })).toBeNull();
  });

  it('without the edge header it reads the older headers (hosts that do not set it)', () => {
    expect(from({ 'cf-ipcountry': 'TW' })).toBe('TW');
    expect(from({ 'x-vercel-ip-country': '', 'x-country': 'jp' })).toBe('JP');
    expect(from({})).toBeNull();
  });
});

// ── Winback ──────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-10T12:00:00Z');
const DAY = 86_400_000;

interface SubRow {
  id: string;
  canceledAt: Date | null;
  interval: string | null;
  tier: string;
  planKey: string | null;
  status: string;
  brand: string;
  stripeSubscriptionId: string | null;
  seekerProfile: { userId: string; locale: string | null; deletedAt: Date | null; user: { email: string; isActive: boolean } } | null;
}

interface LedgerRow {
  userId: string;
  source: string;
  reason: string;
  metadata: Record<string, unknown> | null;
}

/** A row as the Stripe webhook leaves it after the plan ended (tier/planKey free, interval null). */
function sub(userId: string, endedDaysAgo: number, over: Partial<SubRow> = {}): SubRow {
  return {
    id: `row_${userId}`,
    canceledAt: new Date(NOW.getTime() - endedDaysAgo * DAY),
    interval: null,
    tier: 'free',
    planKey: 'free',
    status: 'canceled',
    brand: 'roboapply',
    stripeSubscriptionId: `sub_${userId}`,
    seekerProfile: { userId, locale: 'en', deletedAt: null, user: { email: `${userId}@example.test`, isActive: true } },
    ...over,
  };
}

/** The credit grant the webhook writes for a paid-up period of that subscription. */
function paidGrant(userId: string, subId = `sub_${userId}`, reason = 'grant_purchase'): LedgerRow {
  return { userId, source: 'stripe', reason, metadata: { planKey: 'pro_monthly', stripeSubscriptionId: subId } };
}

type Cursor = { canceledAt: { gt: Date } } | { canceledAt: Date; id: { gt: string } };

function winbackDb(rows: SubRow[], logged: string[] = [], ledger: LedgerRow[] = rows.map((r) => paidGrant(r.seekerProfile?.userId ?? ''))) {
  const findMany = vi.fn(
    async (args: { where: { brand: string; status: string; canceledAt: { gte: Date; lt: Date }; OR?: Cursor[] }; take: number }) => {
      const after = (r: SubRow) =>
        !args.where.OR ||
        args.where.OR.some((c) =>
          c.canceledAt instanceof Date ? r.canceledAt!.getTime() === c.canceledAt.getTime() && r.id > (c as { id: { gt: string } }).id.gt : r.canceledAt! > c.canceledAt.gt,
        );
      return rows
        .filter(
          (r) =>
            r.brand === args.where.brand &&
            r.status === args.where.status &&
            r.stripeSubscriptionId !== null &&
            r.canceledAt !== null &&
            r.canceledAt >= args.where.canceledAt.gte &&
            r.canceledAt < args.where.canceledAt.lt &&
            after(r),
        )
        .sort((a, b) => a.canceledAt!.getTime() - b.canceledAt!.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, args.take);
    },
  );
  const logFindMany = vi.fn(async (args: { where: { userId: { in: string[] }; template: string } }) =>
    args.where.template === WINBACK_TEMPLATE ? logged.filter((u) => args.where.userId.in.includes(u)).map((userId) => ({ userId })) : [],
  );
  const ledgerFindMany = vi.fn(async (args: { where: { userId: { in: string[] }; source: string; reason: { in: string[] } } }) =>
    ledger.filter((l) => args.where.userId.in.includes(l.userId) && l.source === args.where.source && args.where.reason.in.includes(l.reason)),
  );
  return {
    db: { seekerSubscription: { findMany }, rAEmailLog: { findMany: logFindMany }, mockInterviewCreditLedger: { findMany: ledgerFindMany } } as unknown as WinbackDb,
    findMany,
  };
}

describe('winback sweep', () => {
  const ctx = () => ({ name: 'reminders', brand: getBrand('roboapply'), budget: createBudget(60_000), now: NOW });

  it('emails once, 30–37 days after a paid auto-renewing plan ended, only with marketing consent', async () => {
    const rows = [
      sub('due', 31),
      sub('too_soon', 29),
      sub('too_late', 40),
      sub('no_consent', 32),
      sub('already', 33),
      // A pass has no Stripe subscription id (activation clears it).
      sub('pass', 31, { stripeSubscriptionId: null }),
      sub('deleted', 31, { seekerProfile: { userId: 'deleted', locale: null, deletedAt: NOW, user: { email: 'd@example.test', isActive: true } } }),
      sub('disabled', 31, { seekerProfile: { userId: 'disabled', locale: null, deletedAt: null, user: { email: 'x@example.test', isActive: false } } }),
      sub('live_again', 31, { status: 'active', tier: 'pro', planKey: 'pro_monthly', interval: 'month' }),
      sub('other_brand', 31, { brand: 'goapply' }),
    ];
    const { db } = winbackDb(rows, ['already']);
    const sendEmail = vi.fn(async () => ({ status: 'sent' }));
    const sweep = createWinbackSweep({
      db: async () => db,
      env: () => ENV,
      hasMarketingConsent: async (userId) => userId !== 'no_consent',
      sendEmail,
    });
    const res = await sweep(ctx());
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({
      to: 'due@example.test',
      userId: 'due',
      params: { endedOn: new Date(NOW.getTime() - 31 * DAY), price: '$24.99' },
    });
    expect(res).toMatchObject({ processed: 1 });
  });

  it('skips a checkout that never paid (incomplete_expired is stored as canceled with no credit grant)', async () => {
    const rows = [sub('never_paid', 31), sub('paid', 31), sub('other_sub', 31)];
    // never_paid: no grant. other_sub: a grant for a different (earlier) subscription only.
    const ledger = [paidGrant('paid', 'sub_paid', 'grant_renewal'), paidGrant('other_sub', 'sub_older'), { ...paidGrant('never_paid'), reason: 'grant_free_monthly', source: 'system' }];
    const { db } = winbackDb(rows, [], ledger);
    const sendEmail = vi.fn(async () => ({ status: 'sent' }));
    const sweep = createWinbackSweep({ db: async () => db, env: () => ENV, hasMarketingConsent: async () => true, sendEmail });
    await sweep(ctx());
    expect(sendEmail.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId)).toEqual(['paid']);
  });

  it('pages past more than one batch of skipped rows to reach a sendable one', async () => {
    // 250 churned users without marketing consent ended before the one who has it.
    const rows = Array.from({ length: 250 }, (_, i) => sub(`quiet_${String(i).padStart(3, '0')}`, 36));
    rows.push(sub('reachable', 31));
    const { db, findMany } = winbackDb(rows);
    const sendEmail = vi.fn(async () => ({ status: 'sent' }));
    const sweep = createWinbackSweep({ db: async () => db, env: () => ENV, hasMarketingConsent: async (userId) => userId === 'reachable', sendEmail });
    const res = await sweep(ctx());
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ userId: 'reachable' });
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ processed: 1, scanned: 251 });
  });

  it('says nothing about price when Pro is not on sale', async () => {
    expect(winbackPrice(getBrand('roboapply'), 'en', {})).toBeNull();
    expect(winbackPrice(getBrand('roboapply'), 'en', ENV)).toBe('$24.99');
  });

  it('reports no work quickly', async () => {
    const { db } = winbackDb([]);
    const sweep = createWinbackSweep({ db: async () => db, env: () => ENV, hasMarketingConsent: async () => true, sendEmail: vi.fn() });
    expect(await sweep(ctx())).toEqual({ skipped: 'no_work', processed: 0 });
  });

  describe('email', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'wp79-winback-'));
      mkdirSync(join(dir, 'staging'));
      const root = join(process.cwd(), 'server/src/i18n/email');
      copyFileSync(join(root, 'en.json'), join(dir, 'en.json'));
      copyFileSync(join(root, 'staging/billing.en.json'), join(dir, 'staging/billing.en.json'));
      copyFileSync(join(process.cwd(), 'server/src/i18n/email/staging/accountV2.en.json'), join(dir, 'staging/accountV2.en.json'));
      setEmailI18nDirForTests(dir);
      resetEmailI18nCache();
    });
    afterAll(() => {
      setEmailI18nDirForTests(null);
      resetEmailI18nCache();
    });

    it('is a marketing email with no discount language and an optional price line', () => {
      expect(winbackEmail.category).toBe('marketing');
      const brand = getBrand('roboapply');
      const t = createEmailTranslator(brand, 'en');
      const withPrice = winbackEmail.render({ brand, t, params: { endedOn: new Date('2026-09-09T00:00:00Z'), price: '$24.99' }, origin: 'https://www.roboapply.io' });
      expect(withPrice.bodyText).toContain('$24.99');
      expect(withPrice.bodyText).toContain('https://www.roboapply.io/pricing');
      expect(withPrice.bodyText).not.toMatch(/accountV2\.|billing\./);
      expect(withPrice.bodyText.toLowerCase()).not.toMatch(/discount|% off|limited time|hurry|last chance/);
      const noPrice = winbackEmail.render({ brand, t, params: { endedOn: new Date('2026-09-09T00:00:00Z'), price: null }, origin: 'https://www.roboapply.io' });
      expect(noPrice.bodyText).not.toContain('costs');
    });
  });
});
