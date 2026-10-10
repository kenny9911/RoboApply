// WP-62 acceptance — GoApply WeChat Pay checkout UI (Testing Library, jsdom,
// 375 px; no network: lib/api is mocked).
//   - hidden unless GoApply + `pay.wechatpay` + the rail is live in /billing/plans;
//   - prices from the plan catalog; passes say they never renew or auto-debit;
//   - the agreement box starts unticked and gates the pay button;
//   - Native QR on desktop (payee = the collecting entity), H5 on mobile,
//     JSAPI inside WeChat with a QR fallback; the order is polled to "paid";
//   - 续费 renews a pass by buying it again;
//   - the pay button is also the "payment received" notice prompt point, only
//     on GoApply inside WeChat (INT-02);
//   - the H5 return page checks the order until the server settles it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import type { PlansView } from '../../../../lib/api/credits';
import type { BrandId } from '../../../../lib/brand/registry.generated';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { RoboApiError } from '../../../../lib/api/client';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { buildAuthValue, mockAuthState } from '../../../../__tests__/utils/mockAuth';
import enMessages from '../../../../i18n/messages/en.json';
import zhMessages from '../../../../i18n/messages/zh.json';

// The `billingCn` strings as the en and zh bundles carry them (WP-91 merged them out of i18n/staging).
const enCopy = { billingCn: enMessages.billingCn };
const zhCopy = { billingCn: zhMessages.billingCn };

const api = vi.hoisted(() => ({ createWechatPayOrder: vi.fn(), getWechatPayOrder: vi.fn() }));
const credits = vi.hoisted(() => ({ getPlans: vi.fn() }));
const compliance = vi.hoisted(() => ({ getLegalDoc: vi.fn() }));
vi.mock('../../../../lib/api/billingCn', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...credits }));
vi.mock('../../../../lib/api/compliance', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...compliance }));
// The notice prompt (SubscribeOnTap) reads the session and, inside WeChat, the JS-SDK signature.
const notify = vi.hoisted(() => ({ getJsSdkSignature: vi.fn(), subscribeWechatMessages: vi.fn() }));
vi.mock('../../../../lib/api/notifyCn', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...notify }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import { CnRenewButton, WechatPayCheckout, WechatPayReturn, detectTradeType, isOrderNumber } from '..';

/** The part of WeChat's JS-SDK global the notice prompt touches (a fake: no script is loaded). */
type WxSdk = { config: (c: unknown) => void; ready: (cb: () => void) => void; error: (cb: (res: unknown) => void) => void };
import { ORDER_POLL_GRACE_MS, ORDER_POLL_MS, invokeWechatJsapi, orderPollInterval } from '../useWechatPay';

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const WECHAT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50';
const ENTITY = '测试科技（上海）有限公司';
/** Always in the future, so polling never stops for expiry in these tests. */
const EXPIRES = new Date(Date.now() + 15 * 60_000).toISOString();

const GA_ENV = {
  CN_PAYMENTS_ENABLED: 'true',
  CN_PRICE_PRO_WEEK_PASS_FEN: '1200',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRO_QUARTERLY_FEN: '9900',
  CN_PRICE_PRACTICE_PACK_5_FEN: '2900',
  CN_PRICE_PRACTICE_PACK_15_FEN: '7900',
};

function plansView(rails: string[] = ['wechatpay']): PlansView {
  const { plans, defaultSelection } = buildPlanViews('goapply', { env: GA_ENV });
  return {
    plans,
    defaultSelection,
    currency: 'CNY',
    paymentsOpen: rails.length > 0,
    checkout: { rails, showWithdrawalWaiver: false, country: null, acknowledgementVersion: 'test' },
    fxReference: null,
    offers: [],
  } as unknown as PlansView;
}

