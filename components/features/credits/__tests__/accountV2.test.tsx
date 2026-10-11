// WP-79 — plan sheet V2 lines (Taiwan prices, student plans, promotion codes,
// the quarterly switch by link) and the one quarterly suggestion: inline,
// shown once, dismissible forever, never early, never with a made-up saving.
// No network: lib/api is mocked. Phone width (375 px).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import { RA_ENV, atPhoneWidth, checkoutOf, creditsResponse, plansView, renderUi } from './fixtures';
import type { BillingPlanResponse } from '../../../../lib/api/account';
import { RoboApiError } from '../../../../lib/api/client';
import { QUARTERLY_SUGGESTION_KEYS, displayPrice, quarterlySuggestion } from '../../../../lib/pricing';

const api = vi.hoisted(() => ({ getCredits: vi.fn(), getPlans: vi.fn(), getCreditHistory: vi.fn(), cancelSubscription: vi.fn(), sendCancelSurvey: vi.fn() }));
const account = vi.hoisted(() => ({ plan: vi.fn(), checkoutPlan: vi.fn(), alipayCheckoutPlan: vi.fn(), switchQuote: vi.fn(), switchConfirm: vi.fn(), portal: vi.fn(), reconcileCheckout: vi.fn(), resumeSubscription: vi.fn() }));
const v2 = vi.hoisted(() => ({ getStudentStatus: vi.fn(), getUiState: vi.fn(), patchUiState: vi.fn() }));
const countryAction = vi.hoisted(() => ({ visitorCountryAction: vi.fn() }));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/account', async (orig) => ({ ...(await orig<Record<string, unknown>>()), accountApi: account }));
vi.mock('../../../../lib/api/accountV2', async (orig) => {
  const real = await orig<{ accountV2Api: Record<string, unknown> }>();
  return { ...real, accountV2Api: { ...real.accountV2Api, getStudentStatus: v2.getStudentStatus } };
});
vi.mock('../../../../lib/api/uiState', () => ({ getUiState: v2.getUiState, patchUiState: v2.patchUiState }));
vi.mock('../../../../app/(auth)/settings/billing/actions', () => countryAction);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));

import { PlanPicker } from '../PlanPicker';
import { QuarterlySuggestion } from '../QuarterlySuggestion';

const V2_ENV = {
  ...RA_ENV,
  STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd',
  STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '74900',
  STRIPE_PRICE_STUDENT_MONTHLY: 'price_sm',
  STRIPE_PRICE_STUDENT_MONTHLY_CENTS: '1749',
};

const radio = (key: string) => document.querySelector<HTMLInputElement>(`[data-plan="${key}"] input[type="radio"]`);
const option = (key: string) => document.querySelector<HTMLElement>(`[data-plan="${key}"]`);

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

function uiState(values: Record<string, string> = {}, dismissals: Record<string, { count: number; at: string }> = {}) {
  return { state: { tours: {}, dismissals, popupLastShownAt: null, announcementsSeen: [], values }, lastFeedVisitAt: null, updatedAt: null };
}

function studentStatus(verified: boolean) {
  return { verified, schoolDomain: verified ? 'stanford.edu' : null, verifiedAt: null, expiresAt: verified ? '2027-10-10T00:00:00Z' : null, pendingDomain: null, available: true };
}

beforeEach(() => {
  atPhoneWidth();
  for (const fn of [...Object.values(api), ...Object.values(account), ...Object.values(v2), ...Object.values(countryAction)]) fn.mockReset();
  countryAction.visitorCountryAction.mockResolvedValue(null);
  api.getCredits.mockResolvedValue(creditsResponse());
  api.getPlans.mockResolvedValue(plansView('roboapply', V2_ENV));
  account.plan.mockResolvedValue(legacyPlan());
  v2.getStudentStatus.mockResolvedValue(studentStatus(false));
  v2.getUiState.mockResolvedValue(uiState());
  v2.patchUiState.mockImplementation(async () => uiState());
});

