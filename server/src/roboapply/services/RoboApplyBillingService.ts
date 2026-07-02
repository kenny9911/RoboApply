// backend/src/roboapply/services/RoboApplyBillingService.ts
//
// RoboApply self-serve subscriptions for the mock-interview product:
//   • Free / Starter / Growth plans, each granting monthly mock-interview credits.
//   • Non-China (incl. Taiwan) → USD via Stripe recurring subscription.
//   • Mainland China → RMB via Alipay (GoHire worker, one-time monthly pass).
//
// Revenue lives on SeekerSubscription (keyed by seekerProfileId); credit balance
// + ledger live there too (see lib/mockCreditService.ts). Plan catalogue +
// region routing come from lib/mockInterviewPlans.ts + lib/billingRegion.ts.
//
// Stripe webhooks share the one /api/v1/webhooks/stripe endpoint: routes/
// checkout.ts calls handleRoboApplyStripeEvent() FIRST and only falls through to
// recruiter logic when this returns { handled: false }. RoboApply events are
// identified by metadata.product === 'roboapply' (checkout) or a
// stripeSubscriptionId matching a SeekerSubscription row (subscription/invoice.*).
//
// Alipay uses its OWN notify_url (/api/v1/roboapply/billing/alipay/callback) and
// 'ra_'-prefixed AlipayOrder.tier so recruiter flows never touch RA orders.
//
// Spec: docs/roboapply-billing-credits/spec.md.

import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import {
  getMockPlanCatalog,
  priceIdToMockPlanKey,
  isPaidMockPlan,
  type MockPlanKey,
} from '../../lib/mockInterviewPlans.js';
import {
  getBalance,
  grantForPlan,
  grantForPlanIfNewPeriod,
} from '../../lib/mockCreditService.js';
import {
  resolveBillingRegion,
  type RegionSignals,
  type BillingRegion,
} from '../../lib/billingRegion.js';
import { tierDailyCap, getRateCard } from '../../lib/rateCard.js';

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

function roboApplyBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ROBOAPPLY_URL ||
    process.env.ROBOAPPLY_URL ||
    'http://localhost:3611'
  );
}

function backendUrl(): string {
  return process.env.BACKEND_URL || 'https://api.robohire.io';
}

/**
 * Sanitise a caller-supplied post-payment redirect path. Only a same-origin
 * RELATIVE path is allowed (must start with a single '/', never '//' or a
 * scheme) so the checkout success/return URL can't be turned into an open
 * redirect. Returns undefined for anything unsafe → caller falls back to its
 * default.
 */
export function safeNextPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('://') || p.includes('\\')) return undefined;
  return p.slice(0, 200);
}

/**
 * Optional shared secret for the Alipay callback. When `ALIPAY_CALLBACK_SECRET`
 * is set we embed it in the worker's notify_url and require the worker to echo
 * it back on the callback — so a user who knows their own out_trade_no still
 * can't forge a TRADE_SUCCESS to self-grant a plan. When unset, behaviour is
 * unchanged (matches the recruiter Alipay flow). Constant-time compare.
 */
