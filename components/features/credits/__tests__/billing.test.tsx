// WP-21b acceptance — plan sheet, legacy quote, one-click cancel, payment
// failed (component tests at 375 px; no network: lib/api is mocked).
// Market wave M2 (MKT-2E): every Pro to Pro switch on the plan sheet with a
// quote and a new acknowledgement (ST-5), "Keep my plan" (ST-6), the
// payment-method flow of the failed-payment banner (ST-7), the return page's
// reconcile call (ST-3) and the line for a mainland visitor (AL-6).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { RA_ENV, anAttempt, atPhoneWidth, checkoutOf, creditsResponse, plansView, railNotReadyPlansView, renderUi, studentPlansView, unpricedPlansView, withBrand } from './fixtures';
import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import type { BillingPlanResponse } from '../../../../lib/api/account';
import { RoboApiError } from '../../../../lib/api/client';

const api = vi.hoisted(() => ({
  getCredits: vi.fn(),
  getPlans: vi.fn(),
  getCreditHistory: vi.fn(),
  cancelSubscription: vi.fn(),
  sendCancelSurvey: vi.fn(),
}));
const countryAction = vi.hoisted(() => ({ visitorCountryAction: vi.fn() }));
const account = vi.hoisted(() => ({
  plan: vi.fn(),
  checkoutPlan: vi.fn(),
  alipayCheckoutPlan: vi.fn(),
  switchQuote: vi.fn(),
  switchConfirm: vi.fn(),
  portal: vi.fn(),
  reconcileCheckout: vi.fn(),
  resumeSubscription: vi.fn(),
}));
// Account V2 (WP-79) cards inside the billing view: no network.
const v2 = vi.hoisted(() => ({
  getStudentStatus: vi.fn(),
  getUiState: vi.fn(),
  patchUiState: vi.fn(),
}));
vi.mock('../../../../lib/api/accountV2', async (orig) => {
  const real = await orig<{ accountV2Api: Record<string, unknown> }>();
  return { ...real, accountV2Api: { ...real.accountV2Api, getStudentStatus: v2.getStudentStatus } };
});
vi.mock('../../../../lib/api/uiState', () => ({ getUiState: v2.getUiState, patchUiState: v2.patchUiState }));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/account', async (orig) => ({ ...(await orig<Record<string, unknown>>()), accountApi: account }));
vi.mock('../../../../app/(auth)/settings/billing/actions', () => countryAction);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));

import { PlanPicker } from '../PlanPicker';
import { CancelSubscription, CANCEL_ALTERNATIVE_STORAGE_KEY } from '../CancelSubscription';
import { BillingView } from '../BillingView';
import { CheckoutReturn, RETURN_POLL_ATTEMPTS, RETURN_RECONCILE_EVERY } from '../CheckoutReturn';
import { PaymentFailedBanner } from '../PaymentFailedBanner';
import { SettingsSection } from '../SettingsSection';
import SettingsBillingReturnPage from '../../../../app/(auth)/settings/billing/return/page';

function legacyPlan(over: Partial<BillingPlanResponse['current']> = {}): BillingPlanResponse {
  return {
    region: { market: 'other', currency: 'USD', method: 'stripe', source: 'brand' },
    current: { tier: 'free', status: 'active', amountMinor: null, currency: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasStripeCustomer: false, manualRenewal: false, ...over },
    credits: { balance: 1, periodAllotment: null, tier: 'free' },
    plans: [],
    stripeConfigured: true,
    alipayConfigured: false,
  };
}

beforeEach(() => {
  atPhoneWidth();
  for (const fn of [...Object.values(api), ...Object.values(account), ...Object.values(countryAction)]) fn.mockReset();
  countryAction.visitorCountryAction.mockResolvedValue(null);
  for (const fn of Object.values(v2)) fn.mockReset();
  v2.getStudentStatus.mockResolvedValue({ verified: false, schoolDomain: null, verifiedAt: null, expiresAt: null, pendingDomain: null, available: false });
  v2.getUiState.mockResolvedValue({ state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null });
  v2.patchUiState.mockImplementation(async () => ({ state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null }));
  api.getCredits.mockResolvedValue(creditsResponse());
  api.getPlans.mockResolvedValue(plansView());
  api.getCreditHistory.mockResolvedValue({ items: [] });
  account.plan.mockResolvedValue(legacyPlan());
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

const radio = (key: string) => document.querySelector<HTMLInputElement>(`[data-plan="${key}"] input[type="radio"]`)!;
const option = (key: string) => document.querySelector<HTMLElement>(`[data-plan="${key}"]`);
const continueBtn = () => screen.getByRole('button', { name: /continue to payment|see what switching costs/i });
const PORTAL_SCOPE = 'Manage payment is for your payment method, invoices and billing details. To change your plan, choose another one here.';
const OLD_PORTAL_LINE = 'To change how often Pro renews, use Manage payment.';

/** Stands in for whatever makes the billing plan load again (a mutation's invalidation, a focus refetch). */
function RefetchBilling() {
  const client = useQueryClient();
  return (
    <button type="button" onClick={() => void client.invalidateQueries({ queryKey: ['account', 'plan'] })}>
      refetch billing
    </button>
  );
}

/** An error as the API client throws it: HTTP status and the envelope's `code`. */
function apiError(code: string, status: number): RoboApiError {
  return new RoboApiError('failed', { code, status, payload: { success: false, code } });
}

/** A Pro subscriber whose plan renews (`interval`), as the summary and the billing plan state it. */
function subscriber(planKey: string, interval: 'week' | 'month' | 'quarter', over: Parameters<typeof creditsResponse>[0] = {}, billing: Partial<BillingPlanResponse['current']> = {}) {
  api.getCredits.mockResolvedValue(creditsResponse({ planKey, planProfile: 'pro', interval, periodEnd: IN_20_DAYS, upgradable: false, ...over }));
  account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, ...billing }));
}
const IN_20_DAYS = new Date(Date.now() + 20 * 86_400_000).toISOString();
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();

// R-25 / MARKET_STRATEGY §4.1 "Taiwan reference": billing stays in USD; the
// line is a reference computed from the admin's rate, with source and date.
describe('PlanPicker: the TWD reference line for a Taiwan visitor', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const fx = (asOf: string) => ({ currency: 'TWD' as const, ratePerUsd: 32, source: 'Bank of Taiwan', asOf, amounts: {} });
  const refs = (key: string) => document.querySelectorAll(`[data-plan="${key}"] [data-testid="price-reference"]`);

  it('shows it under every USD price, with the source and the date, when the API sends a fresh reference', async () => {
    const asOf = daysAgo(5);
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fx(asOf) }));
    renderUi(<PlanPicker visitorCountry="TW" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    await waitFor(() => expect(refs('pro_monthly')).toHaveLength(1));
    const monthly = refs('pro_monthly')[0];
    // $24.99 × 32 = NT$799.68 → NT$800; the price itself stays in dollars.
    expect(monthly).toHaveTextContent(/About NT\$800/);
    expect(monthly).toHaveTextContent('Bank of Taiwan');
    expect(monthly).toHaveTextContent(asOf);
    expect(monthly).toHaveAttribute('data-as-of', asOf);
    expect(document.querySelector('[data-plan="pro_monthly"]')).toHaveTextContent('$24.99 / month');
    for (const key of ['pro_weekly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15']) expect(refs(key), key).toHaveLength(1);
    // $54.99 × 32 = NT$1,759.68 → NT$1,760.
    expect(refs('pro_quarterly')[0]).toHaveTextContent(/NT\$1,760/);
  });

  it('shows nothing when the reference is older than 45 days, and nothing for a visitor outside Taiwan', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fx(daysAgo(46)) }));
    const stale = renderUi(<PlanPicker visitorCountry="TW" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(document.querySelector('[data-plan="pro_monthly"]')).toHaveTextContent('$24.99 / month');
    expect(screen.queryByTestId('price-reference')).toBeNull();
    stale.unmount();
    // A reference from 44 days ago is still inside the 45-day window.
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fx(daysAgo(44)) }));
    const edge = renderUi(<PlanPicker visitorCountry="TW" navigate={vi.fn()} />);
    await waitFor(() => expect(refs('pro_monthly')).toHaveLength(1));
    edge.unmount();
    api.getPlans.mockResolvedValue(plansView('roboapply', undefined, { fxReference: fx(daysAgo(5)) }));
    renderUi(<PlanPicker visitorCountry="US" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(screen.queryByTestId('price-reference')).toBeNull();
  });

  it('a plan with a real TWD price shows that price and no reference line; plans still in USD keep theirs', async () => {
    const env = { ...RA_ENV, STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd', STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    const { plans, defaultSelection } = buildPlanViews('roboapply', { env, country: 'TW' });
    api.getPlans.mockResolvedValue({
      ...plansView('roboapply', env, { fxReference: fx(daysAgo(5)) }),
      plans,
      defaultSelection,
      checkout: checkoutOf(['stripe'], { showWithdrawalWaiver: true, country: 'TW' }),
    });
    renderUi(<PlanPicker visitorCountry="TW" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    const monthly = document.querySelector('[data-plan="pro_monthly"]')!;
    expect(monthly.textContent).toMatch(/NT\$749|\$749/);
    expect(monthly).toHaveTextContent('Charged in New Taiwan dollars.');
    expect(refs('pro_monthly')).toHaveLength(0);
    await waitFor(() => expect(refs('pro_quarterly')).toHaveLength(1));
    expect(document.querySelector('[data-plan="pro_quarterly"]')).toHaveTextContent('$54.99 / 3 months');
  });
});

