// /pricing on both brands, from the plans API alone (PC-4; MARKET_STRATEGY §4).
//
// The fixtures are the default catalog of §4.1 / §4.2 in the wire shape
// `GET /billing/plans` sends. Every amount, label, day count and refund number
// asserted here must come from that response: the cases that change a number
// in the fixture and expect the page to follow are what holds "nothing is
// written in copy or in code".

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ getIndexStats: vi.fn(), getCreditCaps: vi.fn(), sendSupportMessage: vi.fn(), getPlans: vi.fn() }));
const auth = vi.hoisted(() => ({ status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' }));
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => ({ status: auth.status, user: auth.status === 'authenticated' ? { id: 'u1' } : null }) }));
vi.mock('../../../../lib/api/support', () => ({
  getIndexStats: api.getIndexStats,
  getCreditCaps: api.getCreditCaps,
  sendSupportMessage: api.sendSupportMessage,
}));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPlans: api.getPlans }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/pricing',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { DEFAULT_CREDIT_CATALOG } from '../../../../server/src/platform/credits/catalog';
import { capsFromCatalog } from '../../../../server/src/features/support/service';
import { plansBillingFacts } from '../../../../lib/api/account';
import type { PlansView } from '../../../../lib/api/credits';
import type { BrandId } from '../../../../lib/brand/registry.generated';
import {
  REFUND_POLICY,
  plansView,
  refundPolicyFor,
  railNotReadyPlansView,
  studentPlansView,
  unpricedPlansView,
  withBillingFacts,
  withoutBillingFacts,
} from '../../credits/__tests__/fixtures';
import { PricingPage } from '../PricingPage';
import { renderMarketing } from './render';

const ON = { 'ai.text': true, 'jobs.feed': true, 'jobs.alerts': true } as const;
const ENTITY = '测试科技（上海）有限公司';

/** GoApply with a rail that can charge (the Alipay credential is set): every paid plan on sale. */
function goPlans(view: PlansView = plansView('goapply')): PlansView {
  return { ...view, paymentsOpen: true, checkout: { ...view.checkout, rails: ['alipay'] } };
}

function serve(view: PlansView, brand: BrandId = 'roboapply') {
  api.getPlans.mockImplementation(async () => view);
  api.getCreditCaps.mockImplementation(async () => capsFromCatalog(DEFAULT_CREDIT_CATALOG[brand]));
}

async function renderPricing(brand: BrandId = 'roboapply', flags: Record<string, unknown> = ON) {
  const r = renderMarketing(<PricingPage />, { brand, flags });
  await waitFor(() => expect(screen.queryByText('Loading plans…')).toBeNull());
  await waitFor(() => expect(r.container.querySelector('[data-plan]:not([data-plan="free"])')).not.toBeNull());
  const card = (key: string) => r.container.querySelector(`[data-plan="${key}"]`) as HTMLElement;
  return { ...r, card, text: () => r.container.textContent ?? '' };
}

