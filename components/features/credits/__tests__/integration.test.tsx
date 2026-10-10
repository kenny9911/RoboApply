// INT-02 — billing UI ↔ server wiring (component tests, 375 px; no network:
// lib/api, auth and analytics are mocked):
//   - the cancel survey goes to its own endpoint and no longer fails;
//   - the public cancel page reads `cancel_token_invalid` where the server
//     puts it (the envelope `code`), and tolerates `details.reason`;
//   - the out-of-credits sheet records `upgrade_viewed` once per open;
//   - GoApply: the plan sheet opens the WeChat Pay sheet when the rail is
//     live, and a `weixin://` code is never used as an image address;
//   - GoApply: 续费 only for a pass that is still running, with WeChat Pay live;
//   - the return page checks the order named by `?order=` until it settles.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { GA_ENV, atPhoneWidth, creditsResponse, plansView, renderUi, withBrand } from './fixtures';
import { RoboApiError } from '../../../../lib/api/client';
import type { BillingPlanResponse } from '../../../../lib/api/account';
import type { PlansView } from '../../../../lib/api/credits';
import { buildAuthValue, mockAuthState } from '../../../../__tests__/utils/mockAuth';

const api = vi.hoisted(() => ({
  getCredits: vi.fn(),
  getPlans: vi.fn(),
  getCreditHistory: vi.fn(),
  cancelSubscription: vi.fn(),
  sendCancelSurvey: vi.fn(),
  requestPublicCancel: vi.fn(),
  confirmPublicCancel: vi.fn(),
}));
const account = vi.hoisted(() => ({ plan: vi.fn(), checkoutPlan: vi.fn(), alipayCheckoutPlan: vi.fn(), switchQuote: vi.fn(), switchConfirm: vi.fn(), portal: vi.fn() }));
const cn = vi.hoisted(() => ({ createWechatPayOrder: vi.fn(), getWechatPayOrder: vi.fn() }));
const compliance = vi.hoisted(() => ({ getLegalDoc: vi.fn() }));
const v2 = vi.hoisted(() => ({ getStudentStatus: vi.fn(), getUiState: vi.fn(), patchUiState: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/account', async (orig) => ({ ...(await orig<Record<string, unknown>>()), accountApi: account }));
vi.mock('../../../../lib/api/billingCn', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...cn }));
vi.mock('../../../../lib/api/compliance', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...compliance }));
vi.mock('../../../../lib/api/accountV2', async (orig) => {
  const real = await orig<{ accountV2Api: Record<string, unknown> }>();
  return { ...real, accountV2Api: { ...real.accountV2Api, getStudentStatus: v2.getStudentStatus } };
});
vi.mock('../../../../lib/api/uiState', () => ({ getUiState: v2.getUiState, patchUiState: v2.patchUiState }));
vi.mock('../../../../lib/analytics', async (orig) => ({ ...(await orig<Record<string, unknown>>()), track: analytics.track }));
vi.mock('../../../../app/(auth)/settings/billing/actions', () => ({ visitorCountryAction: vi.fn(async () => null) }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/settings/billing/return',
}));

import { BillingView } from '../BillingView';
import { CancelSubscription } from '../CancelSubscription';
import { CheckoutReturn } from '../CheckoutReturn';
import { OutOfCreditsSheet } from '../OutOfCreditsSheet';
import { PlanPicker } from '../PlanPicker';
import { PublicCancelFlow, isCancelTokenInvalid } from '../PublicCancelFlow';
import { clearCreditsExhausted, reportCreditsExhausted } from '../../../../hooks/shared/useCreditGate';

const ENTITY = '测试科技（上海）有限公司';
const ORDER = 'GAWX20261010080000aaaaaaaaaaaa';
const EXPIRES = new Date(Date.now() + 15 * 60_000).toISOString();
const IN_10_DAYS = new Date(Date.now() + 10 * 86_400_000).toISOString();
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();
const WECHAT_ON = { 'pay.wechatpay': true };

/** GoApply's plans with payments open on the given rails. */
function goPlans(rails: Array<'alipay' | 'wechatpay'> = ['wechatpay']): PlansView {
  return plansView('goapply', { ...GA_ENV, CN_PAYMENTS_ENABLED: 'true' }, {
    paymentsOpen: rails.length > 0,
    checkout: { rails, showWithdrawalWaiver: false, country: null, acknowledgementVersion: 'test' },
  });
}

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