describe('PlanPicker (375 px)', () => {
  it('preselects Monthly, never weekly; shows the monthly equivalent and the rounded-down saving', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(radio('pro_weekly')).not.toBeChecked();
    expect(radio('pro_week_pass')).not.toBeChecked();
    const weekly = document.querySelector('[data-plan="pro_weekly"]')!;
    expect(weekly).toHaveTextContent('$9.99 / week');
    expect(weekly).toHaveTextContent('About $43 a month');
    // 3 × $24.99 = $74.97; $54.99 saves 26.65%, printed rounded down.
    expect(document.querySelector('[data-plan="pro_quarterly"]')).toHaveTextContent('$54.99 / 3 months');
    expect(document.querySelector('[data-plan="pro_quarterly"]')).toHaveTextContent('Save 26%');
    expect(document.body.textContent?.toLowerCase()).not.toContain('unlimited');
  });

  it('weekly stays unselected even when the server names it the default', async () => {
    api.getPlans.mockResolvedValue({ ...plansView(), defaultSelection: 'pro_weekly' });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await screen.findByTestId('plan-picker');
    expect(radio('pro_weekly')).not.toBeChecked();
    expect(continueBtn()).toBeDisabled();
  });

  it('the auto-renew box starts unticked and gates the payment button', async () => {
    const navigate = vi.fn();
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/s', orderId: 'cs_1', rail: 'stripe' });
    renderUi(<PlanPicker navigate={navigate} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    const ack = screen.getByRole('checkbox', { name: /renews automatically every month at \$24\.99 until I cancel/i });
    expect(ack).not.toBeChecked();
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(ack);
    expect(continueBtn()).toBeEnabled();
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/s'));
    expect(account.checkoutPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planKey: 'pro_monthly', autoRenewAck: true, withdrawalWaiver: undefined, next: '/settings/billing/return?plan=pro_monthly' }),
      anAttempt(),
    );
  });

  it('changing the plan unticks the acknowledgement again', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(radio('pro_quarterly'));
    expect(screen.getByRole('checkbox', { name: /renews automatically every 3 months/i })).not.toBeChecked();
  });

  it('one-time plans need no renewal box', async () => {
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/p', orderId: 'cs_p', rail: 'stripe' });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    fireEvent.click(radio('pro_week_pass'));
    expect(screen.queryByRole('checkbox', { name: /renews automatically/i })).toBeNull();
    expect(continueBtn()).toBeEnabled();
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toHaveTextContent("doesn't renew");
  });

  it('EU visitors get the optional withdrawal waiver (unticked); US visitors do not', async () => {
    const { unmount } = renderUi(<PlanPicker visitorCountry="DE" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    const waiver = screen.getByRole('checkbox', { name: /right of withdrawal/i });
    expect(waiver).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    expect(continueBtn()).toBeEnabled(); // the waiver is optional
    unmount();
    renderUi(<PlanPicker visitorCountry="US" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(screen.queryByRole('checkbox', { name: /right of withdrawal/i })).toBeNull();
  });

  it('a payment error says nothing was charged', async () => {
    account.checkoutPlan.mockRejectedValue(new Error('boom'));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(continueBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was charged');
  });

  it('GoApply with no rail that can charge: the passes list with their CNY prices, one "not open yet" note, nothing purchasable', async () => {
    // plansView('goapply'): prices from the catalog, on sale, but `paymentsOpen: false` and no rail.
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply' });
    const picker = await screen.findByTestId('plan-picker');
    expect(picker.querySelector('[data-plan="pro_week_pass"]')).toHaveTextContent('¥12');
    expect(picker.querySelector('[data-plan="pro_monthly"]')).toHaveTextContent('¥39');
    expect(picker.querySelector('[data-plan="pro_quarterly"]')).toHaveTextContent('¥99');
    expect(picker.querySelector('[data-plan="practice_pack_5"]')).toHaveTextContent('¥29');
    expect(picker.querySelector('[data-plan="practice_pack_15"]')).toHaveTextContent('¥79');
    // One note for the sheet, not a tag on every row.
    expect(screen.getByTestId('payments-not-open')).toHaveTextContent('Payment is not open yet');
    expect(screen.queryByText('Not available yet')).toBeNull();
    expect(screen.queryByTestId('rail-chooser')).toBeNull();
    expect(continueBtn()).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /renews automatically/i })).toBeNull();
  });

  it('GoApply rows say what a pass is: paid once, the day count, no renewal', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply' });
    const picker = await screen.findByTestId('plan-picker');
    const row = (key: string) => picker.querySelector(`[data-plan="${key}"]`)!;
    // One-time, no auto-renewal, with the pass's own day count (一次性付款 · 到期不自动续费 in the zh bundle).
    expect(row('pro_week_pass')).toHaveTextContent('7 days of Pro. One-time payment. It does not renew automatically when it ends.');
    expect(row('pro_monthly')).toHaveTextContent('¥39, paid once');
    expect(row('pro_monthly')).toHaveTextContent('30 days of Pro. One-time payment. It does not renew automatically when it ends.');
    expect(row('pro_quarterly')).toHaveTextContent('90 days of Pro. One-time payment. It does not renew automatically when it ends.');
    expect(row('pro_quarterly')).toHaveTextContent('Save 15% compared with paying monthly');
    expect(picker).not.toHaveTextContent(/Renews every/);
    // GoApply sells no weekly billing, so its week pass is compared with nothing.
    expect(picker.querySelector('[data-same-price-as-weekly]')).toBeNull();
  });

  it('GoApply: the day count on a pass is the plan\'s own (passDays from the API), never a number in the copy', async () => {
    const view = plansView('goapply');
    api.getPlans.mockResolvedValue({ ...view, plans: view.plans.map((p) => (p.key === 'pro_week_pass' ? { ...p, passDays: 10 } : p)) });
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply' });
    const picker = await screen.findByTestId('plan-picker');
    expect(picker.querySelector('[data-plan="pro_week_pass"] [data-pass-note]')).toHaveTextContent('10 days of Pro. One-time payment. It does not renew automatically when it ends.');
    expect(picker.querySelector('[data-plan="pro_monthly"] [data-pass-note]')).toHaveTextContent('30 days of Pro.');
  });

  // MARKET_STRATEGY §4.1, §4.2: the sheet lists exactly what the API sends.
  it('RoboApply lists the §4.1 amounts: $9.99 a week (about $43 a month), $24.99, $54.99 with Save 26%, the pass at $9.99, packs $9.99 and $24.99', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    const picker = await screen.findByTestId('plan-picker');
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    const row = (key: string) => picker.querySelector(`[data-plan="${key}"]`)!;
    expect(row('pro_weekly')).toHaveTextContent('$9.99 / week');
    expect(row('pro_weekly')).toHaveTextContent('About $43 a month');
    expect(row('pro_weekly')).not.toHaveTextContent('43.29');
    expect(row('pro_monthly')).toHaveTextContent('$24.99 / month');
    expect(row('pro_quarterly')).toHaveTextContent('$54.99 / 3 months');
    expect(row('pro_quarterly')).toHaveTextContent('Save 26% compared with paying monthly');
    expect(row('pro_week_pass')).toHaveTextContent('$9.99, paid once');
    expect(row('practice_pack_5')).toHaveTextContent('$9.99, paid once');
    expect(row('practice_pack_15')).toHaveTextContent('$24.99, paid once');
    // RoboApply's pass keeps its own wording; the mainland line is GoApply's.
    expect(row('pro_week_pass')).toHaveTextContent("7 days of Pro. One payment; it doesn't renew.");
    expect(picker).not.toHaveTextContent(/Price not set|Not available yet/);
  });

  it('GoApply lists the §4.2 amounts: ¥12, ¥39, ¥99 with Save 15%, packs ¥29 and ¥79', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply' });
    const picker = await screen.findByTestId('plan-picker');
    const text = (key: string) => picker.querySelector(`[data-plan="${key}"]`)!;
    expect(text('pro_week_pass')).toHaveTextContent('¥12, paid once');
    expect(text('pro_monthly')).toHaveTextContent('¥39, paid once');
    expect(text('pro_quarterly')).toHaveTextContent('¥99, paid once');
    expect(text('pro_quarterly')).toHaveTextContent('Save 15%');
    expect(text('practice_pack_5')).toHaveTextContent('¥29, paid once');
    expect(text('practice_pack_15')).toHaveTextContent('¥79, paid once');
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(radio('pro_week_pass')).not.toBeChecked();
  });

  it('the 7-day pass says "same price as weekly billing" only while the two amounts from the API are equal', async () => {
    const { unmount } = renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    const line = () => document.querySelector('[data-plan="pro_week_pass"] [data-same-price-as-weekly]');
    expect(line()).toHaveTextContent('Same price as weekly billing. The pass does not renew; weekly billing does.');
    // Only the pass carries it.
    expect(document.querySelectorAll('[data-same-price-as-weekly]')).toHaveLength(1);
    unmount();
    // A pass priced differently from weekly billing: no line (it is computed, not written).
    const view = plansView();
    api.getPlans.mockResolvedValue({ ...view, plans: view.plans.map((p) => (p.key === 'pro_week_pass' ? { ...p, amountMinor: 699 } : p)) });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toHaveTextContent('$6.99, paid once');
    expect(document.querySelector('[data-same-price-as-weekly]')).toBeNull();
  });

  // M-25: the card rail needs its key AND a webhook secret. Without either the
  // server lists every plan with its amount as not on sale (`payments_disabled`).
  it('RoboApply with its card rail not ready: every amount stays, every row says "Not available yet", one note, nothing can be bought', async () => {
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/never', orderId: 'cs_x', rail: 'stripe' });
    api.getPlans.mockResolvedValue(railNotReadyPlansView());
    renderUi(<PlanPicker navigate={vi.fn()} />);
    const picker = await screen.findByTestId('plan-picker');
    const keys = ['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15'];
    for (const key of keys) {
      const row = picker.querySelector(`[data-plan="${key}"]`)!;
      expect(row.querySelector('[data-not-available]'), key).toHaveTextContent('Not available yet');
      expect(radio(key), key).toBeDisabled();
    }
    expect(picker.querySelector('[data-plan="pro_monthly"]')).toHaveTextContent('$24.99 / month');
    expect(picker.querySelector('[data-plan="pro_quarterly"]')).toHaveTextContent('$54.99 / 3 months');
    expect(screen.getByTestId('payments-not-open')).toHaveTextContent('These are the prices. Payment is not open yet, so nothing can be bought right now.');
    // Nothing is preselected, no renewal box is asked for, and Continue does nothing.
    expect(document.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0);
    expect(screen.queryByRole('checkbox', { name: /renews automatically/i })).toBeNull();
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(account.checkoutPlan).not.toHaveBeenCalled();
    // The closed state never talks about a missing price.
    expect(document.body.textContent).not.toMatch(/price (is )?not set|not priced|no price/i);
  });

  it('RoboApply shows no "not open yet" note and no rail chooser when its one rail can charge', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(screen.queryByTestId('payments-not-open')).toBeNull();
    expect(screen.queryByTestId('rail-chooser')).toBeNull();
  });

  it('plans the API sends with no amount are not listed → an honest empty line, never a fake price or a "price not set" row', async () => {
    api.getPlans.mockResolvedValue(unpricedPlansView());
    renderUi(<PlanPicker navigate={vi.fn()} />);
    expect(await screen.findByText('No plans are on sale right now.')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-plan]')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Price not set|\$|—/);
  });

  it('a pack purchase carries the plan and the practice balance before checkout to the return page', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({}, { balance: 2 }));
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/k', orderId: 'cs_k', rail: 'stripe' });
    renderUi(<PlanPicker requestedPlan="practice_pack_5" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('practice_pack_5')).toBeChecked());
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() =>
      expect(account.checkoutPlan).toHaveBeenCalledWith(
        expect.objectContaining({ planKey: 'practice_pack_5', next: '/settings/billing/return?plan=practice_pack_5&practiceBefore=2' }),
        anAttempt(),
      ),
    );
  });

  it('a renewing subscriber asking for weekly by link gets it selected as a switch (their own request), never a second checkout', async () => {
    subscriber('pro_monthly', 'month');
    renderUi(<PlanPicker requestedPlan="pro_weekly" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_weekly')).toBeChecked());
    expect(screen.getByRole('button', { name: /see what switching costs/i })).toBeEnabled();
    expect(screen.queryByText(OLD_PORTAL_LINE)).toBeNull();
    expect(account.checkoutPlan).not.toHaveBeenCalled();
  });

  it('a hidden plan can never be bought: a server default the sheet does not show leaves Continue disabled', async () => {
    // A one-time plan (no renewal box to tick) that the server names as the
    // default, for a renewing subscriber whose sheet does not show passes.
    const base = plansView();
    const pass = base.plans.find((p) => p.key === 'pro_week_pass')!;
    const hiddenPass = { ...pass, key: 'pro_test_pass', neverPreselected: false, defaultLabel: 'Test pass' };
    api.getPlans.mockResolvedValue({ ...base, plans: [...base.plans, hiddenPass], defaultSelection: 'pro_test_pass' });
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false }));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(PORTAL_SCOPE)).toBeInTheDocument());
    expect(document.querySelector('[data-plan="pro_test_pass"]')).toBeNull();
    expect(document.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0);
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(account.checkoutPlan).not.toHaveBeenCalled();
    expect(account.switchQuote).not.toHaveBeenCalled();
  });

  it('a pass the user holds can be bought again (it is not "Your plan")', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_week_pass', planProfile: 'pro', interval: 'pass', periodEnd: '2026-10-15T00:00:00Z', upgradable: false }));
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/again', orderId: 'cs_2', rail: 'stripe' });
    const navigate = vi.fn();
    renderUi(<PlanPicker requestedPlan="pro_week_pass" navigate={navigate} />);
    await waitFor(() => expect(radio('pro_week_pass')).toBeChecked());
    expect(radio('pro_week_pass')).toBeEnabled();
    expect(document.querySelector('[data-plan="pro_week_pass"]')).not.toHaveTextContent('Your plan');
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/again'));
    expect(account.checkoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'pro_week_pass' }), anAttempt());
  });

  it('a cancelled subscription that still runs: only the passes are offered, no other subscription and no portal line', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false, cancelAtPeriodEnd: true }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true }));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    // Cancelled: only the passes are offered; the monthly plan is not re-sold here.
    await waitFor(() => expect(document.querySelector('[data-plan="pro_week_pass"]')).not.toBeNull());
    expect(document.querySelector('[data-plan="pro_monthly"]')).toBeNull();
    expect(document.querySelector('[data-plan="pro_weekly"]')).toBeNull();
    expect(screen.queryByText(PORTAL_SCOPE)).toBeNull();
    expect(screen.queryByText(OLD_PORTAL_LINE)).toBeNull();
  });

  it('a new ?plan= request selects again (the picker is re-keyed on it)', async () => {
    const view = renderUi(<BillingView navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    view.rerender(withBrand(<BillingView requestedPlan="pro_week_pass" navigate={vi.fn()} />));
    await waitFor(() => expect(radio('pro_week_pass')).toBeChecked());
    expect(radio('pro_monthly')).not.toBeChecked();
  });

  it('/settings#billing (no server country): the edge country is looked up, and an EU buyer gets the waiver', async () => {
    countryAction.visitorCountryAction.mockResolvedValue('FR');
    renderUi(<SettingsSection section="billing" />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(await screen.findByRole('checkbox', { name: /right of withdrawal/i })).not.toBeChecked();
    expect(countryAction.visitorCountryAction).toHaveBeenCalledTimes(1);
  });

  it('/settings#billing: a US buyer gets no waiver; payment waits until the country is known', async () => {
    let resolveCountry: (v: string | null) => void = () => {};
    countryAction.visitorCountryAction.mockReturnValue(new Promise<string | null>((r) => (resolveCountry = r)));
    renderUi(<SettingsSection section="billing" />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked(), { timeout: 4000 });
    await waitFor(() => expect(countryAction.visitorCountryAction).toHaveBeenCalled(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    expect(continueBtn()).toBeDisabled();
    resolveCountry('US');
    await waitFor(() => expect(continueBtn()).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByRole('checkbox', { name: /right of withdrawal/i })).toBeNull();
  });

  it('a server-resolved country is not looked up again', async () => {
    renderUi(<PlanPicker visitorCountry="DE" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(screen.getByRole('checkbox', { name: /right of withdrawal/i })).toBeInTheDocument();
    expect(countryAction.visitorCountryAction).not.toHaveBeenCalled();
  });

  it('legacy practice plan: switching shows the quote first, asks for the renewal box on the quote, and charges only on Confirm', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'starter', legacyPlan: true }));
    account.plan.mockResolvedValue(legacyPlan({ tier: 'starter', hasStripeCustomer: true, currentPeriodEnd: '2026-11-01T00:00:00Z' }));
    account.switchQuote.mockResolvedValue({ quoteId: 'q1', planKey: 'pro_monthly', currency: 'USD', amountDueTodayMinor: 1012, renewalAmountMinor: 2499, nextRenewalAt: '2026-11-10T00:00:00Z' });
    account.switchConfirm.mockResolvedValue({ status: 'switched', planKey: 'pro_monthly', nextRenewalAt: '2026-11-10T00:00:00Z' });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: /see what switching costs/i })).toBeInTheDocument());
    // The plan sheet asks for no box for a switch: the new terms are acknowledged on the quote, with the quote's price.
    expect(screen.queryByRole('checkbox', { name: /renews automatically/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    const quote = await screen.findByTestId('switch-quote');
    expect(within(quote).getByText('$10.12')).toBeInTheDocument();
    expect(within(quote).getByText('$24.99 / month')).toBeInTheDocument();
    expect(account.checkoutPlan).not.toHaveBeenCalled();
    const ack = screen.getByRole('checkbox', { name: /renews automatically every month at \$24\.99 until I cancel/i });
    expect(ack).not.toBeChecked();
    const confirm = screen.getByRole('button', { name: /confirm and pay \$10\.12/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(account.switchConfirm).not.toHaveBeenCalled();
    fireEvent.click(ack);
    fireEvent.click(confirm);
    await waitFor(() => expect(account.switchConfirm).toHaveBeenCalledWith({ quoteId: 'q1', autoRenewAck: true, withdrawalWaiver: undefined }));
    expect(await screen.findByText(/You're on Pro Monthly/)).toBeInTheDocument();
  });
});

// ST-5 (web): MARKET_STRATEGY §4.4 "Plan change", §5.1 "Switch", M-16. The
// plan sheet is where a subscription changes; the portal is not.
describe('PlanPicker: a Pro subscriber changes plans here, with a quote and a new acknowledgement', () => {
  const QUOTE = { quoteId: 'pro_quarterly:1791590400', planKey: 'pro_quarterly', currency: 'USD', amountDueTodayMinor: 3711, renewalAmountMinor: 5499, nextRenewalAt: '2027-01-08T00:00:00Z' };

  it.each([
    { on: 'pro_weekly', interval: 'week' as const, others: ['pro_monthly', 'pro_quarterly'] },
    { on: 'pro_monthly', interval: 'month' as const, others: ['pro_weekly', 'pro_quarterly'] },
    { on: 'pro_quarterly', interval: 'quarter' as const, others: ['pro_weekly', 'pro_monthly'] },
  ])('on $on: the other subscriptions are offered as switches, $on is "Your plan" and disabled, nothing is preselected', async ({ on, interval, others }) => {
    subscriber(on, interval);
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(option(on)).toHaveTextContent('Your plan'));
    expect(radio(on)).toBeDisabled();
    expect(radio(on)).not.toBeChecked();
    for (const key of others) {
      expect(radio(key), key).toBeEnabled();
      expect(option(key), key).not.toHaveTextContent('Your plan');
    }
    // A switch is the subscriber's own choice: no default, and never weekly.
    expect(document.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0);
    expect(continueBtn()).toBeDisabled();
    // Passes come back only after cancelling (or by link); packs stay.
    expect(option('pro_week_pass')).toBeNull();
    expect(option('practice_pack_5')).not.toBeNull();
    // The sheet no longer sends anyone to the portal to change plans.
    expect(screen.getByTestId('portal-scope')).toHaveTextContent(PORTAL_SCOPE);
    expect(screen.queryByText(OLD_PORTAL_LINE)).toBeNull();
  });

  it('a monthly subscriber picks quarterly: amount today, renewal price and next renewal date come from the quote; Confirm waits for the box', async () => {
    subscriber('pro_monthly', 'month');
    account.switchQuote.mockResolvedValue(QUOTE);
    account.switchConfirm.mockResolvedValue({ status: 'switched', planKey: 'pro_quarterly', nextRenewalAt: null });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_quarterly')).toBeEnabled());
    fireEvent.click(radio('pro_quarterly'));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    const quote = await screen.findByTestId('switch-quote');
    expect(account.switchQuote).toHaveBeenCalledWith({ planKey: 'pro_quarterly' });
    expect(within(quote).getByText('$37.11')).toBeInTheDocument();
    expect(within(quote).getByText('$54.99 / 3 months')).toBeInTheDocument();
    expect(within(quote).getByText(/Jan \d+, 2027/)).toBeInTheDocument();
    // The acknowledgement of the new terms: unticked, with the quote's renewal price and the new period.
    const ack = screen.getByRole('checkbox', { name: /renews automatically every 3 months at \$54\.99 until I cancel/i });
    expect(ack).not.toBeChecked();
    const confirm = screen.getByRole('button', { name: /confirm and pay \$37\.11/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(ack);
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(account.switchConfirm).toHaveBeenCalledWith({ quoteId: QUOTE.quoteId, autoRenewAck: true, withdrawalWaiver: undefined }));
    expect(await screen.findByText("You're on Pro Quarterly.")).toBeInTheDocument();
    // A switch is never a second checkout.
    expect(account.checkoutPlan).not.toHaveBeenCalled();
  });

  it('the acknowledgement names the price of the quote, also when it differs from the price on the plan sheet', async () => {
    subscriber('pro_monthly', 'month');
    account.switchQuote.mockResolvedValue({ ...QUOTE, renewalAmountMinor: 4999 });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_quarterly')).toBeEnabled());
    expect(option('pro_quarterly')).toHaveTextContent('$54.99 / 3 months');
    fireEvent.click(radio('pro_quarterly'));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    await screen.findByTestId('switch-quote');
    expect(screen.getByRole('checkbox', { name: /every 3 months at \$49\.99 until I cancel/i })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /\$54\.99/ })).toBeNull();
  });

  it('weekly can be picked by a monthly subscriber, and is a switch too', async () => {
    subscriber('pro_monthly', 'month');
    account.switchQuote.mockResolvedValue({ ...QUOTE, quoteId: 'pro_weekly:1791590400', planKey: 'pro_weekly', amountDueTodayMinor: 0, renewalAmountMinor: 999 });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_weekly')).toBeEnabled());
    expect(radio('pro_weekly')).not.toBeChecked();
    fireEvent.click(radio('pro_weekly'));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    await screen.findByTestId('switch-quote');
    expect(account.switchQuote).toHaveBeenCalledWith({ planKey: 'pro_weekly' });
    expect(screen.getByRole('checkbox', { name: /renews automatically every week at \$9\.99 until I cancel/i })).not.toBeChecked();
  });

  it('the bank asks the buyer to confirm (requiresAction): the sheet says the plan has not changed and links to the invoice page in the same tab; no "You\'re on" state', async () => {
    subscriber('pro_monthly', 'month');
    const navigate = vi.fn();
    account.switchQuote.mockResolvedValue(QUOTE);
    account.switchConfirm.mockResolvedValue({ status: 'requires_action', planKey: 'pro_quarterly', hostedInvoiceUrl: 'https://invoice.stripe.test/i/acct_1/inv_1' });
    renderUi(<PlanPicker navigate={navigate} />);
    await waitFor(() => expect(radio('pro_quarterly')).toBeEnabled());
    fireEvent.click(radio('pro_quarterly'));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    await screen.findByTestId('switch-quote');
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm and pay/i }));
    const notice = await screen.findByTestId('switch-requires-action');
    expect(notice).toHaveTextContent('Your bank needs you to confirm this payment. Your plan has not changed yet.');
    const link = within(notice).getByRole('link', { name: 'Confirm the payment' });
    expect(link).toHaveAttribute('href', 'https://invoice.stripe.test/i/acct_1/inv_1');
    expect(link).not.toHaveAttribute('target');
    expect(screen.queryByText(/You're on/)).toBeNull();
    // The quote and its Confirm are gone: the payment is not asked for twice.
    expect(screen.queryByTestId('switch-quote')).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm and pay/i })).toBeNull();
    // The plan sheet still shows the plan they are on.
    expect(option('pro_monthly')).toHaveTextContent('Your plan');
    expect(option('pro_quarterly')).not.toHaveTextContent('Your plan');
    expect(navigate).not.toHaveBeenCalled();
    expect(account.portal).not.toHaveBeenCalled();
  });

  it('requiresAction with no invoice page: Manage payment instead, which opens the portal with no flow', async () => {
    subscriber('pro_monthly', 'month');
    const navigate = vi.fn();
    account.switchQuote.mockResolvedValue(QUOTE);
    account.switchConfirm.mockResolvedValue({ status: 'requires_action', planKey: 'pro_quarterly', hostedInvoiceUrl: null });
    account.portal.mockResolvedValue({ url: 'https://billing.stripe.test/portal' });
    renderUi(<PlanPicker navigate={navigate} />);
    await waitFor(() => expect(radio('pro_quarterly')).toBeEnabled());
    fireEvent.click(radio('pro_quarterly'));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    await screen.findByTestId('switch-quote');
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm and pay/i }));
    const notice = await screen.findByTestId('switch-requires-action');
    expect(within(notice).queryByRole('link')).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Manage payment' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://billing.stripe.test/portal'));
    expect(account.portal).toHaveBeenCalledWith();
    expect(screen.queryByText(/You're on/)).toBeNull();
  });

  it('a switch that fails says so and keeps the quote', async () => {
    subscriber('pro_monthly', 'month');
    account.switchQuote.mockResolvedValue(QUOTE);
    account.switchConfirm.mockRejectedValue(apiError('payment_provider_error', 502));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_quarterly')).toBeEnabled());
    fireEvent.click(radio('pro_quarterly'));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    await screen.findByTestId('switch-quote');
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm and pay/i }));
    expect(await screen.findByText("The switch didn't go through. Check your invoices before you try again.")).toBeInTheDocument();
    expect(screen.getByTestId('switch-quote')).toBeInTheDocument();
    expect(screen.queryByText(/You're on/)).toBeNull();
  });

  it('until the plan the buyer is on is known, Continue waits: it could be a checkout or a plan change', async () => {
    let resolveCredits: (v: ReturnType<typeof creditsResponse>) => void = () => {};
    api.getCredits.mockReturnValue(new Promise((r) => (resolveCredits = r)));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true }));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(account.checkoutPlan).not.toHaveBeenCalled();
    // The summary arrives: a monthly subscriber. Monthly is their plan, not something to buy again.
    await act(async () => {
      resolveCredits(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: IN_20_DAYS, upgradable: false }));
    });
    await waitFor(() => expect(option('pro_monthly')).toHaveTextContent('Your plan'));
    expect(radio('pro_monthly')).not.toBeChecked();
    expect(continueBtn()).toBeDisabled();
    expect(account.checkoutPlan).not.toHaveBeenCalled();
  });

  it('student plans are switches only for a verified student (the existing gate)', async () => {
    api.getPlans.mockResolvedValue(studentPlansView('roboapply'));
    subscriber('pro_monthly', 'month');
    const first = renderUi(<PlanPicker navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(option('pro_monthly')).toHaveTextContent('Your plan'));
    expect(option('student_monthly')).toBeNull();
    expect(option('student_quarterly')).toBeNull();
    first.unmount();
    v2.getStudentStatus.mockResolvedValue({ verified: true, schoolDomain: 'stanford.edu', verifiedAt: null, expiresAt: '2027-10-10T00:00:00Z', pendingDomain: null, available: true });
    renderUi(<PlanPicker navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(option('student_monthly')).not.toBeNull());
    expect(radio('student_monthly')).toBeEnabled();
    expect(radio('student_quarterly')).toBeEnabled();
    expect(radio('student_monthly')).not.toBeChecked();
    fireEvent.click(radio('student_quarterly'));
    expect(screen.getByRole('button', { name: /see what switching costs/i })).toBeEnabled();
  });

  it('a link to a plan this buyer is not offered falls back to the default instead of a dead button', async () => {
    // RoboApply's server lists the student plans for every caller; an unverified buyer is not offered them.
    api.getPlans.mockResolvedValue(studentPlansView('roboapply'));
    renderUi(<PlanPicker requestedPlan="student_monthly" navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(option('student_monthly')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically every month at \$24\.99/i }));
    expect(continueBtn()).toBeEnabled();
  });
});

