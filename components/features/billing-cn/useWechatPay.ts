'use client';

// components/features/billing-cn/useWechatPay.ts — client state for GoApply
// WeChat Pay (WP-62). Kept next to the components (no hooks/ path in this WP).
//
//   useWechatPayAvailable()   capability on AND the server lists the rail as
//                             live for new purchases (GET /billing/plans
//                             `checkout.rails`, which already checks the
//                             merchant set-up, the collecting entity and the
//                             kill switch) — otherwise no UI entry. WeChat
//                             Pay is GoApply's second rail: the plan sheet
//                             offers it beside Alipay, which stays the default.
//   detectTradeType(ua)       JSAPI inside WeChat, H5 in a mobile browser,
//                             Native QR on desktop.
//   useWechatPayOrder(id)     polls the order while it is pending (stops on
//                             an error and after the payment window). The
//                             status read is open whenever WeChat Pay is SET
//                             UP, also under the kill switch, so an order
//                             that was in flight when sales were closed can
//                             still be looked up; a deployment where WeChat
//                             Pay is not set up answers 404 `feature_disabled`
//                             (`isWechatPayNotSetUp`), which is not retried.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { RoboApiError } from '../../../lib/api/client';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { getWechatPayOrder } from '../../../lib/api/billingCn';
import type { CnOrderStatus, WechatPayTradeType } from '../../../lib/api/contracts/billing-cn';
import type { CatalogPlan } from '../../../lib/api/credits';
import { usePlans } from '../../../hooks/credits/usePlans';

/** Poll interval while an order waits for payment. */
export const ORDER_POLL_MS = 3000;

export function detectTradeType(userAgent: string | null | undefined): WechatPayTradeType {
  const ua = userAgent ?? '';
  if (/MicroMessenger/i.test(ua)) return 'jsapi';
  if (/Mobi|Android|iPhone|iPad|iPod|HarmonyOS|OpenHarmony/i.test(ua)) return 'h5';
  return 'native';
}

export function currentUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

export interface WechatPayAvailability {
  /** True only when a purchase can start now. */
  available: boolean;
  /** Still loading the capability or the plan list. */
  loading: boolean;
  plans: readonly CatalogPlan[];
  /**
   * Every rail the server lists for a new purchase, in its order (the first
   * is the default; Alipay comes before WeChat Pay). Empty while this hook is
   * off or loading.
   */
  rails: readonly string[];
}

export function useWechatPayAvailable(): WechatPayAvailability {
  const brand = useBrand();
  const flag = useFlag('pay.wechatpay');
  const enabled = brand.market === 'cn' && flag;
  const plansQ = usePlans({ enabled });
  const rails = plansQ.data?.checkout?.rails ?? [];
  return {
    available: enabled && rails.includes('wechatpay'),
    loading: enabled && plansQ.isLoading,
    plans: plansQ.data?.plans ?? [],
    rails,
  };
}

/** The plan a CN rail can sell (a priced, sellable pass or pack), or null. */
export function sellableCnPlan(plans: readonly CatalogPlan[], planKey: string | null | undefined): CatalogPlan | null {
  if (!planKey) return null;
  const p = plans.find((x) => x.key === planKey);
  if (!p || !p.sellable || p.amountMinor === null || p.autoRenews) return null;
  return p.kind === 'pass' || p.kind === 'pack' ? p : null;
}

export function orderQueryKey(orderId: string | null): readonly unknown[] {
  return ['billingCn', 'order', orderId] as const;
}

/** Keep polling this long after an order's `expiresAt` (the server closes it ~1 min after). */
export const ORDER_POLL_GRACE_MS = 2 * 60_000;

/**
 * When to poll next, or false to stop: stops once the order is settled, when
 * the status call failed (React Query's own retries already ran; the UI offers
 * "check again"), and after the order's payment window plus a grace period.
 */
export function orderPollInterval(
  state: { status: 'pending' | 'error' | 'success'; data: Pick<CnOrderStatus, 'status' | 'expiresAt'> | undefined },
  fallbackExpiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): number | false {
  if (state.status === 'error') return false;
  if (state.data && state.data.status !== 'pending') return false;
  const expires = Date.parse(state.data?.expiresAt ?? fallbackExpiresAt ?? '');
  if (Number.isFinite(expires) && nowMs > expires + ORDER_POLL_GRACE_MS) return false;
  return ORDER_POLL_MS;
}

/**
 * The order read answered "WeChat Pay is not set up on this deployment"
 * (server: features/billing-cn/routes.ts `whenSetUp`, 404 `feature_disabled`).
 * A final answer: there is no WeChat Pay order to show here.
 */
export function isWechatPayNotSetUp(err: unknown): boolean {
  return err instanceof RoboApiError && err.status === 404 && apiErrorCode(err) === 'feature_disabled';
}

export function useWechatPayOrder(orderId: string | null, opts: { expiresAt?: string | null } = {}): UseQueryResult<CnOrderStatus> {
  return useQuery<CnOrderStatus>({
    queryKey: orderQueryKey(orderId),
    queryFn: ({ signal }) => getWechatPayOrder(orderId!, { signal }),
    enabled: Boolean(orderId),
    refetchInterval: (q) => orderPollInterval(q.state, opts.expiresAt),
    refetchIntervalInBackground: false,
    // "Not set up here" cannot change by asking again.
    retry: (failures, err) => !isWechatPayNotSetUp(err) && failures < 2,
  });
}

/** How long to wait for the WeChat bridge before falling back. */
export const JSAPI_BRIDGE_WAIT_MS = 8000;

/** Minimal typing of the WeChat in-app bridge. */
interface WeixinJSBridgeLike {
  invoke(name: 'getBrandWCPayRequest', params: Record<string, string>, cb: (res: { err_msg?: string }) => void): void;
}

export type JsapiOutcome = 'ok' | 'cancel' | 'fail';

/** Open the WeChat in-app cashier. Resolves with the user's outcome (the server stays the source of truth). */
export function invokeWechatJsapi(params: Record<string, string>, win: Window & { WeixinJSBridge?: WeixinJSBridgeLike } = window as never): Promise<JsapiOutcome> {
  return new Promise((resolve) => {
    const run = () => {
      const bridge = win.WeixinJSBridge;
      if (!bridge) {
        resolve('fail');
        return;
      }
      bridge.invoke('getBrandWCPayRequest', params, (res) => {
        const msg = res?.err_msg ?? '';
        resolve(msg.endsWith(':ok') ? 'ok' : msg.endsWith(':cancel') ? 'cancel' : 'fail');
      });
    };
    if (win.WeixinJSBridge) {
      run();
      return;
    }
    // Outside a real WeChat webview the bridge never arrives: give up after a while.
    const timer = win.setTimeout(() => resolve('fail'), JSAPI_BRIDGE_WAIT_MS);
    win.document.addEventListener(
      'WeixinJSBridgeReady',
      () => {
        win.clearTimeout(timer);
        run();
      },
      { once: true } as AddEventListenerOptions,
    );
  });
}

/** An SVG data URL for a WeChat Pay code (dark on light so it always scans, in either theme). */
export async function qrDataUrl(text: string): Promise<string> {
  const QR = await import('qrcode');
  const svg = await QR.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
