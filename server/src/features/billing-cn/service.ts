// server/src/features/billing-cn/service.ts — GoApply WeChat Pay (WP-62).
//
//   createOrder   a one-time pass or practice pack → Native QR / H5 / JSAPI
//   orderStatus   the buyer's own order; while it is pending, actively asks
//                 WeChat Pay (throttled) so a lost notify still completes it
//   handleNotify  the v3 notify on the RAW body → verify → fulfilPass()
//
// Fulfilment always goes through WP-21a's `fulfilPass()`: a replayed or
// concurrent notify (or a notify racing the active query) finds the order
// completed and does nothing. CN orders never carry a `coaching` purpose and
// never renew or debit automatically.

import { createHash } from 'node:crypto';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import {
  BillingError,
  closePendingOrder,
  fulfilPass,
  getPlan,
  getRegisteredRail,
  isPlanKey,
  loadBillingAccount,
  type BillingDb,
  type CatalogPlan,
  type FulfilResult,
  type PassOrderRef,
} from '../../platform/billing/index.js';
import type { FulfilDb } from '../../platform/billing/fulfilPass.js';
import {
  CallbackRejectedError,
  type CallbackInput,
  type CallbackVerification,
} from '../../platform/billing/rails/types.js';
import {
  createWechatPayRail,
  ensureWechatPayRail,
  isWechatPayRail,
  orderExpiresAt,
  readWechatPayConfig,
  wechatOpenIdFor,
  wechatPayReadiness,
  type WechatCheckoutContext,
  type WechatCheckoutResult,
  type WechatPayRail,
} from '../../platform/billing/rails/wechatpay.js';
import { requirementsMet } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { rateLimitKey, type RateWindow } from '../../platform/ratelimit/index.js';
import { BILLING_CN_CREATE_RATE_LIMIT, CN_PAY_TERMS_CONSENT_TYPE } from './contract.js';
import type { CnOrderState, CnOrderStatus, CnPurpose, CreateWechatOrderResponse, WechatNotifyAck, WechatPayTradeType } from './contract.js';
import type { CreateWechatOrderBodySchema } from './contract.js';
import type { z } from 'zod';

export type CreateWechatOrderInput = z.output<typeof CreateWechatOrderBodySchema>;

export type BillingCnDb = BillingDb & FulfilDb & Pick<ExtendedPrismaClient, 'alipayOrder' | 'rAAuthIdentity' | 'seekerConsentRecord'>;

/** Errors with their own wire codes (the envelope `{ success:false, code, error }`). */
export class BillingCnError extends Error {
  constructor(
    readonly code: 'wechat_openid_missing' | 'purpose_mismatch' | 'terms_outdated',
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingCnError';
  }
}