describe('CancelSubscription', () => {
  it('cancels in ONE click with no dialog, then offers the 7-day pass once as a secondary link', async () => {
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: '2026-11-01T00:00:00Z', alternative: { planKey: 'pro_week_pass' } });
    renderUi(<CancelSubscription periodEnd="2026-11-01T00:00:00Z" />);
    const button = screen.getByRole('button', { name: 'Cancel subscription' });
    fireEvent.click(button);
    await screen.findByTestId('cancel-done');
    expect(api.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Your subscription is cancelled');
    const alt = screen.getByTestId('cancel-alternative');
    expect(alt).toHaveTextContent('Switch to the 7-day pass instead?');
    expect(alt).toHaveAttribute('href', expect.stringContaining('plan=pro_week_pass'));
    expect(window.localStorage.getItem(CANCEL_ALTERNATIVE_STORAGE_KEY)).toBe('1');
  });

  it('the alternative is never shown a second time', async () => {
    window.localStorage.setItem(CANCEL_ALTERNATIVE_STORAGE_KEY, '1');
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: null, alternative: { planKey: 'pro_week_pass' } });
    renderUi(<CancelSubscription periodEnd={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await screen.findByTestId('cancel-done');
    expect(screen.queryByTestId('cancel-alternative')).toBeNull();
  });

  it('the survey is optional and comes after; it goes to the survey endpoint, never the cancel call again', async () => {
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: null, alternative: null });
    api.sendCancelSurvey.mockResolvedValue(undefined);
    renderUi(<CancelSubscription periodEnd={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await screen.findByTestId('cancel-done');
    expect(screen.queryByTestId('cancel-alternative')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'I found a job' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Thanks for telling us.');
    expect(api.sendCancelSurvey).toHaveBeenCalledWith({ reason: 'found_job', note: undefined });
    expect(api.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('a failed survey says so and that the subscription is still cancelled', async () => {
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: null, alternative: null });
    api.sendCancelSurvey.mockRejectedValue(new Error('x'));
    renderUi(<CancelSubscription periodEnd={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await screen.findByTestId('cancel-done');
    fireEvent.click(screen.getByRole('button', { name: 'Too expensive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still cancelled');
  });

  it('on failure it points to the public cancel page', async () => {
    api.cancelSubscription.mockRejectedValue(new Error('x'));
    renderUi(<CancelSubscription periodEnd={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link')).toHaveAttribute('href', '/cancel');
  });
});

describe('BillingView', () => {
  it('monthly Pro: renewal date, Manage payment, one-click Cancel; the plan sheet marks the plan and offers the switches', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ tier: 'free', hasStripeCustomer: true }));
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(within(card).getByText('Pro Monthly')).toBeInTheDocument());
    expect(card).toHaveTextContent('Renews on');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Manage payment' })).toBeInTheDocument());
    expect(within(card).getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    await screen.findByTestId('plan-picker');
    // The plan sheet lists the plan they are on and the subscriptions they can switch to.
    await waitFor(() => expect(option('pro_monthly')).toHaveTextContent('Your plan'));
    expect(radio('pro_monthly')).toBeDisabled();
    expect(radio('pro_weekly')).toBeEnabled();
    expect(radio('pro_quarterly')).toBeEnabled();
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toBeNull();
    expect(document.querySelector('[data-plan="practice_pack_5"]')).not.toBeNull();
    // Nothing to keep: the plan was not cancelled.
    expect(screen.queryByTestId('resume-subscription')).toBeNull();
  });

  it('payment failed: the banner button opens the payment-method update flow (ST-7)', async () => {
    const navigate = vi.fn();
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }));
    account.plan.mockResolvedValue(legacyPlan({ status: 'past_due', hasStripeCustomer: true }));
    account.portal.mockResolvedValue({ url: 'https://billing.stripe.test/p' });
    renderUi(<BillingView navigate={navigate} />);
    const banner = await screen.findByTestId('payment-failed');
    fireEvent.click(within(banner).getByRole('button', { name: 'Update payment method' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://billing.stripe.test/p'));
    expect(account.portal).toHaveBeenCalledTimes(1);
    expect(account.portal).toHaveBeenCalledWith({ flow: 'payment_method_update' });
  });

  it('Manage payment opens the plain portal: no flow is posted', async () => {
    const navigate = vi.fn();
    subscriber('pro_monthly', 'month');
    account.portal.mockResolvedValue({ url: 'https://billing.stripe.test/home' });
    renderUi(<BillingView navigate={navigate} />);
    const card = await screen.findByTestId('current-plan');
    fireEvent.click(await within(card).findByRole('button', { name: 'Manage payment' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://billing.stripe.test/home'));
    expect(account.portal).toHaveBeenCalledTimes(1);
    expect(account.portal).toHaveBeenCalledWith();
  });

  it.each([
    ['no_customer', 409],
    ['stripe_not_configured', 503],
    ['payment_provider_error', 502],
  ])('a portal error (%s) shows the error line on the banner and opens nothing', async (code, status) => {
    const navigate = vi.fn();
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }));
    account.plan.mockResolvedValue(legacyPlan({ status: 'unpaid', hasStripeCustomer: true }));
    account.portal.mockRejectedValue(apiError(code, status));
    renderUi(<PaymentFailedBanner navigate={navigate} />);
    const banner = await screen.findByTestId('payment-failed');
    fireEvent.click(within(banner).getByRole('button', { name: 'Update payment method' }));
    expect(await within(banner).findByText("We couldn't open the payment settings. Try again.")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['past_due', 'unpaid', 'incomplete'])('the banner shows while the plan status is %s, and clears through the normal refetch', async (status) => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }));
    account.plan.mockResolvedValue(legacyPlan({ status, hasStripeCustomer: true }));
    renderUi(
      <>
        <PaymentFailedBanner navigate={vi.fn()} />
        <RefetchBilling />
      </>,
    );
    await screen.findByTestId('payment-failed');
    account.plan.mockResolvedValue(legacyPlan({ status: 'active', hasStripeCustomer: true }));
    fireEvent.click(screen.getByRole('button', { name: 'refetch billing' }));
    await waitFor(() => expect(screen.queryByTestId('payment-failed')).toBeNull());
  });

  it('free: plan name Free, no cancel, plan sheet shown', async () => {
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(within(card).getByText('Free')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    expect(screen.queryByTestId('payment-failed')).toBeNull();
    await screen.findByTestId('plan-picker');
  });

  it('a pass: "Buy another pass" selects that pass, which is buyable; no cancel button', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_week_pass', planProfile: 'pro', interval: 'pass', periodEnd: '2026-10-15T00:00:00Z' }));
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(card).toHaveTextContent('Your pass ends on'));
    expect(within(card).getByRole('link', { name: 'Buy another pass' })).toHaveAttribute('href', '/settings/billing?plan=pro_week_pass#plans');
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    await waitFor(() => expect(radio('pro_week_pass')).toBeEnabled());
  });

  it('cancel → the confirmation, the pass link and the survey stay after the refetch; following the link shows and selects the pass', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false }));
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: '2026-11-01T00:00:00Z', alternative: { planKey: 'pro_week_pass' } });
    const view = renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    const cancel = await within(card).findByRole('button', { name: 'Cancel subscription' });
    // Before the cancel, a renewing subscriber sees the subscriptions (their own and the switches), not the passes.
    await screen.findByTestId('plan-picker');
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toBeNull();
    await waitFor(() => expect(option('pro_quarterly')).not.toBeNull());
    // The server now reports the cancellation on the summary (the only source the view reads).
    api.getCredits.mockResolvedValue(
      creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false, cancelAtPeriodEnd: true }),
    );
    fireEvent.click(cancel);
    await screen.findByTestId('cancel-done');
    await waitFor(() => expect(card).toHaveTextContent('Cancelled. Pro stays on until'));
    expect(screen.getByTestId('cancel-done')).toBeInTheDocument();
    const alt = screen.getByTestId('cancel-alternative');
    expect(alt).toHaveAttribute('href', '/settings/billing?plan=pro_week_pass#plans');
    expect(screen.getByText('Want to tell us why? (optional)')).toBeInTheDocument();
    // Following the link (/settings/billing passes ?plan= down): the pass is shown and selected.
    view.rerender(withBrand(<BillingView requestedPlan="pro_week_pass" navigate={vi.fn()} />));
    await waitFor(() => expect(radio('pro_week_pass')).toBeChecked());
    expect(radio('pro_week_pass')).toBeEnabled();
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toHaveTextContent('$9.99, paid once');
    await waitFor(() => expect(continueBtn()).toBeEnabled());
  });

  it('the requested pass is shown even while the plan still reads as renewing', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false }));
    renderUi(<BillingView requestedPlan="pro_week_pass" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_week_pass')).toBeChecked());
    // Only the pass asked for: the other passes stay off the sheet until the subscription is cancelled.
    expect(radio('pro_week_pass')).toBeEnabled();
    expect(option('pro_monthly')).toHaveTextContent('Your plan');
    // Buying the pass is a checkout, not a switch (the server decides whether a pass can be bought now).
    expect(screen.getByRole('button', { name: /continue to payment/i })).toBeInTheDocument();
  });
});

