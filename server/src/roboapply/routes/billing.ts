// server/src/roboapply/routes/billing.ts
//
// Seeker billing. Mounted at /api/v1/roboapply/billing/* (app.ts). Brand-aware
// since the Jobright clone (TASK_PLAN.md WP-21a): the request's brand picks
// the currency and rail; `?region=` is gone.
//
//   GET  /plan                      current plan, practice credits, the brand's catalog
//   GET  /credits                   practice credit balance (+ allotment)
//   POST /checkout                  { planKey, autoRenewAck?, withdrawalWaiver?, rail?, tradeType? } → CheckoutResponse
//                                   (features/credits/contract.ts): { kind: 'redirect', url, orderId, rail } (Stripe, Alipay,
//                                   WeChat Pay H5) | { kind: 'qr', qrCodeUrl, … } | { kind: 'jsapi', jsapiParams, … }.
//                                   The buyer's country (edge header) picks the Taiwan price; WeChat Pay H5 gets `req.ip`.
//                                   Rail `wechatpay` also needs `termsVersion` = the published 用户协议 version
//                                   (409 terms_outdated otherwise; same gate and consent record as /billing-cn/wechatpay).
//   POST /alipay                    { planKey } → CheckoutResponse (GoApply passes; same as checkout with rail 'alipay')
//   GET/POST /alipay/callback       GoHire Alipay worker notify_url → fulfilPass. PUBLIC and frozen: no auth, no
//                                   CSRF, no capability flag in front of it; it reads query and JSON body and its
//                                   answer codes are a contract with the worker (MARKET_STRATEGY §5.2 rules A1, A2;
//                                   pinned by routes/billing.test.ts). Do not gate it, e.g. on the payments kill switch.
//   POST /portal                    Stripe Billing Portal url
//   POST /cancel                    turn auto-renewal off (one click; confirmation email)
//   POST /switch                    { planKey } → quote; { planKey, confirm: true, prorationDate, autoRenewAck } → switched
//   GET  /history                   unified invoice list (Stripe + CN orders)
//   GET  /invoices/:id/download     Stripe PDF redirect / brand-aware CN receipt
//
// The new seeker endpoints (/credits area, /billing/plans, public /cancel)
// live in server/src/features/credits.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { logger } from '../../services/LoggerService.js';
import {
  getPlan,
  createCheckout,
  handleAlipayCallback,
  createPortalSession,
  cancelAtPeriodEnd,
  switchPlan,
  getBillingHistory,
  resolveInvoiceDownload,
  getAlipayOrderForReceipt,
  safeNextPath,
  RoboApplyBillingError,
} from '../services/RoboApplyBillingService.js';
import { getBalance } from '../../lib/mockCreditService.js';
import { getMockPlanCatalog } from '../../lib/mockInterviewPlans.js';
import { renderAlipayReceiptPdf } from '../lib/invoiceReceipt.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { buyerCountryFromRequest, collectingEntity, isPaymentRail } from '../../platform/billing/index.js';

const router = Router();

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

function handleErr(err: unknown, req: Request, res: Response, code: string) {
  if (err instanceof RoboApplyBillingError) {
    const body: Record<string, unknown> = { success: false, code: err.code, error: err.message };
    if (err.details) body.details = err.details;
    // A refusal that says when to come back (429 rate_limited from the WeChat
    // Pay agreement gate) says so in the header too, as platform/http.ts does.
    const retryAfterSec = err.details?.retryAfterSec;
    if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterSec)));
    }
    return res.status(err.status).json(body);
  }
  logger.error('RA_BILLING', `${code} failed`, { error: err instanceof Error ? err.message : String(err) }, req.requestId);
  return res.status(500).json({ success: false, code, error: 'Billing request failed' });
}

function invalid(res: Response, issues: z.ZodError) {
  return res.status(422).json({
    success: false,
    code: 'invalid_request',
    error: 'Invalid request',
    details: issues.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export const CheckoutBodySchema = z
  .object({
    planKey: z.string().min(1).max(40).optional(),
    /** Retired: starter/growth are no longer sold. */
    tier: z.string().max(40).optional(),
    autoRenewAck: z.boolean().optional(),
    withdrawalWaiver: z.boolean().optional(),
    rail: z.enum(['stripe', 'alipay', 'wechatpay']).optional(),
    next: z.string().max(400).optional(),
    cancelNext: z.string().max(400).optional(),
    tradeType: z.enum(['native', 'h5', 'jsapi']).optional(),
    openId: z.string().max(128).optional(),
    /** WeChat Pay: the 用户协议 version the buyer ticked. Checked against the published one before any order exists. */
    termsVersion: z.string().min(1).max(40).optional(),
  })
  .passthrough();

export const SwitchBodySchema = z
  .object({
    planKey: z.string().min(1).max(40),
    confirm: z.boolean().optional(),
    prorationDate: z.number().int().positive().optional(),
    /** Required with `confirm` when the new plan renews automatically. */
    autoRenewAck: z.boolean().optional(),
    withdrawalWaiver: z.boolean().optional(),
  })
  .strict();

function legacyTierRefusal(res: Response) {
  return res.status(409).json({
    success: false,
    code: 'plan_not_sellable',
    error: 'Practice plans are no longer sold. Choose a Pro plan or a practice pack.',
  });
}

router.get('/plan', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await getPlan(req.user!.id, { brand: brandOf(req) });
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'plan_failed');
  }
});

