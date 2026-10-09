// server/src/platform/billing/rails/alipayWorker.ts
//
// AlipayWorkerRail (GoApply, CNY one-time passes and packs) over the existing
// GoHire payment worker. ARCHITECTURE.md §7.4; CN_TW_LAUNCH_PLAN.md WP-PAY.
//
//   - Only GoApply sells through it (RoboApply's rails are ['stripe']; old
//     RoboApply Alipay passes are honoured to expiry by the callback path).
//   - The worker bills whole yuan; a price that is not a whole yuan is refused
//     rather than rounded.
//   - `platform` stays 'gohire' (the only merchant the worker has) until a
//     GoApply platform exists (`CN_ALIPAY_PLATFORM`). The subject and receipt
//     name the ACTUAL collecting entity (`CN_PAYMENT_COLLECTING_ENTITY`); with
//     no entity configured the rail reports itself unconfigured, so GoApply
//     charging stays off (no 二清, OPS C-13).
//   - Callbacks prove themselves with ALIPAY_CALLBACK_SECRET echoed back by
//     the worker (constant-time compare); `pay.alipay` already requires it.
//     Without the secret every callback is refused (503), including legacy
//     RoboApply orders: the buyer sees the order number, so an unauthenticated
//     callback could fulfil an unpaid order.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { brandEnv, type EnvSource } from '../../brand/brandEnv.js';
import type { ProductBrand } from '../../brand/registry.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { BillingError } from '../errors.js';
import { appOrigin, callbackOrigin, withQueryParam } from '../origins.js';
import { CallbackRejectedError, type CallbackInput, type CallbackVerification, type CheckoutOrder, type CheckoutResult, type PaymentRailImpl } from './types.js';

export const ALIPAY_DEFAULT_WORKER_URL = 'https://worker.gohire.top/payment/payment/create';
export const ALIPAY_CALLBACK_PATH = '/api/v1/roboapply/billing/alipay/callback';

export type AlipayRailDb = Pick<ExtendedPrismaClient, 'alipayOrder'>;

export interface AlipayRailDeps {
  fetch?: typeof fetch;
  getDb?: () => Promise<AlipayRailDb>;
  env?: EnvSource;
  now?: () => Date;
}

const defaultGetDb = async (): Promise<AlipayRailDb> => (await import('../../../lib/prisma.js')).default;

/** The entity that actually collects the money (named on the subject and receipt). */
export function collectingEntity(brand: ProductBrand, env: EnvSource = process.env): string | null {
  return brandEnv(brand, 'PAYMENT_COLLECTING_ENTITY', env) ?? null;
}

/** Whether ALIPAY_CALLBACK_SECRET is set (callbacks are refused without it). */
export function alipayCallbackSecretConfigured(env: EnvSource = process.env): boolean {
  return Boolean(env.ALIPAY_CALLBACK_SECRET);
}

/**
 * Constant-time check of the worker-echoed callback secret. Fails closed: with
 * no secret configured nothing can prove a callback came from the worker (the
 * order number is shown to the buyer), so every callback is refused.
 */
