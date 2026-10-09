// server/src/platform/billing/rails/index.ts — rails public surface.
// Importing this module registers the built-in rails (Stripe, Alipay worker).
// WP-62 registers WeChat Pay with `registerRail('wechatpay', createWechatPayRail())`
// from its own module (imported by its router), never by editing this file.

import { getRegisteredRail, registerRail } from './registry.js';
import { createAlipayWorkerRail } from './alipayWorker.js';
import { createStripeRail } from './stripe.js';

/** Register the built-in rails unless a test (or a later wave) already registered its own. */
export function ensureDefaultRails(): void {
  if (!getRegisteredRail('stripe')) registerRail('stripe', createStripeRail());
  if (!getRegisteredRail('alipay')) registerRail('alipay', createAlipayWorkerRail());
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
  alipayCallbackSecretConfigured,
  alipayCallbackSecretOk,
  collectingEntity,
  createAlipayWorkerRail,
  newOutTradeNo,
} from './alipayWorker.js';
export type { AlipayRailDeps } from './alipayWorker.js';
export { CallbackRejectedError } from './types.js';
export type { CallbackInput, CallbackVerification, CheckoutOrder, CheckoutResult, PaymentRail, PaymentRailImpl } from './types.js';