beforeEach(() => {
  serve(withBillingFacts(plansView('roboapply')));
  api.getIndexStats.mockResolvedValue({ openRoles: null, addedThisWeek: null, popularLists: [], asOf: '2026-10-10T00:00:00.000Z', partial: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.status = 'unauthenticated';
});

describe('/pricing, RoboApply: every amount and label from GET /billing/plans (§4.1)', () => {
  it('prints $9.99 / week with "About $43 a month", $24.99 / month, $54.99 / 3 months with "Save 26%", the pass at $9.99 and packs at $9.99 and $24.99', async () => {
    const { card, text, container } = await renderPricing();
    expect(Array.from(container.querySelectorAll('[data-plan]')).map((el) => el.getAttribute('data-plan'))).toEqual([
      'free',
      'pro_weekly',
      'pro_monthly',
      'pro_quarterly',
      'pro_week_pass',
      'practice_pack_5',
      'practice_pack_15',
    ]);
    expect(within(card('free')).getByText('$0')).toBeInTheDocument();
    expect(within(card('pro_weekly')).getByText('$9.99 / week')).toBeInTheDocument();
    expect(card('pro_weekly').querySelector('[data-monthly-equivalent]')).toHaveTextContent(/^About \$43 a month$/);
    expect(within(card('pro_monthly')).getByText('$24.99 / month')).toBeInTheDocument();
    expect(within(card('pro_quarterly')).getByText('$54.99 / 3 months')).toBeInTheDocument();
    expect(card('pro_quarterly').querySelector('[data-savings]')).toHaveTextContent('Save 26% compared with paying monthly');
    expect(within(card('pro_week_pass')).getByText('$9.99, paid once')).toBeInTheDocument();
    expect(within(card('practice_pack_5')).getByText('$9.99, paid once')).toBeInTheDocument();
    expect(within(card('practice_pack_15')).getByText('$24.99, paid once')).toBeInTheDocument();
    // The server's own 4,329-cent figure is never printed: the page and the plan sheet both say $43.
    expect(text()).not.toContain('43.29');
    // Only weekly has the monthly line, only quarterly the saving, and nobody a student percentage.
    expect(container.querySelectorAll('[data-monthly-equivalent]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-savings]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-student-discount]')).toHaveLength(0);
    // Renewal, pass and pack notes with the plan's own numbers.
    expect(within(card('pro_weekly')).getByText('Renews every week until you cancel.')).toBeInTheDocument();
    expect(within(card('pro_quarterly')).getByText('Renews every 3 months until you cancel.')).toBeInTheDocument();
    expect(card('pro_week_pass').querySelector('[data-pass-note]')).toHaveTextContent("7 days of Pro. One payment; it doesn't renew.");
    expect(within(card('practice_pack_15')).getByText('15 practice interviews, usable for 12 months')).toBeInTheDocument();
    expect(card('pro_monthly').querySelector('[data-practice-allowance]')).toHaveTextContent('3 practice interviews each billing period');
    expect(card('pro_quarterly').querySelector('[data-practice-allowance]')).toHaveTextContent('3 practice interviews a month');
    expect(text()).not.toContain('Price not set yet');
    expect(text()).not.toMatch(/Not open yet|Paid plans can't be bought yet/);
  });

  it('the labels follow the amounts: another quarterly price prints another "Save N%", another weekly price another monthly figure', async () => {
    const view = withBillingFacts(plansView('roboapply'));
    serve({
      ...view,
      plans: view.plans.map((p) => (p.key === 'pro_quarterly' ? { ...p, amountMinor: 5999 } : p.key === 'pro_weekly' ? { ...p, amountMinor: 1199 } : p)),
    });
    const { card } = await renderPricing();
    // 19.98% is printed as 19, never rounded up.
    expect(card('pro_quarterly').querySelector('[data-savings]')).toHaveTextContent('Save 19% compared with paying monthly');
    expect(within(card('pro_quarterly')).getByText('$59.99 / 3 months')).toBeInTheDocument();
    // 1,199 × 52 / 12 = 5,195.67 cents → about $52.
    expect(card('pro_weekly').querySelector('[data-monthly-equivalent]')).toHaveTextContent(/^About \$52 a month$/);
    // A quarterly price with no real saving prints no label at all.
    const flat = withBillingFacts(plansView('roboapply'));
    cleanup();
    serve({ ...flat, plans: flat.plans.map((p) => (p.key === 'pro_quarterly' ? { ...p, amountMinor: 7497 } : p)) });
    const again = await renderPricing();
    expect(again.card('pro_quarterly').querySelector('[data-savings]')).toBeNull();
  });

  it('the 7-day pass says "same price as weekly billing" only while the two amounts from the API are equal', async () => {
    const { card, container } = await renderPricing();
    expect(card('pro_week_pass').querySelector('[data-same-price-as-weekly]')).toHaveTextContent('Same price as weekly billing. The pass does not renew; weekly billing does.');
    expect(container.querySelectorAll('[data-same-price-as-weekly]')).toHaveLength(1);
    cleanup();
    const view = withBillingFacts(plansView('roboapply'));
    serve({ ...view, plans: view.plans.map((p) => (p.key === 'pro_week_pass' ? { ...p, amountMinor: 699 } : p)) });
    const cheaper = await renderPricing();
    expect(within(cheaper.card('pro_week_pass')).getByText('$6.99, paid once')).toBeInTheDocument();
    expect(cheaper.container.querySelector('[data-same-price-as-weekly]')).toBeNull();
    cleanup();
    // No weekly plan in the response: nothing to compare with.
    serve({ ...view, plans: view.plans.filter((p) => p.key !== 'pro_weekly') });
    const alone = await renderPricing();
    expect(alone.container.querySelector('[data-same-price-as-weekly]')).toBeNull();
  });

  it('a verified student sees the two student plans at $17.49 and $37.99, each 30% below the regular price', async () => {
    serve(withBillingFacts(studentPlansView('roboapply')));
    const { card, container } = await renderPricing();
    expect(within(card('student_monthly')).getByRole('heading', { name: 'Student Monthly' })).toBeInTheDocument();
    expect(within(card('student_monthly')).getByText('$17.49 / month')).toBeInTheDocument();
    expect(card('student_monthly').querySelector('[data-student-discount]')).toHaveTextContent('30% below the regular price');
    expect(within(card('student_quarterly')).getByText('$37.99 / 3 months')).toBeInTheDocument();
    expect(card('student_quarterly').querySelector('[data-student-discount]')).toHaveTextContent('30% below the regular price');
    expect(container.querySelectorAll('[data-student-discount]')).toHaveLength(2);
    // The percentage is the response's, in the currency shown: another value prints another number.
    cleanup();
    const view = withBillingFacts(studentPlansView('roboapply'));
    serve({ ...view, plans: view.plans.map((p) => (p.key === 'student_monthly' ? { ...p, studentDiscountPercent: 22 } : p)) });
    const other = await renderPricing();
    expect(other.card('student_monthly').querySelector('[data-student-discount]')).toHaveTextContent('22% below the regular price');
  });

  it('"Price not set yet" appears nowhere: a plan with no amount is left out, priced plans stay', async () => {
    const view = withBillingFacts(plansView('roboapply'));
    serve({ ...view, plans: view.plans.map((p) => (p.key === 'pro_quarterly' ? { ...p, amountMinor: null, sellable: false, unsellableReason: 'price_unset' as const } : p)) });
    const { card, container, text } = await renderPricing();
    expect(card('pro_quarterly')).toBeNull();
    expect(card('pro_monthly')).not.toBeNull();
    expect(text()).not.toMatch(/Price not set|not set yet/i);
    expect(container.querySelectorAll('[data-plan]')).toHaveLength(6);
    cleanup();
    serve(unpricedPlansView());
    const r = renderMarketing(<PricingPage />, { flags: ON });
    await waitFor(() => expect(screen.queryByText('Loading plans…')).toBeNull());
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    expect(Array.from(r.container.querySelectorAll('[data-plan]')).map((el) => el.getAttribute('data-plan'))).toEqual(['free']);
    expect(r.container.textContent).not.toMatch(/Price not set|not set yet/i);
  });

  it('"Not open yet" follows paymentsOpen only: the card rail not ready keeps every amount and removes every buy button', async () => {
    serve(withBillingFacts(railNotReadyPlansView()));
    const closed = await renderPricing();
    expect(closed.container.querySelector('[data-pricing-not-open]')).toHaveTextContent("Paid plans can't be bought yet.");
    for (const key of ['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15']) {
      expect(within(closed.card(key)).getByText('Not open yet'), key).toBeInTheDocument();
      expect(within(closed.card(key)).queryByRole('link'), key).toBeNull();
    }
    expect(within(closed.card('pro_monthly')).getByText('$24.99 / month')).toBeInTheDocument();
    expect(closed.card('pro_quarterly').querySelector('[data-savings]')).toHaveTextContent('Save 26%');
    expect(closed.text()).not.toMatch(/Price not set/);
    cleanup();
    // Open again: no badge, a button on every plan.
    serve(withBillingFacts(plansView('roboapply')));
    const open = await renderPricing();
    expect(open.container.querySelector('[data-pricing-not-open]')).toBeNull();
    expect(open.text()).not.toContain('Not open yet');
    expect(within(open.card('pro_monthly')).getByRole('link', { name: 'Create a free account to buy' })).toBeInTheDocument();
  });
});

describe('/pricing, Taiwan (charged in USD; the reference line is computed from the admin rate)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const fx = (asOf: string) => ({ currency: 'TWD' as const, ratePerUsd: 32, source: 'Bank of Taiwan', asOf, amounts: {} });

  it('a Taiwan visitor sees "About NT$…" with source and date under each USD price while the rate is fresh; nobody else does', async () => {
    const asOf = daysAgo(3);
    serve(withBillingFacts(plansView('roboapply', undefined, { fxReference: fx(asOf), visitor: { country: 'TW' } })));
    const { card } = await renderPricing();
    const ref = await within(card('pro_monthly')).findByTestId('price-reference');
    expect(ref).toHaveTextContent(/About NT\$800/);
    expect(ref).toHaveTextContent(`Bank of Taiwan rate of ${asOf}`);
    expect(within(card('pro_monthly')).getByText('$24.99 / month')).toBeInTheDocument();
    expect(within(card('pro_quarterly')).getByTestId('price-reference')).toHaveTextContent(/NT\$1,760/);
    cleanup();
    serve(withBillingFacts(plansView('roboapply', undefined, { fxReference: fx(daysAgo(60)), visitor: { country: 'TW' } })));
    const stale = await renderPricing();
    expect(stale.container.querySelector('[data-testid="price-reference"]')).toBeNull();
    cleanup();
    serve(withBillingFacts(plansView('roboapply', undefined, { fxReference: fx(asOf), visitor: { country: 'US' } })));
    const us = await renderPricing();
    expect(us.container.querySelector('[data-testid="price-reference"]')).toBeNull();
  });

  it('a plan with a real TWD price prints that price, its own labels and no reference line', async () => {
    const view = withBillingFacts(plansView('roboapply', undefined, { fxReference: fx(daysAgo(3)), visitor: { country: 'TW' } }));
    serve({
      ...view,
      plans: view.plans.map((p) =>
        p.key === 'pro_quarterly'
          ? { ...p, localPrice: { currency: 'TWD' as const, amountMinor: 165000, savingsPercent: 26, monthlyEquivalentMinor: null, studentDiscountPercent: null } }
          : p,
      ),
    });
    const { card } = await renderPricing();
    expect(card('pro_quarterly').textContent).toMatch(/NT\$1,650 \/ 3 months|\$1,650 \/ 3 months/);
    expect(within(card('pro_quarterly')).getByText('Charged in New Taiwan dollars.')).toBeInTheDocument();
    expect(card('pro_quarterly').querySelector('[data-savings]')).toHaveTextContent('Save 26%');
    expect(within(card('pro_quarterly')).queryByTestId('price-reference')).toBeNull();
    // A plan still charged in USD keeps its reference line.
    expect(await within(card('pro_monthly')).findByTestId('price-reference')).toBeInTheDocument();
  });
});

describe('/pricing, GoApply: every amount and label from GET /billing/plans (§4.2)', () => {
  beforeEach(() => serve(withBillingFacts(goPlans()), 'goapply'));

  it('prints ¥12, ¥39 and ¥99 with "Save 15%", packs ¥29 and ¥79, each pass with its own day count and the one-time line', async () => {
    const { card, container, text } = await renderPricing('goapply');
    expect(Array.from(container.querySelectorAll('[data-plan]')).map((el) => el.getAttribute('data-plan'))).toEqual([
      'free',
      'pro_week_pass',
      'pro_monthly',
      'pro_quarterly',
      'practice_pack_5',
      'practice_pack_15',
    ]);
    expect(within(card('free')).getByText('¥0')).toBeInTheDocument();
    expect(within(card('pro_week_pass')).getByText('¥12, paid once')).toBeInTheDocument();
    expect(within(card('pro_monthly')).getByText('¥39, paid once')).toBeInTheDocument();
    expect(within(card('pro_quarterly')).getByText('¥99, paid once')).toBeInTheDocument();
    expect(card('pro_quarterly').querySelector('[data-savings]')).toHaveTextContent('Save 15% compared with paying monthly');
    expect(container.querySelectorAll('[data-savings]')).toHaveLength(1);
    expect(within(card('practice_pack_5')).getByText('¥29, paid once')).toBeInTheDocument();
    expect(within(card('practice_pack_15')).getByText('¥79, paid once')).toBeInTheDocument();
    // 一次性付款 · 到期不自动续费, with the day count of each pass (passDays).
    const line = (days: number) => `${days} days of Pro. One-time payment. It does not renew automatically when it ends.`;
    expect(card('pro_week_pass').querySelector('[data-pass-note]')).toHaveTextContent(line(7));
    expect(card('pro_monthly').querySelector('[data-pass-note]')).toHaveTextContent(line(30));
    expect(card('pro_quarterly').querySelector('[data-pass-note]')).toHaveTextContent(line(90));
    // 季卡: 3 per calendar month while it is live; the others once.
    expect(card('pro_quarterly').querySelector('[data-practice-allowance]')).toHaveTextContent('3 practice interviews each calendar month while the pass is active');
    expect(card('pro_monthly').querySelector('[data-practice-allowance]')).toHaveTextContent('3 practice interviews included');
    expect(card('pro_week_pass').querySelector('[data-practice-allowance]')).toHaveTextContent('1 practice interview included');
    // Nothing renews, nothing is in dollars, no weekly comparison, no missing price.
    expect(text()).not.toMatch(/Renews every|\$|Price not set|Not open yet/);
    expect(container.querySelector('[data-same-price-as-weekly]')).toBeNull();
    expect(container.querySelector('[data-monthly-equivalent]')).toBeNull();
    for (const key of ['pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15']) {
      expect(within(card(key)).getByRole('link', { name: 'Create a free account to buy' }), key).toBeInTheDocument();
    }
  });

  it('the day count is the plan\'s own: another passDays prints another number', async () => {
    const view = withBillingFacts(goPlans());
    serve({ ...view, plans: view.plans.map((p) => (p.key === 'pro_monthly' ? { ...p, passDays: 31 } : p)) }, 'goapply');
    const { card, container } = await renderPricing('goapply');
    expect(card('pro_monthly').querySelector('[data-pass-note]')).toHaveTextContent('31 days of Pro. One-time payment.');
    // And the refund column lists the lengths the API sent.
    expect(container.querySelector('[data-refund-line="oneTime"]')).toHaveTextContent('Passes last 7, 31, and 90 days.');
  });

  it('a verified student sees 学生月卡 ¥29 at 25% and 学生季卡 ¥69 at 30% below the regular price', async () => {
    serve(withBillingFacts(goPlans(studentPlansView('goapply'))), 'goapply');
    const { card } = await renderPricing('goapply');
    expect(within(card('student_monthly')).getByRole('heading', { name: 'Student 30-day pass' })).toBeInTheDocument();
    expect(within(card('student_monthly')).getByText('¥29, paid once')).toBeInTheDocument();
    expect(card('student_monthly').querySelector('[data-student-discount]')).toHaveTextContent('25% below the regular price');
    expect(card('student_monthly').querySelector('[data-pass-note]')).toHaveTextContent('30 days of Pro. One-time payment.');
    expect(within(card('student_quarterly')).getByText('¥69, paid once')).toBeInTheDocument();
    expect(card('student_quarterly').querySelector('[data-student-discount]')).toHaveTextContent('30% below the regular price');
    expect(card('student_quarterly').querySelector('[data-pass-note]')).toHaveTextContent('90 days of Pro. One-time payment.');
  });

  it('"Not open yet" follows paymentsOpen only, with the prices still printed', async () => {
    serve(withBillingFacts(plansView('goapply')), 'goapply'); // no rail can charge
    const { card, container } = await renderPricing('goapply');
    expect(container.querySelector('[data-pricing-not-open]')).not.toBeNull();
    expect(within(card('pro_monthly')).getByText('Not open yet')).toBeInTheDocument();
    expect(within(card('pro_monthly')).getByText('¥39, paid once')).toBeInTheDocument();
    expect(within(card('pro_monthly')).queryByRole('link')).toBeNull();
  });
});

describe('/pricing: the refund and renewal rules, with the numbers taken from the API (§4.4)', () => {
  it('RoboApply prints the four refund lines, names the EEA and Taiwan, and keeps the renewal column and the cancel link', async () => {
    const { container } = await renderPricing();
    const rules = container.querySelector('[data-refund-rules]') as HTMLElement;
    expect(within(rules).getByRole('heading', { level: 2, name: 'Refunds' })).toBeInTheDocument();
    const lines = Array.from(rules.querySelectorAll('[data-refund-line]'));
    expect(lines.map((li) => li.getAttribute('data-refund-line'))).toEqual(['first', 'renewal', 'packs', 'withdrawal']);
    expect(lines[0]).toHaveTextContent(
      'First purchase: you can get a refund within 7 days (weekly billing and the week pass: within 48 hours) if you used fewer than 5 actions that need Pro.',
    );
    expect(lines[1]).toHaveTextContent('A renewal charged by mistake: you can get a refund within 3 days of the charge.');
    expect(lines[2]).toHaveTextContent('Practice packs: you can get a refund while no interview from the pack has been used. A pack stays valid for 12 months.');
    expect(lines[3]).toHaveTextContent(
      'In the EU, the EEA, the UK and Taiwan you can withdraw within 14 days. You get a full refund if you did not ask us to start at once. If you did, a subscription is refunded for the days you have not used. Withdrawing ends the subscription at once.',
    );
    expect(rules).toHaveAttribute('data-refund-policy-version', REFUND_POLICY.version);
    expect(within(rules).getByRole('link', { name: 'Read the refund policy' })).toHaveAttribute('href', '/legal/refunds');
    // No entity line and no pass rules on RoboApply.
    expect(rules.querySelector('[data-refund-line="entity"]')).toBeNull();
    expect(rules.querySelector('[data-pass-refunds]')).toBeNull();
    // The renewal column is unchanged.
    expect(screen.getByRole('heading', { level: 2, name: 'Renewals and cancelling' })).toBeInTheDocument();
    expect(screen.getByText(/You get a reminder email before each monthly or quarterly renewal/)).toBeInTheDocument();
    expect(screen.getByText(/Cancel in Settings, or without signing in on the cancel page/)).toBeInTheDocument();
    expect(screen.getByTestId('cancel-footer-link')).toHaveAttribute('href', '/cancel');
    // No competitor is named anywhere on the page.
    expect(container.textContent).not.toMatch(/jobright|simplify|huntr|teal|kickresume|linkedin/i);
  });

  it('changing the numbers in the response changes the page (nothing is written in the copy)', async () => {
    serve(
      withBillingFacts(plansView('roboapply'), {
        refundPolicy: { firstPurchaseDays: 10, shortPlanHours: 72, paidOnlyCreditLimit: 8, accidentalRenewalDays: 5, withdrawalDays: 30, packValidMonths: 6 },
      }),
    );
    const { container } = await renderPricing();
    const line = (name: string) => container.querySelector(`[data-refund-line="${name}"]`);
    expect(line('first')).toHaveTextContent('within 10 days (weekly billing and the week pass: within 72 hours) if you used fewer than 8 actions that need Pro.');
    expect(line('renewal')).toHaveTextContent('within 5 days of the charge');
    expect(line('packs')).toHaveTextContent('A pack stays valid for 6 months.');
    expect(line('withdrawal')).toHaveTextContent('you can withdraw within 30 days.');
    expect(container.querySelector('[data-refund-rules]')!.textContent).not.toMatch(/\b(7|48|14|12) (days|hours|months)\b/);
    // A singular number reads as a singular.
    cleanup();
    serve(withBillingFacts(plansView('roboapply'), { refundPolicy: { accidentalRenewalDays: 1, shortPlanHours: 1 } }));
    const one = await renderPricing();
    expect(one.container.querySelector('[data-refund-line="renewal"]')).toHaveTextContent('within 1 day of the charge');
    expect(one.container.querySelector('[data-refund-line="first"]')).toHaveTextContent('within 1 hour)');
  });

  it('the refund section is hidden while the response carries no refundPolicy, and nothing else moves', async () => {
    serve(withoutBillingFacts(plansView('roboapply')));
    const { container, card } = await renderPricing();
    expect(container.querySelector('[data-refund-rules]')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Refunds' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Read the refund policy' })).toBeNull();
    expect(container.textContent).not.toMatch(/refund within|withdraw within/i);
    // The renewal column and the plans are still there.
    expect(screen.getByRole('heading', { level: 2, name: 'Renewals and cancelling' })).toBeInTheDocument();
    expect(screen.getByTestId('cancel-footer-link')).toBeInTheDocument();
    expect(within(card('pro_monthly')).getByText('$24.99 / month')).toBeInTheDocument();
    cleanup();
    // The same on GoApply.
    serve(withoutBillingFacts(goPlans()), 'goapply');
    const go = await renderPricing('goapply');
    expect(go.container.querySelector('[data-refund-rules]')).toBeNull();
    expect(go.container.querySelector('[data-pass-refunds]')).toBeNull();
    expect(screen.getByText('Memberships are one-time passes. They never renew automatically.')).toBeInTheDocument();
  });

  it('a refundPolicy that is not the contract shape is treated as absent: no line with a blank or a made-up number', async () => {
    for (const broken of [
      { ...REFUND_POLICY, firstPurchaseDays: undefined },
      { ...REFUND_POLICY, shortPlanHours: '48' },
      { ...REFUND_POLICY, withdrawalDays: 0 },
      { ...REFUND_POLICY, packValidMonths: 1.5 },
      'refund-v1',
      [],
    ]) {
      serve({ ...plansView('roboapply'), refundPolicy: broken } as unknown as PlansView);
      const { container } = await renderPricing();
      expect(container.querySelector('[data-refund-rules]'), JSON.stringify(broken)).toBeNull();
      expect(container.textContent).not.toMatch(/NaN|undefined|null/);
      cleanup();
    }
  });

  it('GoApply prints the pass rules, the one-time line with the day counts and, only when the API names one, the collecting entity', async () => {
    serve(withBillingFacts(goPlans(), { collectingEntity: ENTITY }), 'goapply');
    const { container } = await renderPricing('goapply');
    const rules = container.querySelector('[data-refund-rules]') as HTMLElement;
    const lines = Array.from(rules.querySelectorAll('[data-pass-refunds] [data-refund-line]'));
    expect(lines.map((li) => li.getAttribute('data-refund-line'))).toEqual(['first', 'packs', 'oneTime', 'entity']);
    expect(lines[0]).toHaveTextContent('First pass: you can get a refund within 7 days (week pass: within 48 hours) if you used fewer than 5 actions that need a paid pass.');
    expect(lines[1]).toHaveTextContent('Practice packs: you can get a refund while no interview from the pack has been used. A pack stays valid for 12 months.');
    expect(lines[2]).toHaveTextContent('One-time payment. A pass does not renew automatically when it ends. Passes last 7, 30, and 90 days.');
    expect(lines[3]).toHaveTextContent(`Payment is collected by: ${ENTITY}`);
    // It no longer says the rules come later, and it prints no renewal or withdrawal rule of the other market.
    expect(container.textContent).not.toMatch(/will be published|Refund rules will/i);
    expect(rules.querySelector('[data-refund-line="renewal"]')).toBeNull();
    expect(rules.querySelector('[data-refund-line="withdrawal"]')).toBeNull();
    expect(within(rules).getByRole('link', { name: 'Ask for a refund from the Help page' })).toHaveAttribute('href', '/help');
    expect(screen.queryByRole('link', { name: 'Read the refund policy' })).toBeNull();
    // The renewal column: the passes sentence, no cancel entry.
    expect(screen.getByText('Memberships are one-time passes. They never renew automatically.')).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-footer-link')).toBeNull();
    expect(container.textContent).not.toMatch(/RoboApply|\$/);
  });

  it('GoApply without a collecting entity prints no entity line (never a made-up name)', async () => {
    for (const entity of [null, '', '   ']) {
      serve(withBillingFacts(goPlans(), { collectingEntity: entity }), 'goapply');
      const { container } = await renderPricing('goapply');
      expect(container.querySelector('[data-refund-line="entity"]'), JSON.stringify(entity)).toBeNull();
      expect(container.textContent).not.toMatch(/collected by|收款主体/);
      expect(container.querySelectorAll('[data-pass-refunds] [data-refund-line]')).toHaveLength(3);
      cleanup();
    }
    // A response that states the refund numbers and has no `collectingEntity` key at all.
    const bare = withoutBillingFacts(goPlans());
    expect('collectingEntity' in bare.checkout).toBe(false);
    serve({ ...bare, refundPolicy: REFUND_POLICY } as PlansView, 'goapply');
    const { container } = await renderPricing('goapply');
    expect(container.querySelector('[data-refund-rules]')).not.toBeNull();
    expect(container.querySelector('[data-refund-line="entity"]')).toBeNull();
  });

  it('GoApply numbers follow the response too', async () => {
    serve(withBillingFacts(goPlans(), { refundPolicy: { firstPurchaseDays: 9, shortPlanHours: 24, paidOnlyCreditLimit: 3, packValidMonths: 18 } }), 'goapply');
    const { container } = await renderPricing('goapply');
    expect(container.querySelector('[data-refund-line="first"]')).toHaveTextContent('within 9 days (week pass: within 24 hours) if you used fewer than 3 actions');
    expect(container.querySelector('[data-refund-line="packs"]')).toHaveTextContent('A pack stays valid for 18 months.');
  });
});

