// server/src/roboapply/services/RoboApplyBillingService.ts
//
// Seeker billing behind the legacy `/api/v1/roboapply/billing/*` routes and
// the Stripe webhook (TASK_PLAN.md WP-21a; PRODUCT_PLAN.md §6; ARCHITECTURE.md
// §7.4). Brand-aware since the Jobright clone:
//
//   • the brand picks the rail (`resolveRail`): RoboApply → Stripe (USD),
//     GoApply → Alipay first (CNY passes; the existing worker rail, kept as
//     it is, D6), WeChat Pay as the optional second rail. No `?region=`.
//     GoApply plans are on sale by default at their catalog prices; the
//     Alipay rail opens with ALIPAY_CALLBACK_SECRET alone and
//     CN_PAYMENTS_ENABLED=false is the kill switch (D5).
//   • plans are the R-08 catalog (`platform/billing/planCatalog.ts`): Pro
//     weekly/monthly/quarterly subscriptions, the 7-day pass and practice
//     packs as one-time payments. Legacy `starter`/`growth` are no longer
//     sold; existing subscribers keep them ("Practice plan (legacy)") and can
//     switch with a quote first (`quoteSwitch` → `confirmSwitch`).
//   • checkout refuses an auto-renewing plan without the unticked
//     acknowledgement and records it (`auto_renew_ack`, plus
//     `withdrawal_waiver` when ticked) before the payment page opens.
//   • a RoboApply plan needs no price variable: the Stripe rail resolves the
//     price at checkout through the catalog sync (stripeCatalog.ts; a pin
//     from the environment, else the price found or created under the plan's
//     lookup key), and the webhook recognises such a price by the plan key
//     stamped on it or by its lookup key (`planKeyForPrice`).
//   • one checkout attempt is one Stripe idempotency key: the web's
//     `Idempotency-Key` header reaches the rail as `attemptKey`.
//   • event types this file does not handle itself are offered to the
//     registry in platform/billing/stripeEvents.ts (refunds, disputes and the
//     later lifecycle events register there).
//   • Stripe objects carry `brand` + `planKey` metadata; the webhook is
//     replay-safe (one claim per checkout session / failed invoice / paid
//     switch invoice, period guards on credit grants). Renewal credits are
//     granted only from `invoice.paid`, never from `subscription.updated`
//     (Stripe advances the period before it collects) and never while past_due.
//   • a plan switch needs the auto-renewal acknowledgement for the new terms,
//     recorded before Stripe charges.
//   • CN orders are fulfilled through `fulfilPass()`.
//   • V2 (WP-79): student plans are sold only while the `student` capability
//     is on and only to an account with a live school-email verification
//     (`studentService.isVerified`), on both brands (GoApply: 学生月卡 /
//     学生季卡 passes; one rule, platform/billing/studentPlans.ts); a Taiwan
//     buyer (edge country TW) is
//     charged the plan's Stripe TWD price when one is configured, and the
//     webhook stores that currency and amount.
//   • the recorded auto-renewal acknowledgement names the price that is
//     charged (the TWD amount for a Taiwan buyer on a TWD price).
//   • a WeChat Pay order created here holds the same agreement gate as
//     features/billing-cn (`acknowledgeTerms`): the ticked 用户协议 version
//     must be the published one, and the consent record is written first.
//   • a new Alipay order is counted against the same per-user limit as a
//     WeChat Pay order (`billingCnCreate`: 10 a minute, 60 a day, both CN
//     rails together): each one is a database row plus a call to the payment
//     worker, and GoApply's Alipay rail is open by default. The check sits in
//     FRONT of the rail (the frozen request and callback path is untouched)
//     and fails open: a limiter that cannot answer never blocks a payment.
//
// Revenue state lives on SeekerSubscription (keyed by seekerProfileId);
// practice credits stay in lib/mockCreditService.ts.