router.get('/credits', requireAuth, async (req: Request, res: Response) => {
  try {
    const bal = await getBalance(req.user!.id);
    const catalog = await getMockPlanCatalog();
    return res.json({
      success: true,
      data: {
        balance: bal.credits,
        periodAllotment: bal.periodAllotment,
        tier: bal.tier,
        currentPeriodEnd: bal.currentPeriodEnd?.toISOString() ?? null,
        creditMinutes: catalog.creditMinutes,
      },
    });
  } catch (err) {
    return handleErr(err, req, res, 'credits_failed');
  }
});

async function checkout(req: Request, res: Response, forcedRail?: 'alipay') {
  const parsed = CheckoutBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const body = parsed.data;
  if (!body.planKey) {
    if (body.tier) return legacyTierRefusal(res);
    return res.status(422).json({ success: false, code: 'invalid_request', error: 'Invalid request', details: [{ path: 'planKey', message: 'Required' }] });
  }
  const next = safeNextPath(body.next);
  const cancelNext = safeNextPath(body.cancelNext);
  try {
    const data = await createCheckout({
      userId: req.user!.id,
      brand: brandOf(req),
      planKey: body.planKey,
      autoRenewAck: body.autoRenewAck,
      withdrawalWaiver: body.withdrawalWaiver,
      rail: forcedRail ?? (isPaymentRail(body.rail) ? body.rail : null),
      successPath: next,
      cancelPath: cancelNext ?? (next ? '/settings/billing' : undefined),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      // Decides the price: read from the edge's own header (see buyerCountryFromRequest).
      country: buyerCountryFromRequest(req),
      // The payer's address is the one this server saw, never a body field
      // (WeChat Pay H5 refuses an order without it).
      // `termsVersion` is only what the buyer says they ticked: createCheckout
      // refuses a WeChat Pay order unless it is the published version.
      context:
        body.tradeType || body.termsVersion
          ? {
              ...(body.tradeType ? { tradeType: body.tradeType } : {}),
              openId: body.openId,
              ...(req.ip ? { payerClientIp: req.ip } : {}),
              ...(body.termsVersion ? { termsVersion: body.termsVersion } : {}),
            }
          : undefined,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'checkout_failed');
  }
}

router.post('/checkout', requireAuth, (req, res) => checkout(req, res));
router.post('/alipay', requireAuth, (req, res) => checkout(req, res, 'alipay'));

// GoHire Alipay worker notify_url. Public (no auth); proves itself with the
// echoed ALIPAY_CALLBACK_SECRET and is identified by out_trade_no.
async function alipayCallback(req: Request, res: Response) {
  try {
    const result = await handleAlipayCallback({ query: req.query as Record<string, unknown>, body: req.body, headers: req.headers });
    if (!result.ok) logger.warn('RA_BILLING', 'alipay callback refused', { code: result.code, out_trade_no: req.query.out_trade_no });
    return res.status(result.httpStatus).json({ code: result.code, message: result.message });
  } catch (err) {
    logger.error('RA_BILLING', 'alipay callback error', { out_trade_no: req.query.out_trade_no, error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ code: 50001, message: 'internal error' });
  }
}
router.get('/alipay/callback', alipayCallback);
router.post('/alipay/callback', alipayCallback);

router.post('/portal', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await createPortalSession(req.user!.id, brandOf(req));
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'portal_failed');
  }
});

router.post('/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await cancelAtPeriodEnd(req.user!.id);
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'cancel_failed');
  }
});

// Legacy → Pro (or between Pro intervals). Without `confirm` it only quotes;
// nothing is charged until `{ confirm: true, prorationDate }` comes back.
router.post('/switch', requireAuth, async (req: Request, res: Response) => {
  const parsed = SwitchBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  try {
    const data = await switchPlan(req.user!.id, brandOf(req), {
      ...parsed.data,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'switch_failed');
  }
});

router.get('/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await getBillingHistory(req.user!.id);
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'history_failed');
  }
});

// Direct-open endpoint: Stripe → 302 to the hosted PDF; CN orders → our receipt PDF.
router.get('/invoices/:id/download', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const resolved = await resolveInvoiceDownload(req.user!.id, req.params.id);
    if (resolved.kind === 'stripe') return res.redirect(302, resolved.url);
    const order = await getAlipayOrderForReceipt(req.user!.id, resolved.orderId);
    const brand = getBrand(order.brand);
    const pdf = await renderAlipayReceiptPdf({
      orderId: order.id,
      outTradeNo: order.outTradeNo,
      brandName: brand.name,
      planLabel: order.planLabel,
      subject: `${brand.name} ${order.planLabel}`,
      amountMinor: order.amountMinor,
      currency: 'CNY',
      paidAt: order.paidAt,
      customerName: req.user!.name ?? '',
      customerEmail: req.user!.email,
      paymentMethod: order.channel === 'wechatpay' ? 'WeChat Pay (微信支付)' : 'Alipay (支付宝)',
      collectedBy: collectingEntity(brand),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${brand.id}-receipt-${order.outTradeNo}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    return handleErr(err, req as unknown as Request, res, 'invoice_download_failed');
  }
});

export default router;