describe('/pricing: the published student price for a visitor (carry-over 9)', () => {
  const OFFER = [
    { key: 'student_monthly', amountMinor: 2900, studentDiscountPercent: 25 },
    { key: 'student_quarterly', amountMinor: 6900, studentDiscountPercent: 30 },
  ];

  it('prints the student prices the API publishes while the list carries no student plan', async () => {
    serve(withBillingFacts(goPlans(), { studentOffer: OFFER }), 'goapply');
    const { container } = await renderPricing('goapply');
    const block = container.querySelector('[data-student-offer]') as HTMLElement;
    expect(within(block).getByRole('heading', { name: 'Student price' })).toBeInTheDocument();
    expect(block.querySelector('[data-student-offer-row="student_monthly"]')).toHaveTextContent('Student 30-day pass: ¥29. 25% below the regular price');
    expect(block.querySelector('[data-student-offer-row="student_quarterly"]')).toHaveTextContent('Student 90-day pass: ¥69. 30% below the regular price');
    expect(block).toHaveTextContent('The student price is for students who confirm a school email in Settings.');
    // It is not a plan card: nothing to buy from here.
    expect(container.querySelector('[data-plan="student_monthly"]')).toBeNull();
    expect(within(block).queryByRole('link')).toBeNull();
  });

  it('prints nothing when the API publishes none, and not twice when the student plans are in the list', async () => {
    serve(withBillingFacts(goPlans()), 'goapply');
    const none = await renderPricing('goapply');
    expect(none.container.querySelector('[data-student-offer]')).toBeNull();
    cleanup();
    serve(withBillingFacts(goPlans(), { studentOffer: null }), 'goapply');
    const nul = await renderPricing('goapply');
    expect(nul.container.querySelector('[data-student-offer]')).toBeNull();
    cleanup();
    serve(withBillingFacts(goPlans(studentPlansView('goapply')), { studentOffer: OFFER }), 'goapply');
    const listed = await renderPricing('goapply');
    expect(listed.container.querySelector('[data-plan="student_monthly"]')).not.toBeNull();
    expect(listed.container.querySelector('[data-student-offer]')).toBeNull();
  });

  it('ignores rows that are not the contract shape or name a plan the brand does not have', () => {
    expect(
      plansBillingFacts({
        studentOffer: [{ key: 'student_monthly', amountMinor: 2900, studentDiscountPercent: 25 }, { key: '', amountMinor: 1 }, { key: 'x', amountMinor: -5 }, { key: 'y', amountMinor: 100, studentDiscountPercent: 140 }, null, 'row'],
      }).studentOffer,
    ).toEqual([
      { key: 'student_monthly', amountMinor: 2900, studentDiscountPercent: 25 },
      { key: 'y', amountMinor: 100, studentDiscountPercent: null },
    ]);
    expect(plansBillingFacts(undefined)).toEqual({ refundPolicy: null, collectingEntity: null, studentOffer: [] });
    expect(plansBillingFacts(withoutBillingFacts(plansView('roboapply')))).toEqual({ refundPolicy: null, collectingEntity: null, studentOffer: [] });
    // The default fixture is the contract shape: the server's own refund numbers, no entity.
    expect(plansBillingFacts(plansView('roboapply'))).toEqual({ refundPolicy: REFUND_POLICY, collectingEntity: null, studentOffer: [] });
    expect(REFUND_POLICY).toMatchObject({ firstPurchaseDays: 7, shortPlanHours: 48, paidOnlyCreditLimit: 5, accidentalRenewalDays: 3, withdrawalDays: 14, packValidMonths: 12 });
    expect(plansBillingFacts(withBillingFacts(plansView('goapply'), { collectingEntity: `  ${ENTITY} ` }))).toMatchObject({ refundPolicy: refundPolicyFor('goapply'), collectingEntity: ENTITY });
  });
});