export interface BillingCnDeps {
  env?: EnvSource;
  getDb?: () => Promise<BillingCnDb>;
  /** The rail (default: the registered one, or one bound to `env` when given). */
  rail?: WechatPayRail;
  now?: () => Date;
  fulfil?: (order: PassOrderRef) => Promise<FulfilResult>;
  closeOrder?: (outTradeNo: string) => Promise<boolean>;
  /** Minimum seconds between active queries for one order. */
  queryIntervalSec?: number;
  /**
   * The published GoApply 用户协议 version, or null when none is published
   * (default: the brand's LEGAL_DOCS_VERSION, i.e. CN_LEGAL_DOCS_VERSION —
   * the same value GET /public/legal/terms returns as `version`).
   */
  termsVersion?: (brand: ProductBrand, env: EnvSource) => string | null;
  /** Fixed-window limiter (default: the platform's DB-backed consumeRateLimit). */
  consumeRateLimit?: (key: string, windows: readonly RateWindow[]) => Promise<{ allowed: boolean; retryAfterSec: number }>;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface NotifyOutcome {
  httpStatus: number;
  body: WechatNotifyAck;
  /** What happened (logged; tests read it). */
  result: 'fulfilled' | 'duplicate' | 'closed' | 'ignored' | 'rejected' | 'unmatched' | 'error';
}

const defaultGetDb = async (): Promise<BillingCnDb> => (await import('../../lib/prisma.js')).default as unknown as BillingCnDb;

/**
 * Row status for a paid order we could not honour (amount mismatch, unknown
 * plan). Staff resolve it (grant by hand or refund); the status read stops
 * querying WeChat Pay for it and tells the buyer to contact support.
 */
export const NEEDS_REVIEW = 'needs_review';

const STATUS_MAP: Record<string, CnOrderState> = {
  pending: 'pending',
  completed: 'paid',
  closed: 'closed',
  refunded: 'refunded',
  failed: 'failed',
  [NEEDS_REVIEW]: 'needs_support',
};

const TRADE_TYPE_FROM_COLUMN: Record<string, WechatPayTradeType> = { NATIVE: 'native', H5: 'h5', JSAPI: 'jsapi' };

/** Grace after `time_expire` before a still-unpaid order is closed on our side. */
const EXPIRY_GRACE_MS = 60_000;

const SUCCESS_ACK: WechatNotifyAck = { code: 'SUCCESS', message: '成功' };
const fail = (message: string): WechatNotifyAck => ({ code: 'FAIL', message });

function purposeFor(plan: Pick<CatalogPlan, 'kind'>): CnPurpose {
  return plan.kind === 'pack' ? 'interview_pack' : 'subscription';
}

/**
 * Narrow adapter for the published 用户协议 version. Same rule as compliance's
 * legalDocsVersion() (not on its public surface yet; request to WP-13).
 */
function defaultTermsVersion(brand: ProductBrand, env: EnvSource): string | null {
  return brandEnv(brand, 'LEGAL_DOCS_VERSION', env) ?? null;
}

async function defaultConsumeRateLimit(key: string, windows: readonly RateWindow[]): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const { consumeRateLimit } = await import('../../platform/ratelimit/index.js');
  return consumeRateLimit({ key, windows });
}

/** The exact terms a WeChat Pay buyer agreed to (hashed into the consent record). */
export function cnPayTermsStatement(input: { termsVersion: string; planKey: string; amountMinor: number; collectingEntity: string | null }): string {
  return [
    `用户协议 ${input.termsVersion}`,
    `plan ${input.planKey}`,
    `CNY ${input.amountMinor} fen, one-time, no automatic renewal, no deposit`,
    `payee ${input.collectingEntity ?? '—'}`,
  ].join(' | ');
}

export class BillingCnService {
  private readonly lastQuery = new Map<string, number>();

  constructor(private readonly deps: BillingCnDeps = {}) {}