const orderStatus = (over: Record<string, unknown> = {}) => ({
  orderId: ORDER,
  status: 'pending',
  planKey: 'pro_monthly',
  purpose: 'subscription',
  amountMinor: 3900,
  currency: 'CNY',
  paidAt: null,
  expiresAt: EXPIRES,
  tradeType: 'h5',
  collectingEntity: ENTITY,
  accessUntil: null,
  ...over,
});

function apiError(payload: Record<string, unknown>, status: number) {
  return new RoboApiError('failed', { code: String(payload.code ?? 'error'), status, payload: { success: false, ...payload } });
}

const radio = (key: string) => document.querySelector<HTMLInputElement>(`[data-plan="${key}"] input[type="radio"]`)!;

beforeEach(() => {
  atPhoneWidth();
  for (const group of [api, account, cn, compliance, v2, analytics]) for (const fn of Object.values(group)) fn.mockReset();
  nav.search = '';
  mockAuthState.value = buildAuthValue();
  v2.getStudentStatus.mockResolvedValue({ verified: false, schoolDomain: null, verifiedAt: null, expiresAt: null, pendingDomain: null, available: false });
  const uiState = { state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null };
  v2.getUiState.mockResolvedValue(uiState);
  v2.patchUiState.mockResolvedValue(uiState);
  api.getCredits.mockResolvedValue(creditsResponse());
  api.getPlans.mockResolvedValue(plansView());
  api.getCreditHistory.mockResolvedValue({ items: [] });
  account.plan.mockResolvedValue(legacyPlan());
  compliance.getLegalDoc.mockResolvedValue({ doc: 'terms', locale: 'zh', version: 'cn-terms-2026-10', draft: false, markdown: '', updatedAt: null });
  cn.getWechatPayOrder.mockResolvedValue(orderStatus());
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  act(() => clearCreditsExhausted());
  vi.useRealTimers();
});