// ST-6 (web): MARKET_STRATEGY §4.4 "Cancel": "Keep my plan" resumes while the period is live.
describe('BillingView: "Keep my plan" for a cancelled subscription that is still running', () => {
  const keep = () => screen.getByRole('button', { name: 'Keep my plan' });
  const cancelled = { cancelAtPeriodEnd: true };
  const charged = { amountMinor: 2499, currency: 'usd' };

  it.each([
    { name: 'a monthly plan, cancelled, period still running', brand: 'roboapply' as const, summary: { planKey: 'pro_monthly', planProfile: 'pro' as const, interval: 'month', periodEnd: IN_20_DAYS, ...cancelled }, shown: true },
    { name: 'a weekly plan, cancelled, period still running', brand: 'roboapply' as const, summary: { planKey: 'pro_weekly', planProfile: 'pro' as const, interval: 'week', periodEnd: IN_20_DAYS, ...cancelled }, shown: true },
    { name: 'a plan that still renews (not cancelled)', brand: 'roboapply' as const, summary: { planKey: 'pro_monthly', planProfile: 'pro' as const, interval: 'month', periodEnd: IN_20_DAYS }, shown: false },
    { name: 'a cancelled plan whose period has ended', brand: 'roboapply' as const, summary: { planKey: 'pro_monthly', planProfile: 'pro' as const, interval: 'month', periodEnd: YESTERDAY, ...cancelled }, shown: false },
    { name: 'a cancelled plan with no period end', brand: 'roboapply' as const, summary: { planKey: 'pro_monthly', planProfile: 'pro' as const, interval: 'month', periodEnd: null, ...cancelled }, shown: false },
    { name: 'a one-time pass', brand: 'roboapply' as const, summary: { planKey: 'pro_week_pass', planProfile: 'pro' as const, interval: 'pass', periodEnd: IN_20_DAYS }, shown: false },
    { name: 'a free account', brand: 'roboapply' as const, summary: {}, shown: false },
    { name: 'GoApply (passes; nothing renews there)', brand: 'goapply' as const, summary: { planKey: 'pro_monthly', planProfile: 'pro' as const, interval: 'pass', periodEnd: IN_20_DAYS }, shown: false },
    { name: 'GoApply, even if a summary read as a cancelled renewing plan', brand: 'goapply' as const, summary: { planKey: 'pro_monthly', planProfile: 'pro' as const, interval: 'month', periodEnd: IN_20_DAYS, ...cancelled }, shown: false },
    // The server keeps no renewal terms for a grandfathered practice plan and refuses to resume one.
    {
      name: 'a cancelled legacy practice plan, period still running',
      brand: 'roboapply' as const,
      summary: { planKey: 'starter', legacyPlan: true, interval: 'month', periodEnd: IN_20_DAYS, ...cancelled },
      billing: { tier: 'starter' as const, currentPeriodEnd: IN_20_DAYS },
      shown: false,
    },
  ])('$name → shown: $shown', async ({ brand, summary, shown, ...row }) => {
    api.getCredits.mockResolvedValue(creditsResponse({ upgradable: false, ...summary }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: brand === 'roboapply', ...charged, ...('billing' in row ? row.billing : {}) }));
    if (brand === 'goapply') api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<BillingView navigate={vi.fn()} />, { brand });
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(within(card).queryByText('Loading your plan…')).toBeNull());
    if (shown) {
      await within(card).findByTestId('resume-subscription');
      expect(card).toHaveTextContent('Cancelled. Pro stays on until');
    } else {
      // Give the billing plan and the plans time to arrive before asserting an absence.
      await waitFor(() => expect(account.plan).toHaveBeenCalled());
      await screen.findByText('Invoices and receipts');
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId('resume-subscription')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Keep my plan' })).toBeNull();
    }
    expect(account.resumeSubscription).not.toHaveBeenCalled();
  });

  it('the box is unticked and carries the checkout sentence with the period and the price that is charged; the button waits for it', async () => {
    subscriber('pro_monthly', 'month', cancelled, { amountMinor: 1999, currency: 'usd' });
    renderUi(<BillingView navigate={vi.fn()} />);
    const block = await screen.findByTestId('resume-subscription');
    // What the subscription is charged (the billing plan), not the catalog's $24.99.
    const ack = within(block).getByRole('checkbox', { name: 'I agree this renews automatically every month at $19.99 until I cancel.' });
    expect(ack).not.toBeChecked();
    expect(keep()).toBeDisabled();
    fireEvent.click(keep());
    expect(account.resumeSubscription).not.toHaveBeenCalled();
    fireEvent.click(ack);
    expect(keep()).toBeEnabled();
    fireEvent.click(ack);
    expect(keep()).toBeDisabled();
  });

  it('a quarterly plan reads "every 3 months"; a plan charged in another currency names that price, not the catalog\'s', async () => {
    subscriber('pro_quarterly', 'quarter', cancelled, { amountMinor: 5499, currency: 'usd' });
    const first = renderUi(<BillingView navigate={vi.fn()} />);
    const block = await screen.findByTestId('resume-subscription');
    expect(within(block).getByRole('checkbox', { name: 'I agree this renews automatically every 3 months at $54.99 until I cancel.' })).not.toBeChecked();
    first.unmount();
    // A Taiwan subscription: charged NT$749 a month while the catalog lists $24.99.
    subscriber('pro_monthly', 'month', cancelled, { amountMinor: 74900, currency: 'twd' });
    renderUi(<BillingView navigate={vi.fn()} />);
    const ack = within(await screen.findByTestId('resume-subscription')).getByRole('checkbox');
    // 74900 minor units of TWD, formatted by the shared money helper; never the catalog's 24.99.
    expect(ack).toHaveAccessibleName(expect.stringMatching(/every month at \D*749 until I cancel\.$/));
    expect(ack).not.toHaveAccessibleName(expect.stringContaining('24.99'));
  });

  it('with no charged price on the billing plan nothing is offered, although the catalog lists the plan (the sentence is never printed with a guess)', async () => {
    subscriber('pro_monthly', 'month', cancelled);
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(card).toHaveTextContent('Cancelled. Pro stays on until'));
    // The billing plan has answered (Manage payment comes from it) and the catalog has the plan at $24.99.
    await within(card).findByRole('button', { name: 'Manage payment' });
    await waitFor(() => expect(option('pro_week_pass')).not.toBeNull());
    expect(screen.queryByTestId('resume-subscription')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep my plan' })).toBeNull();
  });

  it('when the billing plan cannot be read nothing is offered: a failed read is not an answer, and the catalog price is not what is charged', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: IN_20_DAYS, upgradable: false, ...cancelled }));
    account.plan.mockRejectedValue(apiError('internal_error', 500));
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(card).toHaveTextContent('Cancelled. Pro stays on until'));
    await waitFor(() => expect(account.plan).toHaveBeenCalled());
    await waitFor(() => expect(option('pro_week_pass')).not.toBeNull());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('resume-subscription')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep my plan' })).toBeNull();
    expect(account.resumeSubscription).not.toHaveBeenCalled();
  });

  it('success: one call, then the card says the plan renews (from the refetched summary) and Cancel is offered again', async () => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockImplementation(async () => {
      // The server turned renewal back on: the next read of the summary says so.
      subscriber('pro_monthly', 'month', {}, charged);
      return { status: 'resumed', planKey: 'pro_monthly', renewsAt: IN_20_DAYS };
    });
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    const block = await within(card).findByTestId('resume-subscription');
    expect(within(card).queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    await waitFor(() => expect(card).toHaveTextContent('Renews on'));
    expect(account.resumeSubscription).toHaveBeenCalledTimes(1);
    expect(account.resumeSubscription).toHaveBeenCalledWith();
    expect(card).not.toHaveTextContent('Cancelled. Pro stays on until');
    await waitFor(() => expect(screen.queryByTestId('resume-subscription')).toBeNull());
    expect(screen.queryByTestId('resume-done')).toBeNull();
    expect(await within(card).findByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    // The plan sheet offers the switches again.
    await waitFor(() => expect(option('pro_monthly')).toHaveTextContent('Your plan'));
  });

  it('until the summary has been read again the card keeps its line and says only that renewal is back on', async () => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockResolvedValue({ status: 'resumed', planKey: 'pro_monthly', renewsAt: null });
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    const block = await within(card).findByTestId('resume-subscription');
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    expect(await within(card).findByTestId('resume-done')).toHaveTextContent('Renewal is back on.');
    // The summary still says cancelled: no "Renews on" is claimed from the answer alone.
    expect(card).not.toHaveTextContent('Renews on');
    expect(screen.queryByRole('button', { name: 'Keep my plan' })).toBeNull();
  });

  it('cancel, then keep the plan: the "cancelled" confirmation goes away with the cancellation', async () => {
    subscriber('pro_monthly', 'month', {}, charged);
    api.cancelSubscription.mockImplementation(async () => {
      subscriber('pro_monthly', 'month', cancelled, charged);
      return { status: 'cancelled', accessUntil: IN_20_DAYS, alternative: null };
    });
    account.resumeSubscription.mockImplementation(async () => {
      subscriber('pro_monthly', 'month', {}, charged);
      return { status: 'resumed', planKey: 'pro_monthly', renewsAt: IN_20_DAYS };
    });
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    fireEvent.click(await within(card).findByRole('button', { name: 'Cancel subscription' }));
    await screen.findByTestId('cancel-done');
    const block = await within(card).findByTestId('resume-subscription');
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    await waitFor(() => expect(card).toHaveTextContent('Renews on'));
    expect(screen.queryByTestId('cancel-done')).toBeNull();
    expect(await within(card).findByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
  });

  // 409 nothing_to_resume says only that the page was behind the server. What
  // the user is told comes from the plan as it is read again after the refusal.
  // A refusal comes over the network, so it arrives in a later task than the
  // click: `refuse` keeps that order (the button shows "pending" first).
  const refuse = async (code: string, status: number): Promise<never> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    throw apiError(code, status);
  };
  it('409 nothing_to_resume and the plan read again is over: "This plan has already ended. Choose a plan below."', async () => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockImplementation(async () => {
      // The plan is over on the server: the next read of the summary is Free.
      api.getCredits.mockResolvedValue(creditsResponse());
      account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true }));
      return refuse('nothing_to_resume', 409);
    });
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    const block = await within(card).findByTestId('resume-subscription');
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    expect(await within(card).findByRole('alert')).toHaveTextContent('This plan has already ended. Choose a plan below.');
    // Worded from the plan read again: the card already says Free, and the retry line never showed.
    expect(within(card).getByText('Free')).toBeInTheDocument();
    expect(within(card).getByTestId('resume-ended')).toBeInTheDocument();
    expect(screen.queryByText("We couldn't turn renewal back on. Try again.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep my plan' })).toBeNull();
    expect(card).not.toHaveTextContent('Renews on');
  });

  it('409 nothing_to_resume and the plan read again renews (kept in another tab): no "already ended" line, the card says "Renews on"', async () => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockImplementation(async () => {
      // Renewal was already turned back on elsewhere: the next read says the plan renews.
      subscriber('pro_monthly', 'month', {}, charged);
      return refuse('nothing_to_resume', 409);
    });
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    const block = await within(card).findByTestId('resume-subscription');
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    await waitFor(() => expect(card).toHaveTextContent('Renews on'));
    await waitFor(() => expect(screen.queryByTestId('resume-subscription')).toBeNull());
    expect(await within(card).findByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    expect(screen.queryByTestId('resume-ended')).toBeNull();
    expect(screen.queryByText('This plan has already ended. Choose a plan below.')).toBeNull();
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(account.resumeSubscription).toHaveBeenCalledTimes(1);
    // The plan sheet agrees with the card.
    await waitFor(() => expect(option('pro_monthly')).toHaveTextContent('Your plan'));
    expect(screen.queryByTestId('resume-ended')).toBeNull();
  });

  it('409 nothing_to_resume while the plan read again is still cancelled and running: the retry line, never "already ended"', async () => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockImplementation(() => refuse('nothing_to_resume', 409));
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    const block = await within(card).findByTestId('resume-subscription');
    const readsBefore = api.getCredits.mock.calls.length;
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    expect(await within(card).findByRole('alert')).toHaveTextContent("We couldn't turn renewal back on. Try again.");
    // The summary was read again before anything was said.
    expect(api.getCredits.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(screen.queryByTestId('resume-ended')).toBeNull();
    expect(card).toHaveTextContent('Cancelled. Pro stays on until');
    expect(keep()).toBeEnabled();
  });

  it('a refusal is not remembered into a later cancellation: after the plan renews again and is cancelled again, the box is offered clean', async () => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockImplementation(async () => {
      subscriber('pro_monthly', 'month', {}, charged);
      return refuse('nothing_to_resume', 409);
    });
    api.cancelSubscription.mockImplementation(async () => {
      subscriber('pro_monthly', 'month', cancelled, charged);
      return { status: 'cancelled', accessUntil: IN_20_DAYS, alternative: null };
    });
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    fireEvent.click(within(await within(card).findByTestId('resume-subscription')).getByRole('checkbox'));
    fireEvent.click(keep());
    fireEvent.click(await within(card).findByRole('button', { name: 'Cancel subscription' }));
    const again = await within(card).findByTestId('resume-subscription');
    expect(within(again).getByRole('checkbox')).not.toBeChecked();
    expect(within(again).queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('resume-ended')).toBeNull();
    expect(keep()).toBeDisabled();
  });

  it.each([
    ['auto_renew_ack_required', 422],
    ['rail_not_configured', 503],
    ['payment_provider_error', 502],
  ])('%s: the generic retry line; the box and the button stay', async (code, status) => {
    subscriber('pro_monthly', 'month', cancelled, charged);
    account.resumeSubscription.mockRejectedValue(apiError(code, status));
    renderUi(<BillingView navigate={vi.fn()} />);
    const block = await screen.findByTestId('resume-subscription');
    fireEvent.click(within(block).getByRole('checkbox'));
    fireEvent.click(keep());
    expect(await within(block).findByRole('alert')).toHaveTextContent("We couldn't turn renewal back on. Try again.");
    expect(screen.queryByTestId('resume-ended')).toBeNull();
    expect(keep()).toBeEnabled();
  });
});