// PC-3 (MARKET_STRATEGY §3, M-14): the caps table reads GET /support/credit-caps,
// so the new free autofill cap reaches the page with no change in the page.
describe('/pricing: the limits table prints the credit catalog (free autofill 20 a day on both brands)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['roboapply', 'goapply'] as const)('%s: form fills read "20 a day" on Free and "Up to 100 a day" on Pro', async (brand) => {
    // The row is listed only where the brand's extension is published.
    vi.stubEnv(brand === 'goapply' ? 'NEXT_PUBLIC_CN_EXT_ID' : 'NEXT_PUBLIC_EXT_ID', 'testextensionid');
    serve(withBillingFacts(brand === 'goapply' ? goPlans() : plansView('roboapply')), brand);
    const { container } = await renderPricing(brand, { ...ON, extension: true });
    await waitFor(() => expect(container.querySelector('[data-caps-table]')).not.toBeNull());
    const table = within(container.querySelector('[data-caps-table]') as HTMLElement);
    const row = within(table.getByRole('row', { name: /^Form fills/ }));
    expect(row.getByText('20 a day')).toBeInTheDocument();
    expect(row.getByText('Up to 100 a day')).toBeInTheDocument();
    expect(row.queryByText('5 a day')).toBeNull();
    // The other free difference between the brands is unchanged: tailoring 2 a day, 3 on GoApply.
    expect(within(table.getByRole('row', { name: /^Tailored resumes/ })).getByText(brand === 'goapply' ? '3 a day' : '2 a day')).toBeInTheDocument();
  });

  it('an admin override of the cap is what the page prints', async () => {
    vi.stubEnv('NEXT_PUBLIC_EXT_ID', 'testextensionid');
    const caps = capsFromCatalog(DEFAULT_CREDIT_CATALOG.roboapply);
    api.getCreditCaps.mockImplementation(async () => ({
      ...caps,
      buckets: caps.buckets.map((b) => (b.bucket === 'autofill' ? { ...b, free: { ...b.free, cap: 5 } } : b)),
    }));
    const r = renderMarketing(<PricingPage />, { flags: { ...ON, extension: true } });
    await waitFor(() => expect(r.container.querySelector('[data-caps-table]')).not.toBeNull());
    const row = within(within(r.container.querySelector('[data-caps-table]') as HTMLElement).getByRole('row', { name: /^Form fills/ }));
    expect(row.getByText('5 a day')).toBeInTheDocument();
  });
});

