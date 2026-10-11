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
//     registry in platform/billing/stripeEvents.ts (refunds and disputes
//     register there).
//   • the Stripe account may be shared with other products, so every webhook
//     case first asks "is this object ours" and answers `{ handled: false }`
//     (HTTP 200) when it is not: a session by `metadata.product`, a
//     subscription by the row that carries its id or by its metadata, an
//     invoice by the row behind its customer or its subscription. A stored
//     row whose brand is not RoboApply's is never changed by a Stripe event
//     (rule A11).
//   • every subscription event re-reads the subscription from Stripe before
//     it syncs, so a late older event cannot roll state back; the plan comes
//     from the PRICE first and from metadata second, so a price changed
//     outside the app records the plan that is really charged.
//   • a subscription is attached to its row by `customer.subscription.created`
//     (or by its first paid invoice), so it activates and is granted once even
//     when `checkout.session.completed` never arrives. One-time payments have
//     no second event: the return page reconciles the Checkout Session
//     (`reconcileCheckoutSession`, the same claimed fulfilment as the webhook).
//   • one set of rules decides whether a subscription that no row carries
//     may be put on a row (`attachRefusal`), for the event, the first invoice
//     and the Checkout Session alike: never one whose first payment is still
//     open (a declined card switches nothing on), never one that has ended,
//     never over another running subscription, and never over a running pass
//     unless a Checkout Session is being fulfilled for the first time. So an
//     old session opened again, or a second session paid in another tab,
//     cannot take the row away from the plan it is on.
//   • a failed charge never makes a row `past_due` on the event's word: the
//     subscription is re-read and the row follows Stripe; the dunning mail
//     goes out only when Stripe says past due. The first invoice of a new
//     subscription sends neither that mail nor the "confirm your payment"
//     one: the buyer is on the Checkout page.
//   • the portal runs on a configuration made by code (stripePortal.ts):
//     plan changes stay in the app, so the renewal acknowledgement is always
//     recorded. A cancellation made in the portal gets the same confirmation
//     mail as one made here, once.
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
  findBillingOwnerByCustomer,
} from '../../platform/billing/index.js';
import { ensurePortalConfiguration } from '../../platform/billing/stripePortal.js';
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
  /** The proration preview of a plan switch (platform/billing/subscriptions.ts). Charges nothing. */
  quoteSwitch: typeof quoteSwitch;
  /** The plan switch itself (platform/billing/subscriptions.ts). */
  confirmSwitch: typeof confirmSwitch;
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
    quoteSwitch,
    confirmSwitch,
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
 * Count one hit against a per-user limit and refuse with 429 `rate_limited`
 * (`details.retryAfterSec`) when it is used up. Fails open: when the limiter
 * itself cannot answer, the request goes ahead (a payment, or the recovery of
 * a paid one, must not hang on a counter).
 */