describe('pure helpers (lib/pricing)', () => {
  const plans = [
    { key: 'pro_monthly', amountMinor: 2499, currency: 'USD', sellable: true },
    { key: 'pro_quarterly', amountMinor: 5999, currency: 'USD', sellable: true },
  ];
  const now = new Date('2026-10-10T00:00:00Z');
  const base = { planKey: 'pro_monthly', willRenew: true, legacy: false, monthlySeenAt: '2026-09-01T00:00:00Z', shownAt: null, dismissed: false, now, plans, subscriptionCurrency: 'USD' };

  it('suggests quarterly with the real saving, rounded down, after 30 days of monthly', () => {
    expect(quarterlySuggestion(base)).toEqual({ targetKey: 'pro_quarterly', currency: 'USD', quarterlyMinor: 5999, threeMonthsMinor: 7497, savingsPercent: 19 });
  });

  it('never early, never twice, never after a dismissal, never when cancelled or not on sale', () => {
    expect(quarterlySuggestion({ ...base, monthlySeenAt: '2026-09-20T00:00:00Z' })).toBeNull();
    expect(quarterlySuggestion({ ...base, monthlySeenAt: null })).toBeNull();
    expect(quarterlySuggestion({ ...base, shownAt: '2026-10-01T00:00:00Z' })).toBeNull();
    expect(quarterlySuggestion({ ...base, dismissed: true })).toBeNull();
    expect(quarterlySuggestion({ ...base, willRenew: false })).toBeNull();
    expect(quarterlySuggestion({ ...base, planKey: 'pro_weekly' })).toBeNull();
    expect(quarterlySuggestion({ ...base, plans: [plans[0]!, { ...plans[1]!, sellable: false }] })).toBeNull();
    expect(quarterlySuggestion({ ...base, plans: [plans[0]!, { ...plans[1]!, amountMinor: 7497 }] })).toBeNull();
  });

  it('reads both amounts in the subscription currency (a TWD subscriber sees TWD), else says nothing', () => {
    // USD 2499/5999 saves 19%; TWD 74900/179000 saves 20% — the TWD subscriber is told the TWD figures.
    const twd = [
      { ...plans[0]!, twdPrice: { amountMinor: 74900 } },
      { ...plans[1]!, localPrice: { currency: 'TWD', amountMinor: 179000 } },
    ];
    expect(quarterlySuggestion({ ...base, plans: twd, subscriptionCurrency: 'TWD' })).toEqual({
      targetKey: 'pro_quarterly',
      currency: 'TWD',
      quarterlyMinor: 179000,
      threeMonthsMinor: 224700,
      savingsPercent: 20,
    });
    expect(quarterlySuggestion({ ...base, plans: twd, subscriptionCurrency: 'USD' })).toMatchObject({ currency: 'USD', savingsPercent: 19 });
    // No TWD quarterly price, or the subscription currency is unknown: no card.
    expect(quarterlySuggestion({ ...base, subscriptionCurrency: 'TWD' })).toBeNull();
    expect(quarterlySuggestion({ ...base, subscriptionCurrency: null })).toBeNull();
  });

  it('prefers a real local price over the base price', () => {
    const views = buildPlanViews('roboapply', { env: V2_ENV, country: 'TW' }).plans;
    const monthly = views.find((p) => p.key === 'pro_monthly')!;
    expect(displayPrice(monthly, monthly)).toMatchObject({ amountMinor: 74900, currency: 'TWD', local: true });
    const weekly = views.find((p) => p.key === 'pro_weekly')!;
    expect(displayPrice(weekly, monthly)).toMatchObject({ amountMinor: 999, currency: 'USD', local: false, monthlyEquivalentMinor: 4300 });
  });
});

