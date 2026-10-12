// server/src/platform/billing/rails/index.ts — rails public surface.
// Importing this module registers the built-in rails (Stripe, Alipay worker).
// WP-62 registers WeChat Pay with `registerRail('wechatpay', createWechatPayRail())`
// from its own module (imported by its router), never by editing this file.

import { getRegisteredRail, registerRail } from './registry.js';
import { createAlipayWorkerRail, reportAlipayRailOnce } from './alipayWorker.js';
import { createStripeRail } from './stripe.js';

/**
 * Register the built-in rails unless a test (or a later wave) already
 * registered its own. This runs at module import, which can be BEFORE the
 * entry point has loaded `.env`, so no decision here reads the environment:
 * the notice about a missing GoApply collecting entity is logged by the Alipay
 * rail on first use (`warnIfAlipayEntityUnset`).
 *
 * The one log call here is the Alipay rail's startup report
 * (`reportAlipayRailOnce`): the host GoApply's Alipay notify goes to
 * (MARKET_STRATEGY §5.3 G8) and, when ALIPAY_SECRETLESS_UNTIL is set, whether
 * the secret-less window is open (G4). Where the environment is complete at
 * import (every deployed runtime) these are the startup lines. Where `.env`
 * arrives later, the rail asks again on first use and repeats a line only if
 * its answer changed; the boot report (platform/startup.ts) should ask too.
 */
export function ensureDefaultRails(): void {
  if (!getRegisteredRail('stripe')) registerRail('stripe', createStripeRail());
  if (!getRegisteredRail('alipay')) {
    registerRail('alipay', createAlipayWorkerRail());
    reportAlipayRailOnce();
  }
}

ensureDefaultRails();

export {
  availableRails,
  getRegisteredRail,
  isPaymentRail,
  railAvailable,
  registerRail,
  registeredRailIds,
  resolveRail,
  unregisterRail,
} from './registry.js';
export { createStripeRail, stripeCheckoutMetadata } from './stripe.js';
export type { StripeRailDeps } from './stripe.js';
export {
  ALIPAY_CALLBACK_PATH,
  ALIPAY_DEFAULT_WORKER_URL,
  ALIPAY_LEGACY_PACKAGE_ID,
  ALIPAY_MAX_PLAUSIBLE_YUAN,
  ALIPAY_ORDER_PREFIX,
  ALIPAY_SECRETLESS_WINDOW_DAYS,
  ALIPAY_SECRETLESS_WINDOW_MS,
  alipayCallbackSecretConfigured,
  alipayCallbackSecretOk,
  alipayEntityNotice,
  alipayEntityRequired,
  alipayPackageIdMode,
  alipaySecretlessEligible,
  alipaySecretlessUntil,
  alipaySecretlessWindowState,
  collectingEntity,
  createAlipayWorkerRail,
  logAlipayNotifyHostOnce,
  logAlipaySecretlessWindowOnce,
  newOutTradeNo,
  reportAlipayRailOnce,
  warnIfAlipayEntityUnset,
} from './alipayWorker.js';
export type { AlipayRailDeps } from './alipayWorker.js';
export { CallbackRejectedError } from './types.js';
export type { CallbackInput, CallbackVerification, CheckoutOrder, CheckoutResult, PaymentRail, PaymentRailImpl } from './types.js';