describe('the staged copy carries no number and the Chinese source text matches the English arguments', () => {
  type Tree = { [key: string]: string | Tree };
  const read = (file: string) => JSON.parse(readFileSync(join(process.cwd(), 'i18n/staging', file), 'utf8')) as Tree;
  const leaves = (node: string | Tree | undefined, prefix: string): Array<[string, string]> =>
    node === undefined ? [] : typeof node === 'string' ? [[prefix, node]] : Object.entries(node).flatMap(([k, v]) => leaves(v, `${prefix}.${k}`));
  const args = (text: string) => Array.from(new Set(Array.from(text.matchAll(/\{(\w+)/g), (m) => m[1]).filter((name) => !['one', 'other'].includes(name!)))).sort();
  const en = { credits: (read('credits.en.json').credits as Tree).pricing as Tree, billingCn: (read('billingCn.en.json').billingCn as Tree).pricing as Tree };
  const zh = { credits: (read('credits.zh.json').credits as Tree).pricing as Tree, billingCn: (read('billingCn.zh.json').billingCn as Tree).pricing as Tree };

  it('no amount, percentage, day count or currency symbol is written in a pricing string (en and zh)', () => {
    const all = [...leaves(en.credits, 'credits.pricing'), ...leaves(en.billingCn, 'billingCn.pricing'), ...leaves(zh.credits, 'credits.pricing'), ...leaves(zh.billingCn, 'billingCn.pricing')];
    expect(all.length).toBeGreaterThan(20);
    for (const [path, text] of all) {
      expect(text, path).not.toMatch(/[0-9０-９]/);
      expect(text, path).not.toMatch(/[$¥€£%]/);
      expect(text, path).not.toMatch(/—/);
      expect(text, path).not.toMatch(/RoboApply|GoApply/);
    }
  });

  it('GoApply-only keys have Chinese source text with the same arguments, and the pass line is 一次性付款 · 到期不自动续费', () => {
    const enLeaves = leaves(en.billingCn, 'billingCn.pricing');
    const zhLeaves = new Map(leaves(zh.billingCn, 'billingCn.pricing'));
    expect(enLeaves.map(([path]) => path).sort()).toEqual(Array.from(zhLeaves.keys()).sort());
    for (const [path, text] of enLeaves) expect(args(zhLeaves.get(path)!), path).toEqual(args(text));
    expect(zhLeaves.get('billingCn.pricing.passNote')).toContain('一次性付款 · 到期不自动续费');
    expect(zhLeaves.get('billingCn.pricing.passNote')).toContain('{days}');
    expect(zhLeaves.get('billingCn.pricing.refund.oneTime')).toContain('一次性付款 · 到期不自动续费');
    expect(zhLeaves.get('billingCn.pricing.refund.entity')).toBe('收款主体：{entity}');
    expect(zhLeaves.get('billingCn.pricing.refund.first')).toMatch(/周卡：\{hours\} 小时/);
    // The staged Chinese of the shared namespace keeps the English arguments too.
    const enCredits = new Map(leaves(en.credits, 'credits.pricing'));
    for (const [path, text] of leaves(zh.credits, 'credits.pricing')) expect(args(text), path).toEqual(args(enCredits.get(path)!));
  });
});
