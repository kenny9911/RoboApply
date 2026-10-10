// WP-21b acceptance — plan sheet, legacy quote, one-click cancel, payment
// failed (component tests at 375 px; no network: lib/api is mocked).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { atPhoneWidth, creditsResponse, plansView, renderUi, withBrand } from './fixtures';
import type { BillingPlanResponse } from '../../../../lib/api/account';

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
import { SettingsSection } from '../SettingsSection';

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
const continueBtn = () => screen.getByRole('button', { name: /continue to payment|see what switching costs/i });

describe('PlanPicker (375 px)', () => {
  it('preselects Monthly, never weekly; shows the monthly equivalent and the rounded-down saving', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(radio('pro_weekly')).not.toBeChecked();
    expect(radio('pro_week_pass')).not.toBeChecked();
    const weekly = document.querySelector('[data-plan="pro_weekly"]')!;
    expect(weekly).toHaveTextContent('$9.99 / week');
    expect(weekly).toHaveTextContent('About $43 a month');
    expect(document.querySelector('[data-plan="pro_quarterly"]')).toHaveTextContent('Save 19%');
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

  it('GoApply before CN payments: passes listed as not available, nothing purchasable', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply' });
    await screen.findByTestId('plan-picker');
    expect(radio('pro_monthly')).toBeDisabled();
    expect(screen.getAllByText('Not available yet').length).toBeGreaterThan(0);
    expect(continueBtn()).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /renews automatically/i })).toBeNull();
  });

  it('no priced plans → an honest empty line, not a fake price', async () => {
    api.getPlans.mockResolvedValue(plansView('roboapply', {}));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    expect(await screen.findByText('No plans are on sale right now.')).toBeInTheDocument();
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
      ),
    );
  });

  it('a hidden plan can never be bought: a renewing subscriber asking for weekly gets no selection and no Continue', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false }));
    renderUi(<PlanPicker requestedPlan="pro_weekly" navigate={vi.fn()} />);
    await screen.findByTestId('plan-picker');
    await waitFor(() => expect(screen.getByText('To change how often Pro renews, use Manage payment.')).toBeInTheDocument());
    expect(document.querySelector('[data-plan="pro_weekly"]')).toBeNull();
    expect(document.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0);
    expect(continueBtn()).toBeDisabled();
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
    await waitFor(() => expect(screen.getByText('To change how often Pro renews, use Manage payment.')).toBeInTheDocument());
    expect(document.querySelector('[data-plan="pro_test_pass"]')).toBeNull();
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(account.checkoutPlan).not.toHaveBeenCalled();
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
    expect(account.checkoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'pro_week_pass' }));
  });

  it('a running subscription is still "Your plan" and cannot be bought twice', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false, cancelAtPeriodEnd: true }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true }));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    // Cancelled: only the passes are offered; the monthly plan is not re-sold here.
    await waitFor(() => expect(document.querySelector('[data-plan="pro_week_pass"]')).not.toBeNull());
    expect(document.querySelector('[data-plan="pro_monthly"]')).toBeNull();
    expect(document.querySelector('[data-plan="pro_weekly"]')).toBeNull();
    expect(screen.queryByText('To change how often Pro renews, use Manage payment.')).toBeNull();
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

  it('legacy practice plan: switching shows the quote first and charges only on Confirm', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'starter', legacyPlan: true }));
    account.plan.mockResolvedValue(legacyPlan({ tier: 'starter', hasStripeCustomer: true, currentPeriodEnd: '2026-11-01T00:00:00Z' }));
    account.switchQuote.mockResolvedValue({ quoteId: 'q1', planKey: 'pro_monthly', currency: 'USD', amountDueTodayMinor: 1012, renewalAmountMinor: 2499, nextRenewalAt: '2026-11-10T00:00:00Z' });
    account.switchConfirm.mockResolvedValue({ status: 'switched', planKey: 'pro_monthly', nextRenewalAt: '2026-11-10T00:00:00Z' });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: /see what switching costs/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(screen.getByRole('button', { name: /see what switching costs/i }));
    const quote = await screen.findByTestId('switch-quote');
    expect(within(quote).getByText('$10.12')).toBeInTheDocument();
    expect(within(quote).getByText('$24.99 / month')).toBeInTheDocument();
    expect(account.checkoutPlan).not.toHaveBeenCalled();
    expect(account.switchConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm and pay \$10\.12/i }));
    await waitFor(() => expect(account.switchConfirm).toHaveBeenCalledWith({ quoteId: 'q1', autoRenewAck: true, withdrawalWaiver: undefined }));
    expect(await screen.findByText(/You're on Pro Monthly/)).toBeInTheDocument();
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
  it('monthly Pro: renewal date, Manage payment, one-click Cancel; no plan cards for the same interval', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', periodEnd: '2026-11-01T00:00:00Z', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ tier: 'free', hasStripeCustomer: true }));
    renderUi(<BillingView navigate={vi.fn()} />);
    const card = await screen.findByTestId('current-plan');
    await waitFor(() => expect(within(card).getByText('Pro Monthly')).toBeInTheDocument());
    expect(card).toHaveTextContent('Renews on');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Manage payment' })).toBeInTheDocument());
    expect(within(card).getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    await screen.findByTestId('plan-picker');
    expect(document.querySelector('[data-plan="pro_weekly"]')).toBeNull();
    expect(document.querySelector('[data-plan="practice_pack_5"]')).not.toBeNull();
  });

  it('payment failed: banner with Update payment method', async () => {
    const navigate = vi.fn();
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month' }));
    account.plan.mockResolvedValue(legacyPlan({ status: 'past_due', hasStripeCustomer: true }));
    account.portal.mockResolvedValue({ url: 'https://billing.stripe.test/p' });
    renderUi(<BillingView navigate={navigate} />);
    const banner = await screen.findByTestId('payment-failed');
    fireEvent.click(within(banner).getByRole('button', { name: 'Update payment method' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://billing.stripe.test/p'));
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
    // Before the cancel, a renewing subscriber sees no Pro plans on the sheet.
    await screen.findByTestId('plan-picker');
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toBeNull();
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
    expect(document.querySelector('[data-plan="pro_week_pass"]')).toHaveTextContent('$6.99');
    await waitFor(() => expect(continueBtn()).toBeEnabled());
  });

  it('the requested pass is shown even while the plan still reads as renewing', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false }));
    renderUi(<BillingView requestedPlan="pro_week_pass" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_week_pass')).toBeChecked());
    expect(document.querySelector('[data-plan="pro_weekly"]')).toBeNull();
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