import type Stripe from 'stripe';
import prisma, { type ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { getMockPlanCatalog, priceIdToMockPlanKey, isPaidMockPlan, type MockPlanKey } from '../../lib/mockInterviewPlans.js';
import { getBalance as defaultGetBalance, grantForPlanIfNewPeriod as defaultGrantIfNewPeriod, type GrantTier } from '../../lib/mockCreditService.js';
import { billingRegionForBrand, type BillingRegion } from '../../lib/billingRegion.js';
import { tierDailyCap, getRateCard } from '../../lib/rateCard.js';
import { getBrand, parseBrandId, type BrandId, type PaymentRail, type ProductBrand } from '../../platform/brand/registry.js';
import {
  BillingError,
  availableRails,
  buildPlanViews,
  cancelSubscription,
  closePendingOrder,
  confirmSwitch,
  describePlan,
  fulfilPass,
  getPlan as getCatalogPlan,
  getRegisteredRail,
  getStripe as platformGetStripe,
  grantPracticePack,
  isPlanKey,
  isStudentPlan,
  loadBillingAccount,
  claimBillingEvent,
  invoiceSubscriptionId,
  parseStripeLookupKey,
  planDefinitionFor,
  planKeyForPrice,
  quoteSwitch,
  railAvailable,
  recordCheckoutAcknowledgements,
  resolveRail,
  safeReturnPath,
  stripePeriod,
  studentVerifiedForPlan,
  usesTwdPrice,
  CallbackRejectedError,
  alipayCallbackSecretOk as platformAlipaySecretOk,
  appOrigin,
  type BillingAccount,
  type CallbackInput,
  type CancelOutcome,
  type CatalogPlan,
  type CheckoutOrder,
  type PlanStatus,
  type PlanView,
  type StripeEventResult,
  type SwitchQuote,
  stripeEventHandler,
} from '../../platform/billing/index.js';
import { sendEmail as platformSendEmail } from '../../platform/email/index.js';
import '../../platform/email/templates/billing/index.js';
import { entitlementService } from '../../platform/credits/index.js';
import { isEnabled } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { consumeRateLimit as platformConsumeRateLimit, rateLimitKey, rateLimitWindows, type RateWindow } from '../../platform/ratelimit/index.js';
import type { CheckoutResponse } from '../../features/credits/contract.js';

// ── Dependencies (tests replace them) ─────────────────────────────────────

export type BillingServiceDb = Pick<
  ExtendedPrismaClient,
  '$transaction' | 'user' | 'seekerProfile' | 'seekerSubscription' | 'alipayOrder' | 'rACreditLedger' | 'seekerConsentRecord' | 'roboApplyMission'
>;

export interface BillingServiceDeps {
  db: BillingServiceDb;
  getStripe: () => Stripe | null;
  now: () => Date;
  grantIfNewPeriod: typeof defaultGrantIfNewPeriod;
  grantPack: (input: { userId: string; credits: number; idempotencyKey: string; purchasedAt: Date }) => Promise<unknown>;
  getBalance: typeof defaultGetBalance;
  sendEmail: typeof platformSendEmail;
  invalidate: (userId: string) => void;
  /** The `student` capability for this user on this brand (student plans are V2, off by default). */
  studentEnabled: (userId: string, brand: ProductBrand) => Promise<boolean>;
  /** A live school-email verification (features/account-v2 `studentService.isVerified`). */
  isStudentVerified: (userId: string) => Promise<boolean>;
  /**
   * The WeChat Pay agreement gate (features/billing-cn `billingCnService.acknowledgeTerms`):
   * per-user limit, "ticked the published 用户协议", then the consent record.
   */
  acknowledgeCnPayTerms: (input: CnPayTermsInput) => Promise<void>;
  /** Counts one hit against a rate limit (platform/ratelimit `consumeRateLimit`). */
  consumeRateLimit: (key: string, windows: readonly RateWindow[]) => Promise<{ allowed: boolean; retryAfterSec: number }>;
}

export interface CnPayTermsInput {
  userId: string;
  brand: ProductBrand;
  seekerProfileId: string;
  plan: Pick<CatalogPlan, 'key' | 'amountMinor'>;
  termsVersion: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

function defaultDeps(): BillingServiceDeps {
  return {
    db: prisma,
    getStripe: () => platformGetStripe(),
    now: () => new Date(),
    grantIfNewPeriod: defaultGrantIfNewPeriod,
    grantPack: (input) => grantPracticePack(input),
    getBalance: defaultGetBalance,
    sendEmail: platformSendEmail,
    invalidate: (userId) => entitlementService.invalidate(userId),
    studentEnabled: (userId, brand) => isEnabled('student', { userId, brand }),
    isStudentVerified: async (userId) => {
      const { studentService } = await import('../../features/account-v2/index.js');
      return studentService.isVerified(userId);
    },
    acknowledgeCnPayTerms: async (input) => {
      // Loaded on first use: the service module registers nothing on import.
      const { billingCnService } = await import('../../features/billing-cn/service.js');
      await billingCnService.acknowledgeTerms(
        input.userId,
        input.brand,
        { seekerProfileId: input.seekerProfileId, plan: input.plan, termsVersion: input.termsVersion },
        { ip: input.ip ?? null, userAgent: input.userAgent ?? null },
      );
    },
    consumeRateLimit: (key, windows) => platformConsumeRateLimit({ key, windows }),
  };
}

let deps: BillingServiceDeps = defaultDeps();

/** Tests only: override some dependencies (call with no argument to restore). */
export function setBillingServiceDepsForTests(partial?: Partial<BillingServiceDeps>): void {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
}

// ── Compatibility exports (routes/stripeWebhook.ts, routes/billing.ts) ───

export function getStripe(): Stripe | null {
  return deps.getStripe();
}

/** Same-origin relative return path, or undefined. */
export function safeNextPath(raw: unknown): string | undefined {
  return safeReturnPath(raw);
}

/** Constant-time check of the Alipay worker's echoed callback secret (false when ALIPAY_CALLBACK_SECRET is unset). */
export function alipayCallbackSecretOk(token: string | undefined): boolean {
  return platformAlipaySecretOk(token);
}

export class RoboApplyBillingError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fromBillingError(err: unknown): never {
  if (err instanceof BillingError) throw new RoboApplyBillingError(err.code, err.message, err.status, err.details);
  throw err;
}

/**
 * Hold the WeChat Pay agreement gate and answer its refusals in this route's
 * envelope: 409 `terms_outdated` (missing or stale version; `details.currentVersion`)
 * and 429 `rate_limited` keep their codes instead of becoming a 500.
 */
async function holdCnPayTermsGate(input: CnPayTermsInput): Promise<void> {
  try {
    await deps.acknowledgeCnPayTerms(input);
  } catch (err) {
    if (err instanceof HttpError) {
      const details = err.details && typeof err.details === 'object' && !Array.isArray(err.details) ? (err.details as Record<string, unknown>) : undefined;
      throw new RoboApplyBillingError(err.code, err.message, err.status, details);
    }
    // BillingCnError, matched by shape so this module does not load billing-cn up front.
    const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; details?: unknown };
    if (e && e.name === 'BillingCnError' && typeof e.code === 'string' && typeof e.status === 'number') {
      throw new RoboApplyBillingError(e.code, String(e.message ?? ''), e.status, e.details as Record<string, unknown> | undefined);
    }
    throw err;
  }
}

/**
 * Abuse guard for a new Alipay order: the per-user limit WeChat Pay orders
 * already have (`billingCnCreate`, one budget for both CN rails). Refused
 * with 429 `rate_limited` and `details.retryAfterSec` before anything is
 * recorded or sent. Fails open: when the limiter itself cannot answer, the
 * payment goes ahead (the existing Alipay path must keep working, D6).
 */
async function holdCnOrderRateLimit(userId: string, brand: ProductBrand): Promise<void> {
  let result: { allowed: boolean; retryAfterSec: number };
  try {
    result = await deps.consumeRateLimit(rateLimitKey('billingCnCreate', 'user', userId, brand.id), rateLimitWindows('billingCnCreate'));
  } catch (err) {
    logger.warn('RA_BILLING', 'order rate limit check failed; allowing', { userId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!result.allowed) {
    throw new RoboApplyBillingError('rate_limited', 'Too many payment attempts. Try again later.', 429, { retryAfterSec: result.retryAfterSec });
  }
}

async function requireAccount(userId: string): Promise<BillingAccount> {
  const account = await loadBillingAccount(deps.db, userId);
  if (!account) throw new RoboApplyBillingError('no_profile', 'No account', 404);
  return account;
}

// ── Read: current plan + credits + catalog ───────────────────────────────

export interface RoboApplyPlanView {
  brand: BrandId;
  /** The brand's currency and primary rail (no longer chosen by region signals). */
  region: BillingRegion;
  current: {
    tier: string;
    status: string;
    amountMinor: number | null;
    currency: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    hasStripeCustomer: boolean;
    /** A pass that ends unless bought again (CN passes, old intl Alipay passes). */
    manualRenewal: boolean;
    planKey: string;
    state: PlanStatus['state'];
    /** Grandfathered starter/growth ("Practice plan (legacy)"). */
    legacyPlan: boolean;
    autoRenews: boolean;
    /** Stripe is retrying a failed charge (show the payment-failed banner). */
    paymentFailed: boolean;
    rail: string | null;
  };
  credits: { balance: number; periodAllotment: number | null; tier: string };
  /** Legacy practice-plan rows (shape kept for old clients). Never purchasable now. */
  plans: Array<{ key: MockPlanKey; credits: number; usdMinor: number; cnyMinor: number; current: boolean; purchasable: false }>;
  /** The R-08 catalog for this brand. */
  catalog: PlanView[];
  defaultSelection: string | null;
  rails: PaymentRail[];
  stripeConfigured: boolean;
  alipayConfigured: boolean;
}

export async function getPlan(userId: string, opts: { brand: ProductBrand }): Promise<RoboApplyPlanView> {
  const account = await requireAccount(userId);
  const now = deps.now();
  const status = describePlan(account, now);
  const sub = account.subscription;
  const mock = await getMockPlanCatalog();
  const balance = await deps.getBalance(userId);
  const tier = sub?.tier ?? 'free';
  const legacyPlans = (['free', 'starter', 'growth'] as MockPlanKey[]).map((k) => ({
    key: k,
    credits: mock.plans[k].credits,
    usdMinor: mock.plans[k].usdMinor,
    cnyMinor: mock.plans[k].cnyMinor,
    current: tier === k,
    purchasable: false as const,
  }));
  const views = buildPlanViews(opts.brand.id, { currentPlanKey: status.live ? status.planKey : 'free' });
  return {
    brand: opts.brand.id,
    region: billingRegionForBrand(opts.brand),
    current: {
      tier,
      status: sub?.status ?? 'active',
      amountMinor: sub?.amountMinor ?? null,
      currency: sub?.currency ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      hasStripeCustomer: Boolean(sub?.stripeCustomerId),
      manualRenewal: status.live && (status.state === 'pass' || status.state === 'legacy_pass'),
      planKey: status.planKey,
      state: status.state,
      legacyPlan: status.state === 'legacy_subscription' || status.state === 'legacy_pass',
      autoRenews: status.autoRenews,
      paymentFailed: status.paymentFailed,
      rail: sub?.rail ?? (sub?.stripeSubscriptionId ? 'stripe' : null),
    },
    credits: { balance: balance.credits, periodAllotment: balance.periodAllotment, tier: balance.tier },
    plans: legacyPlans,
    catalog: views.plans,
    defaultSelection: views.defaultSelection,
    rails: availableRails(opts.brand),
    stripeConfigured: railAvailable(opts.brand, 'stripe'),
    alipayConfigured: railAvailable(opts.brand, 'alipay'),
  };
}

// ── Checkout (any rail) ──────────────────────────────────────────────────

export interface CheckoutInput {
  userId: string;
  brand: ProductBrand;
  planKey: string;
  autoRenewAck?: boolean;
  withdrawalWaiver?: boolean;
  rail?: PaymentRail | null;
  successPath?: string;
  cancelPath?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Buyer's country from the edge header; 'TW' charges the plan's Taiwan price when one is configured. */
  country?: string | null;
  context?: CheckoutOrder['context'];
  /** The web's per-attempt key (`Idempotency-Key` header), already validated by the route; the Stripe rail keys the session on it. */
  attemptKey?: string | null;
  /** The buyer's app locale (`X-Robo-Locale`); the Stripe payment page opens in it. */
  locale?: string | null;
}

/** What POST /billing/checkout answers: the shared contract type (features/credits/contract.ts). */
export type CheckoutView = CheckoutResponse;

/**
 * A student plan may be bought only while the capability is on and the buyer
 * holds a live verification. Returns that verification for the rail, or
 * `undefined` for every other plan. Fails closed: a verification lookup that
 * errors counts as "not verified".
 */
async function studentVerifiedFor(userId: string, brand: ProductBrand, plan: Pick<PlanView, 'key' | 'requiresFlag'>): Promise<boolean | undefined> {
  // One rule for every rail and route (platform/billing/studentPlans.ts).
  return studentVerifiedForPlan(userId, brand, plan, deps);
}

export async function createCheckout(input: CheckoutInput): Promise<CheckoutView> {
  try {
    if (!isPlanKey(input.planKey)) {
      throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey });
    }
    const plan = getCatalogPlan(input.brand.id, input.planKey);
    // V2 plans stay off the shelf, except the student plans (their own gate below).
    if (!plan || !plan.sellable || plan.kind === 'free' || (plan.phase !== 'mvp' && !isStudentPlan(plan))) {
      throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey, reason: plan?.unsellableReason ?? 'unknown' });
    }
    if (plan.requiresAutoRenewAck && input.autoRenewAck !== true) {
      throw new BillingError('auto_renew_ack_required', 'Tick the box to agree that this plan renews automatically');
    }
    const rail = resolveRail(input.brand, input.rail ?? null);
    const account = await requireAccount(input.userId);
    if (!account.seekerProfileId) throw new BillingError('no_profile', 'No seeker profile');

    const status = describePlan(account, deps.now());
    if (plan.kind === 'pass' && status.live && status.autoRenews) {
      // Cancel first; the pass then starts when the paid period ends.
      throw new BillingError('already_subscribed', 'You already have a plan that renews. Cancel it first, then buy the pass.', {
        planKey: status.planKey,
      });
    }
    if (plan.kind === 'subscription' && status.live) {
      // Two live plans would double-charge the overlap.
      if (status.state === 'pass' || status.state === 'legacy_pass') {
        // A pass has no subscription to switch; it simply ends. Say when.
        const until = status.accessUntil?.toISOString() ?? null;
        throw new BillingError('pass_active', until ? `Your pass runs until ${until.slice(0, 10)}. You can subscribe once it ends.` : 'Your pass is still running. You can subscribe once it ends.', {
          planKey: status.planKey,
          availableFrom: until,
        });
      }
      throw new BillingError('already_subscribed', 'You already have a plan. Switch plans, or subscribe when it ends.', {
        planKey: status.planKey,
        accessUntil: status.accessUntil?.toISOString() ?? null,
      });
    }

    // Before anything is recorded: an unverified buyer leaves no acknowledgement behind.
    const studentVerified = await studentVerifiedFor(input.userId, input.brand, plan);

    // A WeChat Pay order needs the published 用户协议 ticked, whichever route
    // creates it: refused here before any record or order exists.
    if (rail.id === 'wechatpay') {
      await holdCnPayTermsGate({
        userId: input.userId,
        brand: input.brand,
        seekerProfileId: account.seekerProfileId,
        plan,
        termsVersion: input.context?.termsVersion ?? null,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    } else if (rail.id === 'alipay') {
      // The same per-user order limit (the WeChat Pay gate above counts its
      // own hit): refused here before any record or order exists.
      await holdCnOrderRateLimit(input.userId, input.brand);
    }

    // The acknowledgement names the price that is charged: a Taiwan buyer on a
    // TWD price ticked (and pays) the TWD amount, not the catalog USD one.
    const ackPlan = usesTwdPrice(plan, input.country) ? { ...plan, amountMinor: plan.twdPrice!.amountMinor, currency: plan.twdPrice!.currency } : plan;
    await recordCheckoutAcknowledgements(deps.db, {
      seekerProfileId: account.seekerProfileId,
      plan: ackPlan,
      autoRenewAck: input.autoRenewAck === true,
      withdrawalWaiver: input.withdrawalWaiver === true,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    const result = await rail.createCheckout({
      brand: input.brand,
      plan,
      user: { id: account.userId, email: account.email, name: account.name },
      seekerProfileId: account.seekerProfileId,
      stripeCustomerId: account.subscription?.stripeCustomerId ?? null,
      acknowledgements: { autoRenewAck: input.autoRenewAck === true, withdrawalWaiver: input.withdrawalWaiver === true },
      successPath: input.successPath,
      cancelPath: input.cancelPath,
      context: input.context,
      country: input.country ?? null,
      ...(studentVerified !== undefined ? { studentVerified } : {}),
      attemptKey: input.attemptKey ?? null,
      locale: input.locale ?? null,
    });
    logger.info('RA_BILLING', 'checkout created', { userId: input.userId, planKey: plan.key, rail: rail.id, brand: input.brand.id });
    return { ...result, rail: rail.id };
  } catch (err) {
    return fromBillingError(err);
  }
}

// ── Portal, cancel, switch ───────────────────────────────────────────────

export async function createPortalSession(userId: string, brand: ProductBrand): Promise<{ url: string }> {
  const stripe = deps.getStripe();
  if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
  const account = await requireAccount(userId);
  const customer = account.subscription?.stripeCustomerId;
  if (!customer) throw new RoboApplyBillingError('no_customer', 'No billing account yet — subscribe first', 409);
  const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${appOrigin(brand)}/settings/billing` });
  return { url: portal.url };
}

/** One-click cancel (sends the confirmation email when auto-renewal was turned off). */
export async function cancelPlan(
  userId: string,
  input: { reason?: string; note?: string; source: 'in_app' | 'public_link' | 'legacy_route' },
): Promise<CancelOutcome & { account: BillingAccount }> {
  const account = await requireAccount(userId);
  let outcome: CancelOutcome;
  try {
    outcome = await cancelSubscription(account, input, { getStripe: deps.getStripe, db: deps.db, now: deps.now });
  } catch (err) {
    return fromBillingError(err);
  }
  deps.invalidate(userId);
  if (outcome.changed) await sendCancelConfirmation(account, outcome);
  return { ...outcome, account };
}

export async function sendCancelConfirmation(account: BillingAccount, outcome: CancelOutcome): Promise<void> {
  try {
    await deps.sendEmail({
      template: 'billing.cancel_confirmed',
      to: account.email,
      userId: account.userId,
      locale: account.locale,
      brand: account.brand,
      params: {
        planKey: outcome.planKey,
        cancelledAt: deps.now().toISOString(),
        accessUntil: outcome.accessUntil ? outcome.accessUntil.toISOString() : null,
      },
    });
  } catch (err) {
    logger.warn('RA_BILLING', 'cancel confirmation email failed', { userId: account.userId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Legacy route: `{ ok: true }` after turning auto-renewal off. */
export async function cancelAtPeriodEnd(userId: string): Promise<{ ok: true; status: CancelOutcome['status']; accessUntil: string | null }> {
  const res = await cancelPlan(userId, { source: 'legacy_route' });
  return { ok: true, status: res.status, accessUntil: res.accessUntil?.toISOString() ?? null };
}

export interface SwitchInput {
  planKey: string;
  confirm?: boolean;
  prorationDate?: number;
  /** Required on confirm for an auto-renewing target (the unticked box on the quote sheet). */
  autoRenewAck?: boolean;
  withdrawalWaiver?: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

export async function switchPlan(
  userId: string,
  brand: ProductBrand,
  input: SwitchInput,
): Promise<{ quote: SwitchQuote } | { switched: true; planKey: string }> {
  const account = await requireAccount(userId);
  try {
    if (!isPlanKey(input.planKey)) throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey });
    if (account.brand !== brand.id) throw new BillingError('switch_not_available', 'Switch plans on the site you signed up on');
    const target = getCatalogPlan(brand.id, input.planKey);
    if (!target) throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey });
    // A switch TO a student plan needs the same capability and verification as buying one.
    const studentVerified = await studentVerifiedFor(userId, brand, target);
    const stripeDeps = { getStripe: deps.getStripe, db: deps.db, now: deps.now, ...(studentVerified !== undefined ? { studentVerified } : {}) };
    if (!input.confirm) return { quote: await quoteSwitch(account, target, stripeDeps) };
    if (input.prorationDate === undefined) throw new BillingError('quote_expired', 'Review the quote first');
    const seekerProfileId = account.seekerProfileId;
    if (!seekerProfileId) throw new BillingError('no_profile', 'No seeker profile');
    const res = await confirmSwitch(account, target, input.prorationDate, stripeDeps, {
      autoRenewAck: input.autoRenewAck === true,
      record: (charged) =>
        recordCheckoutAcknowledgements(deps.db, {
          seekerProfileId,
          plan: { ...target, amountMinor: charged.amountMinor, currency: charged.currency },
          autoRenewAck: input.autoRenewAck === true,
          withdrawalWaiver: input.withdrawalWaiver === true,
          ip: input.ip,
          userAgent: input.userAgent,
        }),
    });
    deps.invalidate(userId);
    return { switched: true, planKey: res.planKey };
  } catch (err) {
    return fromBillingError(err);
  }
}

// ── CN rails: callback → fulfilPass ──────────────────────────────────────

/** Alipay worker notify (own notify_url). Idempotent. */
export async function handleAlipayCallback(input: CallbackInput): Promise<{ ok: boolean; httpStatus: number; code: number; message: string }> {
  const rail = getRegisteredRail('alipay');
  if (!rail?.verifyCallback) return { ok: false, httpStatus: 503, code: 50003, message: 'alipay rail unavailable' };
  let verified;
  try {
    verified = await rail.verifyCallback(input);
  } catch (err) {
    if (err instanceof CallbackRejectedError) {
      if (err.reason === 'not_configured') return { ok: false, httpStatus: 503, code: 50003, message: 'callback verification unavailable' };
      if (err.reason === 'bad_secret') return { ok: false, httpStatus: 403, code: 40003, message: 'forbidden' };
      return { ok: false, httpStatus: 400, code: 40001, message: 'invalid callback params' };
    }
    throw err;
  }
  if (verified.status === 'paid') {
    const res = await fulfilPass({ outTradeNo: verified.outTradeNo, channel: 'alipay', paidAmountMinor: verified.paidAmountMinor, transactionId: verified.transactionId });
    if (res.status === 'not_found') return { ok: false, httpStatus: 400, code: 40002, message: 'order not found' };
    if (res.status === 'amount_mismatch') return { ok: false, httpStatus: 400, code: 40004, message: 'amount mismatch' };
    if (res.status === 'unknown_plan') return { ok: false, httpStatus: 400, code: 40005, message: 'unknown plan' };
    if (res.status === 'fulfilled' && res.userId && res.planKey && isPaidMockPlan(res.planKey)) {
      await syncMissionTier(res.userId, res.planKey).catch(() => {});
    }
    return { ok: true, httpStatus: 200, code: 0, message: 'success' };
  }
  if (verified.status === 'closed') {
    await closePendingOrder(verified.outTradeNo);
    return { ok: true, httpStatus: 200, code: 0, message: 'closed' };
  }
  return { ok: true, httpStatus: 200, code: 0, message: 'no action' };
}

// ── Billing history + invoice download ───────────────────────────────────

export interface BillingInvoice {
  id: string;
  kind: 'stripe' | 'alipay';
  date: string;
  amountMinor: number;
  currency: string;
  status: string;
  description: string;
  downloadable: boolean;
}

function orderPlanLabel(order: { planKey: string | null; tier: string; brand: string | null }): string {
  const key = order.planKey ?? order.tier.replace(/^ra_/, '');
  if (key === 'starter' || key === 'growth') return 'Practice plan (legacy)';
  const brand = parseBrandId(order.brand) ?? 'roboapply';
  return planDefinitionFor(brand, key)?.defaultLabel ?? key;
}

export async function getBillingHistory(userId: string): Promise<{ invoices: BillingInvoice[] }> {
  const account = await requireAccount(userId);
  const out: BillingInvoice[] = [];
  const brandName = getBrand(account.brand).name;
  const stripe = deps.getStripe();
  const customer = account.subscription?.stripeCustomerId;
  if (stripe && customer) {
    try {
      const list = await stripe.invoices.list({ customer, limit: 50 });
      for (const inv of list.data) {
        out.push({
          id: inv.id as string,
          kind: 'stripe',
          date: new Date((inv.created ?? 0) * 1000).toISOString(),
          amountMinor: inv.amount_paid ?? inv.amount_due ?? 0,
          currency: (inv.currency ?? 'usd').toUpperCase(),
          status: inv.status ?? 'open',
          description: inv.lines?.data?.[0]?.description ?? `${brandName} subscription`,
          downloadable: Boolean(inv.invoice_pdf || inv.hosted_invoice_url),
        });
      }
    } catch (err) {
      logger.warn('RA_BILLING', 'stripe invoice list failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const orders = await deps.db.alipayOrder.findMany({
    where: { userId, tier: { startsWith: 'ra_' }, status: 'completed' },
    orderBy: { completedAt: 'desc' },
    take: 50,
  });
  for (const o of orders) {
    const orderBrand = getBrand(parseBrandId(o.brand) ?? 'roboapply').name;
    out.push({
      id: o.id,
      kind: 'alipay',
      date: (o.completedAt ?? o.createdAt).toISOString(),
      amountMinor: o.amountMinor ?? Math.round(o.amount * 100),
      currency: 'CNY',
      status: 'paid',
      description: `${orderBrand} ${orderPlanLabel(o)} (${o.channel === 'wechatpay' ? 'WeChat Pay' : 'Alipay'})`,
      downloadable: true,
    });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { invoices: out };
}

export async function resolveInvoiceDownload(
  userId: string,
  invoiceId: string,
): Promise<{ kind: 'stripe'; url: string } | { kind: 'alipay'; orderId: string }> {
  const account = await requireAccount(userId);
  if (invoiceId.startsWith('in_')) {
    const stripe = deps.getStripe();
    if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
    const inv = await stripe.invoices.retrieve(invoiceId);
    const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (!account.subscription?.stripeCustomerId || customerId !== account.subscription.stripeCustomerId) {
      throw new RoboApplyBillingError('forbidden', 'Invoice does not belong to you', 403);
    }
    const url = inv.invoice_pdf || inv.hosted_invoice_url;
    if (!url) throw new RoboApplyBillingError('no_pdf', 'No downloadable invoice available', 404);
    return { kind: 'stripe', url };
  }
  const order = await deps.db.alipayOrder.findUnique({ where: { id: invoiceId } });
  if (!order || order.userId !== userId || !order.tier.startsWith('ra_')) {
    throw new RoboApplyBillingError('not_found', 'Invoice not found', 404);
  }
  return { kind: 'alipay', orderId: order.id };
}

export interface ReceiptOrder {
  id: string;
  outTradeNo: string;
  brand: BrandId;
  planLabel: string;
  amountMinor: number;
  channel: string;
  paidAt: Date;
}

export async function getAlipayOrderForReceipt(userId: string, orderId: string): Promise<ReceiptOrder> {
  const order = await deps.db.alipayOrder.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== userId || !order.tier.startsWith('ra_')) {
    throw new RoboApplyBillingError('not_found', 'Invoice not found', 404);
  }
  return {
    id: order.id,
    outTradeNo: order.outTradeNo,
    brand: parseBrandId(order.brand) ?? 'roboapply',
    planLabel: orderPlanLabel(order),
    amountMinor: order.amountMinor ?? Math.round(order.amount * 100),
    channel: order.channel ?? 'alipay',
    paidAt: order.completedAt ?? order.createdAt,
  };
}

// ── Stripe webhook ───────────────────────────────────────────────────────

async function syncMissionTier(userId: string, tier: string): Promise<void> {
  const card = await getRateCard();
  await deps.db.roboApplyMission
    .update({ where: { userId }, data: { tier: tier as never, dailyCap: tierDailyCap(card, tier) } })
    .catch(() => {
      /* mission may not exist — non-fatal */
    });
}

/** Stripe status → SeekerSubscription.status. past_due keeps Pro while Stripe retries; unpaid/incomplete do not. */
export const STRIPE_STATUS_MAP: Record<string, string> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'paused',
};

/**
 * One-time claim for a webhook side effect (a checkout session, a failed
 * invoice): the shared claim of platform/billing/stripeEvents.ts, on this
 * service's clock.
 */
function claimOnce(db: Pick<ExtendedPrismaClient, 'rACreditLedger'>, userId: string, key: string, refType: string): Promise<boolean> {
  return claimBillingEvent(db, userId, key, refType, deps.now());
}

interface SubHints {
  seekerProfileId?: string;
  planKey?: string;
  fromCheckout?: boolean;
  billingCountry?: string | null;
}

interface UpsertResult {
  handled: boolean;
  userId?: string;
  planKey?: string;
  tier?: string;
}

function resolvePlanFromStripe(sub: Stripe.Subscription, hints: SubHints, legacyCatalog: Awaited<ReturnType<typeof getMockPlanCatalog>>) {
  const price = sub.items?.data?.[0]?.price ?? null;
  const priceId = price?.id ?? null;
  const metaKey = (sub.metadata?.planKey as string | undefined) ?? hints.planKey;
  // Metadata first, then the price itself: the plan key stamped on a synced
  // price, its lookup key, or a pinned id (so a price the catalog sync
  // created is recognised on an instance that never resolved it).
  const planKey = (isPlanKey(metaKey) ? metaKey : null) ?? planKeyForPrice(price);
  if (planKey) return { planKey, tier: 'pro' as GrantTier, legacy: false, priceId };
  const legacy: MockPlanKey = priceIdToMockPlanKey(legacyCatalog, priceId) ?? (sub.metadata?.tier === 'growth' ? 'growth' : 'starter');
  return { planKey: legacy as string, tier: legacy as GrantTier, legacy: true, priceId };
}

async function upsertFromSubscription(sub: Stripe.Subscription, hints: SubHints, creditGrant: 'always' | 'period' | 'none'): Promise<UpsertResult> {
  const db = deps.db;
  const select = { id: true, seekerProfileId: true, tier: true, stripeSubscriptionId: true } as const;
  let row = await db.seekerSubscription.findFirst({ where: { stripeSubscriptionId: sub.id }, select });
  if (!row && hints.fromCheckout) {
    if (hints.seekerProfileId) row = await db.seekerSubscription.findUnique({ where: { seekerProfileId: hints.seekerProfileId }, select });
    if (!row && typeof sub.customer === 'string') row = await db.seekerSubscription.findFirst({ where: { stripeCustomerId: sub.customer }, select });
  }
  if (!row) return { handled: false };

  const legacyCatalog = await getMockPlanCatalog();
  const plan = resolvePlanFromStripe(sub, hints, legacyCatalog);
  const status = STRIPE_STATUS_MAP[sub.status] ?? 'active';
  const ended = status === 'canceled';
  const { start, end } = stripePeriod(sub);
  const item = sub.items?.data?.[0];
  const def = plan.legacy ? null : planDefinitionFor('roboapply', plan.planKey);
  const tier = ended ? 'free' : plan.tier;
  // What is actually charged. A Taiwan subscription runs on the plan's TWD
  // price: Stripe says so on the price (currency and unit amount). When a
  // thin event leaves those fields out, the price's lookup key answers (a
  // synced price carries currency and amount in it), and for a pinned TWD
  // price the configured id does.
  const twd = plan.legacy || !isPlanKey(plan.planKey) ? null : (getCatalogPlan('roboapply', plan.planKey)?.twdPrice ?? null);
  const fromLookupKey = parseStripeLookupKey(item?.price?.lookup_key);
  const onPinnedTwdPrice = Boolean(twd?.stripePriceId && plan.priceId && twd.stripePriceId === plan.priceId);
  const chargedCurrency = item?.price?.currency?.toUpperCase() ?? fromLookupKey?.currency ?? (onPinnedTwdPrice ? 'TWD' : undefined);
  const chargedAmountMinor =
    typeof item?.price?.unit_amount === 'number' ? item.price.unit_amount : (fromLookupKey?.amountMinor ?? (onPinnedTwdPrice ? twd!.amountMinor : undefined));

  await db.seekerSubscription.update({
    where: { id: row.id },
    data: {
      tier: tier as never,
      status,
      brand: 'roboapply',
      rail: 'stripe',
      planKey: ended ? 'free' : plan.planKey,
      interval: ended ? null : (def?.interval ?? 'month'),
      market: 'other',
      currency: chargedCurrency,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : undefined,
      stripePriceId: plan.priceId ?? undefined,
      amountMinor: chargedAmountMinor,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: ended ? deps.now() : null,
      ...(sub.start_date ? { startedAt: new Date(sub.start_date * 1000) } : {}),
      ...(hints.billingCountry ? { billingCountry: hints.billingCountry.toUpperCase() } : {}),
    },
  });

  const profile = await db.seekerProfile.findUnique({ where: { id: row.seekerProfileId }, select: { userId: true } });
  const userId = profile?.userId;
  if (userId) {
    if (plan.legacy || ended) await syncMissionTier(userId, tier).catch(() => {});
    // Credits only for a paid-up period. past_due keeps Pro features on while
    // Stripe retries, but the new period's practice minutes wait for payment.
    const paidUp = status === 'active' || status === 'trialing';
    if (creditGrant !== 'none' && paidUp && !ended) {
      await deps.grantIfNewPeriod({
        userId,
        tier: plan.tier,
        credits: plan.legacy ? undefined : (def?.practice?.credits ?? 0),
        periodStart: start,
        currentPeriodEnd: end,
        source: 'stripe',
        force: creditGrant === 'always' || String(row.tier) !== String(plan.tier),
        metadata: { planKey: plan.planKey, stripeSubscriptionId: sub.id },
      });
    }
    deps.invalidate(userId);
  }
  logger.info('RA_BILLING', 'stripe subscription synced', { subId: sub.id, status, planKey: plan.planKey, creditGrant });
  return { handled: true, userId, planKey: plan.planKey, tier };
}

/** A one-time payment (7-day pass or practice pack) from Stripe Checkout. */
async function fulfilStripePayment(session: Stripe.Checkout.Session): Promise<{ handled: boolean; duplicate?: boolean }> {
  const meta = session.metadata ?? {};
  const planKey = meta.planKey;
  const userId = meta.userId ?? session.client_reference_id ?? undefined;
  const seekerProfileId = meta.seekerProfileId;
  if (!userId || !seekerProfileId || !isPlanKey(planKey)) return { handled: false };
  const def = planDefinitionFor('roboapply', planKey);
  if (!def || (def.kind !== 'pass' && def.kind !== 'pack')) return { handled: false };
  if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { handled: true }; // async payment methods: wait for checkout.session.async_payment_succeeded
  }
  const now = deps.now();
  const billingCountry = session.customer_details?.address?.country?.toUpperCase() ?? null;

  if (def.kind === 'pack') {
    const fresh = await claimOnce(deps.db, userId, `checkout:${session.id}`, 'stripe_checkout');
    await deps.grantPack({ userId, credits: def.practice?.credits ?? 0, idempotencyKey: `stripe:${session.id}`, purchasedAt: now });
    return { handled: true, duplicate: !fresh };
  }

  // The 7-day pass: claim + activate in one transaction.
  const periodEnd = await deps.db.$transaction(async (tx) => {
    const fresh = await claimOnce(tx, userId, `checkout:${session.id}`, 'stripe_checkout');
    if (!fresh) return null;
    const cur = await tx.seekerSubscription.findUnique({
      where: { seekerProfileId },
      select: { tier: true, status: true, currentPeriodEnd: true, startedAt: true, stripeSubscriptionId: true },
    });
    const curLive =
      cur && String(cur.tier) !== 'free' && ['active', 'trialing', 'past_due'].includes(cur.status) && cur.currentPeriodEnd && cur.currentPeriodEnd > now
        ? cur.currentPeriodEnd
        : null;
    const base = curLive ?? now;
    const end = new Date(base.getTime() + (def.passDays ?? 7) * 86_400_000);
    const data = {
      tier: 'pro' as const,
      status: 'active',
      brand: 'roboapply',
      rail: 'stripe',
      planKey,
      interval: 'pass',
      market: 'other',
      currency: (session.currency ?? 'usd').toUpperCase(),
      amountMinor: session.amount_total ?? null,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      // A cancelled subscription still running hands over to the pass at its end;
      // its later events no longer match this row (stripeSubscriptionId cleared).
      stripeSubscriptionId: null,
      startedAt: curLive ? (cur?.startedAt ?? now) : now,
      ...(typeof session.customer === 'string' ? { stripeCustomerId: session.customer } : {}),
      ...(billingCountry ? { billingCountry } : {}),
    };
    await tx.seekerSubscription.upsert({ where: { seekerProfileId }, update: data, create: { seekerProfileId, ...data } });
    return end;
  });
  if (!periodEnd) {
    // Replay: the activation committed earlier. Re-run the period-guarded grant
    // (periodStart = when the claim committed) so a crash between the commit
    // and the grant heals, while a completed grant (renewedAt ≥ claim) skips.
    const claim = await deps.db.rACreditLedger.findUnique({
      where: { idempotencyKey: `billing:checkout:${session.id}` },
      select: { createdAt: true, settledAt: true },
    });
    const row = await deps.db.seekerSubscription.findUnique({ where: { seekerProfileId }, select: { planKey: true, currentPeriodEnd: true } });
    const claimedAt = claim?.settledAt ?? claim?.createdAt ?? null;
    if (claimedAt && row?.planKey === planKey && row.currentPeriodEnd && row.currentPeriodEnd > now) {
      await deps.grantIfNewPeriod({
        userId,
        tier: 'pro',
        credits: def.practice?.credits ?? 0,
        periodStart: claimedAt,
        currentPeriodEnd: row.currentPeriodEnd,
        source: 'stripe',
        force: false,
        metadata: { planKey, checkoutSessionId: session.id, replay: true },
      });
    }
    return { handled: true, duplicate: true };
  }
  await deps.grantIfNewPeriod({
    userId,
    tier: 'pro',
    credits: def.practice?.credits ?? 0,
    periodStart: now,
    currentPeriodEnd: periodEnd,
    source: 'stripe',
    force: true,
    metadata: { planKey, checkoutSessionId: session.id },
  });
  deps.invalidate(userId);
  logger.info('RA_BILLING', 'stripe pass activated', { userId, planKey, periodEnd: periodEnd.toISOString() });
  return { handled: true };
}

// `invoiceSubscriptionId` and `StripeEventResult` live in platform/billing/stripeEvents.ts;
// re-exported here for the callers that import them from this service.
export { invoiceSubscriptionId };
export type { StripeEventResult };

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<{ handled: boolean; duplicate?: boolean }> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return { handled: false };
  const row = await deps.db.seekerSubscription.findFirst({
    where: { stripeSubscriptionId: subId },
    select: { id: true, seekerProfileId: true, planKey: true, tier: true, amountMinor: true, currency: true },
  });
  if (!row) return { handled: false };
  await deps.db.seekerSubscription.update({ where: { id: row.id }, data: { status: 'past_due' } });
  const profile = await deps.db.seekerProfile.findUnique({ where: { id: row.seekerProfileId }, select: { userId: true, locale: true } });
  if (!profile) return { handled: true };
  deps.invalidate(profile.userId);
  const fresh = invoice.id ? await claimOnce(deps.db, profile.userId, `payfail:${invoice.id}`, 'stripe_invoice') : false;
  if (!fresh) return { handled: true, duplicate: true };
  const user = await deps.db.user.findUnique({ where: { id: profile.userId }, select: { email: true } });
  if (user?.email) {
    await deps.sendEmail({
      template: 'billing.payment_failed',
      to: user.email,
      userId: profile.userId,
      locale: profile.locale,
      brand: 'roboapply',
      params: {
        planKey: row.planKey ?? String(row.tier),
        amountMinor: invoice.amount_due ?? row.amountMinor ?? null,
        currency: (invoice.currency ?? row.currency ?? 'usd').toUpperCase(),
      },
    });
  }
  logger.info('RA_BILLING', 'subscription marked past_due', { subId });
  return { handled: true };
}

export async function handleRoboApplyStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<StripeEventResult> {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.product !== 'roboapply') return { handled: false };
        if (session.metadata?.brand && session.metadata.brand !== 'roboapply') {
          // GoApply never charges through Stripe; never activate anything for it here.
          logger.error('RA_BILLING', 'stripe checkout for a non-Stripe brand ignored', { sessionId: session.id, brand: session.metadata.brand });
          return { handled: true };
        }
        if (session.mode === 'payment') return await fulfilStripePayment(session);
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null);
        if (!subscriptionId) return { handled: true };
        const userId = session.metadata?.userId ?? session.client_reference_id ?? null;
        const fresh = userId ? await claimOnce(deps.db, userId, `checkout:${session.id}`, 'stripe_checkout') : true;
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const r = await upsertFromSubscription(
          sub,
          {
            seekerProfileId: session.metadata?.seekerProfileId,
            planKey: session.metadata?.planKey ?? session.metadata?.tier,
            fromCheckout: true,
            billingCountry: session.customer_details?.address?.country ?? null,
          },
          fresh ? 'always' : 'period',
        );
        return { handled: r.handled, ...(fresh ? {} : { duplicate: true }) };
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        // State only. Stripe advances the period when it drafts the renewal
        // invoice, before it collects, so credits wait for invoice.paid.
        const sub = event.data.object as Stripe.Subscription;
        const r = await upsertFromSubscription(
          sub,
          { planKey: (sub.metadata?.planKey as string) || (sub.metadata?.tier as string) || undefined },
          'none',
        );
        return { handled: r.handled };
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        if (!subId) return { handled: false };
        const owned = await deps.db.seekerSubscription.findFirst({ where: { stripeSubscriptionId: subId }, select: { id: true, seekerProfileId: true } });
        if (!owned) return { handled: false };
        const reason = invoice.billing_reason;
        if (reason !== 'subscription_cycle' && reason !== 'subscription_update' && reason !== 'subscription_create') return { handled: true };
        // A paid renewal (or the first invoice, as a safety net behind checkout)
        // grants the period's credits once, guarded by the period start. A paid
        // plan switch grants the new plan's credits once per invoice.
        let mode: 'always' | 'period' = 'period';
        let duplicate = false;
        if (reason === 'subscription_update' && invoice.id) {
          const profile = await deps.db.seekerProfile.findUnique({ where: { id: owned.seekerProfileId }, select: { userId: true } });
          if (profile) {
            const fresh = await claimOnce(deps.db, profile.userId, `invoice:${invoice.id}`, 'stripe_invoice');
            mode = fresh ? 'always' : 'period';
            duplicate = !fresh;
          }
        }
        const sub = await stripe.subscriptions.retrieve(subId);
        await upsertFromSubscription(sub, {}, mode);
        return { handled: true, ...(duplicate ? { duplicate: true } : {}) };
      }
      case 'invoice.payment_failed':
        return await handlePaymentFailed(event.data.object as Stripe.Invoice);
      default: {
        // Event types added by other billing modules (stripeEvents.ts registry).
        // Inside this try: a handler that throws answers 500, so Stripe retries.
        const handler = stripeEventHandler(event.type);
        if (!handler) return { handled: false };
        return await handler(event, { stripe, db: deps.db, now: deps.now });
      }
    }
  } catch (err) {
    logger.error('RA_BILLING', 'webhook handling failed', { type: event.type, id: event.id, error: err instanceof Error ? err.message : String(err) });
    return { handled: false, failed: true };
  }
}