async function holdRateLimit(key: string, windows: readonly RateWindow[], userId: string): Promise<void> {
  let result: { allowed: boolean; retryAfterSec: number };
  try {
    result = await deps.consumeRateLimit(key, windows);
  } catch (err) {
    logger.warn('RA_BILLING', 'order rate limit check failed; allowing', { userId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!result.allowed) {
    throw new RoboApplyBillingError('rate_limited', 'Too many payment attempts. Try again later.', 429, { retryAfterSec: result.retryAfterSec });
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
  await holdRateLimit(rateLimitKey('billingCnCreate', 'user', userId, brand.id), rateLimitWindows('billingCnCreate'), userId);
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
    // Rule A11 for the ACCOUNT, not only for the request's brand: Stripe never
    // serves an account or a plan row of another brand (an admin session may
    // sit on the other brand's host). The webhook would refuse to fulfil such
    // a payment, so the session is never created.
    if (rail.id === 'stripe' && !stripeServesAccount(account)) {
      throw new BillingError('rail_not_allowed', 'Card payments are not available for this account', { rail: 'stripe' });
    }

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

/** What the portal opens on: the full portal, or straight on "update your payment method" (the failed-payment banner). */
export type PortalFlow = 'payment_method_update';

/**
 * A Stripe customer portal session. Every session runs on OUR portal
 * configuration (stripePortal.ts: created by code, plan changes off), never
 * on the account's default one.
 */
export async function createPortalSession(userId: string, brand: ProductBrand, opts: { flow?: PortalFlow } = {}): Promise<{ url: string }> {
  const noCustomer = () => new RoboApplyBillingError('no_customer', 'No billing account yet — subscribe first', 409);
  // Rule A11, before anything else: a brand that does not list Stripe has no
  // Stripe customer to open a portal for, whether or not a Stripe key is usable here.
  if (!brand.paymentRails.includes('stripe')) throw noCustomer();
  const stripe = deps.getStripe();
  if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
  const account = await requireAccount(userId);
  const customer = account.subscription?.stripeCustomerId;
  if (!customer) throw noCustomer();
  try {
    const configuration = await ensurePortalConfiguration(stripe, brand);
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${appOrigin(brand)}/settings/billing`,
      configuration,
      ...(opts.flow === 'payment_method_update' ? { flow_data: { type: 'payment_method_update' as const } } : {}),
    });
    return { url: portal.url };
  } catch (err) {
    logger.error('RA_BILLING', 'stripe portal session failed', { userId, flow: opts.flow ?? null, error: err instanceof Error ? err.message : String(err) });
    throw new RoboApplyBillingError('payment_provider_error', 'The billing page could not be opened. Try again.', 502, { provider: 'stripe' });
  }
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

/**
 * What POST /billing/switch answers. Without `confirm`: the quote. With it:
 * the plan was switched, or the payment for the switch still needs the buyer
 * (3-D Secure, a declined card): nothing changed yet, and the hosted invoice
 * page is where they finish it.
 */
export type SwitchResult =
  | { quote: SwitchQuote }
  | { switched: true; planKey: string }
  | { switched: false; requiresAction: true; hostedInvoiceUrl: string | null; planKey: string };

/** The two optional members `confirmSwitch` adds when the payment needs the buyer (read with safe defaults). */
interface SwitchNeedsAction {
  requiresAction?: boolean;
  hostedInvoiceUrl?: string | null;
}

/**
 * Read-your-write for a paid switch. Stripe has applied the new plan, and the
 * web reads the plan once, right after the answer: without this the row would
 * still say the old plan until `customer.subscription.updated` arrives, so the
 * sheet would say "You're on Pro Quarterly" above a card that reads Monthly.
 * State only: the practice credits of the switch stay with `invoice.paid`
 * (its own claim). Never fails the answer: the charge is made, and the webhook
 * writes the same state a moment later.
 */
async function syncSwitchedSubscription(userId: string, subscriptionId: string | null | undefined): Promise<void> {
  const stripe = deps.getStripe();
  if (!stripe || !subscriptionId) return;
  try {
    await upsertFromSubscription(await stripe.subscriptions.retrieve(subscriptionId), {}, 'none');
  } catch (err) {
    logger.warn('RA_BILLING', 'plan switched, but the row could not be synced; the webhook will write it', { userId, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function switchPlan(userId: string, brand: ProductBrand, input: SwitchInput): Promise<SwitchResult> {
  const account = await requireAccount(userId);
  try {
    if (!isPlanKey(input.planKey)) throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey });
    if (account.brand !== brand.id) throw new BillingError('switch_not_available', 'Switch plans on the site you signed up on');
    const target = getCatalogPlan(brand.id, input.planKey);
    if (!target) throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: input.planKey });
    // A switch TO a student plan needs the same capability and verification as buying one.
    const studentVerified = await studentVerifiedFor(userId, brand, target);
    const stripeDeps = { getStripe: deps.getStripe, db: deps.db, now: deps.now, ...(studentVerified !== undefined ? { studentVerified } : {}) };
    if (!input.confirm) return { quote: await deps.quoteSwitch(account, target, stripeDeps) };
    if (input.prorationDate === undefined) throw new BillingError('quote_expired', 'Review the quote first');
    const seekerProfileId = account.seekerProfileId;
    if (!seekerProfileId) throw new BillingError('no_profile', 'No seeker profile');
    const res: Awaited<ReturnType<typeof confirmSwitch>> & SwitchNeedsAction = await deps.confirmSwitch(account, target, input.prorationDate, stripeDeps, {
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
    if (res.requiresAction === true) {
      deps.invalidate(userId);
      // Stripe holds the change until the payment is completed: the plan is NOT switched yet.
      const hostedInvoiceUrl = typeof res.hostedInvoiceUrl === 'string' && res.hostedInvoiceUrl ? res.hostedInvoiceUrl : null;
      return { switched: false, requiresAction: true, hostedInvoiceUrl, planKey: res.planKey };
    }
    await syncSwitchedSubscription(userId, res.stripeSubscriptionId);
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
  // Rule A11: only a RoboApply account has invoices at Stripe; no other account makes the server ask.
  const stripe = stripeServesAccount(account) ? deps.getStripe() : null;
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
    const notFound = () => new RoboApplyBillingError('not_found', 'Invoice not found', 404);
    // Rule A11, before Stripe is asked anything: only a RoboApply account that
    // holds a Stripe customer can own a Stripe invoice. Anyone else (a GoApply
    // user, an account that never paid by card) gets 404 with no Stripe call.
    const ownCustomer = stripeServesAccount(account) ? (account.subscription?.stripeCustomerId ?? null) : null;
    if (!ownCustomer) throw notFound();
    const stripe = deps.getStripe();
    if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
    let inv: Stripe.Invoice;
    try {
      inv = await stripe.invoices.retrieve(invoiceId);
    } catch (err) {
      if (isStripeMissing(err)) throw notFound();
      logger.error('RA_BILLING', 'stripe invoice read failed', { userId, error: err instanceof Error ? err.message : String(err) });
      throw new RoboApplyBillingError('payment_provider_error', 'The invoice could not be read. Try again.', 502, { provider: 'stripe' });
    }
    const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (customerId !== ownCustomer) {
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

// ── Whose Stripe object is it ────────────────────────────────────────────

/**
 * A stored row a Stripe event may change: RoboApply's, or an old row that
 * names no brand. A row of another brand is never Stripe's (rule A11): no
 * event syncs it, activates it or rewrites its brand.
 */
function stripeMayChange(row: { brand?: string | null }): boolean {
  return row.brand == null || row.brand === 'roboapply';
}

/**
 * Stripe serves this account: it is RoboApply's and so is its plan row (or
 * the row names no brand, or there is none). The request-side half of rule
 * A11, for the paths that are not the webhook: checkout, the invoice list and
 * the invoice download.
 */
function stripeServesAccount(account: Pick<BillingAccount, 'brand' | 'subscription'>): boolean {
  return account.brand === 'roboapply' && stripeMayChange(account.subscription ?? {});
}

/** Metadata that names a brand other than RoboApply (GoApply never charges through Stripe). */
function namesAnotherBrand(metadata: Stripe.Metadata | null | undefined): boolean {
  return Boolean(metadata?.brand) && metadata!.brand !== 'roboapply';
}

/**
 * A Checkout Session is ours when we stamped it (`metadata.product`); the
 * Stripe account may be shared with other products. One that names another
 * brand is ours to see and never ours to fulfil.
 */
function sessionOwnership(session: Stripe.Checkout.Session): 'ours' | 'not_ours' | 'other_brand' {
  if (session.metadata?.product !== 'roboapply') return 'not_ours';
  return namesAnotherBrand(session.metadata) ? 'other_brand' : 'ours';
}

/** The id of a Stripe reference that arrives as an id or as the expanded object. */
function stripeRefId(ref: string | { id?: string | null } | null | undefined): string | null {
  if (typeof ref === 'string') return ref || null;
  return ref?.id ?? null;
}

/** An error the Stripe SDK raised (its errors carry a `type` such as `StripeAPIError`, `StripeConnectionError`). */
function isStripeError(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === 'string' && type.startsWith('Stripe');
}

/** Stripe says the object does not exist. */
function isStripeMissing(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === 'resource_missing' || e?.statusCode === 404;
}

interface SubHints {
  seekerProfileId?: string;
  planKey?: string;
  /**
   * The subscription may not be on a row yet (checkout, `customer.subscription.created`,
   * the first paid invoice): find the row by the seeker profile, then by the customer.
   */
  attach?: boolean;
  billingCountry?: string | null;
}

interface UpsertResult {
  handled: boolean;
  userId?: string;
  planKey?: string;
  tier?: string;
}

/**
 * The plan a subscription is on. The PRICE answers first (the plan key
 * stamped on a synced price, its lookup key, a pinned id): it is what Stripe
 * charges, so a price changed outside the app (the Dashboard, a pending
 * update) records the plan that is really paid for, with its interval and
 * practice allowance. Metadata is the second source (a subscriber on a price
 * whose pin is no longer honoured), the legacy practice-plan map the last.
 */
function resolvePlanFromStripe(sub: Stripe.Subscription, hints: SubHints, legacyCatalog: Awaited<ReturnType<typeof getMockPlanCatalog>>) {
  const price = sub.items?.data?.[0]?.price ?? null;
  const priceId = price?.id ?? null;
  const metaKey = (sub.metadata?.planKey as string | undefined) ?? hints.planKey;
  const planKey = planKeyForPrice(price) ?? (isPlanKey(metaKey) ? metaKey : null);
  if (planKey) return { planKey, tier: 'pro' as GrantTier, legacy: false, priceId };
  const legacy: MockPlanKey = priceIdToMockPlanKey(legacyCatalog, priceId) ?? (sub.metadata?.tier === 'growth' ? 'growth' : 'starter');
  return { planKey: legacy as string, tier: legacy as GrantTier, legacy: true, priceId };
}

/**
 * How a sync grants practice credits: 'none' (state only), 'period' (once per
 * billing period, guarded by the period start), 'always' (forced: a first
 * period), 'change' (forced, for a paid plan switch: a legacy plan moving to
 * Pro gets the new allowance, a switch between two Pro plans only tops the
 * balance up; mockCreditService `planChange`).
 */
type CreditGrantMode = 'always' | 'period' | 'none' | 'change';

async function upsertFromSubscription(sub: Stripe.Subscription, hints: SubHints, creditGrant: CreditGrantMode): Promise<UpsertResult> {
  const db = deps.db;
  const select = { id: true, seekerProfileId: true, tier: true, stripeSubscriptionId: true, brand: true } as const;
  const customerId = stripeRefId(sub.customer);
  let row = await db.seekerSubscription.findFirst({ where: { stripeSubscriptionId: sub.id }, select });
  if (!row && hints.attach) {
    if (hints.seekerProfileId) row = await db.seekerSubscription.findUnique({ where: { seekerProfileId: hints.seekerProfileId }, select });
    if (!row && customerId) row = await db.seekerSubscription.findFirst({ where: { stripeCustomerId: customerId }, select });
  }
  if (!row) return { handled: false };
  if (!stripeMayChange(row)) {
    // Rule A11: the one place a subscription is written to a row, so the one guard.
    logger.error('RA_BILLING', 'stripe subscription event for a row of another brand ignored', { subId: sub.id, rowId: row.id, brand: row.brand });
    return { handled: false };
  }

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
      stripeCustomerId: customerId ?? undefined,
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
        force: creditGrant === 'always' || creditGrant === 'change' || String(row.tier) !== String(plan.tier),
        ...(creditGrant === 'change' ? { planChange: true } : {}),
        metadata: { planKey: plan.planKey, stripeSubscriptionId: sub.id },
      });
    }
    deps.invalidate(userId);
  }
  logger.info('RA_BILLING', 'stripe subscription synced', { subId: sub.id, status, planKey: plan.planKey, creditGrant });
  return { handled: true, userId, planKey: plan.planKey, tier };
}

/** The session's money has arrived (or none was due). */
function sessionIsPaid(session: Stripe.Checkout.Session): boolean {
  return !session.payment_status || session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
}

/** The claim that records which subscription a paid pass took off its row (`refId` holds the subscription id). */
function passoverClaimKey(sessionId: string): string {
  return `billing:passover:${sessionId}`;
}

/**
 * End, at Stripe, the subscription a paid pass took off its row. The pass
 * clears `stripeSubscriptionId`, so no later event of that subscription can
 * reach the row again: left alone, a subscription that still renews (bought in
 * another tab, or kept with "Keep my plan" after the pass checkout was opened,
 * or renewed again in Stripe's portal) would charge every period with nothing
 * behind it and no way to cancel it in the app. The row already carries the
 * time that was paid for (the pass starts at the period's end), so nothing the
 * buyer paid for is lost.
 *
 * Idempotent (`passover:<sub>:<session>`); a subscription Stripe already holds
 * as cancelled is success. Any other failure throws: the webhook answers 500
 * and the replay branch runs this again.
 */
async function endDetachedSubscription(stripe: Stripe, subscriptionId: string, sessionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey: `passover:${subscriptionId}:${sessionId}` });
  } catch (err) {
    if (isStripeMissing(err)) return;
    // Stripe refuses to cancel what is already cancelled; the subscription's own status decides.
    let status: string | null = null;
    try {
      status = (await stripe.subscriptions.retrieve(subscriptionId)).status;
    } catch (readErr) {
      if (isStripeMissing(readErr)) return;
    }
    if (status !== 'canceled' && status !== 'incomplete_expired') throw err;
  }
}

/** A one-time payment (7-day pass or practice pack) from Stripe Checkout. */
async function fulfilStripePayment(session: Stripe.Checkout.Session, stripe: Stripe): Promise<{ handled: boolean; duplicate?: boolean; pending?: boolean }> {
  const meta = session.metadata ?? {};
  const planKey = meta.planKey;
  const userId = meta.userId ?? session.client_reference_id ?? undefined;
  const seekerProfileId = meta.seekerProfileId;
  if (!userId || !seekerProfileId || !isPlanKey(planKey)) return { handled: false };
  const def = planDefinitionFor('roboapply', planKey);
  if (!def || (def.kind !== 'pass' && def.kind !== 'pack')) return { handled: false };
  if (!sessionIsPaid(session)) {
    return { handled: true, pending: true }; // async payment methods: wait for checkout.session.async_payment_succeeded
  }
  // Rule A11: a pass or a pack is never activated on a row of another brand.
  const held = await deps.db.seekerSubscription.findUnique({ where: { seekerProfileId }, select: { id: true, brand: true } });
  if (held && !stripeMayChange(held)) {
    logger.error('RA_BILLING', 'stripe payment for a row of another brand ignored', { sessionId: session.id, rowId: held.id, brand: held.brand });
    return { handled: false };
  }
  const now = deps.now();
  const billingCountry = session.customer_details?.address?.country?.toUpperCase() ?? null;

  if (def.kind === 'pack') {
    const fresh = await claimOnce(deps.db, userId, `checkout:${session.id}`, 'stripe_checkout');
    await deps.grantPack({ userId, credits: def.practice?.credits ?? 0, idempotencyKey: `stripe:${session.id}`, purchasedAt: now });
    return { handled: true, duplicate: !fresh };
  }

  // The 7-day pass: claim + activate in one transaction.
  const activated = await deps.db.$transaction(async (tx) => {
    const fresh = await claimOnce(tx, userId, `checkout:${session.id}`, 'stripe_checkout');
    if (!fresh) return null;
    const cur = await tx.seekerSubscription.findUnique({
      where: { seekerProfileId },
      select: { tier: true, status: true, currentPeriodEnd: true, startedAt: true, stripeSubscriptionId: true, cancelAtPeriodEnd: true },
    });
    // The subscription this pass takes off the row is written down in the same
    // transaction, so a delivery that dies before it is ended at Stripe is
    // finished by the replay (`endDetachedSubscription`).
    const detached = cur?.stripeSubscriptionId ?? null;
    if (detached) {
      await tx.rACreditLedger.createMany({
        data: [
          {
            userId,
            bucket: 'billing_event',
            amount: 0,
            status: 'committed',
            fromSource: 'stripe',
            idempotencyKey: passoverClaimKey(session.id),
            refType: 'stripe_subscription',
            refId: detached,
            settledAt: now,
          },
        ],
        skipDuplicates: true,
      });
    }
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
      // A subscription still running hands over to the pass at its end; its
      // later events no longer match this row (stripeSubscriptionId cleared),
      // so it is ended at Stripe right after the commit.
      stripeSubscriptionId: null,
      startedAt: curLive ? (cur?.startedAt ?? now) : now,
      ...(typeof session.customer === 'string' ? { stripeCustomerId: session.customer } : {}),
      ...(billingCountry ? { billingCountry } : {}),
    };
    await tx.seekerSubscription.upsert({ where: { seekerProfileId }, update: data, create: { seekerProfileId, ...data } });
    return { end, detached, stillRenewing: Boolean(detached) && curLive !== null && cur?.cancelAtPeriodEnd !== true };
  });
  if (!activated) {
    // Replay: the activation committed earlier. Finish what may have been cut
    // short. First the subscription the pass took off the row (the same
    // idempotent cancel).
    const passover = await deps.db.rACreditLedger.findUnique({ where: { idempotencyKey: passoverClaimKey(session.id) }, select: { refId: true } });
    if (passover?.refId) await endDetachedSubscription(stripe, passover.refId, session.id);
    // Then the period-guarded grant
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
  const periodEnd = activated.end;
  if (activated.detached) {
    if (activated.stillRenewing) {
      // Money: the buyer held a renewing subscription and paid for a pass as well. Someone should look.
      logger.error('RA_BILLING', 'pass paid over a subscription that still renewed: the subscription is ended at Stripe', {
        userId,
        sessionId: session.id,
        subId: activated.detached,
      });
    }
    await endDetachedSubscription(stripe, activated.detached, session.id);
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

/**
 * A failed charge. The row never becomes `past_due` on the event's word: the
 * subscription is re-read and the row follows what Stripe holds NOW, so an old
 * failure delivered after the retry was paid changes nothing, and a
 * subscription whose FIRST payment was declined (Stripe keeps it `incomplete`
 * while the buyer is still on the Checkout page) is never switched on. The
 * mail goes out once per invoice (`billing:payfail:<invoice>`), and only when
 * Stripe says the subscription is past due.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice, stripe: Stripe): Promise<{ handled: boolean; duplicate?: boolean }> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return { handled: false };
  const row = await deps.db.seekerSubscription.findFirst({
    where: { stripeSubscriptionId: subId },
    select: { id: true, seekerProfileId: true, planKey: true, tier: true, amountMinor: true, currency: true, brand: true },
  });
  if (!row) return { handled: false };
  if (!stripeMayChange(row)) {
    logger.error('RA_BILLING', 'stripe invoice event for a row of another brand ignored', { invoiceId: invoice.id ?? null, rowId: row.id, brand: row.brand });
    return { handled: false };
  }
  // The first invoice of a new subscription: the buyer is on the Checkout
  // page, which shows the decline itself. Nothing was paid for, so nothing is
  // past due, and there is nobody to chase by mail.
  if (invoice.billing_reason === 'subscription_create') return { handled: true };

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    if (!isStripeMissing(err)) throw err; // the webhook answers 500 and Stripe retries
    logger.warn('RA_BILLING', 'payment failed for a subscription Stripe no longer knows: nothing changed', { subId, invoiceId: invoice.id ?? null });
    return { handled: true };
  }
  const synced = await upsertFromSubscription(sub, {}, 'none');
  if (STRIPE_STATUS_MAP[sub.status] !== 'past_due') {
    // Paid in the meantime, ended, or never started: the row now says so, and no failure mail is owed.
    logger.info('RA_BILLING', 'payment failed, but the subscription is not past due now', { subId, status: sub.status });
    return { handled: true };
  }
  const profile = await deps.db.seekerProfile.findUnique({ where: { id: row.seekerProfileId }, select: { userId: true, locale: true } });
  if (!profile) return { handled: true };
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
        planKey: synced.planKey ?? row.planKey ?? String(row.tier),
        amountMinor: invoice.amount_due ?? row.amountMinor ?? null,
        currency: (invoice.currency ?? row.currency ?? 'usd').toUpperCase(),
      },
    });
  }
  logger.info('RA_BILLING', 'subscription marked past_due', { subId });
  return { handled: true };
}

// ── Checkout Session → fulfilment (the webhook and the return-page reconcile) ──

interface CheckoutApplied {
  handled: boolean;
  /** The session was fulfilled earlier; nothing changed twice. */
  duplicate?: boolean;
  /** The money has not arrived yet (an async payment method): nothing was fulfilled. */
  pending?: boolean;
  planKey: string | null;
}

/**
 * Fulfil one of OUR Checkout Sessions, once: a subscription is synced to its
 * row and granted, a one-time payment activates the pass or grants the pack.
 * The claim `billing:checkout:<session>` makes it replay-safe, so the webhook
 * (`checkout.session.completed`, `.async_payment_succeeded`) and the return
 * page (`reconcileCheckoutSession`) run exactly this and whichever comes
 * second is a duplicate. The caller has already decided the session is ours.
 */
async function applyCheckoutSession(session: Stripe.Checkout.Session, stripe: Stripe): Promise<CheckoutApplied> {
  const metaPlanKey = session.metadata?.planKey;
  const planKey = isPlanKey(metaPlanKey) ? metaPlanKey : null;
  if (session.mode === 'payment') {
    const r = await fulfilStripePayment(session, stripe);
    return { ...r, planKey };
  }
  const subscriptionId = stripeRefId(session.subscription);
  if (!subscriptionId) return { handled: true, pending: true, planKey };
  const userId = session.metadata?.userId ?? session.client_reference_id ?? null;
  // Stripe first, claims second: a failed read leaves nothing claimed, so the retry is a first run.
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const tracked = await deps.db.seekerSubscription.findFirst({ where: { stripeSubscriptionId: sub.id }, select: { id: true } });
  // The first payment has not been made: nothing to fulfil yet.
  if (!tracked && STRIPE_STATUS_MAP[sub.status] === 'incomplete') return { handled: true, pending: true, planKey };
  const fresh = userId ? await claimOnce(deps.db, userId, `checkout:${session.id}`, 'stripe_checkout') : true;
  const hints: SubHints = {
    seekerProfileId: session.metadata?.seekerProfileId,
    planKey: session.metadata?.planKey ?? session.metadata?.tier,
    billingCountry: session.customer_details?.address?.country ?? null,
  };
  // A session with no user id cannot hold a claim; it grants as it always did.
  const grant = () => (userId ? firstPeriodGrant(userId, sub.id) : Promise.resolve<'always' | 'period'>(fresh ? 'always' : 'period'));
  let r: UpsertResult & { skipped?: AttachRefusal };
  if (tracked) {
    r = await upsertFromSubscription(sub, hints, await grant());
  } else {
    // No row carries this subscription. A session fulfilled for the first
    // time attaches it; an old session (the return URL opened again, a
    // resent event) must not put a subscription back on a row that has moved
    // on, and that is what the attach rules decide.
    r = await attachSubscription(sub, { hints, ours: true, firstFulfilment: fresh, creditGrant: grant });
    if (r.skipped) return { handled: true, duplicate: true, planKey };
  }
  return { handled: r.handled, ...(fresh ? {} : { duplicate: true }), planKey: r.planKey ?? planKey };
}

/** How often one user may ask to reconcile a Checkout Session: 10 a minute. */
export const CHECKOUT_RECONCILE_WINDOWS: readonly RateWindow[] = [{ limit: 10, windowSec: 60 }];

/** What POST /billing/checkout/reconcile answers. Never Stripe's session object. */
export interface ReconcileResult {
  status: 'fulfilled' | 'already_fulfilled' | 'pending';
  mode: 'payment' | 'subscription';
  planKey: string | null;
}

/**
 * Lost-event recovery for the return page (MARKET_STRATEGY.md §5.1): a
 * one-time payment has a single webhook event, so when the buyer comes back
 * from Stripe the web asks us to look the session up and fulfil it. It runs
 * the same claimed fulfilment as the webhook; a later webhook is a duplicate
 * and a repeated call changes nothing.
 *
 * The session must be the caller's own: ours (`metadata.product`), RoboApply's,
 * stamped with the caller's user id and, when the account already has a
 * Stripe customer, paid by that customer. Every other session answers 403
 * with no detail, so the endpoint tells nobody anything about a session id.
 */
export async function reconcileCheckoutSession(userId: string, brand: ProductBrand, sessionId: string): Promise<ReconcileResult> {
  const forbidden = () => new RoboApplyBillingError('forbidden', 'This payment does not belong to you', 403);
  // Rule A11: a request on a brand that does not list Stripe never reaches Stripe.
  if (!brand.paymentRails.includes('stripe')) throw forbidden();
  await holdRateLimit(rateLimitKey('billingReconcile', 'user', userId, brand.id), CHECKOUT_RECONCILE_WINDOWS, userId);
  const stripe = deps.getStripe();
  if (!stripe) throw new RoboApplyBillingError('stripe_not_configured', 'Billing is not configured', 503);
  const account = await requireAccount(userId);
  // The same rule for the account: one that belongs to another brand has nothing at Stripe to look up.
  if (account.brand !== 'roboapply') throw forbidden();

  const providerError = (step: string, err: unknown) => {
    logger.error('RA_BILLING', 'checkout reconcile: stripe call failed', { userId, step, error: err instanceof Error ? err.message : String(err) });
    return new RoboApplyBillingError('payment_provider_error', 'The payment provider could not be reached. Try again.', 502, { provider: 'stripe' });
  };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (isStripeMissing(err)) throw new RoboApplyBillingError('not_found', 'Payment not found', 404);
    throw providerError('retrieve session', err);
  }

  const meta = session.metadata ?? {};
  const customerId = stripeRefId(session.customer);
  const ownCustomer = account.subscription?.stripeCustomerId ?? null;
  const mine =
    sessionOwnership(session) === 'ours' &&
    meta.userId === userId &&
    (session.mode === 'payment' || session.mode === 'subscription') &&
    (!ownCustomer || customerId === ownCustomer);
  if (!mine) throw forbidden();

  const mode: ReconcileResult['mode'] = session.mode === 'subscription' ? 'subscription' : 'payment';
  const metaPlanKey = isPlanKey(meta.planKey) ? meta.planKey : null;
  // Not paid (still open, expired, or an async method that has not settled): nothing to fulfil, nothing changes.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { status: 'pending', mode, planKey: metaPlanKey };
  }

  let applied: CheckoutApplied;
  try {
    applied = await applyCheckoutSession(session, stripe);
  } catch (err) {
    // A Stripe failure (the subscription re-read) is the provider's; anything else is ours and stays a 500.
    if (isStripeError(err)) throw providerError('apply session', err);
    throw err;
  }
  deps.invalidate(userId);
  if (!applied.handled || applied.pending) {
    if (!applied.handled) logger.warn('RA_BILLING', 'checkout reconcile: a paid session could not be fulfilled', { userId, sessionId: session.id, mode, planKey: metaPlanKey });
    return { status: 'pending', mode, planKey: applied.planKey ?? metaPlanKey };
  }
  logger.info('RA_BILLING', 'checkout reconciled', { userId, sessionId: session.id, mode, duplicate: applied.duplicate === true });
  return { status: applied.duplicate ? 'already_fulfilled' : 'fulfilled', mode, planKey: applied.planKey ?? metaPlanKey };
}

// ── Subscription events: re-read, then sync ──────────────────────────────

const SUBSCRIPTION_CREATED = 'customer.subscription.created';
const SUBSCRIPTION_DELETED = 'customer.subscription.deleted';

function subscriptionEnded(sub: Stripe.Subscription): boolean {
  return STRIPE_STATUS_MAP[sub.status] === 'canceled';
}

/**
 * The subscription as Stripe holds it NOW. An event carries a snapshot from
 * when it was made, and events arrive late and out of order: syncing the
 * snapshot would let an old event roll the row back. A failure throws, so the
 * webhook answers 500 and Stripe retries; only a `deleted` event whose
 * subscription Stripe no longer knows falls back to its snapshot (deleted is
 * final, so there is nothing newer to miss).
 */
async function currentSubscription(stripe: Stripe, snapshot: Stripe.Subscription, type: string): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.retrieve(snapshot.id);
  } catch (err) {
    if (type === SUBSCRIPTION_DELETED && isStripeMissing(err)) return snapshot;
    throw err;
  }
}

/**
 * The first period's credits are granted on purpose, once, by whichever
 * arrives first: the Checkout Session or the subscription's first paid
 * invoice. The winner of claim `billing:subcreate:<sub>` forces the grant, so
 * a free-plan grant that landed after the period began cannot make it skip;
 * every later arrival and every replay is guarded by the period start.
 */
async function firstPeriodGrant(userId: string, subscriptionId: string): Promise<'always' | 'period'> {
  return (await claimOnce(deps.db, userId, `subcreate:${subscriptionId}`, 'stripe_subscription')) ? 'always' : 'period';
}

/** How far a first period may begin after the subscription's start and still count as the first (the shortest plan is a week). */
const FIRST_PERIOD_SLACK_MS = 3_600_000;

/** The subscription has not renewed yet: its current period began when it started. Unknown counts as "no". */
function inFirstPeriod(sub: Stripe.Subscription): boolean {
  const { start } = stripePeriod(sub);
  if (!start || typeof sub.start_date !== 'number') return false;
  return start.getTime() <= sub.start_date * 1000 + FIRST_PERIOD_SLACK_MS;
}

/** Why a subscription that no row carries is NOT put on a row. */
type AttachRefusal = 'ended' | 'incomplete' | 'other_subscription' | 'running_pass';

interface AttachTarget {
  status: string;
  tier: unknown;
  currentPeriodEnd: Date | null;
  stripeSubscriptionId: string | null;
}

/**
 * The attach rules, in one place. A subscription that no row carries is put
 * on `row` unless
 *   - it has ended (only a late event can say so; the row has moved on);
 *   - its first payment has not been made (`incomplete`): a declined card
 *     must not switch anything on. The first paid invoice or the Checkout
 *     Session attaches it once the money has arrived;
 *   - the row is on ANOTHER subscription that is still running (a second
 *     Checkout Session paid in another tab, or an old one coming back): the
 *     row keeps the one it tracks, so its renewals and its end are not lost;
 *   - the row holds a running pass and this is not the first fulfilment of a
 *     Checkout Session: a late or replayed event must not replace the pass.
 */
function attachRefusal(sub: Stripe.Subscription, row: AttachTarget | null, now: Date, firstFulfilment: boolean): AttachRefusal | null {
  const status = STRIPE_STATUS_MAP[sub.status] ?? 'active';
  if (status === 'canceled') return 'ended';
  if (status === 'incomplete') return 'incomplete';
  if (!row) return null;
  const running =
    String(row.tier) !== 'free' && ['active', 'trialing', 'past_due'].includes(row.status) && row.currentPeriodEnd != null && row.currentPeriodEnd > now;
  if (!running) return null;
  if (row.stripeSubscriptionId) return row.stripeSubscriptionId === sub.id ? null : 'other_subscription';
  // Paid access that no Stripe subscription renews: a pass (Stripe's 7-day pass, or an old Alipay pass).
  return firstFulfilment ? null : 'running_pass';
}

interface AttachOptions {
  hints?: SubHints;
  /** The caller already decided the object is ours (a Checkout Session we stamped). */
  ours?: boolean;
  /** A Checkout Session fulfilled for the first time (its claim was won just now). Events are never that. */
  firstFulfilment?: boolean;
  /** Asked only once the subscription really attaches, so a refused attach claims nothing. */
  creditGrant: () => Promise<CreditGrantMode>;
}

/**
 * Put one of our subscriptions on its row for the first time (state, and
 * credits only as `creditGrant` says). Used by `customer.subscription.created`,
 * by the first paid invoice and by the Checkout Session, so a subscription
 * activates even when `checkout.session.completed` never arrives. The row is
 * found by the seeker profile (`metadata.seekerProfileId`), then by the
 * customer. `attachRefusal` decides whether it may; a refusal changes nothing
 * and answers `{ handled: true, skipped }`.
 */
async function attachSubscription(sub: Stripe.Subscription, opts: AttachOptions): Promise<UpsertResult & { skipped?: AttachRefusal }> {
  const meta = sub.metadata ?? {};
  if (!opts.ours && (meta.product !== 'roboapply' || namesAnotherBrand(meta))) return { handled: false };
  const seekerProfileId = opts.hints?.seekerProfileId || (meta.seekerProfileId as string | undefined) || undefined;
  const customerId = stripeRefId(sub.customer);
  const select = { id: true, tier: true, status: true, brand: true, currentPeriodEnd: true, stripeSubscriptionId: true } as const;
  let row = seekerProfileId ? await deps.db.seekerSubscription.findUnique({ where: { seekerProfileId }, select }) : null;
  if (!row && customerId) row = await deps.db.seekerSubscription.findFirst({ where: { stripeCustomerId: customerId }, select });
  if (row && !stripeMayChange(row)) {
    logger.error('RA_BILLING', 'stripe subscription for a row of another brand not attached', { subId: sub.id, rowId: row.id, brand: row.brand });
    return { handled: false };
  }
  const refusal = attachRefusal(sub, row, deps.now(), opts.firstFulfilment === true);
  if (refusal) {
    const detail = { subId: sub.id, rowId: row?.id ?? null, reason: refusal, tracked: row?.stripeSubscriptionId ?? null };
    // Two running subscriptions for one buyer is money: someone has to look at it.
    if (refusal === 'other_subscription') logger.error('RA_BILLING', 'stripe subscription not attached: the row is on another running subscription', detail);
    else logger.warn('RA_BILLING', 'stripe subscription not attached', detail);
    return { handled: true, skipped: refusal };
  }
  if (!row) return { handled: false };
  const planKey = opts.hints?.planKey ?? ((meta.planKey as string) || (meta.tier as string) || undefined);
  return upsertFromSubscription(sub, { ...opts.hints, seekerProfileId, planKey, attach: true }, await opts.creditGrant());
}

/**
 * A cancellation made outside the app (the Stripe portal) gets the same
 * confirmation mail as one made here, once. Our own cancel stamps
 * `metadata.cancelSource` on the subscription and sends its own mail, so a
 * subscription that carries it is skipped. Claim: `billing:cancel:<sub>:<period end>`.
 */
async function confirmOutsideCancellation(before: { cancelAtPeriodEnd: boolean }, sub: Stripe.Subscription, synced: UpsertResult): Promise<void> {
  if (!synced.userId || before.cancelAtPeriodEnd || sub.cancel_at_period_end !== true || subscriptionEnded(sub)) return;
  if (String(sub.metadata?.cancelSource ?? '').trim()) return;
  const { end } = stripePeriod(sub);
  const fresh = await claimOnce(deps.db, synced.userId, `cancel:${sub.id}:${end ? Math.floor(end.getTime() / 1000) : 'open'}`, 'stripe_subscription');
  if (!fresh) return;
  const account = await loadBillingAccount(deps.db, synced.userId);
  if (!account) return;
  await sendCancelConfirmation(account, { status: 'cancelled', accessUntil: end, planKey: synced.planKey ?? account.subscription?.planKey ?? 'pro', changed: true });
  logger.info('RA_BILLING', 'cancellation from outside the app confirmed by mail', { userId: synced.userId, subId: sub.id });
}

async function handleSubscriptionEvent(type: string, snapshot: Stripe.Subscription, stripe: Stripe): Promise<StripeEventResult> {
  const meta = snapshot.metadata ?? {};
  const row = await deps.db.seekerSubscription.findFirst({
    where: { stripeSubscriptionId: snapshot.id },
    select: { id: true, brand: true, cancelAtPeriodEnd: true },
  });
  // Ours: a row already carries its id (legacy starter / growth subscriptions
  // have no product metadata), or we stamped it. Never another brand's.
  if (!row && meta.product !== 'roboapply') return { handled: false };
  if (namesAnotherBrand(meta) || (row && !stripeMayChange(row))) {
    logger.error('RA_BILLING', 'stripe subscription event for another brand ignored', { type, subId: snapshot.id, brand: row?.brand ?? meta.brand ?? null });
    return { handled: false };
  }
  // Ours, but on no row: only `created` attaches. A later event of a
  // subscription the row no longer tracks (replaced by a pass) changes nothing.
  if (!row && type !== SUBSCRIPTION_CREATED) return { handled: false };

  // State only. Stripe advances the period when it drafts the renewal
  // invoice, before it collects, so credits wait for invoice.paid.
  const sub = await currentSubscription(stripe, snapshot, type);
  if (!row) return { handled: (await attachSubscription(sub, { creditGrant: async () => 'none' })).handled };
  const synced = await upsertFromSubscription(sub, { planKey: (sub.metadata?.planKey as string) || (sub.metadata?.tier as string) || undefined }, 'none');
  if (synced.handled) await confirmOutsideCancellation(row, sub, synced);
  return { handled: synced.handled };
}

// ── Invoice events ───────────────────────────────────────────────────────

async function handleInvoicePaid(invoice: Stripe.Invoice, stripe: Stripe): Promise<StripeEventResult> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return { handled: false };
  const reason = invoice.billing_reason;
  const owned = await deps.db.seekerSubscription.findFirst({
    where: { stripeSubscriptionId: subId },
    select: { id: true, seekerProfileId: true, brand: true, billingCountry: true },
  });
  // The first invoice carries the customer's address. When the Checkout
  // Session never arrived (the only other source), it is what tells the
  // withdrawal rules and the Taiwan revenue report where the buyer is.
  const invoiceCountry = reason === 'subscription_create' ? (invoice.customer_address?.country ?? null) : null;
  // The first paid invoice forces the first period's grant when it is the
  // first to arrive (`firstPeriodGrant`). Only while the subscription is in
  // that first period: an old first invoice sent again after a renewal is
  // guarded by the period start like any other replay.
  const firstInvoiceGrant = (userId: string | null | undefined, sub: Stripe.Subscription): Promise<'always' | 'period'> =>
    userId && inFirstPeriod(sub) ? firstPeriodGrant(userId, sub.id) : Promise.resolve('period');
  if (!owned) {
    // No row carries this subscription. It is ours only when the invoice's
    // customer is one of ours, and only its FIRST invoice attaches it
    // (`customer.subscription.created` may be late or lost, and is not
    // attached at all while the first payment is still open).
    if (reason !== 'subscription_create') return { handled: false };
    const owner = await findBillingOwnerByCustomer(deps.db, invoice.customer);
    if (!owner) return { handled: false };
    if (!stripeMayChange(owner.subscription)) {
      logger.error('RA_BILLING', 'stripe invoice event for a row of another brand ignored', { invoiceId: invoice.id ?? null, rowId: owner.subscription.id, brand: owner.subscription.brand });
      return { handled: false };
    }
    const sub = await stripe.subscriptions.retrieve(subId);
    return { handled: (await attachSubscription(sub, { hints: { billingCountry: invoiceCountry }, creditGrant: () => firstInvoiceGrant(owner.userId, sub) })).handled };
  }
  if (!stripeMayChange(owned)) {
    logger.error('RA_BILLING', 'stripe invoice event for a row of another brand ignored', { invoiceId: invoice.id ?? null, rowId: owned.id, brand: owned.brand });
    return { handled: false };
  }
  if (reason !== 'subscription_cycle' && reason !== 'subscription_update' && reason !== 'subscription_create') return { handled: true };
  // Stripe first, claims second: a failed read leaves nothing claimed, so the retry still grants.
  const sub = await stripe.subscriptions.retrieve(subId);
  // A paid renewal grants the period's credits once, guarded by the period
  // start. A paid plan switch grants once per invoice, as a plan change: the
  // new plan's allowance for a legacy plan moving to Pro, a top-up (never a
  // refill) between two Pro plans. The first invoice grants the first period
  // (see `firstInvoiceGrant`).
  let mode: 'always' | 'period' | 'change' = 'period';
  let duplicate = false;
  if (reason !== 'subscription_cycle') {
    const profile = await deps.db.seekerProfile.findUnique({ where: { id: owned.seekerProfileId }, select: { userId: true } });
    if (profile && reason === 'subscription_update' && invoice.id) {
      const fresh = await claimOnce(deps.db, profile.userId, `invoice:${invoice.id}`, 'stripe_invoice');
      mode = fresh ? 'change' : 'period';
      duplicate = !fresh;
    }
    if (reason === 'subscription_create') mode = await firstInvoiceGrant(profile?.userId, sub);
  }
  // Never over a country the row already holds (the Checkout Session's).
  await upsertFromSubscription(sub, invoiceCountry && !owned.billingCountry ? { billingCountry: invoiceCountry } : {}, mode);
  return { handled: true, ...(duplicate ? { duplicate: true } : {}) };
}

/** The price of an invoice line, as the id or the object, in the current API shape or the older one. */
function invoiceLinePrice(line: unknown): string | { id?: string | null; lookup_key?: string | null; metadata?: Record<string, string> | null } | null {
  const l = line as { pricing?: { price_details?: { price?: unknown } | null } | null; price?: unknown } | null;
  const price = l?.pricing?.price_details?.price ?? l?.price ?? null;
  return typeof price === 'string' || (price !== null && typeof price === 'object') ? (price as never) : null;
}

/**
 * The plan an invoice is for, to name it in a mail: the row that carries the
 * invoice's subscription, then a price on the invoice's lines, then the plan
 * key we stamped on the subscription (the invoice carries a copy), then the
 * customer's row. Never the free plan (nobody is asked to confirm a payment
 * for it): null then, and the mail names no plan.
 */
async function planKeyForInvoice(invoice: Stripe.Invoice, customerRow: { planKey: string | null; tier: string }): Promise<string | null> {
  const paid = (key: string | null | undefined): string | null => (key && key !== 'free' ? key : null);
  const subId = invoiceSubscriptionId(invoice);
  if (subId) {
    const row = await deps.db.seekerSubscription.findFirst({ where: { stripeSubscriptionId: subId }, select: { planKey: true, tier: true } });
    const fromRow = row ? paid(row.planKey ?? String(row.tier)) : null;
    if (fromRow) return fromRow;
  }
  for (const line of invoice.lines?.data ?? []) {
    const fromPrice = planKeyForPrice(invoiceLinePrice(line));
    if (fromPrice) return fromPrice;
  }
  const stamped = (invoice.parent as { subscription_details?: { metadata?: Record<string, string> | null } | null } | null | undefined)?.subscription_details?.metadata?.planKey;
  if (isPlanKey(stamped) && stamped !== 'free') return stamped;
  return paid(customerRow.planKey ?? customerRow.tier);
}

/**
 * The bank wants the buyer to confirm a payment (3-D Secure) that Stripe
 * tried without them: a renewal or a plan switch. One mail with the hosted
 * invoice page, where they finish it. State does not change here (a failed
 * charge is `invoice.payment_failed`). Claim: `billing:payaction:<invoice>`.
 *
 * The FIRST invoice of a subscription is not mailed: Stripe sends this event
 * for it too whenever the card needs confirming, while the buyer is doing
 * exactly that on the Checkout page.
 */
async function handlePaymentActionRequired(invoice: Stripe.Invoice): Promise<StripeEventResult> {
  // Ours only when the customer is one of ours (the account may be shared).
  const owner = await findBillingOwnerByCustomer(deps.db, invoice.customer);
  if (!owner) return { handled: false };
  if (!stripeMayChange(owner.subscription)) {
    logger.error('RA_BILLING', 'stripe invoice event for a row of another brand ignored', { invoiceId: invoice.id ?? null, rowId: owner.subscription.id, brand: owner.subscription.brand });
    return { handled: false };
  }
  if (invoice.billing_reason === 'subscription_create') return { handled: true };
  const url = invoice.hosted_invoice_url;
  if (!invoice.id || !url) {
    // Nothing to link to: say so and claim nothing, so a later event that carries the link still mails.
    logger.warn('RA_BILLING', 'payment action required without a hosted invoice page', { invoiceId: invoice.id ?? null, userId: owner.userId });
    return { handled: true };
  }
  const fresh = await claimOnce(deps.db, owner.userId, `payaction:${invoice.id}`, 'stripe_invoice');
  if (!fresh) return { handled: true, duplicate: true };
  if (owner.email) {
    await deps.sendEmail({
      template: 'billing.payment_action_required',
      to: owner.email,
      userId: owner.userId,
      locale: owner.locale,
      brand: 'roboapply',
      params: {
        planKey: await planKeyForInvoice(invoice, owner.subscription),
        amountMinor: invoice.amount_remaining ?? invoice.amount_due ?? null,
        currency: (invoice.currency ?? owner.subscription.currency ?? 'usd').toUpperCase(),
        hostedInvoiceUrl: url,
      },
    });
  }
  logger.info('RA_BILLING', 'payment action required: buyer mailed', { userId: owner.userId, invoiceId: invoice.id });
  return { handled: true };
}

/**
 * The event types this function handles itself. `charge.refunded` and
 * `charge.dispute.created` are NOT here: they are registered by the refund
 * module (stripeEvents.ts registry) and reach it through the default branch.
 */
export const HANDLED_STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
] as const;

export async function handleRoboApplyStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<StripeEventResult> {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        const whose = sessionOwnership(session);
        if (whose === 'not_ours') return { handled: false };
        if (whose === 'other_brand') {
          // GoApply never charges through Stripe; never activate anything for it here.
          logger.error('RA_BILLING', 'stripe checkout for a non-Stripe brand ignored', { sessionId: session.id, brand: session.metadata?.brand });
          return { handled: true };
        }
        if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
          // Nothing was fulfilled, so nothing changes: the buyer can start again from the plan sheet.
          logger.info('RA_BILLING', 'stripe checkout did not complete', { type: event.type, sessionId: session.id, planKey: session.metadata?.planKey ?? null });
          return { handled: true };
        }
        const applied = await applyCheckoutSession(session, stripe);
        return { handled: applied.handled, ...(applied.duplicate ? { duplicate: true } : {}) };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.pending_update_applied':
      case 'customer.subscription.pending_update_expired':
        return await handleSubscriptionEvent(event.type, event.data.object as Stripe.Subscription, stripe);
      case 'invoice.paid':
        return await handleInvoicePaid(event.data.object as Stripe.Invoice, stripe);
      case 'invoice.payment_failed':
        return await handlePaymentFailed(event.data.object as Stripe.Invoice, stripe);
      case 'invoice.payment_action_required':
        return await handlePaymentActionRequired(event.data.object as Stripe.Invoice);
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