export function alipayCallbackSecretOk(token: string | undefined): boolean {
  const secret = process.env.ALIPAY_CALLBACK_SECRET;
  if (!secret) return true; // not configured → no check (backward-compatible)
  const a = Buffer.from(String(token ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadSubscriptionForUser(userId: string) {
  const profile = await prisma.seekerProfile.findUnique({
    where: { userId },
    select: { id: true, market: true, locale: true, subscription: true },
  });
  return {
    profileId: profile?.id ?? null,
    market: profile?.market ?? null,
    locale: profile?.locale ?? null,
    subscription: profile?.subscription ?? null,
  };
}

export class RoboApplyBillingError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ─── Read: current plan + credits + region + tier catalogue ───────────────────

export interface RoboApplyPlanView {
  region: BillingRegion;
  current: {
    tier: string;
    status: string;
    amountMinor: number | null;
    currency: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    hasStripeCustomer: boolean;
    /** True for the CN/Alipay one-time monthly pass (manual renewal). */
    manualRenewal: boolean;
  };
  credits: {
    balance: number;
    periodAllotment: number | null;
    tier: string;
  };
  plans: Array<{
    key: MockPlanKey;
    credits: number;
    usdMinor: number;
    cnyMinor: number;
    current: boolean;
    purchasable: boolean;
  }>;
  stripeConfigured: boolean;
  alipayConfigured: boolean;
}

export async function getPlan(userId: string, regionSignals: RegionSignals = {}): Promise<RoboApplyPlanView> {
  const catalog = await getMockPlanCatalog();
  const { market, locale, subscription } = await loadSubscriptionForUser(userId);
  const region = resolveBillingRegion({
    ...regionSignals,
    profileMarket: regionSignals.profileMarket ?? market,
    locale: regionSignals.locale ?? locale,
  });
  const tier = (subscription?.tier as string) ?? 'free';
  const balance = await getBalance(userId);

  const plans = (['free', 'starter', 'growth'] as MockPlanKey[]).map((k) => {
    const p = catalog.plans[k];
    return {
      key: k,
      credits: p.credits,
      usdMinor: p.usdMinor,
      cnyMinor: p.cnyMinor,
      current: tier === k,
      // Stripe path needs a price id; Alipay path needs a configured CNY price.
      purchasable:
        k !== 'free' &&
        (region.method === 'stripe' ? !!p.stripePriceId : p.cnyMinor > 0),
    };
  });

  return {
    region,
    current: {
      tier,
      status: subscription?.status ?? 'active',
      amountMinor: subscription?.amountMinor ?? null,
      currency: subscription?.currency ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      hasStripeCustomer: !!subscription?.stripeCustomerId,
      // CN/Alipay subs have no Stripe subscription id and are billed in CNY →
      // manual monthly renewal. Derived from the SUBSCRIPTION's own state (set
      // at activation), never the current request's region — a CN subscriber
      // travelling abroad must still see the Alipay "renew" path.
      manualRenewal:
        isPaidMockPlan(tier) && !subscription?.stripeSubscriptionId && subscription?.currency === 'CNY',
    },
    credits: { balance: balance.credits, periodAllotment: balance.periodAllotment, tier: balance.tier },
    plans,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    alipayConfigured: !!(process.env.ALIPAY_API_URL || true), // worker has a default URL
  };
}

// ─── Stripe Checkout (USD recurring) ──────────────────────────────────────────

export async function createCheckoutSession(params: {
  userId: string;
  email: string;
  tier: 'starter' | 'growth';
  /** Same-origin relative path to return to after success/cancel (signup flow). */
  successPath?: string;
  cancelPath?: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);

  const catalog = await getMockPlanCatalog();
  const priceId = catalog.plans[params.tier].stripePriceId;
  if (!priceId) throw new RoboApplyBillingError('no_price', `No Stripe price configured for ${params.tier}`, 503);

  const { profileId, subscription } = await loadSubscriptionForUser(params.userId);
  if (!profileId) throw new RoboApplyBillingError('no_profile', 'No RoboApply profile', 409);

  let customerId = subscription?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: params.email,
      metadata: { userId: params.userId, seekerProfileId: profileId, product: 'roboapply' },
    });
    customerId = customer.id;
    await prisma.seekerSubscription.upsert({
      where: { seekerProfileId: profileId },
      update: { stripeCustomerId: customerId },
      create: { seekerProfileId: profileId, tier: 'free', status: 'active', stripeCustomerId: customerId },
    });
  }

  const base = roboApplyBaseUrl();
  const successUrl = params.successPath
    ? `${base}${params.successPath}${params.successPath.includes('?') ? '&' : '?'}billing=success`
    : `${base}/account?billing=success`;
  const cancelUrl = `${base}${params.cancelPath ?? '/account'}${(params.cancelPath ?? '/account').includes('?') ? '&' : '?'}billing=cancel`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: params.userId,
    metadata: { userId: params.userId, seekerProfileId: profileId, tier: params.tier, product: 'roboapply' },
    subscription_data: {
      metadata: { userId: params.userId, seekerProfileId: profileId, tier: params.tier, product: 'roboapply' },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });

  if (!session.url) throw new RoboApplyBillingError('checkout_failed', 'Stripe did not return a checkout URL', 502);
  logger.info('RA_BILLING', 'stripe checkout session created', { userId: params.userId, tier: params.tier, sessionId: session.id });
  return { url: session.url };
}