describe('cancel survey (POST /credits/cancel/survey)', () => {
  it('a note alone is enough; it is sent once and the page thanks the person (no "We couldn\'t send that")', async () => {
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: null, alternative: null });
    // The server answers 204: the wrapper resolves with nothing.
    api.sendCancelSurvey.mockResolvedValue(undefined);
    renderUi(<CancelSubscription periodEnd={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await screen.findByTestId('cancel-done');
    fireEvent.change(screen.getByLabelText('Anything else? (optional)'), { target: { value: '  Moving abroad.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Thanks for telling us.');
    expect(api.sendCancelSurvey).toHaveBeenCalledTimes(1);
    expect(api.sendCancelSurvey).toHaveBeenCalledWith({ reason: undefined, note: 'Moving abroad.' });
    expect(screen.queryByText(/couldn't send that/)).toBeNull();
    expect(api.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('only the five reasons the server accepts are offered', async () => {
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', accessUntil: null, alternative: null });
    api.sendCancelSurvey.mockResolvedValue(undefined);
    renderUi(<CancelSubscription periodEnd={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    const done = await screen.findByTestId('cancel-done');
    const reasons = within(done)
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed'))
      .map((b) => b.textContent);
    expect(reasons).toEqual(['Too expensive', 'I found a job', 'Not useful enough', 'Taking a break', 'Something else']);
    fireEvent.click(screen.getByRole('button', { name: 'Taking a break' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCancelSurvey).toHaveBeenCalledWith({ reason: 'pause', note: undefined }));
  });
});

describe('public cancel: where the error code is read', () => {
  it('reads cancel_token_invalid from the envelope code (where the server puts it)', async () => {
    api.confirmPublicCancel.mockRejectedValue(apiError({ code: 'cancel_token_invalid', error: 'This link has expired or was already used. Ask for a new one.' }, 410));
    renderUi(<PublicCancelFlow token="tok_abcdefghijklmnop" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    // The link is spent: the button is gone and a new link can be requested.
    expect(screen.queryByRole('button', { name: 'Cancel now' })).toBeNull();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('also when an area reason carries it in details.reason', () => {
    expect(isCancelTokenInvalid(apiError({ code: 'cancel_token_invalid' }, 410))).toBe(true);
    expect(isCancelTokenInvalid(apiError({ code: 'gone', details: { reason: 'cancel_token_invalid' } }, 410))).toBe(true);
    expect(isCancelTokenInvalid(apiError({ code: 'payment_provider_error' }, 502))).toBe(false);
    expect(isCancelTokenInvalid(new Error('offline'))).toBe(false);
  });

  it('any other failure keeps the link usable: a plain error and the same button', async () => {
    api.confirmPublicCancel.mockRejectedValue(apiError({ code: 'payment_provider_error' }, 502));
    renderUi(<PublicCancelFlow token="tok_abcdefghijklmnop" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/expired or was already used/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel now' })).toBeEnabled();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });
});

describe('OutOfCreditsSheet records upgrade_viewed once per open', () => {
  const exhausted = (bucket = 'tailor') => ({ bucket, resetsAt: '2026-10-11T07:00:00.000Z', upgradable: true });

  it('nothing is recorded while it is closed', () => {
    renderUi(<OutOfCreditsSheet />);
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('one event when it opens, with where it came from and the bucket; re-renders and refetches add none', async () => {
    const view = renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted(exhausted()));
    await screen.findByTestId('out-of-credits-options');
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith('upgrade_viewed', { from: 'out_of_credits', bucket: 'tailor' });
    // The credit summary arriving re-renders the open sheet; so does the parent.
    await waitFor(() => expect(api.getCredits).toHaveBeenCalled());
    view.rerender(withBrand(<OutOfCreditsSheet />));
    view.rerender(withBrand(<OutOfCreditsSheet />));
    expect(screen.getByTestId('out-of-credits-options')).toBeInTheDocument();
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it('a second report while it is still open is the same view', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted(exhausted()));
    await screen.findByTestId('out-of-credits-options');
    act(() => reportCreditsExhausted(exhausted()));
    act(() => reportCreditsExhausted(exhausted('cover_letter')));
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it('closing and opening again is a new view, with the new bucket', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted(exhausted()));
    await screen.findByTestId('out-of-credits-options');
    fireEvent.click(screen.getByRole('button', { name: /Continue without it/ }));
    await waitFor(() => expect(screen.queryByTestId('out-of-credits-options')).toBeNull());
    act(() => reportCreditsExhausted(exhausted('cover_letter')));
    await screen.findByTestId('out-of-credits-options');
    expect(analytics.track).toHaveBeenCalledTimes(2);
    expect(analytics.track).toHaveBeenLastCalledWith('upgrade_viewed', { from: 'out_of_credits', bucket: 'cover_letter' });
  });

  it('practice credits are recorded under the practice bucket', async () => {
    renderUi(<OutOfCreditsSheet />);
    act(() => reportCreditsExhausted({ bucket: 'practice', resetsAt: null, upgradable: false }));
    await screen.findByTestId('out-of-credits-options');
    expect(analytics.track).toHaveBeenCalledWith('upgrade_viewed', { from: 'out_of_credits', bucket: 'practice' });
  });
});

describe('PlanPicker on GoApply', () => {
  const continueBtn = () => screen.getByRole('button', { name: 'Continue to payment' });

  it('WeChat Pay live: Continue opens the WeChat Pay sheet for the chosen pass; the legacy checkout is not called', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: WECHAT_ON });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    const sheet = await screen.findByTestId('wechatpay-checkout');
    expect(sheet).toHaveTextContent('¥39');
    expect(sheet).toHaveTextContent('It does not renew');
    expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
    expect(account.checkoutPlan).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a weixin:// payment code is drawn as a QR code, never used as an image address', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    cn.createWechatPayOrder.mockResolvedValue({
      orderId: ORDER,
      tradeType: 'native',
      codeUrl: 'weixin://wxpay/bizpayurl?pr=abc',
      expiresAt: EXPIRES,
      collectingEntity: ENTITY,
      amountMinor: 3900,
      currency: 'CNY',
      planKey: 'pro_monthly',
    });
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    const sheet = await screen.findByTestId('wechatpay-checkout');
    await waitFor(() => expect(compliance.getLegalDoc).toHaveBeenCalled());
    fireEvent.click(within(sheet).getByRole('checkbox'));
    const pay = within(sheet).getByRole('button', { name: /Pay ¥39 / });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.click(pay);
    const code = await screen.findByRole('img', { name: 'WeChat Pay code for ¥39' });
    expect(code.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    const sources = Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
    expect(sources.some((src) => /^weixin:/i.test(src))).toBe(false);
    expect(document.body.innerHTML).not.toContain('src="weixin:');
    expect(cn.createWechatPayOrder).toHaveBeenCalledWith({ planKey: 'pro_monthly', tradeType: 'native', termsVersion: 'cn-terms-2026-10' });
  });

  it('a pack opens the same sheet for that pack', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    fireEvent.click(radio('practice_pack_5'));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    expect(await screen.findByTestId('wechatpay-checkout')).toHaveTextContent('¥29');
  });

  it('only Alipay live: Continue opens the Alipay page from the shared redirect answer', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay']));
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: WECHAT_ON });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://payments.example.com/pay'));
    expect(account.alipayCheckoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'pro_monthly' }));
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
  });

  it('a payment-code answer from the legacy checkout is never rendered as an image or opened as a page', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay']));
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'qr', qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc', orderId: ORDER, rail: 'wechatpay' });
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: WECHAT_ON });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.alipayCheckoutPlan).toHaveBeenCalled());
    // Nothing to open: the page says so instead of doing nothing.
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't open the payment page. Nothing was charged.");
    expect(continueBtn()).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('with the pay.wechatpay capability off the sheet never opens, even if the plans list the rail', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    account.alipayCheckoutPlan.mockRejectedValue(apiError({ code: 'rail_not_configured' }, 503));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: { 'pay.wechatpay': false } });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was charged');
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
  });

  it('payments not open (CN_PAYMENTS_ENABLED unset): every plan reads "Not available yet" and nothing can be bought', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    await screen.findByTestId('plan-picker');
    expect(document.querySelectorAll('input[type="radio"]:not(:disabled)')).toHaveLength(0);
    expect(screen.getAllByText('Not available yet').length).toBeGreaterThan(0);
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
    expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
    expect(cn.createWechatPayOrder).not.toHaveBeenCalled();
  });

  it('RoboApply is unchanged: Stripe checkout, no WeChat Pay', async () => {
    account.checkoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://checkout.stripe.test/s', orderId: 'cs_1', rail: 'stripe' });
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { flags: WECHAT_ON });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox', { name: /renews automatically/i }));
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/s'));
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
  });
});