describe('PlanPicker V2', () => {
  it('shows a Taiwan buyer the configured TWD price instead of the USD price', async () => {
    const { plans, defaultSelection } = buildPlanViews('roboapply', { env: V2_ENV, country: 'TW' });
    api.getPlans.mockResolvedValue({ ...plansView('roboapply', V2_ENV), plans, defaultSelection, checkout: checkoutOf(['stripe'], { showWithdrawalWaiver: true, country: 'TW' }) });
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(option('pro_monthly')).not.toBeNull());
    expect(option('pro_monthly')!.textContent).toMatch(/NT\$749|\$749/);
    expect(option('pro_monthly')!.textContent).toContain('Charged in New Taiwan dollars.');
    expect(option('pro_quarterly')!.textContent).not.toContain('New Taiwan dollars');
  });

  it('shows a Taiwan student the discount computed from the TWD prices', async () => {
    const env = { ...V2_ENV, STRIPE_PRICE_STUDENT_MONTHLY_TWD: 'price_sm_twd', STRIPE_PRICE_STUDENT_MONTHLY_TWD_CENTS: '59900' };
    const { plans, defaultSelection } = buildPlanViews('roboapply', { env, studentEnabled: true, country: 'TW' });
    api.getPlans.mockResolvedValue({ ...plansView('roboapply', env), plans, defaultSelection, checkout: checkoutOf(['stripe'], { showWithdrawalWaiver: true, country: 'TW' }) });
    v2.getStudentStatus.mockResolvedValue(studentStatus(true));
    renderUi(<PlanPicker navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(option('student_monthly')).not.toBeNull());
    expect(option('student_monthly')!.textContent).toContain('20% below the regular price');
    expect(option('student_monthly')!.textContent).not.toContain('30%');
  });

  it('lists student plans only for a verified student, with the computed discount', async () => {
    const { plans, defaultSelection } = buildPlanViews('roboapply', { env: V2_ENV, studentEnabled: true });
    api.getPlans.mockResolvedValue({ ...plansView('roboapply', V2_ENV), plans, defaultSelection });
    const { unmount } = renderUi(<PlanPicker navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(option('pro_monthly')).not.toBeNull());
    expect(option('student_monthly')).toBeNull();
    unmount();

    v2.getStudentStatus.mockResolvedValue(studentStatus(true));
    renderUi(<PlanPicker navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(option('student_monthly')).not.toBeNull());
    expect(option('student_monthly')!.textContent).toContain('30% below the regular price');
    // One label on a student row: the student percentage, never "Save N%" against the regular monthly price.
    expect(option('student_quarterly')!.textContent).toContain('30% below the regular price');
    expect(option('student_quarterly')!.textContent).not.toMatch(/Save \d+%/);
    expect(option('pro_quarterly')!.textContent).toMatch(/Save \d+%/);
    expect(radio('student_monthly')!.checked).toBe(false);
  });

  it('never asks the student API when the capability is off', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(option('pro_monthly')).not.toBeNull());
    expect(v2.getStudentStatus).not.toHaveBeenCalled();
  });

  it('mentions promotion codes only when the payment page takes them', async () => {
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(screen.queryByText(/promotion code/i)).toBeNull();
  });

  it('says so when checkout refuses a student plan', async () => {
    const { plans } = buildPlanViews('roboapply', { env: V2_ENV, studentEnabled: true });
    api.getPlans.mockResolvedValue({ ...plansView('roboapply', V2_ENV), plans, defaultSelection: 'student_monthly' });
    v2.getStudentStatus.mockResolvedValue(studentStatus(true));
    account.checkoutPlan.mockRejectedValue(new RoboApiError('no', { code: 'student_verification_required', status: 403, payload: { code: 'student_verification_required' } }));
    renderUi(<PlanPicker requestedPlan="student_monthly" navigate={vi.fn()} />, { flags: { student: true } });
    await waitFor(() => expect(radio('student_monthly')).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue to payment/i }));
    expect(await screen.findByText('Confirm your school email first to get the student price.')).toBeInTheDocument();
  });

  it('offers a monthly subscriber the quarterly plan by link, as a switch with a quote', async () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false }));
    renderUi(<PlanPicker requestedPlan="pro_quarterly" navigate={vi.fn()} />);
    await waitFor(() => expect(radio('pro_quarterly')).toBeChecked());
    // Every other subscription is a switch now (ST-5); the link only decides which one is selected.
    expect(option('pro_weekly')).not.toBeNull();
    expect(radio('pro_weekly')!.checked).toBe(false);
    expect(option('pro_monthly')!.textContent).toContain('Your plan');
    expect(screen.getByRole('button', { name: /see what switching costs/i })).toBeInTheDocument();
  });
});