function renderUi(ui: ReactElement, opts: { brand?: BrandId; flagOn?: boolean; zh?: boolean; notifyOn?: boolean } = {}) {
  const brand = opts.brand ?? 'goapply';
  return renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, { 'pay.wechatpay': opts.flagOn ?? true, 'notify.wechat': opts.notifyOn ?? false })}>
      {ui}
    </BrandProvider>,
    opts.zh ? { intlLocale: 'zh', intlMessages: zhCopy } : {},
  );
}

const native = (over: Record<string, unknown> = {}) => ({
  orderId: 'GAWX20261010080000aaaaaaaaaaaa',
  tradeType: 'native',
  codeUrl: 'weixin://wxpay/bizpayurl?pr=abc',
  expiresAt: EXPIRES,
  collectingEntity: ENTITY,
  amountMinor: 3900,
  currency: 'CNY',
  planKey: 'pro_monthly',
  ...over,
});

const status = (over: Record<string, unknown> = {}) => ({
  orderId: 'GAWX20261010080000aaaaaaaaaaaa',
  status: 'pending',
  planKey: 'pro_monthly',
  purpose: 'subscription',
  amountMinor: 3900,
  currency: 'CNY',
  paidAt: null,
  expiresAt: EXPIRES,
  tradeType: 'native',
  collectingEntity: ENTITY,
  accessUntil: null,
  ...over,
});

function apiError(code: string, status: number) {
  return new RoboApiError(code, { code, status, payload: { success: false, code, error: code } });
}

function tickTerms() {
  fireEvent.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  for (const fn of [...Object.values(api), ...Object.values(credits), ...Object.values(compliance), ...Object.values(notify)]) fn.mockReset();
  mockAuthState.value = buildAuthValue();
  notify.getJsSdkSignature.mockResolvedValue({ appId: 'wx_mp_app', timestamp: 1, nonceStr: 'n', signature: 's', templates: { payment_success: 'Tpl_Pay_000001' }, canDeliver: true });
  notify.subscribeWechatMessages.mockResolvedValue({ recorded: ['payment_success'], canDeliver: true, wechatChannelOn: true });
  credits.getPlans.mockResolvedValue(plansView());
  compliance.getLegalDoc.mockResolvedValue({ doc: 'terms', locale: 'zh', version: 'cn-terms-2026-10', draft: false, markdown: '', updatedAt: null });
  api.getWechatPayOrder.mockResolvedValue(status());
});