  private env(): EnvSource {
    return this.deps.env ?? process.env;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private db(): Promise<BillingCnDb> {
    return (this.deps.getDb ?? defaultGetDb)();
  }

  private envRail: WechatPayRail | null = null;

  private rail(): WechatPayRail {
    if (this.deps.rail) return this.deps.rail;
    if (this.deps.env) return (this.envRail ??= createWechatPayRail({ env: this.deps.env, getDb: this.deps.getDb, now: this.deps.now }));
    const registered = getRegisteredRail('wechatpay') ?? ensureWechatPayRail();
    if (!isWechatPayRail(registered)) throw new BillingError('rail_not_registered', 'WeChat Pay is not available yet', { rail: 'wechatpay' });
    return registered;
  }

  private fulfil(order: PassOrderRef): Promise<FulfilResult> {
    return (this.deps.fulfil ?? ((o: PassOrderRef) => fulfilPass(o, { getDb: this.deps.getDb as (() => Promise<FulfilDb>) | undefined })))(order);
  }

  private closeLocal(outTradeNo: string): Promise<boolean> {
    return (this.deps.closeOrder ?? ((no: string) => closePendingOrder(no, { getDb: this.deps.getDb as (() => Promise<FulfilDb>) | undefined })))(outTradeNo);
  }

  /** Charging allowed on this brand now (capability requirements + entity match). */
  available(brand: ProductBrand): boolean {
    const env = this.env();
    // Same rule as the registry's railAvailable(), evaluated against this env.
    return requirementsMet('pay.wechatpay', brand, env) && wechatPayReadiness(brand, env).ready;
  }

  /** The user's openid under the paying app (WeChat sign-in through WECHATPAY_APP_ID), or null. */
  private async openIdFor(userId: string, brand: ProductBrand): Promise<string | null> {
    return wechatOpenIdFor(await this.db(), { userId, brandId: brand.id, appId: readWechatPayConfig(this.env()).appId });
  }

  /** Abuse guard: each order is a DB row plus a signed WeChat Pay call. */
  private async assertCreateRateLimit(userId: string, brand: ProductBrand): Promise<void> {
    const consume = this.deps.consumeRateLimit ?? defaultConsumeRateLimit;
    const result = await consume(rateLimitKey('billingCnCreate', 'user', userId, brand.id), BILLING_CN_CREATE_RATE_LIMIT);
    if (!result.allowed) {
      throw new HttpError('rate_limited', 'Too many payment attempts. Try again later.', { retryAfterSec: result.retryAfterSec }, {
        'Retry-After': String(result.retryAfterSec),
      });
    }
  }

  async createOrder(userId: string, brand: ProductBrand, input: CreateWechatOrderInput, meta: RequestMeta = {}): Promise<CreateWechatOrderResponse> {
    const env = this.env();
    await this.assertCreateRateLimit(userId, brand);
    if (!this.available(brand)) {
      throw new BillingError('rail_not_configured', 'WeChat Pay is not open yet', { rail: 'wechatpay', reason: wechatPayReadiness(brand, env).reason });
    }
    if (!input.planKey) throw new HttpError('invalid_request', 'Send planKey.', [{ path: 'planKey', message: 'Required' }]);
    const plan = isPlanKey(input.planKey) ? getPlan(brand.id, input.planKey, env) : null;
    if (!plan || !plan.sellable || plan.phase !== 'mvp' || (plan.kind !== 'pass' && plan.kind !== 'pack') || plan.autoRenews) {
      throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey, reason: plan?.unsellableReason ?? 'unknown' });
    }
    if (input.purpose && input.purpose !== purposeFor(plan)) {
      throw new BillingCnError('purpose_mismatch', 422, 'The purpose does not match the plan.');
    }
    // The buyer must have ticked the 用户协议 that is published now (it names
    // the collecting entity): a stale tab or a scripted client is refused.
    const currentTerms = (this.deps.termsVersion ?? defaultTermsVersion)(brand, env);
    if (!currentTerms || input.termsVersion !== currentTerms) {
      throw new BillingCnError('terms_outdated', 409, 'The agreement changed. Reload it and tick the box again.', { currentVersion: currentTerms });
    }

    const db = await this.db();
    const account = await loadBillingAccount(db, userId);
    if (!account) throw new HttpError('unauthorized');
    if (!account.seekerProfileId) throw new BillingError('no_profile', 'No seeker profile');

    const context: WechatCheckoutContext = { tradeType: input.tradeType };
    // JSAPI: the rail pays with the openid WeChat sign-in recorded (never a
    // client-sent one); answer a clear 409 here when there is none.
    if (input.tradeType === 'jsapi' && !(await this.openIdFor(userId, brand))) {
      throw new BillingCnError('wechat_openid_missing', 409, 'Sign in with WeChat to pay inside WeChat, or scan the QR code.');
    }
    if (input.tradeType === 'h5') context.payerClientIp = meta.ip ?? undefined;

    // Durable proof of what was agreed, written before WeChat Pay is called
    // (an abandoned checkout leaves an unused record, which is harmless).
    // Moves to AlipayOrder.termsVersion once that column exists (schema request).
    await db.seekerConsentRecord.create({
      data: {
        seekerProfileId: account.seekerProfileId,
        consentType: CN_PAY_TERMS_CONSENT_TYPE,
        granted: true,
        proseVersion: input.termsVersion,
        proseHash: createHash('sha256')
          .update(
            cnPayTermsStatement({
              termsVersion: input.termsVersion,
              planKey: plan.key,
              amountMinor: plan.amountMinor ?? 0,
              collectingEntity: wechatPayReadiness(brand, env).collectingEntity,
            }),
            'utf8',
          )
          .digest('hex'),
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
      },
    });

