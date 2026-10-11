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

import { ATTEMPT_KEY_RE, GA_ENV, anAttempt, atPhoneWidth, attemptKeys, checkoutOf, creditsResponse, plansView, renderUi, withBrand } from './fixtures';
import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
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

/** GoApply's plans (catalog prices, no payments switch) with the given rails able to charge. */
function goPlans(rails: Array<'alipay' | 'wechatpay'> = ['wechatpay'], env: Record<string, string> = GA_ENV): PlansView {
  return plansView('goapply', env, {
    paymentsOpen: rails.length > 0,
    checkout: checkoutOf(rails),
  });
}

/** The same, as the server answers a signed-in, verified student (nobody else is sent the student passes). */
function goPlansWithStudent(rails: Array<'alipay' | 'wechatpay'> = ['alipay']): PlansView {
  const { plans, defaultSelection } = buildPlanViews('goapply', { env: GA_ENV, studentEnabled: true });
  return { ...goPlans(rails), plans, defaultSelection };
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
    expect(account.alipayCheckoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'pro_monthly' }), anAttempt());
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

  it('with the pay.wechatpay capability off the sheet never opens, even if the plans list only that rail: no rail is left, so nothing is bought', async () => {
    api.getPlans.mockResolvedValue(goPlans(['wechatpay']));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: { 'pay.wechatpay': false } });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    // The page never falls back to a rail the server did not list.
    expect(await screen.findByTestId('payments-not-open')).toBeInTheDocument();
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
    expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
    expect(account.checkoutPlan).not.toHaveBeenCalled();
  });

  it('only Alipay can charge: a working Alipay button, no chooser, no "not open yet" note', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay']));
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    const navigate = vi.fn();
    // Alipay does not depend on the WeChat Pay capability.
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: { 'pay.wechatpay': false } });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    expect(screen.queryByTestId('rail-chooser')).toBeNull();
    expect(screen.queryByTestId('payments-not-open')).toBeNull();
    expect(screen.queryByText('Not available yet')).toBeNull();
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://payments.example.com/pay'));
    expect(account.alipayCheckoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'pro_monthly', next: '/settings/billing/return?plan=pro_monthly' }), anAttempt());
    expect(account.checkoutPlan).not.toHaveBeenCalled();
  });

  it('too many Alipay orders in a short time (429 rate_limited): says so, and that nothing was charged', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay']));
    account.alipayCheckoutPlan.mockRejectedValue(apiError({ code: 'rate_limited', details: { retryAfterSec: 37 } }, 429));
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: { 'pay.wechatpay': false } });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many payment attempts. Wait a minute and try again. Nothing was charged.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('both rails can charge: the chooser lists Alipay first and selected, WeChat Pay second; Continue pays with Alipay', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay', 'wechatpay']));
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: WECHAT_ON });
    const chooser = await screen.findByTestId('rail-chooser');
    expect(within(chooser).getByText('Pay with')).toBeInTheDocument();
    const options = Array.from(chooser.querySelectorAll('[data-rail]'));
    expect(options.map((o) => o.getAttribute('data-rail'))).toEqual(['alipay', 'wechatpay']);
    expect(options.map((o) => o.querySelector('span')!.firstElementChild!.textContent)).toEqual(['Alipay', 'WeChat Pay']);
    expect(within(chooser).getByRole('radio', { name: /Alipay/ })).toBeChecked();
    expect(within(chooser).getByRole('radio', { name: /WeChat Pay/ })).not.toBeChecked();
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://payments.example.com/pay'));
    expect(account.alipayCheckoutPlan).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
    expect(cn.createWechatPayOrder).not.toHaveBeenCalled();
  });

  it('both rails can charge: choosing WeChat Pay opens its sheet for the chosen pass, and Alipay is not called', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay', 'wechatpay']));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const chooser = await screen.findByTestId('rail-chooser');
    fireEvent.click(within(chooser).getByRole('radio', { name: /WeChat Pay/ }));
    expect(within(chooser).getByRole('radio', { name: /WeChat Pay/ })).toBeChecked();
    fireEvent.click(radio('pro_quarterly'));
    // Picking another plan keeps the chosen way to pay.
    expect(within(chooser).getByRole('radio', { name: /WeChat Pay/ })).toBeChecked();
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    expect(await screen.findByTestId('wechatpay-checkout')).toHaveTextContent('¥99');
    expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
  });

  it('both rails listed but WeChat Pay cannot open here (capability off): only Alipay, no chooser', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay', 'wechatpay']));
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: { 'pay.wechatpay': false } });
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    expect(screen.queryByTestId('rail-chooser')).toBeNull();
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://payments.example.com/pay'));
  });

  it('no rail credential: prices are shown with the "not open yet" note and nothing can be bought', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply'));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const picker = await screen.findByTestId('plan-picker');
    expect(picker.querySelector('[data-plan="pro_monthly"]')).toHaveTextContent('¥39');
    expect(screen.getByTestId('payments-not-open')).toHaveTextContent('These are the prices. Payment is not open yet, so nothing can be bought right now.');
    expect(screen.queryByText('Not available yet')).toBeNull();
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
    expect(account.alipayCheckoutPlan).not.toHaveBeenCalled();
    expect(cn.createWechatPayOrder).not.toHaveBeenCalled();
  });

  it('the kill switch (server: every plan payments_disabled, no rail): the same note, every row disabled and marked "Not available yet", nothing can be bought', async () => {
    api.getPlans.mockResolvedValue(plansView('goapply', { CN_PAYMENTS_ENABLED: 'false' }));
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const picker = await screen.findByTestId('plan-picker');
    expect(picker.querySelector('[data-plan="pro_monthly"]')).toHaveTextContent('¥39');
    expect(document.querySelectorAll('[data-plan] input[type="radio"]:not(:disabled)')).toHaveLength(0);
    expect(screen.getByTestId('payments-not-open')).toBeInTheDocument();
    // A row that cannot be chosen says why (the same rule as RoboApply with its card rail not ready);
    // the sheet-level note is still said once.
    const rows = Array.from(document.querySelectorAll('[data-plan]'));
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.querySelector('[data-not-available]'), row.getAttribute('data-plan') ?? '').toHaveTextContent('Not available yet');
    expect(screen.getAllByTestId('payments-not-open')).toHaveLength(1);
    expect(continueBtn()).toBeDisabled();
  });

  it('a verified GoApply student sees 学生月卡 ¥29 and 学生季卡 ¥69 with the computed saving, and buys one through Alipay', async () => {
    api.getPlans.mockResolvedValue(goPlansWithStudent(['alipay']));
    v2.getStudentStatus.mockResolvedValue({ verified: true, schoolDomain: 'pku.edu.cn', verifiedAt: null, expiresAt: '2027-10-10T00:00:00Z', pendingDomain: null, available: true });
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />, { brand: 'goapply', flags: { student: true } });
    await waitFor(() => expect(document.querySelector('[data-plan="student_monthly"]')).not.toBeNull());
    const monthly = document.querySelector<HTMLElement>('[data-plan="student_monthly"]')!;
    const quarterly = document.querySelector<HTMLElement>('[data-plan="student_quarterly"]')!;
    expect(monthly).toHaveTextContent('Student 30-day pass');
    expect(monthly).toHaveTextContent('¥29, paid once');
    expect(monthly).toHaveTextContent('25% below the regular price');
    expect(monthly).toHaveTextContent('30 days of Pro. One-time payment. It does not renew automatically when it ends.');
    expect(quarterly).toHaveTextContent('Student 90-day pass');
    expect(quarterly).toHaveTextContent('¥69, paid once');
    expect(quarterly).toHaveTextContent('30% below the regular price');
    expect(quarterly).toHaveTextContent('90 days of Pro. One-time payment. It does not renew automatically when it ends.');
    // Never preselected: the regular 30-day pass is.
    expect(radio('pro_monthly')).toBeChecked();
    expect(radio('student_monthly')).not.toBeChecked();
    fireEvent.click(radio('student_monthly'));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    // A pass: no auto-renewal box to tick.
    expect(screen.queryByRole('checkbox', { name: /renews automatically/i })).toBeNull();
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://payments.example.com/pay'));
    expect(account.alipayCheckoutPlan).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'student_monthly' }), anAttempt());
  });

  it('a buyer who verifies while the sheet holds the earlier list: the plans are asked for once more and the student passes appear', async () => {
    // First answer: what the server sends anyone who is not a verified student (five paid plans).
    api.getPlans.mockResolvedValueOnce(goPlans(['alipay']));
    api.getPlans.mockResolvedValue(goPlansWithStudent(['alipay']));
    v2.getStudentStatus.mockResolvedValue({ verified: true, schoolDomain: 'pku.edu.cn', verifiedAt: null, expiresAt: '2027-10-10T00:00:00Z', pendingDomain: null, available: true });
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: { student: true } });
    await waitFor(() => expect(document.querySelector('[data-plan="student_monthly"]')).not.toBeNull());
    expect(document.querySelector('[data-plan="student_quarterly"]')).not.toBeNull();
    expect(api.getPlans).toHaveBeenCalledTimes(2);
    // The choice already made is kept; a student pass is never preselected.
    expect(radio('pro_monthly')).toBeChecked();
  });

  it('a server that keeps answering without student passes is asked once more, not in a loop', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay']));
    v2.getStudentStatus.mockResolvedValue({ verified: true, schoolDomain: 'pku.edu.cn', verifiedAt: null, expiresAt: null, pendingDomain: null, available: true });
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: { student: true } });
    await waitFor(() => expect(api.getPlans).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    await new Promise((r) => setTimeout(r, 30));
    expect(api.getPlans).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-plan="student_monthly"]')).toBeNull();
  });

  it('a GoApply user who is not a verified student never sees the student passes, even if a response carried them', async () => {
    api.getPlans.mockResolvedValue(goPlansWithStudent(['alipay']));
    const { unmount } = renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: { student: true } });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    await waitFor(() => expect(v2.getStudentStatus).toHaveBeenCalled());
    expect(document.querySelector('[data-plan="student_monthly"]')).toBeNull();
    expect(document.querySelector('[data-plan="student_quarterly"]')).toBeNull();
    expect(screen.queryByText(/below the regular price/)).toBeNull();
    unmount();
    // The capability off: not shown to a verified student either, and the student API is not asked.
    v2.getStudentStatus.mockClear();
    v2.getStudentStatus.mockResolvedValue({ verified: true, schoolDomain: 'pku.edu.cn', verifiedAt: null, expiresAt: null, pendingDomain: null, available: true });
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: { student: false } });
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
    expect(document.querySelector('[data-plan="student_monthly"]')).toBeNull();
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