describe('trade type by context', () => {
  it('JSAPI inside WeChat, H5 in a mobile browser, Native QR on desktop', () => {
    expect(detectTradeType(WECHAT)).toBe('jsapi');
    expect(detectTradeType(MOBILE)).toBe('h5');
    expect(detectTradeType('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe('h5');
    expect(detectTradeType(DESKTOP)).toBe('native');
    expect(detectTradeType(undefined)).toBe('native');
  });
});

describe('visibility (no UI entry when off)', () => {
  it('renders nothing on RoboApply, with the capability off, or when the rail is not live', async () => {
    const { container, unmount } = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />, { brand: 'roboapply' });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    unmount();
    const off = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />, { flagOn: false });
    await waitFor(() => expect(off.container).toBeEmptyDOMElement());
    off.unmount();
    credits.getPlans.mockResolvedValue(plansView(['alipay']));
    const noRail = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    await waitFor(() => expect(noRail.container).toBeEmptyDOMElement());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for a plan CN rails do not sell', async () => {
    const { container } = renderUi(<WechatPayCheckout planKey="pro_weekly" userAgent={DESKTOP} />);
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('WechatPayCheckout', () => {
  it('shows the catalog price, says the pass never renews, and starts with the agreement unticked', async () => {
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    expect(await screen.findByText('30-day pass')).toBeInTheDocument();
    expect(screen.getByText('¥39')).toBeInTheDocument();
    expect(screen.getByText(/Pro for 30 days\. It does not renew, and nothing is charged automatically\./)).toBeInTheDocument();
    expect(screen.getByText(/No deposit and no other fees/)).toBeInTheDocument();
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'user agreement' })).toHaveAttribute('href', '/legal/terms');
    expect(screen.getByRole('link', { name: 'fee schedule' })).toHaveAttribute('href', '/pricing');
    const pay = screen.getByRole('button', { name: 'Pay ¥39 with WeChat Pay' });
    expect(pay).toBeDisabled();
    tickTerms();
    await waitFor(() => expect(pay).toBeEnabled());
  });

  it('pay stays disabled while the agreement version is loading (it is the acceptance record)', async () => {
    let resolveDoc: (v: unknown) => void = () => {};
    compliance.getLegalDoc.mockReturnValue(new Promise((r) => (resolveDoc = r)));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    const pay = screen.getByRole('button', { name: 'Pay ¥39 with WeChat Pay' });
    expect(pay).toBeDisabled();
    fireEvent.click(pay);
    expect(api.createWechatPayOrder).not.toHaveBeenCalled();
    resolveDoc({ doc: 'terms', locale: 'en', version: 'cn-terms-2026-10', draft: false, markdown: '', updatedAt: null });
    await waitFor(() => expect(pay).toBeEnabled());
  });

  it('if the agreement cannot be loaded: a plain error and a retry, never an unversioned order', async () => {
    compliance.getLegalDoc.mockRejectedValue(new RoboApiError('boom', { status: 500 }));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Nothing was charged. Try again.');
    expect(screen.queryByRole('button', { name: /Pay ¥39 / })).toBeNull();
    compliance.getLegalDoc.mockResolvedValue({ doc: 'terms', locale: 'en', version: 'cn-terms-2026-10', draft: false, markdown: '', updatedAt: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay ¥39 with WeChat Pay' })).toBeEnabled());
    expect(api.createWechatPayOrder).not.toHaveBeenCalled();
  }, 10_000);

  it('renders nothing (no payment wording) while availability is loading', async () => {
    let resolvePlans: (v: unknown) => void = () => {};
    credits.getPlans.mockReturnValue(new Promise((r) => (resolvePlans = r)));
    const { container } = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/WeChat Pay/)).toBeNull();
    resolvePlans(plansView());
    expect(await screen.findByText('30-day pass')).toBeInTheDocument();
  });

  it('a practice pack says how many sessions and for how long', async () => {
    renderUi(<WechatPayCheckout planKey="practice_pack_5" userAgent={DESKTOP} />);
    // 12 comes from the catalog's practice.validMonths, not from the copy.
    expect(await screen.findByText('5 practice sessions, valid for 12 months.')).toBeInTheDocument();
    expect(screen.getByText('¥29')).toBeInTheDocument();
  });

  it('desktop: Native QR with the payee, then polls until paid', async () => {
    api.createWechatPayOrder.mockResolvedValue(native());
    api.getWechatPayOrder.mockResolvedValueOnce(status()).mockResolvedValue(status({ status: 'paid', paidAt: '2026-10-10T08:01:00.000Z', accessUntil: '2026-11-09T08:01:00.000Z' }));
    const onPaid = vi.fn();
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} onPaid={onPaid} />);
    await screen.findByText('30-day pass');
    await waitFor(() => expect(compliance.getLegalDoc).toHaveBeenCalled());
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));

    await waitFor(() => expect(api.createWechatPayOrder).toHaveBeenCalledWith({ planKey: 'pro_monthly', tradeType: 'native', termsVersion: 'cn-terms-2026-10' }));
    const img = await screen.findByRole('img', { name: 'WeChat Pay code for ¥39' });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText(`Paid to: ${ENTITY}`)).toBeInTheDocument();
    expect(screen.getByText('Amount: ¥39')).toBeInTheDocument();

    const result = await screen.findByTestId('wechatpay-result', {}, { timeout: 6000 });
    expect(result).toHaveAttribute('data-state', 'paid');
    expect(screen.getByText(/Payment received\. Pro is on until/)).toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'View billing' })).toHaveAttribute('href', '/settings/billing');
  }, 10_000);

  it('an expired code says nothing was charged and offers a new one', async () => {
    api.createWechatPayOrder.mockResolvedValue(native());
    api.getWechatPayOrder.mockResolvedValue(status({ status: 'closed' }));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByText('This payment code has expired. Nothing was charged.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Get a new code' }));
    expect(await screen.findByTestId('wechatpay-checkout')).toBeInTheDocument();
  });

  it('mobile browser: H5 opens WeChat', async () => {
    api.createWechatPayOrder.mockResolvedValue(native({ tradeType: 'h5', codeUrl: undefined, h5Url: 'https://wx.tenpay.com/checkmweb?prepay_id=1&redirect_url=x' }));
    const navigate = vi.fn();
    renderUi(<WechatPayCheckout planKey="pro_week_pass" userAgent={MOBILE} navigate={navigate} />);
    await screen.findByText('7-day pass');
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥12 / }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://wx.tenpay.com/checkmweb?prepay_id=1&redirect_url=x'));
    expect(api.createWechatPayOrder.mock.calls[0]![0]).toMatchObject({ tradeType: 'h5' });
  });

  it('inside WeChat without a WeChat sign-in: falls back to the QR code with the long-press hint', async () => {
    api.createWechatPayOrder.mockRejectedValueOnce(apiError('wechat_openid_missing', 409)).mockResolvedValueOnce(native());
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT} />);
    await screen.findByText('30-day pass');
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByText('Press and hold the code, then choose to identify it.')).toBeInTheDocument();
    expect(api.createWechatPayOrder.mock.calls.map((c) => c[0].tradeType)).toEqual(['jsapi', 'native']);
  });

  it('inside WeChat: JSAPI opens the cashier; a cancel charges nothing', async () => {
    const invoke = vi.fn((_n: string, _p: unknown, cb: (r: { err_msg: string }) => void) => cb({ err_msg: 'get_brand_wcpay_request:cancel' }));
    (window as unknown as { WeixinJSBridge?: unknown }).WeixinJSBridge = { invoke };
    api.createWechatPayOrder.mockResolvedValue(
      native({ tradeType: 'jsapi', codeUrl: undefined, jsapi: { appId: 'wx1', timeStamp: '1', nonceStr: 'n', package: 'prepay_id=p', signType: 'RSA', paySign: 's' } }),
    );
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT} />);
    await screen.findByText('30-day pass');
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByText('Payment cancelled. Nothing was charged.')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('getBrandWCPayRequest', expect.objectContaining({ package: 'prepay_id=p', signType: 'RSA' }), expect.any(Function));
    delete (window as unknown as { WeixinJSBridge?: unknown }).WeixinJSBridge;
  });

  it('inside WeChat: when the in-app cashier fails, the QR code replaces it (no JSAPI retry loop)', async () => {
    const invoke = vi.fn((_n: string, _p: unknown, cb: (r: { err_msg: string }) => void) => cb({ err_msg: 'get_brand_wcpay_request:fail' }));
    (window as unknown as { WeixinJSBridge?: unknown }).WeixinJSBridge = { invoke };
    api.createWechatPayOrder
      .mockResolvedValueOnce(native({ tradeType: 'jsapi', codeUrl: undefined, jsapi: { appId: 'wx1', timeStamp: '1', nonceStr: 'n', package: 'prepay_id=p', signType: 'RSA', paySign: 's' } }))
      .mockResolvedValueOnce(native());
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT} />);
    await screen.findByText('30-day pass');
    await waitFor(() => expect(compliance.getLegalDoc).toHaveBeenCalled());
    tickTerms();
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay ¥39 / })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByTestId('wechatpay-qr')).toBeInTheDocument();
    expect(screen.getByText('WeChat could not finish the payment. Use the QR code below instead.')).toBeInTheDocument();
    expect(screen.getByText('Press and hold the code, then choose to identify it.')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'WeChat Pay code for ¥39' })).toBeInTheDocument();
    expect(api.createWechatPayOrder.mock.calls.map((c) => c[0].tradeType)).toEqual(['jsapi', 'native']);
    expect(invoke).toHaveBeenCalledTimes(1);
    delete (window as unknown as { WeixinJSBridge?: unknown }).WeixinJSBridge;
  });

  it('when the status check keeps failing: polling stops and the user can check again', async () => {
    api.createWechatPayOrder.mockResolvedValue(native());
    api.getWechatPayOrder.mockRejectedValue(new RoboApiError('gone', { status: 503 }));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay ¥39 / })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByText('We could not check this payment just now.', {}, { timeout: 8000 })).toBeInTheDocument();
    const calls = api.getWechatPayOrder.mock.calls.length;
    await new Promise((r) => setTimeout(r, ORDER_POLL_MS + 500));
    expect(api.getWechatPayOrder.mock.calls.length).toBe(calls);
    api.getWechatPayOrder.mockResolvedValue(status({ status: 'paid', paidAt: '2026-10-10T08:01:00.000Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByTestId('wechatpay-result')).toHaveAttribute('data-state', 'paid');
  }, 20_000);

  it('a paid order we could not honour says payment was received and points to support (never "nothing was charged")', async () => {
    api.createWechatPayOrder.mockResolvedValue(native());
    api.getWechatPayOrder.mockResolvedValue(status({ status: 'needs_support' }));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay ¥39 / })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    const result = await screen.findByTestId('wechatpay-result');
    expect(result).toHaveAttribute('data-state', 'needs_support');
    expect(result).toHaveTextContent(/^Payment received, but we could not add it to your account automatically\./);
    expect(result).not.toHaveTextContent(/Nothing was charged/);
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/help');
    expect(screen.queryByRole('button', { name: 'Get a new code' })).toBeNull();
  });

  it('plain errors: not open yet / not on sale / generic retry', async () => {
    api.createWechatPayOrder.mockRejectedValueOnce(apiError('rail_not_configured', 503));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByRole('alert')).toHaveTextContent('WeChat Pay is not open yet.');
    api.createWechatPayOrder.mockRejectedValueOnce(apiError('plan_not_sellable', 409));
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This plan is not on sale right now.'));
    api.createWechatPayOrder.mockRejectedValueOnce(new RoboApiError('boom', { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nothing was charged. Try again.'));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('a newer agreement (409 terms_outdated): unticks the box, reloads the agreement, and orders with the new version', async () => {
    api.createWechatPayOrder.mockRejectedValueOnce(apiError('terms_outdated', 409)).mockResolvedValueOnce(native());
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    compliance.getLegalDoc.mockResolvedValue({ doc: 'terms', locale: 'en', version: 'cn-terms-2026-11', draft: false, markdown: '', updatedAt: null });
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The agreement was updated. Read it again and tick the box to continue. Nothing was charged.');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Pay ¥39 / })).toBeDisabled();
    await waitFor(() => expect(compliance.getLegalDoc).toHaveBeenCalledTimes(2));
    tickTerms();
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay ¥39 / })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    await waitFor(() => expect(api.createWechatPayOrder).toHaveBeenLastCalledWith({ planKey: 'pro_monthly', tradeType: 'native', termsVersion: 'cn-terms-2026-11' }));
  });

  it('too many attempts (429 rate_limited): says to wait, nothing was charged', async () => {
    api.createWechatPayOrder.mockRejectedValueOnce(apiError('rate_limited', 429));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />);
    await screen.findByText('30-day pass');
    tickTerms();
    fireEvent.click(screen.getByRole('button', { name: /Pay ¥39 / }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many payment attempts. Wait a minute and try again. Nothing was charged.');
  });

  it('renders the Chinese copy on GoApply', async () => {
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />, { zh: true });
    expect(await screen.findByText('会员月卡')).toBeInTheDocument();
    expect(screen.getByText('会员权益 30 天。到期不自动续费，不会自动扣款。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '《用户协议》' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /微信支付/ })).toBeDisabled();
  });
});

