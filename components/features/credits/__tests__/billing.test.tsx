// WP-21b acceptance — plan sheet, legacy quote, one-click cancel, payment
// failed (component tests at 375 px; no network: lib/api is mocked).
// Market wave M2 (MKT-2E): every Pro to Pro switch on the plan sheet with a
// quote and a new acknowledgement (ST-5), "Keep my plan" (ST-6), the
// payment-method flow of the failed-payment banner (ST-7), the return page's
// reconcile call (ST-3) and the line for a mainland visitor (AL-6).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { focusManager, useQueryClient } from '@tanstack/react-query';

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
  withdrawal: vi.fn(),
  withdraw: vi.fn(),
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
import { WITHDRAW_REREAD_DELAYS_MS, WithdrawContract, openWithdrawals, withdrawRefusal, withdrawalKind } from '../WithdrawContract';
import type { WithdrawalOption, WithdrawalOverview } from '../../../../lib/api/account';
import { WITHDRAWAL_OPEN_STEP_REFRESH_MS, WITHDRAWAL_STALE_MS } from '../../../../hooks/credits/useBillingActions';
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
  // No purchase can be withdrawn unless a test says otherwise (the answer for most buyers).
  account.withdrawal.mockResolvedValue({ available: false, options: [] });
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
    // 74900 minor units of TWD; never the catalog's 24.99. The sentence has no currency note beside it, so on a
    // US dollar page the amount names its currency: "NT$749", never a bare "$749" (waveM2-carryover MKT-4C.3).
    expect(ack).toHaveAccessibleName('I agree this renews automatically every month at NT$749 until I cancel.');
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
// ST-9 (web): MARKET_STRATEGY §4.4 "Statutory withdrawal": a labelled "Withdraw
// from contract" entry for 14 days after each purchase of a buyer in the EU,
// the EEA, the UK or Taiwan. Who sees it is the server's answer; the page asks
// and prints, it never computes an amount or a day.
describe('BillingView: "Withdraw from contract" for 14 days after an eligible purchase', () => {
  // The page's clock in the tests that fix it: noon on day 5 of a purchase made on Oct 6.
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  const now = () => NOW;
  const PAID_AT = '2026-10-06T12:00:00.000Z';
  const DEADLINE = '2026-10-20T12:00:00.000Z';
  const IN_9_DAYS = new Date(Date.now() + 9 * 86_400_000).toISOString();

  /** One open purchase and its quote. The default: a monthly plan on day 5, waiver ticked, 25 of 30 days go back. */
  const option = (over: { purchase?: Partial<WithdrawalOption['purchase']>; quote?: Partial<WithdrawalOption['quote']> } = {}): WithdrawalOption => ({
    purchase: { source: 'stripe', id: 'in_monthly_1', planKey: 'pro_monthly', chargedAt: PAID_AT, amountMinor: 2499, currency: 'USD', ...over.purchase },
    quote: { rule: 'withdrawal_14d_prorata', refundMinor: 2083, currency: 'USD', deadline: DEADLINE, prorata: { usedDays: 5, periodDays: 30 }, region: 'eu', ...over.quote },
  });
  const open = (...options: WithdrawalOption[]): WithdrawalOverview => ({ available: true, options });
  const NONE: WithdrawalOverview = { available: false, options: [] };
  /** The quote without the waiver: the whole price, no day count. */
  const fullRefund = (over: Partial<WithdrawalOption['quote']> = {}) => option({ quote: { rule: 'withdrawal_14d', refundMinor: 2499, prorata: null, ...over } });

  const section = () => screen.findByTestId('withdraw-contract');
  const entry = () => screen.getByRole('button', { name: 'Withdraw from contract' });
  const confirmButton = (amount = '$20.83') => screen.getByRole('button', { name: `Withdraw and refund ${amount}` });
  const settled = async () => {
    await screen.findByTestId('current-plan');
    await waitFor(() => expect(account.withdrawal).toHaveBeenCalled());
    await waitFor(() => expect(radio('pro_monthly')).not.toBeNull());
  };

  describe('who sees it', () => {
    it('a German subscriber inside the 14 days sees the entry, as its own section with its own heading', async () => {
      subscriber('pro_monthly', 'month');
      account.withdrawal.mockResolvedValue(open(option({ quote: { deadline: IN_9_DAYS } })));
      renderUi(<BillingView navigate={vi.fn()} />);
      const block = await section();
      expect(within(block).getByRole('heading', { level: 2, name: 'Withdraw from contract' })).toBeInTheDocument();
      expect(within(block).getByRole('button', { name: 'Withdraw from contract' })).toBeEnabled();
      // Never a line inside the plan card or its cancel control: cancelling and withdrawing are different things.
      const card = screen.getByTestId('current-plan');
      expect(card).not.toContainElement(block);
      expect(within(card).queryByText(/Withdraw/)).toBeNull();
      expect(within(screen.getByTestId('cancel-subscription')).queryByText(/Withdraw/)).toBeNull();
      // It sits under the plan card, above the plan sheet.
      expect(card.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(block.compareDocumentPosition(document.getElementById('billing-plans')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Showing it sends nothing.
      expect(account.withdraw).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'a US subscriber (the server says not available)', answer: NONE },
      { name: 'anyone past day 14 (the server says not available)', answer: NONE },
      { name: 'a quote whose last day has already passed on this device', answer: open(option({ quote: { deadline: YESTERDAY } })) },
      { name: 'an answer that says available but carries no quote', answer: { available: true, options: [] } as WithdrawalOverview },
    ])('never: $name', async ({ answer }) => {
      subscriber('pro_monthly', 'month');
      account.withdrawal.mockResolvedValue(answer);
      renderUi(<BillingView visitorCountry="US" navigate={vi.fn()} />);
      await settled();
      expect(screen.queryByTestId('withdraw-contract')).toBeNull();
      expect(screen.queryByText(/Withdraw/)).toBeNull();
    });

    it('never on GoApply, and the mainland brand does not even ask', async () => {
      api.getPlans.mockResolvedValue(plansView('goapply', undefined, { paymentsOpen: true, checkout: checkoutOf(['alipay']) }));
      api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'pass', periodEnd: IN_20_DAYS }));
      // Even if something answered with a quote, a GoApply page would not show it.
      account.withdrawal.mockResolvedValue(open(option({ quote: { deadline: IN_9_DAYS } })));
      renderUi(<BillingView navigate={vi.fn()} />, { brand: 'goapply' });
      await screen.findByTestId('current-plan');
      await waitFor(() => expect(radio('pro_monthly')).not.toBeNull());
      expect(account.withdrawal).not.toHaveBeenCalled();
      expect(screen.queryByTestId('withdraw-contract')).toBeNull();
      expect(screen.queryByText(/Withdraw/)).toBeNull();
    });

    it('nothing while the answer is still out', async () => {
      account.withdrawal.mockReturnValue(new Promise(() => undefined));
      renderUi(<BillingView navigate={vi.fn()} />);
      await screen.findByTestId('current-plan');
      expect(screen.queryByTestId('withdraw-contract')).toBeNull();
    });

    it('a check that failed is mentioned only where a right of withdrawal is plausible, with a way to ask again', async () => {
      account.withdrawal.mockRejectedValue(apiError('payment_provider_error', 502));
      const us = renderUi(<BillingView visitorCountry="US" navigate={vi.fn()} />);
      await screen.findByTestId('current-plan');
      await waitFor(() => expect(account.withdrawal.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
      expect(screen.queryByTestId('withdraw-contract')).toBeNull();
      us.unmount();

      account.withdrawal.mockReset();
      account.withdrawal.mockRejectedValue(apiError('payment_provider_error', 502));
      renderUi(<BillingView visitorCountry="DE" navigate={vi.fn()} />);
      const failed = await screen.findByTestId('withdraw-check-error', undefined, { timeout: 4000 });
      expect(failed).toHaveTextContent("We couldn't check whether you can still withdraw from a recent purchase.");
      // Nothing is claimed: no amount, no day, no button that withdraws.
      expect(screen.queryByRole('button', { name: 'Withdraw from contract' })).toBeNull();
      account.withdrawal.mockResolvedValue(open(option({ quote: { deadline: IN_9_DAYS } })));
      fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Withdraw from contract' })).toBeEnabled();
      expect(screen.queryByTestId('withdraw-check-error')).toBeNull();
    });
  });

  describe('the two steps', () => {
    it('step one opens the confirmation: the plan, the quoted refund, the pro-rata sentence, the last day, and that Pro ends at once', async () => {
      account.withdrawal.mockResolvedValue(open(option()));
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      // The row: what was paid, what goes back, until when. All from the quote.
      const row = within(block).getByTestId('withdraw-option');
      expect(row).toHaveTextContent('Pro Monthly');
      expect(row).toHaveTextContent('Paid so far: $24.99. Bought on Oct 6, 2026.');
      expect(row).toHaveTextContent('Refund if you withdraw now: $20.83.');
      expect(row).toHaveTextContent(/You can withdraw until Oct 20, 2026/);
      fireEvent.click(entry());
      const step = await screen.findByTestId('withdraw-confirm');
      expect(within(step).getByRole('heading', { name: 'Withdraw from Pro Monthly?' })).toBeInTheDocument();
      expect(step).toHaveTextContent('We refund $20.83 to the payment method you paid with.');
      // 25/30 on day 5 with the waiver: the numbers are the quote's `prorata`, never worked out here.
      expect(within(step).getByTestId('withdraw-prorata')).toHaveTextContent('You asked us to start at once, so the refund covers the 25 of 30 days you have not used.');
      expect(step).toHaveTextContent(/You can withdraw until Oct 20, 2026/);
      expect(step).toHaveTextContent('Your subscription ends at once and Pro stops right away.');
      expect(confirmButton()).toBeEnabled();
      // Nothing is sent to the server before the second step.
      expect(account.withdraw).not.toHaveBeenCalled();
    });

    it('without the waiver the quote is the full price and there is no day count', async () => {
      account.withdrawal.mockResolvedValue(open(fullRefund()));
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      const step = await screen.findByTestId('withdraw-confirm');
      expect(step).toHaveTextContent('We refund $24.99 to the payment method you paid with.');
      expect(within(step).queryByTestId('withdraw-prorata')).toBeNull();
      expect(step).not.toHaveTextContent(/days you have not used/);
      expect(confirmButton('$24.99')).toBeEnabled();
    });

    it('every number on the sheet comes from the quote (other numbers, other sheet)', async () => {
      account.withdrawal.mockResolvedValue(
        open(option({ purchase: { id: 'in_weekly_9', planKey: 'pro_weekly', amountMinor: 1998 }, quote: { refundMinor: 571, prorata: { usedDays: 3, periodDays: 7 }, deadline: '2026-10-16T12:00:00.000Z' } })),
      );
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      // A weekly plan on day 10: both charges it paid so far are in the amount.
      expect(block).toHaveTextContent('Paid so far: $19.98.');
      fireEvent.click(entry());
      const step = await screen.findByTestId('withdraw-confirm');
      expect(step).toHaveTextContent('We refund $5.71 to the payment method you paid with.');
      expect(step).toHaveTextContent('covers the 4 of 7 days you have not used');
      expect(step).toHaveTextContent(/until Oct 16, 2026/);
      expect(confirmButton('$5.71')).toBeInTheDocument();
      expect(step).not.toHaveTextContent(/20\.83|24\.99|25 of 30/);
    });

    it('"Keep this purchase" closes the step and sends nothing', async () => {
      account.withdrawal.mockResolvedValue(open(option()));
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      fireEvent.click(await screen.findByRole('button', { name: 'Keep this purchase' }));
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
      expect(entry()).toBeEnabled();
      expect(account.withdraw).not.toHaveBeenCalled();
    });

    it('focus follows the step: to its title when it opens, back to the entry when it closes, to the heading once the purchase is gone', async () => {
      account.withdrawal.mockResolvedValue(open(option()));
      account.withdraw.mockResolvedValue({ status: 'withdrawn', refundMinor: 2083, currency: 'USD' });
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      fireEvent.click(entry());
      const step = await screen.findByTestId('withdraw-confirm');
      expect(within(step).getByRole('heading', { name: 'Withdraw from Pro Monthly?' })).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Keep this purchase' }));
      await waitFor(() => expect(entry()).toHaveFocus());
      fireEvent.click(entry());
      fireEvent.click(confirmButton());
      await screen.findByTestId('withdraw-done');
      await waitFor(() => expect(within(block).getByRole('heading', { level: 2, name: 'Withdraw from contract' })).toHaveFocus());
    });

    it('step two withdraws: the purchase id goes out once; the page shows the refunded amount, the email line, and reads the plan again', async () => {
      subscriber('pro_monthly', 'month');
      account.withdrawal.mockResolvedValue(open(option({ quote: { deadline: IN_9_DAYS } })));
      // The server's own figure, on purpose not the quoted one.
      account.withdraw.mockResolvedValue({ status: 'withdrawn', refundMinor: 2000, currency: 'USD' });
      renderUi(<BillingView navigate={vi.fn()} />);
      await section();
      const card = screen.getByTestId('current-plan');
      await waitFor(() => expect(card).toHaveTextContent('Renews on'));
      fireEvent.click(entry());
      await screen.findByTestId('withdraw-confirm');
      // After the withdrawal the server holds a free account and no open purchase.
      api.getCredits.mockResolvedValue(creditsResponse());
      account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true }));
      account.withdrawal.mockResolvedValue(NONE);
      fireEvent.click(confirmButton());
      const done = await screen.findByTestId('withdraw-done');
      expect(done).toHaveTextContent('You have withdrawn from Pro Monthly. We are refunding $20. A confirmation email is on its way.');
      expect(done).toHaveTextContent('Your subscription has ended, so Pro is off.');
      expect(account.withdraw).toHaveBeenCalledTimes(1);
      expect(account.withdraw).toHaveBeenCalledWith('in_monthly_1');
      // The plan is read again: the card shows what the server holds now.
      await waitFor(() => expect(card).toHaveTextContent('Free'));
      expect(card).not.toHaveTextContent('Renews on');
      // The confirmation stays although the quote now says nothing is open; the entry is gone.
      expect(screen.getByTestId('withdraw-done')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Withdraw from contract' })).toBeNull();
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
    });

    it('an answer without an amount states none', async () => {
      account.withdrawal.mockResolvedValue(open(option()));
      account.withdraw.mockResolvedValue({ status: 'withdrawn', refundMinor: null, currency: null });
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      fireEvent.click(confirmButton());
      const done = await screen.findByTestId('withdraw-done');
      expect(done).toHaveTextContent('You have withdrawn from Pro Monthly. Your refund and a confirmation email are on their way.');
      expect(done.textContent).not.toMatch(/\d/);
    });

    it('while it is being sent the button cannot be pressed twice', async () => {
      account.withdrawal.mockResolvedValue(open(option()));
      account.withdraw.mockReturnValue(new Promise(() => undefined));
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      fireEvent.click(confirmButton());
      const pending = await screen.findByRole('button', { name: 'Withdrawing…' });
      expect(pending).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Keep this purchase' })).toBeDisabled();
      fireEvent.click(pending);
      expect(account.withdraw).toHaveBeenCalledTimes(1);
    });

    it('after a withdrawal the plan is read again at once and twice more, so the card catches up with the payment provider', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        account.withdrawal.mockResolvedValue(open(option({ quote: { deadline: new Date(Date.now() + 9 * 86_400_000).toISOString() } })));
        account.withdraw.mockResolvedValue({ status: 'withdrawn', refundMinor: 2083, currency: 'USD' });
        subscriber('pro_monthly', 'month');
        renderUi(<BillingView navigate={vi.fn()} />);
        await section();
        fireEvent.click(entry());
        fireEvent.click(confirmButton());
        await screen.findByTestId('withdraw-done');
        expect(WITHDRAW_REREAD_DELAYS_MS).toEqual([3000, 10_000]);
        await waitFor(() => expect(api.getCredits.mock.calls.length).toBeGreaterThanOrEqual(2));
        const afterFirst = api.getCredits.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        await waitFor(() => expect(api.getCredits.mock.calls.length).toBe(afterFirst + 1));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(7000);
        });
        await waitFor(() => expect(api.getCredits.mock.calls.length).toBe(afterFirst + 2));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(api.getCredits.mock.calls.length).toBe(afterFirst + 2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // A pro-rata refund is one day smaller every day, and the server works the refund out when the withdrawal is sent.
  // So the amount the buyer is asked to confirm must be today's, also on a page that was left open.
  describe('the amount to confirm is never an old one', () => {
    /** Day 5: 25 of 30 days go back. Day 6: 24 of 30. */
    const day5 = option();
    const day6 = option({ quote: { refundMinor: 2000, prorata: { usedDays: 6, periodDays: 30 } } });
    const leaveOpen = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    });

    it('a quote just read opens the step at once, without another read', async () => {
      account.withdrawal.mockResolvedValue(open(day5));
      renderUi(<WithdrawContract now={now} />);
      await section();
      await leaveOpen(WITHDRAWAL_STALE_MS - 5000);
      fireEvent.click(entry());
      expect(screen.getByTestId('withdraw-confirm')).toBeInTheDocument();
      expect(confirmButton('$20.83')).toBeEnabled();
      expect(account.withdrawal).toHaveBeenCalledTimes(1);
    });

    it('a quote that has been on screen for a while is read again when the entry is pressed; the step opens with that answer', async () => {
      account.withdrawal.mockResolvedValueOnce(open(day5));
      let answer!: (o: WithdrawalOverview) => void;
      account.withdrawal.mockImplementationOnce(() => new Promise<WithdrawalOverview>((resolve) => (answer = resolve)));
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      expect(block).toHaveTextContent('Refund if you withdraw now: $20.83.');
      // The page stays open into the next day. Nothing is asked meanwhile.
      await leaveOpen(86_400_000);
      expect(account.withdrawal).toHaveBeenCalledTimes(1);
      fireEvent.click(entry());
      // The read is out: no step yet, and the entry cannot be pressed twice.
      expect(account.withdrawal).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
      expect(entry()).toBeDisabled();
      expect(entry()).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByTestId('withdraw-refreshing')).toHaveTextContent('Checking the refund amount…');
      await act(async () => answer(open(day6)));
      const step = await screen.findByTestId('withdraw-confirm');
      // Today's figures, on the sheet and on the button. Yesterday's are nowhere.
      expect(step).toHaveTextContent('We refund $20 to the payment method you paid with.');
      expect(within(step).getByTestId('withdraw-prorata')).toHaveTextContent('covers the 24 of 30 days you have not used');
      expect(confirmButton('$20')).toBeEnabled();
      expect(block).not.toHaveTextContent(/20\.83|25 of 30/);
      expect(screen.queryByTestId('withdraw-refreshing')).toBeNull();
      // Reading again sends no withdrawal.
      expect(account.withdraw).not.toHaveBeenCalled();
    });

    it('when that read says the purchase is no longer open, no step opens and the page says so', async () => {
      account.withdrawal.mockResolvedValueOnce(open(day5));
      account.withdrawal.mockResolvedValue(NONE);
      renderUi(<WithdrawContract now={now} />);
      await section();
      await leaveOpen(86_400_000);
      fireEvent.click(entry());
      expect(await screen.findByTestId('withdraw-gone')).toHaveTextContent('This purchase can no longer be withdrawn.');
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Withdraw from contract' })).toBeNull();
      expect(account.withdraw).not.toHaveBeenCalled();
    });

    it('when that read fails, no step opens with the old amount; the row says so and the entry asks again', async () => {
      account.withdrawal.mockResolvedValueOnce(open(day5));
      account.withdrawal.mockRejectedValueOnce(apiError('not_found', 404));
      account.withdrawal.mockResolvedValue(open(day6));
      renderUi(<WithdrawContract now={now} />);
      await section();
      await leaveOpen(86_400_000);
      fireEvent.click(entry());
      expect(await screen.findByTestId('withdraw-refresh-error')).toHaveTextContent("We couldn't check the refund amount just now. Try again.");
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
      expect(screen.queryByRole('button', { name: /Withdraw and refund/ })).toBeNull();
      await waitFor(() => expect(entry()).toBeEnabled());
      fireEvent.click(entry());
      await screen.findByTestId('withdraw-confirm');
      expect(confirmButton('$20')).toBeEnabled();
      expect(screen.queryByTestId('withdraw-refresh-error')).toBeNull();
      expect(account.withdrawal).toHaveBeenCalledTimes(3);
    });

    it('while a step is open the quote is read again every few minutes, and the step shows the new amount', async () => {
      account.withdrawal.mockResolvedValueOnce(open(day5));
      account.withdrawal.mockResolvedValue(open(day6));
      renderUi(<WithdrawContract now={now} />);
      await section();
      // No step, no timer: a page that only shows the rows asks nothing by itself.
      await leaveOpen(WITHDRAWAL_OPEN_STEP_REFRESH_MS + 1000);
      expect(account.withdrawal).toHaveBeenCalledTimes(1);
      fireEvent.click(entry());
      await screen.findByTestId('withdraw-confirm');
      await waitFor(() => expect(confirmButton('$20')).toBeEnabled());
      const reads = account.withdrawal.mock.calls.length;
      await leaveOpen(WITHDRAWAL_OPEN_STEP_REFRESH_MS + 1000);
      await waitFor(() => expect(account.withdrawal.mock.calls.length).toBe(reads + 1));
      expect(WITHDRAWAL_OPEN_STEP_REFRESH_MS).toBeLessThanOrEqual(10 * 60 * 1000);
      // Closing the step stops the timer.
      fireEvent.click(screen.getByRole('button', { name: 'Keep this purchase' }));
      const after = account.withdrawal.mock.calls.length;
      await leaveOpen(WITHDRAWAL_OPEN_STEP_REFRESH_MS * 3);
      expect(account.withdrawal.mock.calls.length).toBe(after);
    });

    it('a read that says the purchase is gone while its step is open closes the step with the reason, instead of an empty page', async () => {
      account.withdrawal.mockResolvedValueOnce(open(day5));
      account.withdrawal.mockResolvedValue(NONE);
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      await screen.findByTestId('withdraw-confirm');
      await leaveOpen(WITHDRAWAL_OPEN_STEP_REFRESH_MS + 1000);
      expect(await screen.findByTestId('withdraw-gone')).toHaveTextContent('This purchase can no longer be withdrawn.');
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
      expect(screen.queryByRole('button', { name: /Withdraw and refund/ })).toBeNull();
      expect(account.withdraw).not.toHaveBeenCalled();
    });

    it('a tab that comes back into view reads an old quote again, so the row shows today\'s amount; a fresh one is left alone', async () => {
      account.withdrawal.mockResolvedValueOnce(open(day5));
      account.withdrawal.mockResolvedValue(open(day6));
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      const comeBack = () =>
        act(async () => {
          focusManager.setFocused(false);
          focusManager.setFocused(true);
          await vi.advanceTimersByTimeAsync(50);
        });
      await comeBack();
      expect(account.withdrawal).toHaveBeenCalledTimes(1);
      await leaveOpen(86_400_000);
      await comeBack();
      await waitFor(() => expect(block).toHaveTextContent('Refund if you withdraw now: $20.'));
      expect(account.withdrawal).toHaveBeenCalledTimes(2);
    });
  });

  describe('refusals', () => {
    it('409 withdrawal_not_available: "This purchase can no longer be withdrawn", the step closes and the quote is read again', async () => {
      account.withdrawal.mockResolvedValueOnce(open(option()));
      account.withdrawal.mockResolvedValue(NONE);
      account.withdraw.mockRejectedValue(apiError('withdrawal_not_available', 409));
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      fireEvent.click(confirmButton());
      expect(await screen.findByTestId('withdraw-gone')).toHaveTextContent('This purchase can no longer be withdrawn.');
      expect(screen.queryByTestId('withdraw-confirm')).toBeNull();
      await waitFor(() => expect(account.withdrawal).toHaveBeenCalledTimes(2));
      // The quote read again says nothing is open: the entry goes, the message stays.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Withdraw from contract' })).toBeNull());
      expect(screen.getByTestId('withdraw-gone')).toBeInTheDocument();
      expect(screen.queryByTestId('withdraw-done')).toBeNull();
    });

    it('a refused purchase is not offered again, even if a later quote still lists it; another purchase still is', async () => {
      const pack = option({ purchase: { id: 'in_pack_1', planKey: 'practice_pack_5', amountMinor: 999 }, quote: { rule: 'withdrawal_14d', refundMinor: 999, prorata: null } });
      // The quote keeps listing both (as after a refund the provider itself refused: 409 with details.reason refund_refused).
      account.withdrawal.mockResolvedValue(open(option(), pack));
      account.withdraw.mockRejectedValue(
        new RoboApiError('refused', { code: 'withdrawal_not_available', status: 409, payload: { success: false, code: 'withdrawal_not_available', details: { reason: 'refund_refused' } } }),
      );
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      fireEvent.click(within(block).getByRole('button', { name: 'Withdraw from contract: Pro Monthly' }));
      fireEvent.click(confirmButton());
      expect(await screen.findByTestId('withdraw-gone')).toHaveTextContent('This purchase can no longer be withdrawn.');
      await waitFor(() => expect(account.withdrawal.mock.calls.length).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(screen.getAllByTestId('withdraw-option').map((r) => r.getAttribute('data-purchase'))).toEqual(['in_pack_1']));
      expect(screen.queryByRole('button', { name: /Pro Monthly/ })).toBeNull();
    });

    it.each([
      ['rate_limited', 429, 'You tried this several times in a row. Wait a while, then try again.'],
      ['rail_not_configured', 503, "Card payments are not set up here, so we can't send the refund. Nothing changed."],
      ['payment_provider_error', 502, 'The payment provider did not confirm the withdrawal. Try again. Nothing is refunded twice.'],
      ['server_error', 500, "The withdrawal didn't go through. Try again."],
    ])('%s (%i) keeps the confirmation open with its own message, and the same button sends again', async (code, status, message) => {
      account.withdrawal.mockResolvedValue(open(option()));
      account.withdraw.mockRejectedValueOnce(apiError(code, status));
      account.withdraw.mockResolvedValue({ status: 'withdrawn', refundMinor: 2083, currency: 'USD' });
      renderUi(<WithdrawContract now={now} />);
      await section();
      fireEvent.click(entry());
      fireEvent.click(confirmButton());
      const step = screen.getByTestId('withdraw-confirm');
      expect(await within(step).findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByTestId('withdraw-gone')).toBeNull();
      expect(confirmButton()).toBeEnabled();
      fireEvent.click(confirmButton());
      expect(await screen.findByTestId('withdraw-done')).toHaveTextContent('We are refunding $20.83.');
      expect(account.withdraw).toHaveBeenCalledTimes(2);
    });

    it('each refusal maps to its own message key', () => {
      expect(withdrawRefusal(apiError('withdrawal_not_available', 409))).toBe('unavailable');
      expect(withdrawRefusal(apiError('rate_limited', 429))).toBe('rateLimited');
      expect(withdrawRefusal(apiError('rail_not_configured', 503))).toBe('notConfigured');
      expect(withdrawRefusal(apiError('payment_provider_error', 502))).toBe('provider');
      expect(withdrawRefusal(new Error('offline'))).toBe('generic');
    });
  });

  describe('one row per open purchase', () => {
    const pack = option({ purchase: { id: 'in_pack_1', planKey: 'practice_pack_5', amountMinor: 999, chargedAt: '2026-10-09T12:00:00.000Z' }, quote: { rule: 'withdrawal_14d', refundMinor: 999, prorata: null, deadline: '2026-10-23T12:00:00.000Z' } });

    it('a pack bought on day 3 of a monthly plan and the plan are two rows, each with its own amount and last day', async () => {
      account.withdrawal.mockResolvedValue(open(pack, option()));
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      expect(block).toHaveTextContent('You can still withdraw from the purchases below.');
      const rows = within(block).getAllByTestId('withdraw-option');
      expect(rows.map((r) => r.getAttribute('data-purchase'))).toEqual(['in_pack_1', 'in_monthly_1']);
      expect(rows[0]).toHaveTextContent('Practice pack (5)');
      expect(rows[0]).toHaveTextContent('Refund if you withdraw now: $9.99.');
      expect(rows[0]).toHaveTextContent(/until Oct 23, 2026/);
      expect(rows[1]).toHaveTextContent('Pro Monthly');
      expect(rows[1]).toHaveTextContent('Refund if you withdraw now: $20.83.');
      expect(rows[1]).toHaveTextContent(/until Oct 20, 2026/);
      // Each entry says which purchase it is for.
      expect(within(rows[0]!).getByRole('button', { name: 'Withdraw from contract: Practice pack (5)' })).toBeInTheDocument();
      expect(within(rows[1]!).getByRole('button', { name: 'Withdraw from contract: Pro Monthly' })).toBeInTheDocument();
    });

    it('withdrawing the pack names what ends (the pack, not Pro), sends the pack\'s id and leaves the plan\'s row', async () => {
      account.withdrawal.mockResolvedValue(open(pack, option()));
      account.withdraw.mockResolvedValue({ status: 'withdrawn', refundMinor: 999, currency: 'USD' });
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      fireEvent.click(within(block).getByRole('button', { name: 'Withdraw from contract: Practice pack (5)' }));
      const step = await screen.findByTestId('withdraw-confirm');
      expect(step).toHaveAttribute('data-purchase', 'in_pack_1');
      expect(step).toHaveTextContent('The practice interviews left from this pack are removed at once.');
      expect(step).not.toHaveTextContent(/Pro stops/);
      fireEvent.click(confirmButton('$9.99'));
      const done = await screen.findByTestId('withdraw-done');
      expect(done).toHaveTextContent('You have withdrawn from Practice pack (5). We are refunding $9.99.');
      expect(account.withdraw).toHaveBeenCalledWith('in_pack_1');
      // The plan can still be withdrawn: its row stays, alone.
      const rows = screen.getAllByTestId('withdraw-option');
      expect(rows.map((r) => r.getAttribute('data-purchase'))).toEqual(['in_monthly_1']);
    });

    it('what a withdrawal ends is worded by the kind of purchase', () => {
      const plans = buildPlanViews('roboapply', { env: RA_ENV }).plans;
      expect(withdrawalKind('pro_monthly', plans)).toBe('subscription');
      expect(withdrawalKind('pro_weekly', plans)).toBe('subscription');
      expect(withdrawalKind('pro_week_pass', plans)).toBe('pass');
      expect(withdrawalKind('practice_pack_15', plans)).toBe('pack');
      // A plan the catalog does not list: a pack by its key, anything else says only "what this purchase gave you".
      expect(withdrawalKind('practice_pack_5', [])).toBe('pack');
      expect(withdrawalKind('starter', plans)).toBe('other');
      expect(withdrawalKind(null, plans)).toBe('other');
    });

    it('a pass, and a plan the page has no name for, are worded without claiming Pro stops', async () => {
      account.withdrawal.mockResolvedValue(
        open(option({ purchase: { id: 'in_pass_1', planKey: 'pro_week_pass', amountMinor: 999 }, quote: { rule: 'withdrawal_14d', refundMinor: 999, prorata: null } }), option({ purchase: { id: 'in_x_1', planKey: 'some_future_plan' } })),
      );
      renderUi(<WithdrawContract now={now} />);
      const block = await section();
      fireEvent.click(within(block).getByRole('button', { name: 'Withdraw from contract: 7-day pass (no renewal)' }));
      expect(await screen.findByTestId('withdraw-confirm')).toHaveTextContent('The days this pass gave you end at once.');
      fireEvent.click(screen.getByRole('button', { name: 'Keep this purchase' }));
      fireEvent.click(within(block).getByRole('button', { name: 'Withdraw from contract: Your purchase' }));
      const step = await screen.findByTestId('withdraw-confirm');
      expect(within(step).getByRole('heading', { name: 'Withdraw from Your purchase?' })).toBeInTheDocument();
      expect(step).toHaveTextContent('What this purchase gave you ends at once.');
    });
  });

  it('a refund in another currency than the brand\'s names its currency everywhere on the sheet', async () => {
    account.withdrawal.mockResolvedValue(open(option({ purchase: { amountMinor: 74900, currency: 'TWD' }, quote: { rule: 'withdrawal_14d', refundMinor: 74900, currency: 'TWD', prorata: null, region: 'tw' } })));
    renderUi(<WithdrawContract now={now} />);
    const block = await section();
    expect(block).toHaveTextContent('Paid so far: NT$749.');
    expect(block).toHaveTextContent('Refund if you withdraw now: NT$749.');
    fireEvent.click(entry());
    expect(confirmButton('NT$749')).toBeInTheDocument();
    expect(block.textContent).not.toMatch(/(^|[^T])\$749/);
  });

  it('openWithdrawals: what the server offers, minus anything whose last day has passed', () => {
    const live = option();
    const over = option({ purchase: { id: 'in_old' }, quote: { deadline: NOW.toISOString() } });
    expect(openWithdrawals(open(live, over), NOW).map((o) => o.purchase.id)).toEqual(['in_monthly_1']);
    expect(openWithdrawals({ available: false, options: [live] }, NOW)).toEqual([]);
    expect(openWithdrawals(null, NOW)).toEqual([]);
    expect(openWithdrawals(undefined, NOW)).toEqual([]);
  });
});

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