// AL-6 (web): MARKET_STRATEGY §5.3 G12, M-18. One line with a link; no redirect.
describe('PlanPicker: a visitor in mainland China on the international brand', () => {
  const note = () => screen.queryByTestId('cn-visitor-note');

  it('edge country CN on RoboApply: one line linking to the other brand\'s pricing page; nothing navigates and the plans still work', async () => {
    const navigate = vi.fn();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, replace: assign } });
    try {
      account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/cn', orderId: 'cs_cn', rail: 'stripe' });
      renderUi(<PlanPicker visitorCountry="CN" navigate={navigate} />);
      await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
      const line = note()!;
      expect(line).toHaveTextContent('In mainland China? You can pay in RMB with Alipay on GoApply.');
      const links = within(line).getAllByRole('link');
      expect(links).toHaveLength(1);
      // The other brand's canonical origin from the brand payload, plus /pricing.
      expect(links[0]).toHaveAttribute('href', 'https://www.goapply.top/pricing');
      expect(links[0]).toHaveAttribute('rel', 'noopener');
      // Above the options.
      expect(line.compareDocumentPosition(option('pro_weekly')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // No redirect: rendering opened nothing.
      expect(navigate).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      // The card plans stay fully usable.
      for (const key of ['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15']) expect(radio(key), key).toBeEnabled();
      expect(screen.queryByTestId('rail-chooser')).toBeNull();
      fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
      fireEvent.click(continueBtn());
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/cn'));
      expect(account.checkoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'pro_monthly' }), anAttempt());
      expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it.each(['TW', 'HK', 'MO', 'US', 'SG', null])('country %s renders no line', async (country) => {
    renderUi(<PlanPicker visitorCountry={country} navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(note()).toBeNull();
    expect(document.body.textContent).not.toContain('mainland China');
  });

  it('the country the plans response or the edge lookup resolves counts too (/settings#billing has no server country)', async () => {
    api.getPlans.mockResolvedValue({ ...plansView(), checkout: checkoutOf(['stripe'], { country: 'CN' }) });
    const first = renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(note()).not.toBeNull());
    first.unmount();
    api.getPlans.mockResolvedValue(plansView());
    countryAction.visitorCountryAction.mockResolvedValue('CN');
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(note()).not.toBeNull());
  });

  it('an unknown country (the lookup answers nothing) renders no line', async () => {
    countryAction.visitorCountryAction.mockResolvedValue(null);
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    await waitFor(() => expect(countryAction.visitorCountryAction).toHaveBeenCalled());
    expect(note()).toBeNull();
  });

  it('GoApply never renders it, whatever the country', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply', undefined, { paymentsOpen: true, checkout: checkoutOf(['alipay'], { country: 'CN' }) }));
    renderUi(<PlanPicker visitorCountry="CN" navigate={vi.fn()} />, { brand: 'goapply' });
    await waitFor(() => expect(option('pro_monthly')).not.toBeNull());
    expect(note()).toBeNull();
    expect(document.body.textContent).not.toMatch(/mainland China|RoboApply/);
  });
});

