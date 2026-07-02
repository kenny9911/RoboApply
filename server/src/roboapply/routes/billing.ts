// backend/src/roboapply/routes/billing.ts
//
// RoboApply self-serve billing for the mock-interview product. Mounted at
// /api/v1/roboapply/billing/* in backend/src/index.ts.
//
//   GET  /plan                      — region + both prices + credits + plan catalogue
//   GET  /credits                   — current credit balance (+ allotment)
//   POST /checkout                  — { tier } → Stripe Checkout url (USD recurring)
//   POST /alipay                    — { tier } → Alipay pay url (RMB monthly pass)
//   GET/POST /alipay/callback       — GoHire Alipay worker notify_url
//   POST /portal                    — Stripe Billing Portal url
//   POST /cancel                    — cancel Stripe sub at period end
//   GET  /history                   — unified invoice list (Stripe + Alipay)
//   GET  /invoices/:id/download     — redirect to Stripe PDF / stream Alipay receipt
//
// V1 namespace (imports the shared engine + Stripe billing service freely).

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { logger } from '../../services/LoggerService.js';
import {
  getPlan,
  createCheckoutSession,
  createAlipayOrder,
  handleRoboApplyAlipayCallback,
  alipayCallbackSecretOk,
  createPortalSession,
  cancelAtPeriodEnd,
  getBillingHistory,
  resolveInvoiceDownload,
  getAlipayOrderForReceipt,
  safeNextPath,
  RoboApplyBillingError,
} from '../services/RoboApplyBillingService.js';
import { getBalance } from '../../lib/mockCreditService.js';
import { countryHeaderFromRequest } from '../../lib/billingRegion.js';
import { getRequestLocale } from '../v2/lib/raLocale.js';
import { renderAlipayReceiptPdf } from '../lib/invoiceReceipt.js';

const router = Router();

function handleErr(err: unknown, req: Request, res: Response, code: string) {
  if (err instanceof RoboApplyBillingError) {
    return res.status(err.status).json({ success: false, code: err.code, error: err.message });
  }
  logger.error('RA_BILLING', `${code} failed`, { error: err instanceof Error ? err.message : String(err) }, req.requestId);
  return res.status(500).json({ success: false, code, error: 'Billing request failed' });
}

function validatePaidTier(raw: unknown): 'starter' | 'growth' {
  if (raw === 'starter' || raw === 'growth') return raw;
  throw new RoboApplyBillingError('invalid_tier', 'tier must be starter | growth');
}

router.get('/plan', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await getPlan(req.user!.id, {
      explicit: typeof req.query.region === 'string' ? req.query.region : null,
      countryHeader: countryHeaderFromRequest(req),
      locale: getRequestLocale(req),
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'plan_failed');
  }
});

router.get('/credits', requireAuth, async (req: Request, res: Response) => {
  try {
    const bal = await getBalance(req.user!.id);
    return res.json({
      success: true,
      data: {
        balance: bal.credits,
        periodAllotment: bal.periodAllotment,
        tier: bal.tier,
        currentPeriodEnd: bal.currentPeriodEnd?.toISOString() ?? null,
      },
    });
  } catch (err) {
    return handleErr(err, req, res, 'credits_failed');
  }
});

router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  try {
    const tier = validatePaidTier((req.body ?? {}).tier);
    const next = safeNextPath((req.body ?? {}).next);
    // Optional explicit cancel return (in-app /plans upgrades return to /plans).
    // Back-compat: when absent, keep the signup default (/choose-plan when a
    // success `next` was given, else the service default of /account).
    const cancelNext = safeNextPath((req.body ?? {}).cancelNext);
    const data = await createCheckoutSession({
      userId: req.user!.id,
      email: req.user!.email,
      tier,
      successPath: next,
      cancelPath: cancelNext ?? (next ? '/choose-plan' : undefined),
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'checkout_failed');
  }
});

router.post('/alipay', requireAuth, async (req: Request, res: Response) => {
  try {
    const tier = validatePaidTier((req.body ?? {}).tier);
    const next = safeNextPath((req.body ?? {}).next);
    const data = await createAlipayOrder({
      userId: req.user!.id,
      name: req.user!.name ?? null,
      email: req.user!.email,
      tier,
      returnPath: next,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'alipay_failed');
  }
});

// GoHire Alipay worker notify_url. Public (no auth) — identified by out_trade_no.
async function alipayCallback(req: Request, res: Response) {
  // Optional shared-secret check (see ALIPAY_CALLBACK_SECRET). When configured,
  // a callback missing the worker-echoed secret is rejected before any DB write
  // — closing the forge/brute-force vector on this public endpoint.
  const cbToken = (req.query.cb || (req.body as any)?.cb || req.headers['x-alipay-callback-secret']) as string | undefined;
  if (!alipayCallbackSecretOk(cbToken)) {
    logger.warn('RA_BILLING', 'alipay callback rejected — bad/missing secret', { out_trade_no: req.query.out_trade_no });
    return res.status(403).json({ code: 40003, message: 'forbidden' });
  }
  const pay_status = (req.query.pay_status || (req.body as any)?.pay_status) as string | undefined;
  const out_trade_no = (req.query.out_trade_no || (req.body as any)?.out_trade_no) as string | undefined;
  logger.info('RA_BILLING', 'alipay callback', { pay_status, out_trade_no });
  try {
    const result = await handleRoboApplyAlipayCallback({ pay_status, out_trade_no });
    return res.status(result.ok ? 200 : 400).json({ code: result.code, message: result.message });
  } catch (err) {
    logger.error('RA_BILLING', 'alipay callback error', { out_trade_no, error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ code: 50001, message: 'internal error' });
  }
}
router.get('/alipay/callback', alipayCallback);
router.post('/alipay/callback', alipayCallback);

router.post('/portal', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await createPortalSession(req.user!.id);
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

router.get('/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await getBillingHistory(req.user!.id);
    return res.json({ success: true, data });
  } catch (err) {
    return handleErr(err, req, res, 'history_failed');
  }
});

// Direct-open endpoint: the frontend just opens this URL in a new tab. Stripe →
// 302 to the hosted PDF; Alipay → stream the generated receipt PDF inline.
router.get('/invoices/:id/download', requireAuth, async (req: Request, res: Response) => {
  try {
    const resolved = await resolveInvoiceDownload(req.user!.id, req.params.id);
    if (resolved.kind === 'stripe') {
      return res.redirect(302, resolved.url);
    }
    const order = await getAlipayOrderForReceipt(req.user!.id, resolved.orderId);
    const planLabel = order.tier.replace(/^ra_/, '') === 'growth' ? 'Growth' : 'Starter';
    const pdf = await renderAlipayReceiptPdf({
      orderId: order.id,
      outTradeNo: order.outTradeNo,
      planLabel,
      subject: `RoboApply ${planLabel} 月度订阅`,
      amountMinor: Math.round(order.amount * 100),
      currency: 'CNY',
      paidAt: order.completedAt ?? order.createdAt,
      customerName: req.user!.name ?? '',
      customerEmail: req.user!.email,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="roboapply-receipt-${order.outTradeNo}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    return handleErr(err, req, res, 'invoice_download_failed');
  }
});

export default router;