export async function createPortalSession(userId: string): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
  const { subscription } = await loadSubscriptionForUser(userId);
  if (!subscription?.stripeCustomerId) {
    throw new RoboApplyBillingError('no_customer', 'No billing account yet — subscribe first', 409);
  }
  const portal = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: `${roboApplyBaseUrl()}/account`,
  });
  return { url: portal.url };
}

export async function cancelAtPeriodEnd(userId: string): Promise<{ ok: true }> {
  const stripe = getStripe();
  if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
  const { subscription } = await loadSubscriptionForUser(userId);
  if (!subscription?.stripeSubscriptionId) {
    throw new RoboApplyBillingError('no_subscription', 'No active auto-renewing subscription to cancel', 409);
  }
  await stripe.subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: true });
  await prisma.seekerSubscription.update({ where: { id: subscription.id }, data: { cancelAtPeriodEnd: true } });
  logger.info('RA_BILLING', 'cancel-at-period-end requested', { userId });
  return { ok: true };
}

// ─── Alipay (RMB one-time monthly pass) ───────────────────────────────────────

export async function createAlipayOrder(params: {
  userId: string;
  name: string | null;
  email: string;
  tier: 'starter' | 'growth';
  /** Same-origin relative path to return to after payment (signup flow). */
  returnPath?: string;
}): Promise<{ url: string }> {
  const { profileId } = await loadSubscriptionForUser(params.userId);
  if (!profileId) throw new RoboApplyBillingError('no_profile', 'No RoboApply profile', 409);

  const catalog = await getMockPlanCatalog();
  const cnyMinor = catalog.plans[params.tier].cnyMinor;
  if (cnyMinor <= 0) throw new RoboApplyBillingError('no_price', `No CNY price configured for ${params.tier}`, 503);
  // The GoHire Alipay worker bills in WHOLE YUAN (matches the recruiter flow).
  const amount = Math.round(cnyMinor / 100);

  const now = new Date();
  const ts = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const uid = Math.random().toString(36).slice(2, 10);
  const outTradeNo = `RAORDER_${ts}_${params.userId.slice(0, 8)}_${uid}`;

  const subject = `RoboApply ${params.tier === 'growth' ? 'Growth' : 'Starter'} 月度订阅`;
  const alipayPayload = {
    out_trade_no: outTradeNo,
    total_amount: amount,
    subject,
    pay_channel: 'alipay',
    user_name: params.name || params.email,
    user_email: params.email,
    user_id: params.userId,
    // The GoHire payment worker only has the 'gohire' platform (Alipay merchant)
    // registered; an unknown platform like 'roboapply' makes it 500. RoboApply
    // orders stay distinguishable downstream by the RAORDER_ out_trade_no prefix
    // and the ra_* tier on AlipayOrder, and the callback routes by our own
    // notify_url (below) — not by platform. Set ROBOAPPLY_ALIPAY_PLATFORM once a
    // dedicated RoboApply merchant/platform is registered on the worker.
    platform: process.env.ROBOAPPLY_ALIPAY_PLATFORM || 'gohire',
    package_data: {
      package_id: params.tier,
      package_name: params.tier,
      package_type: '1',
      package_price: String(amount),
    },
    notify_url: `${backendUrl()}/api/v1/roboapply/billing/alipay/callback${
      process.env.ALIPAY_CALLBACK_SECRET ? `?cb=${encodeURIComponent(process.env.ALIPAY_CALLBACK_SECRET)}` : ''
    }`,
    return_url: `${roboApplyBaseUrl()}${params.returnPath ?? '/account'}${
      (params.returnPath ?? '/account').includes('?') ? '&' : '?'
    }billing=success`,
  };

  const alipayApiUrl = process.env.ALIPAY_API_URL || 'https://worker.gohire.top/payment/payment/create';
  let alipayData: { code: number; data?: { pay_url: string }; message?: string };
  try {
    const alipayRes = await fetch(alipayApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alipayPayload),
    });
    // Read as text first: an unknown platform / worker fault returns a non-JSON
    // body (e.g. plain "Internal Server Error"), which .json() would throw on —
    // masking the real cause. Capture + log the status and body instead.
    const rawBody = await alipayRes.text();
    try {
      alipayData = JSON.parse(rawBody) as typeof alipayData;
    } catch {
      logger.error('RA_BILLING', 'alipay worker non-JSON response', {
        status: alipayRes.status,
        body: rawBody.slice(0, 300),
        platform: alipayPayload.platform,
      });
      throw new RoboApplyBillingError('alipay_failed', 'Payment provider returned an unexpected response', 502);
    }
  } catch (err) {
    if (err instanceof RoboApplyBillingError) throw err;
    logger.error('RA_BILLING', 'alipay worker request failed', { error: err instanceof Error ? err.message : String(err) });
    throw new RoboApplyBillingError('alipay_unreachable', 'Could not reach the payment provider', 502);
  }

  if (alipayData.code !== 0 || !alipayData.data?.pay_url) {
    logger.error('RA_BILLING', 'alipay worker error', { code: alipayData.code, message: alipayData.message });
    throw new RoboApplyBillingError('alipay_failed', alipayData.message || 'Failed to create Alipay order', 502);
  }

  await prisma.alipayOrder.create({
    data: {
      userId: params.userId,
      outTradeNo,
      tier: `ra_${params.tier}`, // distinct from recruiter starter/growth/business
      amount,
      status: 'pending',
    },
  });

  logger.info('RA_BILLING', 'alipay order created', { userId: params.userId, tier: params.tier, outTradeNo, amount });
  return { url: alipayData.data.pay_url };
}