describe('BillingView on GoApply: 续费 for a pass that is still running', () => {
  const pass = (periodEnd: string, planKey = 'pro_monthly') =>
    creditsResponse({ planKey, planProfile: 'pro', interval: 'pass', periodEnd, upgradable: false });

  it('a live pass with WeChat Pay live shows Renew, which opens the checkout for the same pass', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    api.getCredits.mockResolvedValue(pass(IN_10_DAYS));
    renderUi(<BillingView navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    const renew = await within(card).findByRole('button', { name: 'Renew' });
    // The plain "Buy another pass" link is replaced, not shown next to it.
    expect(within(card).queryByRole('link', { name: 'Buy another pass' })).toBeNull();
    fireEvent.click(renew);
    expect(await screen.findByText('Renew your 30-day pass')).toBeInTheDocument();
    expect(screen.getByText(/The new days start after your current access ends/)).toBeInTheDocument();
    expect(await screen.findByTestId('wechatpay-checkout')).toHaveTextContent('¥39');
  });

  it('an expired pass gets no Renew button (the plan sheet is the way back in)', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    api.getCredits.mockResolvedValue(pass(YESTERDAY));
    renderUi(<BillingView navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    await within(card).findByRole('link', { name: 'Buy another pass' });
    expect(within(card).queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('no Renew button while WeChat Pay is not live; the plan sheet link stays', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    api.getCredits.mockResolvedValue(pass(IN_10_DAYS));
    renderUi(<BillingView navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    expect(await within(card).findByRole('link', { name: 'Buy another pass' })).toHaveAttribute('href', '/settings/billing?plan=pro_monthly#plans');
    expect(within(card).queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('no Renew button for a free GoApply user', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    renderUi(<BillingView navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    await screen.findByTestId('plan-picker');
    expect(within(card).queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('RoboApply passes keep the plain link (no WeChat Pay there)', async () => {
    api.getCredits.mockResolvedValue(pass(IN_10_DAYS, 'pro_week_pass'));
    renderUi(<BillingView navigate={vi.fn()} />, { flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    expect(await within(card).findByRole('link', { name: 'Buy another pass' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Renew' })).toBeNull();
  });
});

describe('CheckoutReturn with ?order= (back from WeChat Pay H5)', () => {
  it('checks that order and keeps checking until the server says it is paid', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    cn.getWechatPayOrder
      .mockResolvedValueOnce(orderStatus())
      .mockResolvedValue(orderStatus({ status: 'paid', paidAt: '2026-10-10T08:01:00.000Z', accessUntil: '2026-11-09T08:01:00.000Z' }));
    nav.search = `plan=pro_monthly&order=${ORDER}`;
    renderUi(<CheckoutReturn outcome={null} planKey="pro_monthly" />, { brand: 'goapply', flags: WECHAT_ON });
    const box = await screen.findByTestId('wechatpay-return');
    expect(box).toHaveTextContent('Checking your payment');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Checking your payment');
    expect(cn.getWechatPayOrder).toHaveBeenCalledWith(ORDER, expect.anything());
    // Not paid yet: nothing claims success.
    expect(screen.queryByText(/Payment received/)).toBeNull();
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'paid'), { timeout: 6000 });
    expect(box).toHaveTextContent(/Payment received\. Pro is on until/);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Payment received');
    expect(cn.getWechatPayOrder.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('link', { name: 'View billing' })).toHaveAttribute('href', '/settings/billing');
  }, 10_000);

  it('came back without paying: says nothing was charged and stops asking', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    cn.getWechatPayOrder.mockResolvedValue(orderStatus({ status: 'closed' }));
    renderUi(<CheckoutReturn outcome={null} orderId={ORDER} />, { brand: 'goapply', flags: WECHAT_ON });
    const box = await screen.findByTestId('wechatpay-return');
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'closed'));
    expect(box).toHaveTextContent('This payment was not completed. Nothing was charged.');
    // The heading agrees with the body: it stops saying "checking" once the order is final.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Payment not completed'));
    expect(screen.queryByText(/Checking your payment/)).toBeNull();
    const calls = cn.getWechatPayOrder.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(cn.getWechatPayOrder.mock.calls.length).toBe(calls);
  });

  it('money taken but not added: points to support, never "nothing was charged"', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    cn.getWechatPayOrder.mockResolvedValue(orderStatus({ status: 'needs_support' }));
    renderUi(<CheckoutReturn outcome={null} orderId={ORDER} />, { brand: 'goapply', flags: WECHAT_ON });
    const box = await screen.findByTestId('wechatpay-return');
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'needs_support'));
    expect(box).toHaveTextContent('Payment received, but we could not add it');
    expect(box).not.toHaveTextContent('Nothing was charged');
    expect(within(box).getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/help');
    // A neutral heading: neither "checking" nor "not completed" (money was taken).
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Payment status'));
    expect(screen.queryByText(/Checking your payment|Payment not completed/)).toBeNull();
  });

  it.each([
    ['failed', 'Payment not completed'],
    ['refunded', 'Payment status'],
  ] as const)('a %s order gets the heading "%s"', async (status, heading) => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    cn.getWechatPayOrder.mockResolvedValue(orderStatus({ status }));
    renderUi(<CheckoutReturn outcome={null} orderId={ORDER} />, { brand: 'goapply', flags: WECHAT_ON });
    const box = await screen.findByTestId('wechatpay-return');
    await waitFor(() => expect(box).toHaveAttribute('data-state', status));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading));
  });

  it('a failed status check says so and offers to check again', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    cn.getWechatPayOrder.mockRejectedValue(apiError({ code: 'not_found' }, 404));
    renderUi(<CheckoutReturn outcome={null} orderId={ORDER} />, { brand: 'goapply', flags: WECHAT_ON });
    const box = await screen.findByTestId('wechatpay-return', {}, { timeout: 8000 });
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'error'), { timeout: 8000 });
    expect(within(box).getByRole('alert')).toHaveTextContent('We could not check this payment just now.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Payment status');
    cn.getWechatPayOrder.mockResolvedValue(orderStatus({ status: 'paid', accessUntil: '2026-11-09T08:01:00.000Z' }));
    fireEvent.click(within(box).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'paid'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Payment received'));
  }, 15_000);

  it('ignores an order parameter that is not an order number, and any order on RoboApply', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    nav.search = 'order=<script>';
    const go = renderUi(<CheckoutReturn outcome={null} />, { brand: 'goapply', flags: WECHAT_ON });
    expect(await screen.findByText('Open billing to see your current plan.')).toBeInTheDocument();
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    expect(screen.queryByTestId('wechatpay-return')).toBeNull();
    go.unmount();
    api.getPlans.mockResolvedValue(plansView());
    nav.search = `order=${ORDER}`;
    renderUi(<CheckoutReturn outcome="success" />, { flags: WECHAT_ON });
    expect(await screen.findByText(/Your plan updates within a minute/)).toBeInTheDocument();
    expect(screen.queryByTestId('wechatpay-return')).toBeNull();
    expect(cn.getWechatPayOrder).not.toHaveBeenCalled();
  });

  it('with WeChat Pay off the ordinary return page shows and no order is looked up', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<CheckoutReturn outcome={null} orderId={ORDER} />, { brand: 'goapply', flags: { 'pay.wechatpay': false } });
    expect(await screen.findByText('Open billing to see your current plan.')).toBeInTheDocument();
    expect(cn.getWechatPayOrder).not.toHaveBeenCalled();
  });
});