describe('order polling and the WeChat bridge', () => {
  const pending = { status: 'pending' as const, expiresAt: '2026-10-10T08:15:00.000Z' };
  const at = (iso: string) => Date.parse(iso);
  it('polls while pending; stops when settled, on an error, and after the payment window', () => {
    expect(orderPollInterval({ status: 'success', data: pending }, null, at('2026-10-10T08:05:00Z'))).toBe(ORDER_POLL_MS);
    expect(orderPollInterval({ status: 'pending', data: undefined }, pending.expiresAt, at('2026-10-10T08:05:00Z'))).toBe(ORDER_POLL_MS);
    expect(orderPollInterval({ status: 'success', data: { ...pending, status: 'paid' } }, null, at('2026-10-10T08:05:00Z'))).toBe(false);
    expect(orderPollInterval({ status: 'error', data: undefined }, pending.expiresAt, at('2026-10-10T08:05:00Z'))).toBe(false);
    expect(orderPollInterval({ status: 'error', data: pending }, null, at('2026-10-10T08:05:00Z'))).toBe(false);
    expect(orderPollInterval({ status: 'success', data: pending }, null, at('2026-10-10T08:15:00Z') + ORDER_POLL_GRACE_MS - 1)).toBe(ORDER_POLL_MS);
    expect(orderPollInterval({ status: 'success', data: pending }, null, at('2026-10-10T08:15:00Z') + ORDER_POLL_GRACE_MS + 1)).toBe(false);
  });

  it('no WeChat bridge: the cashier resolves "fail" after the wait', async () => {
    let fire: () => void = () => {};
    const win = {
      setTimeout: (fn: () => void) => ((fire = fn), 1),
      clearTimeout: () => {},
      document: { addEventListener: () => {} },
    } as unknown as Window;
    const p = invokeWechatJsapi({}, win);
    fire();
    await expect(p).resolves.toBe('fail');
  });
});