export function alipayCallbackSecretOk(token: string | undefined, env: EnvSource = process.env): boolean {
  const secret = env.ALIPAY_CALLBACK_SECRET;
  if (!secret) return false;
  const a = Buffer.from(String(token ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Our order number: '<GA|RA>ORDER_<yyyymmddhhmmss>_<user8>_<random>'. */
export function newOutTradeNo(brand: ProductBrand, userId: string, now: Date): string {
  const ts = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const prefix = brand.market === 'cn' ? 'GAORDER' : 'RAORDER';
  return `${prefix}_${ts}_${userId.slice(0, 8)}_${randomBytes(5).toString('hex')}`;
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return first(v[0]);
  return typeof v === 'string' && v ? v : undefined;
}

export function createAlipayWorkerRail(deps: AlipayRailDeps = {}): PaymentRailImpl {
  const getDb = deps.getDb ?? defaultGetDb;
  const now = deps.now ?? (() => new Date());

  return {
    id: 'alipay',
    isConfigured: (brand, env) => brand.market !== 'cn' || collectingEntity(brand, env) !== null,

    async createCheckout(order: CheckoutOrder): Promise<CheckoutResult> {
      const env = deps.env ?? process.env;
      const doFetch = deps.fetch ?? fetch;
      const { brand, plan } = order;
      if (!plan.sellable || plan.amountMinor === null) {
        throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key });
      }
      if (plan.amountMinor % 100 !== 0) {
        throw new BillingError('price_not_whole_yuan', 'This price cannot be charged through Alipay', { planKey: plan.key });
      }
      const entity = collectingEntity(brand, env);
      if (brand.market === 'cn' && !entity) {
        throw new BillingError('rail_not_configured', 'Payments are not open yet', { rail: 'alipay' });
      }
      const amountYuan = plan.amountMinor / 100;
      const at = now();
      const outTradeNo = newOutTradeNo(brand, order.user.id, at);
      const subject = `${brand.name} ${plan.defaultLabel}`.slice(0, 120);
      const secret = env.ALIPAY_CALLBACK_SECRET;
      const returnPath = order.successPath ?? '/settings/billing/return';
      const payload = {
        out_trade_no: outTradeNo,
        total_amount: amountYuan,
        subject,
        body: entity ? `${subject} · ${entity}`.slice(0, 200) : subject,
        pay_channel: 'alipay',
        user_name: order.user.name || order.user.email,
        user_email: order.user.email,
        user_id: order.user.id,
        platform: (brand.market === 'cn' ? env.CN_ALIPAY_PLATFORM : env.ROBOAPPLY_ALIPAY_PLATFORM)?.trim() || 'gohire',
        package_data: {
          package_id: plan.key,
          package_name: plan.key,
          package_type: '1',
          package_price: String(amountYuan),
        },
        notify_url: `${callbackOrigin(brand, env)}${ALIPAY_CALLBACK_PATH}${secret ? `?cb=${encodeURIComponent(secret)}` : ''}`,
        return_url: `${appOrigin(brand, env)}${withQueryParam(returnPath, 'billing', 'success')}`,
      };

      const url = env.ALIPAY_API_URL?.trim() || ALIPAY_DEFAULT_WORKER_URL;
      let data: { code: number; data?: { pay_url?: string }; message?: string };
      try {
        const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const raw = await res.text();
        try {
          data = JSON.parse(raw) as typeof data;
        } catch {
          logger.error('RA_BILLING', 'alipay worker non-JSON response', { status: res.status, body: raw.slice(0, 300), platform: payload.platform });
          throw new BillingError('payment_provider_error', 'Payment provider returned an unexpected response', { provider: 'alipay' });
        }
      } catch (err) {
        if (err instanceof BillingError) throw err;
        logger.error('RA_BILLING', 'alipay worker request failed', { error: err instanceof Error ? err.message : String(err) });
        throw new BillingError('payment_provider_error', 'Could not reach the payment provider', { provider: 'alipay' });
      }
      if (data.code !== 0 || !data.data?.pay_url) {
        logger.error('RA_BILLING', 'alipay worker error', { code: data.code, message: data.message });
        throw new BillingError('payment_provider_error', data.message || 'Failed to create the Alipay order', { provider: 'alipay' });
      }

      const db = await getDb();
      await db.alipayOrder.create({
        data: {
          userId: order.user.id,
          outTradeNo,
          tier: `ra_${plan.key}`,
          amount: amountYuan,
          amountMinor: plan.amountMinor,
          status: 'pending',
          channel: 'alipay',
          brand: brand.id,
          planKey: plan.key,
          purpose: plan.kind === 'pack' ? 'interview_pack' : 'subscription',
        },
      });
      logger.info('RA_BILLING', 'alipay order created', { userId: order.user.id, planKey: plan.key, outTradeNo, amountYuan, brand: brand.id });
      return { kind: 'redirect', url: data.data.pay_url, orderId: outTradeNo };
    },

    async verifyCallback(input: CallbackInput): Promise<CallbackVerification> {
      const env = deps.env ?? process.env;
      const body = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
      const token = first(input.query.cb) ?? first(body.cb) ?? first(input.headers['x-alipay-callback-secret']);
      if (!alipayCallbackSecretConfigured(env)) {
        logger.error('RA_BILLING', 'alipay callback refused: ALIPAY_CALLBACK_SECRET is not set');
        throw new CallbackRejectedError('callback secret not configured', 'not_configured');
      }
      if (!alipayCallbackSecretOk(token, env)) throw new CallbackRejectedError('bad or missing callback secret', 'bad_secret');
      const payStatus = first(input.query.pay_status) ?? first(body.pay_status);
      const outTradeNo = first(input.query.out_trade_no) ?? first(body.out_trade_no);
      if (!payStatus || !outTradeNo) throw new CallbackRejectedError('invalid callback params', 'invalid_params');
      const totalRaw = first(input.query.total_amount) ?? first(body.total_amount) ?? (typeof body.total_amount === 'number' ? String(body.total_amount) : undefined);
      const total = totalRaw !== undefined && /^\d+(\.\d{1,2})?$/.test(totalRaw) ? Math.round(Number(totalRaw) * 100) : null;
      const status: CallbackVerification['status'] = payStatus === 'TRADE_SUCCESS' ? 'paid' : payStatus === 'TRADE_CLOSED' ? 'closed' : 'pending';
      return { outTradeNo, status, paidAmountMinor: total, transactionId: first(input.query.trade_no) ?? first(body.trade_no) ?? null };
    },
  };
}