/** Alipay payment callback for RoboApply orders (own notify_url). Idempotent. */
export async function handleRoboApplyAlipayCallback(params: {
  pay_status: string | undefined;
  out_trade_no: string | undefined;
}): Promise<{ ok: boolean; code: number; message: string }> {
  const { pay_status, out_trade_no } = params;
  if (!pay_status || !out_trade_no) {
    return { ok: false, code: 40001, message: 'invalid callback params' };
  }
  const order = await prisma.alipayOrder.findUnique({ where: { outTradeNo: out_trade_no } });
  if (!order || !order.tier.startsWith('ra_')) {
    return { ok: false, code: 40002, message: 'order not found' };
  }
  const planKey = order.tier.replace(/^ra_/, '') as MockPlanKey;

  if (pay_status === 'TRADE_SUCCESS' && order.status !== 'completed') {
    const catalog = await getMockPlanCatalog();
    const cnyMinor = catalog.plans[planKey]?.cnyMinor ?? Math.round(order.amount * 100);
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Claim the order → activate the subscription. The order.status guard makes
    // this idempotent: a duplicate callback finds it already completed and skips.
    let activated = false;
    await prisma.$transaction(async (tx) => {
      const current = await tx.alipayOrder.findUnique({ where: { outTradeNo: out_trade_no }, select: { status: true } });
      if (current?.status === 'completed') return;
      await tx.alipayOrder.update({ where: { outTradeNo: out_trade_no }, data: { status: 'completed', completedAt: new Date() } });

      const profile = await tx.seekerProfile.findUnique({ where: { userId: order.userId }, select: { id: true } });
      if (!profile) {
        logger.warn('RA_BILLING', 'alipay callback: no seeker profile', { userId: order.userId, outTradeNo: out_trade_no });
        return;
      }
      await tx.seekerSubscription.upsert({
        where: { seekerProfileId: profile.id },
        update: {
          tier: planKey as never,
          status: 'active',
          market: 'cn',
          currency: 'CNY',
          amountMinor: cnyMinor,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          startedAt: new Date(),
        },
        create: {
          seekerProfileId: profile.id,
          tier: planKey as never,
          status: 'active',
          market: 'cn',
          currency: 'CNY',
          amountMinor: cnyMinor,
          currentPeriodEnd: periodEnd,
          startedAt: new Date(),
        },
      });
      activated = true;
    });

    if (activated) {
      // Each Alipay payment is a fresh monthly pass → grant (reset to allotment).
      await grantForPlan({
        userId: order.userId,
        tier: planKey,
        reason: 'grant_purchase',
        source: 'alipay',
        currentPeriodEnd: periodEnd,
        metadata: { outTradeNo: out_trade_no, amountCny: order.amount },
      });
      await syncMissionTier(order.userId, planKey).catch(() => {});
      logger.info('RA_BILLING', 'alipay subscription activated', { userId: order.userId, tier: planKey, outTradeNo: out_trade_no });
    }
    return { ok: true, code: 0, message: 'success' };
  }

  if (pay_status === 'TRADE_CLOSED' && order.status === 'pending') {
    await prisma.alipayOrder.update({ where: { outTradeNo: out_trade_no }, data: { status: 'closed' } });
    return { ok: true, code: 0, message: 'closed' };
  }
  return { ok: true, code: 0, message: 'no action' };
}