// ST-3 (web): MARKET_STRATEGY §5.1 "Lost-event recovery". Call count per state,
// with the account API mocked and fake timers.
describe('CheckoutReturn: the Checkout Session is reconciled on return', () => {
  const SESSION = 'cs_test_a1B2c3D4e5F6g7H8';
  const POLL = 1000;
  const free = () => creditsResponse();
  const pro = (planKey = 'pro_week_pass') => creditsResponse({ planProfile: 'pro', planKey, interval: 'pass' });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One re-read of the summary: the poll timer fires and its promises settle. */
  async function polls(n: number) {
    for (let i = 0; i < n; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL);
      });
    }
  }
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  const page = (ui: ReactElement, brand: 'roboapply' | 'goapply' = 'roboapply') => renderUi(ui, { brand });

  it('the route reads session_id only when it is a Checkout Session id', async () => {
    const props = async (query: Record<string, string | string[]>) => ((await SettingsBillingReturnPage({ searchParams: Promise.resolve(query) })) as ReactElement<Record<string, unknown>>).props;
    expect(await props({ billing: 'success', session_id: SESSION, plan: 'pro_week_pass' })).toMatchObject({ outcome: 'success', planKey: 'pro_week_pass', sessionId: SESSION });
    expect((await props({ billing: 'success', session_id: `cs_live_${'a'.repeat(58)}` })).sessionId).toBe(`cs_live_${'a'.repeat(58)}`);
    for (const bad of ['', 'cs_', 'cs_short', 'sub_1234567890', 'cs_test_has-dash-inside', 'cs_test_has space1', `cs_${'a'.repeat(201)}`, '{CHECKOUT_SESSION_ID}', '../../etc']) {
      expect((await props({ billing: 'success', session_id: bad })).sessionId, bad).toBeNull();
    }
    expect((await props({ billing: 'success', session_id: [SESSION, SESSION] })).sessionId).toBeNull();
    expect((await props({ billing: 'success' })).sessionId).toBeNull();
  });

  it('back with ?billing=success&session_id=cs_…: one call at once; a pass shows Pro as soon as the summary says so, with no further call', async () => {
    api.getCredits.mockResolvedValueOnce(free());
    api.getCredits.mockResolvedValue(pro());
    account.reconcileCheckout.mockResolvedValue({ status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    // At once: before any poll timer has fired.
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    expect(account.reconcileCheckout).toHaveBeenCalledWith(SESSION);
    await settle();
    // After the answer the summary was read again; it says Pro, so the page does.
    expect(await screen.findByText('Pro is on.')).toBeInTheDocument();
    await polls(RETURN_POLL_ATTEMPTS + 2);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
  });

  it('a pack shows its new balance once the practice balance says so', async () => {
    api.getCredits.mockResolvedValueOnce(creditsResponse({}, { balance: 2 }));
    api.getCredits.mockResolvedValue(creditsResponse({}, { balance: 7 }));
    account.reconcileCheckout.mockResolvedValue({ status: 'fulfilled', mode: 'payment', planKey: 'practice_pack_5' });
    page(<CheckoutReturn outcome="success" planKey="practice_pack_5" practiceBefore={2} sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(await screen.findByText('Your practice interviews are added. You have 7 now.')).toBeInTheDocument();
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
  });

  it('the page never claims success from the reconcile answer alone', async () => {
    api.getCredits.mockResolvedValue(free());
    account.reconcileCheckout.mockResolvedValue({ status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Your plan updates within a minute/)).toBeInTheDocument();
    expect(screen.queryByText('Pro is on.')).toBeNull();
    // The summary never says Pro: the page ends on the "taking longer" line, still without claiming it.
    await polls(RETURN_POLL_ATTEMPTS);
    expect(screen.getByText(/taking longer than usual/)).toBeInTheDocument();
    expect(screen.queryByText('Pro is on.')).toBeNull();
    // Settled on the server: it was not asked again.
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
  });

  it('a pending answer keeps polling: asked again on every third re-read while still waiting', async () => {
    api.getCredits.mockResolvedValue(free());
    account.reconcileCheckout.mockResolvedValue({ status: 'pending', mode: 'payment', planKey: 'pro_week_pass' });
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    await polls(RETURN_RECONCILE_EVERY - 1);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    await polls(1);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(2);
    await polls(RETURN_RECONCILE_EVERY);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(3);
    await polls(RETURN_POLL_ATTEMPTS);
    // Once when it opened, then on re-reads 3, 6 and 9 of the 10.
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1 + Math.floor(RETURN_POLL_ATTEMPTS / RETURN_RECONCILE_EVERY));
    expect(screen.getByText(/taking longer than usual/)).toBeInTheDocument();
  });

  it('pending, then fulfilled on a later call: the page turns to done when the summary does, and stops asking', async () => {
    api.getCredits.mockResolvedValue(free());
    account.reconcileCheckout.mockResolvedValueOnce({ status: 'pending', mode: 'payment', planKey: 'pro_week_pass' });
    account.reconcileCheckout.mockImplementationOnce(async () => {
      api.getCredits.mockResolvedValue(pro());
      return { status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' };
    });
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(screen.getByText(/Your plan updates within a minute/)).toBeInTheDocument();
    await polls(RETURN_RECONCILE_EVERY);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Pro is on.')).toBeInTheDocument();
    await polls(RETURN_POLL_ATTEMPTS);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['forbidden', 403],
    ['not_found', 404],
    ['invalid_request', 422],
    ['stripe_not_configured', 503],
  ])('a %s answer (%i) makes no further call and leaves the waiting, then the "taking longer" copy', async (code, status) => {
    api.getCredits.mockResolvedValue(free());
    account.reconcileCheckout.mockRejectedValue(apiError(code, status));
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Your plan updates within a minute/)).toBeInTheDocument();
    await polls(RETURN_POLL_ATTEMPTS + 1);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/taking longer than usual/)).toBeInTheDocument();
    expect(screen.queryByText('Pro is on.')).toBeNull();
  });

  it.each([
    ['rate_limited', 429],
    ['payment_provider_error', 502],
  ])('a %s answer (%i) may pass: it is asked again on the third re-read', async (code, status) => {
    api.getCredits.mockResolvedValue(free());
    account.reconcileCheckout.mockRejectedValue(apiError(code, status));
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    await polls(RETURN_RECONCILE_EVERY);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'no session id', ui: <CheckoutReturn outcome="success" planKey="pro_week_pass" pollMs={POLL} />, brand: 'roboapply' as const },
    { name: 'a session id that is not one', ui: <CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId="cs_x" pollMs={POLL} />, brand: 'roboapply' as const },
    { name: 'outcome cancel', ui: <CheckoutReturn outcome="cancel" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />, brand: 'roboapply' as const },
    { name: 'no outcome', ui: <CheckoutReturn outcome={null} planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />, brand: 'roboapply' as const },
    { name: 'GoApply', ui: <CheckoutReturn outcome="success" planKey="pro_monthly" sessionId={SESSION} pollMs={POLL} />, brand: 'goapply' as const },
  ])('no call is made: $name', async ({ ui, brand }) => {
    api.getCredits.mockResolvedValue(free());
    if (brand === 'goapply') api.getPlans.mockResolvedValue(plansView('goapply'));
    page(ui, brand);
    await settle();
    await polls(RETURN_POLL_ATTEMPTS + 1);
    expect(account.reconcileCheckout).not.toHaveBeenCalled();
  });

  it('a pack bought with no balance to compare: waited for only while the server says the payment is not settled; then the neutral line', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({}, { balance: 9 }));
    account.reconcileCheckout.mockResolvedValueOnce({ status: 'pending', mode: 'payment', planKey: 'practice_pack_5' });
    account.reconcileCheckout.mockResolvedValue({ status: 'fulfilled', mode: 'payment', planKey: 'practice_pack_5' });
    page(<CheckoutReturn outcome="success" planKey="practice_pack_5" practiceBefore={null} sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(screen.getByText(/practice interviews are added within a minute/)).toBeInTheDocument();
    await polls(RETURN_RECONCILE_EVERY);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(2);
    // Settled, but there is nothing to compare the balance with: neutral, never "You have N now".
    expect(await screen.findByText(/added as soon as the payment clears/)).toBeInTheDocument();
    expect(screen.queryByText(/You have 9 now/)).toBeNull();
    await polls(RETURN_POLL_ATTEMPTS);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(2);
  });

  it('already Pro when the page opens (a second pass): still one call, so the new pass is not left to a lost notification', async () => {
    api.getCredits.mockResolvedValue(pro());
    account.reconcileCheckout.mockResolvedValue({ status: 'already_fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    page(<CheckoutReturn outcome="success" planKey="pro_week_pass" sessionId={SESSION} pollMs={POLL} />);
    await settle();
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
    await polls(3);
    expect(account.reconcileCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsSection', () => {
  it('#billing renders the billing view; #credits the credits view', async () => {
    const { unmount } = renderUi(<SettingsSection section="billing" />);
    expect(await screen.findByTestId('billing-view')).toBeInTheDocument();
    unmount();
    renderUi(<SettingsSection section="credits" />);
    expect(await screen.findByTestId('credits-usage')).toBeInTheDocument();
  });

  it('other sections render nothing', () => {
    const { container } = renderUi(<SettingsSection section="security" />);
    expect(container).toBeEmptyDOMElement();
  });
});