describe('QuarterlySuggestion', () => {
  const NOW = new Date('2026-10-10T00:00:00Z');
  const monthly = () => {
    api.getCredits.mockResolvedValue(creditsResponse({ planKey: 'pro_monthly', planProfile: 'pro', interval: 'month', upgradable: false }));
    account.plan.mockResolvedValue(legacyPlan({ hasStripeCustomer: true, cancelAtPeriodEnd: false, currency: 'USD' }));
  };

  it('shows once after 30 days of monthly, with both real amounts, and stamps that it was shown', async () => {
    monthly();
    v2.getUiState.mockResolvedValue(uiState({ [QUARTERLY_SUGGESTION_KEYS.monthlySeenAt]: '2026-09-01T00:00:00.000Z' }));
    renderUi(<QuarterlySuggestion now={() => NOW} />);
    const card = await screen.findByTestId('quarterly-suggestion');
    // $54.99 against 3 × $24.99 = $74.97: 26.65%, printed rounded down.
    expect(card.textContent).toContain('save 26%');
    expect(card.textContent).toContain('$54.99');
    expect(card.textContent).toContain('$74.97');
    await waitFor(() => expect(v2.patchUiState).toHaveBeenCalledWith({ values: { [QUARTERLY_SUGGESTION_KEYS.shownAt]: NOW.toISOString() } }));
    // The stamp does not hide the card that caused it.
    expect(screen.getByTestId('quarterly-suggestion')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See what changes' })).toHaveAttribute('href', '/settings/billing?plan=pro_quarterly#plans');
  });

  it('"No thanks" hides it and dismisses it for good', async () => {
    monthly();
    v2.getUiState.mockResolvedValue(uiState({ [QUARTERLY_SUGGESTION_KEYS.monthlySeenAt]: '2026-09-01T00:00:00.000Z' }));
    renderUi(<QuarterlySuggestion now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'No thanks' }));
    expect(screen.queryByTestId('quarterly-suggestion')).toBeNull();
    expect(v2.patchUiState).toHaveBeenCalledWith({ dismiss: [QUARTERLY_SUGGESTION_KEYS.dismissal] });
  });

  it('is not shown again once shown, nor before 30 days (it records the first sighting)', async () => {
    monthly();
    v2.getUiState.mockResolvedValue(uiState({ [QUARTERLY_SUGGESTION_KEYS.monthlySeenAt]: '2026-09-01T00:00:00.000Z', [QUARTERLY_SUGGESTION_KEYS.shownAt]: '2026-10-01T00:00:00.000Z' }));
    const { unmount } = renderUi(<QuarterlySuggestion now={() => NOW} />);
    await waitFor(() => expect(v2.getUiState).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('quarterly-suggestion')).toBeNull();
    unmount();

    v2.getUiState.mockResolvedValue(uiState());
    renderUi(<QuarterlySuggestion now={() => NOW} />);
    await waitFor(() => expect(v2.patchUiState).toHaveBeenCalledWith({ values: { [QUARTERLY_SUGGESTION_KEYS.monthlySeenAt]: NOW.toISOString() } }));
    expect(screen.queryByTestId('quarterly-suggestion')).toBeNull();
  });

  it('never asks anything of free users, weekly subscribers or cancelled plans', async () => {
    renderUi(<QuarterlySuggestion now={() => NOW} />);
    await waitFor(() => expect(api.getCredits).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(v2.getUiState).not.toHaveBeenCalled();
    expect(screen.queryByTestId('quarterly-suggestion')).toBeNull();
  });
});