describe('CnRenewButton (续费)', () => {
  it('opens the checkout for the same pass and says when the new days start', async () => {
    renderUi(<CnRenewButton planKey="pro_monthly" accessUntil={new Date(Date.now() + 3 * 86_400_000).toISOString()} userAgent={DESKTOP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Renew' }));
    expect(await screen.findByText('Renew your 30-day pass')).toBeInTheDocument();
    expect(screen.getByText(/The new days start after your current access ends/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Pay ¥39 / })).toBeDisabled();
  });

  it('is 续费 in Chinese', async () => {
    renderUi(<CnRenewButton planKey="pro_quarterly" userAgent={DESKTOP} />, { zh: true });
    expect(await screen.findByRole('button', { name: '续费' })).toBeInTheDocument();
  });

  it('is hidden for packs and when WeChat Pay is not live', async () => {
    const pack = renderUi(<CnRenewButton planKey="practice_pack_5" userAgent={DESKTOP} />);
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    await waitFor(() => expect(pack.container).toBeEmptyDOMElement());
    pack.unmount();
    credits.getPlans.mockResolvedValue(plansView([]));
    const off = renderUi(<CnRenewButton planKey="pro_monthly" userAgent={DESKTOP} />);
    await waitFor(() => expect(off.container).toBeEmptyDOMElement());
  });
});

describe('the "payment received" notice prompt at checkout (SubscribeOnTap, payment_success)', () => {
  const WECHAT_FULL = `${WECHAT} NetType/WIFI`;
  /** The wrapper SubscribeOnTap adds around the control it prompts on. */
  const prompt = () => document.querySelector('[data-wechat-subscribe]');
  /** WeChat's own open tag, laid over the pay button once the control can be used. */
  const openTag = () => document.querySelector('wx-open-subscribe');

  function fakeWx(): WxSdk {
    let readyCb: (() => void) | null = null;
    return {
      config: vi.fn(() => queueMicrotask(() => readyCb?.())),
      ready: (cb: () => void) => {
        readyCb = cb;
      },
      error: () => undefined,
    };
  }

  function inBrowser(ua: string) {
    vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => ua);
    (window as unknown as { wx?: WxSdk }).wx = fakeWx();
  }
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { wx?: WxSdk }).wx;
  });

  it('on GoApply inside WeChat the pay button is the prompt point; WeChat asks once the agreement is ticked', async () => {
    inBrowser(WECHAT_FULL);
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT_FULL} />, { notifyOn: true });
    await screen.findByRole('button', { name: /Pay ¥39 / });
    await waitFor(() => expect(prompt()).not.toBeNull());
    const pay = screen.getByRole('button', { name: /Pay ¥39 / });
    expect(prompt()!.contains(pay)).toBe(true);
    // The Cancel button next to it is not part of the prompt.
    // (No onCancel here; the prompt wraps exactly one control.)
    expect(prompt()!.querySelectorAll('button')).toHaveLength(1);
    // Disabled until the agreement is ticked: no tag over a button that does nothing.
    expect(pay).toBeDisabled();
    expect(openTag()).toBeNull();
    tickTerms();
    await waitFor(() => expect(openTag()).not.toBeNull());
    expect(openTag()!.getAttribute('template')).toBe('Tpl_Pay_000001');
    expect(prompt()).toHaveAttribute('data-wechat-subscribe', 'on');
  });

  it('whatever the buyer answers, the payment goes on (the answer is recorded, then the pay button runs)', async () => {
    inBrowser(WECHAT_FULL);
    api.createWechatPayOrder.mockResolvedValue(native());
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={DESKTOP} />, { notifyOn: true });
    await screen.findByRole('button', { name: /Pay ¥39 / });
    tickTerms();
    await waitFor(() => expect(openTag()).not.toBeNull());
    openTag()!.dispatchEvent(new CustomEvent('success', { detail: { subscribeDetails: JSON.stringify({ Tpl_Pay_000001: JSON.stringify({ status: 'reject' }) }) } }));
    await waitFor(() => expect(api.createWechatPayOrder).toHaveBeenCalledTimes(1));
    expect(notify.subscribeWechatMessages).toHaveBeenCalledWith({ templateKeys: ['payment_success'], scene: 'payment', results: { payment_success: 'reject' } });
  });

  it('no prompt outside WeChat, on RoboApply, with WeChat notices off, or signed out', async () => {
    // GoApply in an ordinary mobile browser.
    inBrowser(MOBILE);
    const mobile = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={MOBILE} />, { notifyOn: true });
    await screen.findByRole('button', { name: /Pay ¥39 / });
    expect(prompt()).toBeNull();
    mobile.unmount();

    // GoApply inside WeChat, but WeChat notices are not configured.
    inBrowser(WECHAT_FULL);
    const off = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT_FULL} />, { notifyOn: false });
    await screen.findByRole('button', { name: /Pay ¥39 / });
    expect(prompt()).toBeNull();
    off.unmount();

    // Signed out (no session to record a permission for).
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    const out = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT_FULL} />, { notifyOn: true });
    await screen.findByRole('button', { name: /Pay ¥39 / });
    expect(prompt()).toBeNull();
    out.unmount();
    mockAuthState.value = buildAuthValue();

    // RoboApply never renders the WeChat Pay checkout at all.
    const ra = renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT_FULL} />, { brand: 'roboapply', notifyOn: true });
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    expect(ra.container).toBeEmptyDOMElement();
    expect(prompt()).toBeNull();
    expect(openTag()).toBeNull();
    expect(notify.getJsSdkSignature).not.toHaveBeenCalled();
  });

  it('"Try again" for the agreement is not a prompt point (only the button that pays asks)', async () => {
    inBrowser(WECHAT_FULL);
    compliance.getLegalDoc.mockRejectedValue(apiError('internal_error', 500));
    renderUi(<WechatPayCheckout planKey="pro_monthly" userAgent={WECHAT_FULL} />, { notifyOn: true });
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 });
    expect(prompt()).toBeNull();
    expect(retry.closest('[data-wechat-subscribe]')).toBeNull();
  });
});