    const result: WechatCheckoutResult = await this.rail().createCheckout({
      brand,
      plan,
      user: { id: account.userId, email: account.email, name: account.name },
      seekerProfileId: account.seekerProfileId,
      acknowledgements: { autoRenewAck: false, withdrawalWaiver: false },
      successPath: `/settings/billing/return?plan=${encodeURIComponent(plan.key)}`,
      context: context as CheckoutOrderContext,
    });
    logger.info('RA_BILLING', 'wechatpay checkout terms acknowledged', {
      userId,
      outTradeNo: result.orderId,
      termsVersion: input.termsVersion,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
    });

    const base = {
      orderId: result.orderId ?? '',
      expiresAt: result.expiresAt,
      collectingEntity: result.collectingEntity,
      amountMinor: plan.amountMinor ?? 0,
      currency: 'CNY' as const,
      planKey: plan.key,
    };
    if (result.kind === 'qr') return { ...base, tradeType: 'native', codeUrl: result.qrCodeUrl };
    if (result.kind === 'redirect') return { ...base, tradeType: 'h5', h5Url: result.url };
    const p = result.jsapiParams;
    return {
      ...base,
      tradeType: 'jsapi',
      jsapi: { appId: p.appId ?? '', timeStamp: p.timeStamp ?? '', nonceStr: p.nonceStr ?? '', package: p.package ?? '', signType: 'RSA', paySign: p.paySign ?? '' },
    };
  }

  async orderStatus(userId: string, brand: ProductBrand, orderId: string): Promise<CnOrderStatus> {
    const db = await this.db();
    let row = await db.alipayOrder.findUnique({ where: { outTradeNo: orderId } });
    if (!row || row.userId !== userId || row.channel !== 'wechatpay') throw new HttpError('not_found', 'Order not found.');

    if (row.status === 'pending') {
      await this.reconcile(row.outTradeNo, row.createdAt);
      row = (await db.alipayOrder.findUnique({ where: { outTradeNo: orderId } })) ?? row;
    }

    const status = STATUS_MAP[row.status] ?? 'pending';
    let accessUntil: string | null = null;
    if (status === 'paid' && row.purpose !== 'interview_pack') {
      const account = await loadBillingAccount(db, userId);
      const sub = account?.subscription;
      if (sub && sub.planKey === row.planKey && sub.currentPeriodEnd) accessUntil = sub.currentPeriodEnd.toISOString();
    }
    return {
      orderId: row.outTradeNo,
      status,
      planKey: row.planKey ?? null,
      purpose: row.purpose === 'interview_pack' || row.purpose === 'subscription' ? row.purpose : null,
      amountMinor: row.amountMinor ?? Math.round(row.amount * 100),
      currency: 'CNY',
      paidAt: row.completedAt ? row.completedAt.toISOString() : null,
      expiresAt: orderExpiresAt(row.createdAt).toISOString(),
      tradeType: row.tradeType ? (TRADE_TYPE_FROM_COLUMN[row.tradeType] ?? null) : null,
      collectingEntity: wechatPayReadiness(brand, this.env()).collectingEntity,
      accessUntil,
    };
  }

  /**
   * Ask WeChat Pay about a pending order (at most once per interval), fulfil
   * it when paid and close it when it expired unpaid. Never throws: the
   * status read answers from our own row either way.
   */
  private async reconcile(outTradeNo: string, createdAt: Date): Promise<void> {
    const nowMs = this.now().getTime();
    const interval = (this.deps.queryIntervalSec ?? 5) * 1000;
    const last = this.lastQuery.get(outTradeNo) ?? 0;
    if (nowMs - last < interval) return;
    this.lastQuery.set(outTradeNo, nowMs);
    if (this.lastQuery.size > 5000) this.lastQuery.delete(this.lastQuery.keys().next().value as string);
    try {
      const rail = this.rail();
      const q = await rail.queryOrder(outTradeNo);
      if (q?.status === 'paid') {
        await this.applyVerified({ ...q, outTradeNo });
        return;
      }
      if (q?.status === 'closed') {
        await this.closeLocal(outTradeNo);
        return;
      }
      const expired = nowMs > orderExpiresAt(createdAt).getTime() + EXPIRY_GRACE_MS;
      if (!expired) return;
      if (q === null) {
        // WeChat Pay has no such order: nothing can be paid against it.
        await this.closeLocal(outTradeNo);
        return;
      }
      // Still NOTPAY / USERPAYING after the window. Close locally ONLY once
      // WeChat Pay confirms the close: a payer mid-payment (USERPAYING) or a
      // refused close leaves the row pending, so the next poll asks again and
      // the buyer is never told "nothing was charged" before a late charge.
      if (q.status === 'pending' && q.tradeState !== 'USERPAYING' && (await rail.closeOrder(outTradeNo))) {
        await this.closeLocal(outTradeNo);
      }
    } catch (err) {
      logger.warn('RA_BILLING', 'wechatpay order query failed', { outTradeNo, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async applyVerified(v: CallbackVerification): Promise<NotifyOutcome['result']> {
    if (v.status === 'closed') {
      await this.closeLocal(v.outTradeNo);
      return 'closed';
    }
    if (v.status !== 'paid') return 'ignored';
    const res = await this.fulfil({ outTradeNo: v.outTradeNo, channel: 'wechatpay', paidAmountMinor: v.paidAmountMinor, transactionId: v.transactionId });
    switch (res.status) {
      case 'fulfilled':
        return 'fulfilled';
      case 'already_fulfilled':
        return 'duplicate';
      default: {
        // Money arrived for an order we cannot honour as-is (unknown order,
        // wrong amount, unknown plan). Retrying will not change that: log it
        // loudly for staff (refund in the merchant console), park the row in
        // NEEDS_REVIEW (the buyer sees "payment received, contact support"
        // and the active query stops), and acknowledge.
        logger.error('RA_BILLING', 'wechatpay paid order not fulfilled', { outTradeNo: v.outTradeNo, status: res.status, transactionId: v.transactionId });
        if (res.status !== 'not_found') {
          const db = await this.db();
          await db.alipayOrder.updateMany({
            where: { outTradeNo: v.outTradeNo, channel: 'wechatpay', status: { in: ['pending', 'closed', 'failed'] } },
            data: { status: NEEDS_REVIEW, ...(v.transactionId ? { wxTransactionId: v.transactionId } : {}) },
          });
        }
        return 'unmatched';
      }
    }
  }

  /** WeChat Pay v3 notify. `rawBody` must be the untouched request bytes. */
  async handleNotify(input: { rawBody: Buffer; headers: CallbackInput['headers'] }): Promise<NotifyOutcome> {
    let verified: CallbackVerification;
    try {
      verified = await this.rail().verifyCallback({ query: {}, body: null, headers: input.headers, rawBody: input.rawBody });
    } catch (err) {
      if (err instanceof CallbackRejectedError) {
        logger.warn('RA_BILLING', 'wechatpay notify rejected', { reason: err.reason, message: err.message });
        const status = err.reason === 'bad_secret' ? 401 : err.reason === 'not_configured' ? 503 : 400;
        return { httpStatus: status, body: fail(err.reason === 'bad_secret' ? '签名错误' : '请求无效'), result: 'rejected' };
      }
      logger.error('RA_BILLING', 'wechatpay notify verification error', { error: err instanceof Error ? err.message : String(err) });
      return { httpStatus: 500, body: fail('系统错误'), result: 'error' };
    }
    try {
      const result = await this.applyVerified(verified);
      logger.info('RA_BILLING', 'wechatpay notify handled', { outTradeNo: verified.outTradeNo, status: verified.status, result });
      return { httpStatus: 200, body: SUCCESS_ACK, result };
    } catch (err) {
      // A database failure: answer FAIL so WeChat Pay retries the notify.
      logger.error('RA_BILLING', 'wechatpay notify fulfilment error', { outTradeNo: verified.outTradeNo, error: err instanceof Error ? err.message : String(err) });
      return { httpStatus: 500, body: fail('系统错误'), result: 'error' };
    }
  }
}

type CheckoutOrderContext = NonNullable<import('../../platform/billing/rails/types.js').CheckoutOrder['context']>;

export const billingCnService = new BillingCnService();