// ─── Billing history + invoice download ───────────────────────────────────────

export interface BillingInvoice {
  id: string;
  kind: 'stripe' | 'alipay';
  date: string; // ISO
  amountMinor: number;
  currency: string;
  status: string; // paid | open | uncollectible | void | pending | failed
  description: string;
  downloadable: boolean;
}

export async function getBillingHistory(userId: string): Promise<{ invoices: BillingInvoice[] }> {
  const { subscription } = await loadSubscriptionForUser(userId);
  const out: BillingInvoice[] = [];

  // Stripe invoices (USD).
  const stripe = getStripe();
  if (stripe && subscription?.stripeCustomerId) {
    try {
      const list = await stripe.invoices.list({ customer: subscription.stripeCustomerId, limit: 50 });
      for (const inv of list.data) {
        out.push({
          id: inv.id as string,
          kind: 'stripe',
          date: new Date((inv.created ?? 0) * 1000).toISOString(),
          amountMinor: inv.amount_paid ?? inv.amount_due ?? 0,
          currency: (inv.currency ?? 'usd').toUpperCase(),
          status: inv.status ?? 'open',
          description: inv.lines?.data?.[0]?.description ?? 'RoboApply subscription',
          downloadable: !!(inv.invoice_pdf || inv.hosted_invoice_url),
        });
      }
    } catch (err) {
      logger.warn('RA_BILLING', 'stripe invoice list failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Alipay orders (CNY).
  const orders = await prisma.alipayOrder.findMany({
    where: { userId, tier: { startsWith: 'ra_' }, status: 'completed' },
    orderBy: { completedAt: 'desc' },
    take: 50,
  });
  for (const o of orders) {
    out.push({
      id: o.id,
      kind: 'alipay',
      date: (o.completedAt ?? o.createdAt).toISOString(),
      amountMinor: Math.round(o.amount * 100),
      currency: 'CNY',
      status: 'paid',
      description: `RoboApply ${o.tier.replace(/^ra_/, '')} (Alipay)`,
      downloadable: true,
    });
  }

  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { invoices: out };
}

/**
 * Resolve an invoice download. Stripe → a redirect URL to the hosted PDF.
 * Alipay → signals the route to stream a generated PDF receipt. Ownership is
 * verified here so a guessed id can't leak another user's invoice.
 */
export async function resolveInvoiceDownload(
  userId: string,
  invoiceId: string,
): Promise<{ kind: 'stripe'; url: string } | { kind: 'alipay'; orderId: string }> {
  const { subscription } = await loadSubscriptionForUser(userId);

  // Stripe invoice ids start with 'in_'.
  if (invoiceId.startsWith('in_')) {
    const stripe = getStripe();
    if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
    const inv = await stripe.invoices.retrieve(invoiceId);
    const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (!subscription?.stripeCustomerId || customerId !== subscription.stripeCustomerId) {
      throw new RoboApplyBillingError('forbidden', 'Invoice does not belong to you', 403);
    }
    const url = inv.invoice_pdf || inv.hosted_invoice_url;
    if (!url) throw new RoboApplyBillingError('no_pdf', 'No downloadable invoice available', 404);
    return { kind: 'stripe', url };
  }

  // Otherwise an AlipayOrder id.
  const order = await prisma.alipayOrder.findUnique({ where: { id: invoiceId } });
  if (!order || order.userId !== userId || !order.tier.startsWith('ra_')) {
    throw new RoboApplyBillingError('not_found', 'Invoice not found', 404);
  }
  return { kind: 'alipay', orderId: order.id };
}

export async function getAlipayOrderForReceipt(userId: string, orderId: string) {
  const order = await prisma.alipayOrder.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== userId || !order.tier.startsWith('ra_')) {
    throw new RoboApplyBillingError('not_found', 'Invoice not found', 404);
  }
  return order;
}

// ─── Webhook reconciliation (Stripe, shared endpoint) ─────────────────────────

async function syncMissionTier(userId: string, tier: string): Promise<void> {
  const card = await getRateCard();
  await prisma.roboApplyMission
    .update({ where: { userId }, data: { tier: tier as never, dailyCap: tierDailyCap(card, tier) } })
    .catch(() => {
      /* mission may not exist — non-fatal */
    });
}

const STRIPE_STATUS_MAP: Record<string, string> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'past_due',
  incomplete: 'past_due',
  incomplete_expired: 'canceled',
};

interface UpsertResult {
  handled: boolean;
  userId?: string;
  oldTier?: string;
  newTier?: MockPlanKey | 'free';
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/** Sync a Stripe subscription onto the SeekerSubscription row. `creditGrant`
 *  controls credit granting: 'always' (deliberate purchase), 'period'
 *  (renewal/update — only when the period rolled or tier changed), 'none'. */
async function upsertFromSubscription(
  sub: Stripe.Subscription,
  hints: { userId?: string; seekerProfileId?: string; tier?: MockPlanKey },
  creditGrant: 'always' | 'period' | 'none',
): Promise<UpsertResult> {
  const catalog = await getMockPlanCatalog();
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const tier = hints.tier ?? priceIdToMockPlanKey(catalog, priceId) ?? null;

  let row = await prisma.seekerSubscription.findFirst({
    where: { stripeSubscriptionId: sub.id },
    select: { id: true, seekerProfileId: true, tier: true },
  });
  if (!row && hints.seekerProfileId) {
    row = await prisma.seekerSubscription.findUnique({
      where: { seekerProfileId: hints.seekerProfileId },
      select: { id: true, seekerProfileId: true, tier: true },
    });
  }
  if (!row && typeof sub.customer === 'string') {
    row = await prisma.seekerSubscription.findFirst({
      where: { stripeCustomerId: sub.customer },
      select: { id: true, seekerProfileId: true, tier: true },
    });
  }
  if (!row) return { handled: false };

  const status = STRIPE_STATUS_MAP[sub.status] ?? 'active';
  const periodEnd = (sub as any).current_period_end ? new Date((sub as any).current_period_end * 1000) : null;
  const periodStart = (sub as any).current_period_start ? new Date((sub as any).current_period_start * 1000) : null;
  const amountMinor = typeof item?.price?.unit_amount === 'number' ? item.price.unit_amount : undefined;
  const resolvedTier: MockPlanKey | 'free' = status === 'canceled' ? 'free' : (tier ?? 'starter');
  const oldTier = String(row.tier);

  await prisma.seekerSubscription.update({
    where: { id: row.id },
    data: {
      tier: resolvedTier as never,
      status,
      market: 'other',
      currency: item?.price?.currency?.toUpperCase() ?? undefined,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : undefined,
      stripePriceId: priceId ?? undefined,
      amountMinor,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: status === 'canceled' ? new Date() : null,
      startedAt: (sub as any).start_date ? new Date((sub as any).start_date * 1000) : undefined,
    },
  });

  const profile = await prisma.seekerProfile.findUnique({ where: { id: row.seekerProfileId }, select: { userId: true } });
  const userId = profile?.userId;
  if (userId) {
    await syncMissionTier(userId, resolvedTier);
    // Credit grants for active paid subscriptions.
    if (creditGrant !== 'none' && status !== 'canceled' && isPaidMockPlan(resolvedTier)) {
      await grantForPlanIfNewPeriod({
        userId,
        tier: resolvedTier,
        periodStart,
        currentPeriodEnd: periodEnd,
        source: 'stripe',
        force: creditGrant === 'always' || oldTier !== resolvedTier,
      });
    }
  }

  logger.info('RA_BILLING', 'stripe subscription synced', { subId: sub.id, status, tier: resolvedTier, creditGrant });
  return { handled: true, userId, oldTier, newTier: resolvedTier, periodStart, periodEnd };
}

export async function handleRoboApplyStripeEvent(
  event: Stripe.Event,
  stripe: Stripe,
): Promise<{ handled: boolean }> {
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.product !== 'roboapply') return { handled: false };
        const subscriptionId = session.subscription as string | null;
        if (!subscriptionId) return { handled: true };
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await upsertFromSubscription(
          sub,
          {
            userId: session.metadata?.userId,
            seekerProfileId: session.metadata?.seekerProfileId,
            tier: session.metadata?.tier as MockPlanKey | undefined,
          },
          'always', // deliberate purchase → grant credits now
        );
        return { handled: true };
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const r = await upsertFromSubscription(
          sub,
          {
            seekerProfileId: (sub.metadata?.seekerProfileId as string) || undefined,
            tier: (sub.metadata?.tier as MockPlanKey) || undefined,
          },
          'period', // only grant on a true tier change / new period
        );
        return { handled: r.handled };
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const r = await upsertFromSubscription(
          sub,
          {
            seekerProfileId: (sub.metadata?.seekerProfileId as string) || undefined,
            tier: (sub.metadata?.tier as MockPlanKey) || undefined,
          },
          'none',
        );
        return { handled: r.handled };
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = (invoice as any).subscription as string | null;
        if (!subId) return { handled: false };
        const owned = await prisma.seekerSubscription.findFirst({ where: { stripeSubscriptionId: subId }, select: { id: true } });
        if (!owned) return { handled: false };
        // Renewal cycle → grant the new period's credits. The first invoice
        // (billing_reason 'subscription_create') is already covered by
        // checkout.session.completed, so we only act on the recurring cycle.
        if ((invoice as any).billing_reason === 'subscription_cycle') {
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertFromSubscription(sub, {}, 'period');
        }
        return { handled: true };
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = (invoice as any).subscription as string | null;
        if (!subId) return { handled: false };
        const row = await prisma.seekerSubscription.findFirst({ where: { stripeSubscriptionId: subId }, select: { id: true } });
        if (!row) return { handled: false };
        await prisma.seekerSubscription.update({ where: { id: row.id }, data: { status: 'past_due' } });
        logger.info('RA_BILLING', 'subscription marked past_due', { subId });
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error('RA_BILLING', 'webhook handling failed', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false };
  }
}