describe('WechatPayReturn (the H5 return page)', () => {
  const ORDER = 'GAWX20261010080000aaaaaaaaaaaa';

  it('accepts only something shaped like an order number', () => {
    expect(isOrderNumber(ORDER)).toBe(true);
    for (const bad of [null, undefined, '', 'abc', '<script>', 'a b c d e f', 'x'.repeat(65), '../../etc']) expect(isOrderNumber(bad), String(bad)).toBe(false);
  });

  it('asks about that order, says it is checking, and reports paid only when the server does', async () => {
    api.getWechatPayOrder.mockResolvedValueOnce(status({ tradeType: 'h5' })).mockResolvedValue(status({ status: 'paid', tradeType: 'h5', accessUntil: '2026-11-09T08:01:00.000Z' }));
    const onPaid = vi.fn();
    const onStatus = vi.fn();
    renderUi(<WechatPayReturn orderId={ORDER} onPaid={onPaid} onStatus={onStatus} />);
    const box = await screen.findByTestId('wechatpay-return');
    expect(box).toHaveTextContent('Checking your payment');
    expect(box.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(onPaid).not.toHaveBeenCalled();
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'paid'), { timeout: 6000 });
    expect(box).toHaveTextContent(/Payment received\. Pro is on until/);
    expect(onPaid).toHaveBeenCalledTimes(1);
    // Each state is reported once, in order, and "paid" only after the server said so.
    const reported = onStatus.mock.calls.map((c) => c[0]);
    expect(reported.at(-1)).toBe('paid');
    expect(reported.filter((s) => s === 'paid')).toHaveLength(1);
    expect(reported.slice(0, -1).every((s) => s === 'checking' || s === 'pending')).toBe(true);
    expect(api.getWechatPayOrder).toHaveBeenCalledWith(ORDER, expect.anything());
  }, 10_000);

  it('a paid practice pack says the sessions are added', async () => {
    api.getWechatPayOrder.mockResolvedValue(status({ status: 'paid', planKey: 'practice_pack_5', purpose: 'interview_pack' }));
    renderUi(<WechatPayReturn orderId={ORDER} />);
    const box = await screen.findByTestId('wechatpay-return');
    await waitFor(() => expect(box).toHaveTextContent('Payment received. Your practice sessions are added.'));
  });

  it('renders nothing without an order, off GoApply, or while WeChat Pay is not live', async () => {
    const none = renderUi(<WechatPayReturn orderId={null} />);
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    expect(none.container).toBeEmptyDOMElement();
    none.unmount();
    const ra = renderUi(<WechatPayReturn orderId={ORDER} />, { brand: 'roboapply' });
    expect(ra.container).toBeEmptyDOMElement();
    ra.unmount();
    credits.getPlans.mockResolvedValue(plansView([]));
    const off = renderUi(<WechatPayReturn orderId={ORDER} />);
    await waitFor(() => expect(credits.getPlans).toHaveBeenCalled());
    expect(off.container).toBeEmptyDOMElement();
    expect(api.getWechatPayOrder).not.toHaveBeenCalled();
  });

  it('is in Chinese on GoApply', async () => {
    api.getWechatPayOrder.mockResolvedValue(status({ status: 'closed' }));
    renderUi(<WechatPayReturn orderId={ORDER} />, { zh: true });
    expect(await screen.findByText('本次支付未完成，未扣款。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看账单' })).toHaveAttribute('href', '/settings/billing');
  });
});

describe('copy bundles', () => {
  function keys(o: unknown, prefix = ''): string[] {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  }
  it('zh has exactly the English keys', () => {
    expect(keys(zhCopy).sort()).toEqual(keys(enCopy).sort());
  });
  it('never names a brand literally', () => {
    expect(JSON.stringify([enCopy, zhCopy])).not.toMatch(/RoboApply|GoApply/);
  });
});