// ST-2 (web half; MARKET_STRATEGY §5.1 "Idempotency keys"): one checkout
// attempt = one key. The server builds the payment provider's idempotency key
// from it, so a double click opens one payment page and a second, intended
// purchase opens another.
describe('PlanPicker: one checkout attempt, one Idempotency-Key', () => {
  const redirect = (n: number) => ({ kind: 'redirect' as const, url: `https://checkout.stripe.test/s${n}`, orderId: `cs_${n}`, rail: 'stripe' as const });
  const ack = () => screen.getByRole('checkbox', { name: /renews automatically/i });
  const continueBtn = () => screen.getByRole('button', { name: /continue to payment/i });
  async function ready() {
    await waitFor(() => expect(radio('pro_monthly')).toBeChecked());
  }

  it('the key is a UUID that fits the header the server accepts', async () => {
    account.checkoutPlan.mockResolvedValue(redirect(1));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await ready();
    fireEvent.click(ack());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(1));
    const [key] = attemptKeys(account.checkoutPlan);
    expect(key).toMatch(ATTEMPT_KEY_RE);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // The key travels beside the body, never inside it.
    expect(account.checkoutPlan.mock.calls[0][0]).not.toHaveProperty('attemptKey');
  });

  it('a double click sends one key: the button is disabled while the call is pending, and a click after the answer repeats the same key', async () => {
    let release: (v: unknown) => void = () => undefined;
    account.checkoutPlan.mockImplementationOnce(() => new Promise((r) => (release = r)));
    account.checkoutPlan.mockResolvedValue(redirect(1));
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />);
    await ready();
    fireEvent.click(ack());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(1));
    // The second click of a double click lands on a disabled button.
    await waitFor(() => expect(screen.getByRole('button', { name: /opening the payment page/i })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /opening the payment page/i }));
    expect(account.checkoutPlan).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(redirect(1));
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/s1'));
    // Same sheet, same request, clicked again (the browser has not left yet): the same key, so the provider answers the same page.
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(2));
    const keys = attemptKeys(account.checkoutPlan);
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(1);
  });

  it('reopening the plan sheet sends a new key', async () => {
    account.checkoutPlan.mockResolvedValue(redirect(1));
    const first = renderUi(<PlanPicker navigate={vi.fn()} />);
    await ready();
    fireEvent.click(ack());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(1));
    first.unmount();
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await ready();
    fireEvent.click(ack());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(2));
    const keys = attemptKeys(account.checkoutPlan);
    // The same plan and the same boxes, and still a new attempt.
    expect(account.checkoutPlan.mock.calls[1][0]).toEqual(account.checkoutPlan.mock.calls[0][0]);
    expect(keys[1]).toMatch(ATTEMPT_KEY_RE);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('changing the selected plan makes a new key, also when the buyer comes back to the first plan', async () => {
    account.checkoutPlan.mockResolvedValue(redirect(1));
    renderUi(<PlanPicker navigate={vi.fn()} />);
    await ready();
    fireEvent.click(radio('practice_pack_5'));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(1));
    fireEvent.click(radio('practice_pack_15'));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(2));
    fireEvent.click(radio('practice_pack_5'));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(3));
    expect(account.checkoutPlan.mock.calls.map((c) => (c[0] as { planKey: string }).planKey)).toEqual(['practice_pack_5', 'practice_pack_15', 'practice_pack_5']);
    expect(new Set(attemptKeys(account.checkoutPlan)).size).toBe(3);
  });

  it('ticking an acknowledgement box makes a new key (the request body changed)', async () => {
    account.checkoutPlan.mockResolvedValue(redirect(1));
    renderUi(<PlanPicker visitorCountry="DE" navigate={vi.fn()} />);
    await ready();
    fireEvent.click(ack());
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(1));
    // The optional withdrawal waiver is ticked: another body, another key.
    fireEvent.click(screen.getByRole('checkbox', { name: /right of withdrawal/i }));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(2));
    expect(account.checkoutPlan.mock.calls[0][0]).toMatchObject({ withdrawalWaiver: false });
    expect(account.checkoutPlan.mock.calls[1][0]).toMatchObject({ withdrawalWaiver: true });
    // The renewal box unticked and ticked again: the same body, and still a new attempt.
    fireEvent.click(ack());
    fireEvent.click(ack());
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.checkoutPlan).toHaveBeenCalledTimes(3));
    expect(new Set(attemptKeys(account.checkoutPlan)).size).toBe(3);
  });

  it('a failed call is followed by a new key; the conflict answer (502 idempotency_conflict) shows the normal error line', async () => {
    account.checkoutPlan.mockRejectedValueOnce(apiError({ code: 'payment_provider_error', details: { reason: 'idempotency_conflict' } }, 502));
    account.checkoutPlan.mockResolvedValue(redirect(2));
    const navigate = vi.fn();
    renderUi(<PlanPicker navigate={navigate} />);
    await ready();
    fireEvent.click(ack());
    fireEvent.click(continueBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't open the payment page. Nothing was charged. Try again.");
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/s2'));
    const keys = attemptKeys(account.checkoutPlan);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(ATTEMPT_KEY_RE);
    expect(keys[1]).not.toBe(keys[0]);
    // The body did not change: only the attempt did.
    expect(account.checkoutPlan.mock.calls[1][0]).toEqual(account.checkoutPlan.mock.calls[0][0]);
  });

  it('GoApply: the Alipay call carries the key too, and choosing another way to pay starts a new attempt', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay', 'wechatpay']));
    account.alipayCheckoutPlan.mockResolvedValue({ kind: 'redirect', url: 'https://payments.example.com/pay', orderId: null, rail: 'alipay' });
    renderUi(<PlanPicker navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const chooser = await screen.findByTestId('rail-chooser');
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.alipayCheckoutPlan).toHaveBeenCalledTimes(1));
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.alipayCheckoutPlan).toHaveBeenCalledTimes(2));
    fireEvent.click(within(chooser).getByRole('radio', { name: /WeChat Pay/ }));
    fireEvent.click(within(chooser).getByRole('radio', { name: /Alipay/ }));
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    fireEvent.click(continueBtn());
    await waitFor(() => expect(account.alipayCheckoutPlan).toHaveBeenCalledTimes(3));
    const keys = attemptKeys(account.alipayCheckoutPlan);
    for (const key of keys) expect(key).toMatch(ATTEMPT_KEY_RE);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(account.checkoutPlan).not.toHaveBeenCalled();
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

  it('both rails can charge: no straight-to-WeChat Renew; the link opens the plan sheet, where Alipay is the default', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay', 'wechatpay']));
    api.getCredits.mockResolvedValue(pass(IN_10_DAYS));
    renderUi(<BillingView navigate={vi.fn()} requestedPlan="pro_monthly" />, { brand: 'goapply', flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    expect(await within(card).findByRole('link', { name: 'Buy another pass' })).toHaveAttribute('href', '/settings/billing?plan=pro_monthly#plans');
    expect(within(card).queryByRole('button', { name: 'Renew' })).toBeNull();
    expect(screen.queryByTestId('wechatpay-checkout')).toBeNull();
    // The plan sheet on the same page: both rails, Alipay first and selected.
    const options = await screen.findAllByRole('radio', { name: /Alipay|WeChat Pay/ });
    expect(options.map((o) => (o as HTMLInputElement).value)).toEqual(['alipay', 'wechatpay']);
    expect(options[0]).toBeChecked();
  });

  it('Alipay alone can charge: the plain link, no Renew button', async () => {
    api.getPlans.mockResolvedValue(goPlans(['alipay']));
    api.getCredits.mockResolvedValue(pass(IN_10_DAYS));
    renderUi(<BillingView navigate={vi.fn()} />, { brand: 'goapply', flags: WECHAT_ON });
    const card = await screen.findByTestId('current-plan');
    expect(await within(card).findByRole('link', { name: 'Buy another pass' })).toHaveAttribute('href', '/settings/billing?plan=pro_monthly#plans');
    expect(within(card).queryByRole('button', { name: 'Renew' })).toBeNull();
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
