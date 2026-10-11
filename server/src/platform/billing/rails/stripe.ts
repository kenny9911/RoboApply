// server/src/platform/billing/rails/stripe.ts
//
// StripeRail (RoboApply, USD). ARCHITECTURE.md §7.4; PRODUCT_PLAN.md §6.3;
// docs/jobright-clone/market/MARKET_STRATEGY.md §5.1 "Checkout", "Idempotency keys".
//   - Pro plans (`pro_weekly`, `pro_monthly`, `pro_quarterly`, student V2) are
//     Stripe subscriptions; the 7-day pass and practice packs are one-time
//     payments (mode 'payment' with an invoice).
//   - The price is resolved at checkout by the catalog sync
//     (stripeCatalog.ts `resolveStripePriceId`): a pin from the environment,
//     else the price found or created under the plan's lookup key. No price
//     variable is needed.
//   - Every session, subscription and payment carries metadata `brand`,
//     `planKey`, `userId`, `seekerProfileId`, `product: 'roboapply'` and the
//     checkout acknowledgements, so the webhook can reconcile without guessing.
//   - Idempotency: `customers.create` under `customer:<seekerProfileId>`;
//     `checkout.sessions.create` under
//     `checkout:<userId>:<planKey>:<currency>:<attempt>`, where <attempt> is
//     the web's per-attempt key (`order.attemptKey`) or, without one, a
//     60-second bucket that only absorbs a double click.
//   - The session is opened in the buyer's language, with Adaptive Pricing
//     off (the buyer is charged the currency and amount the plan sheet
//     showed) and a line above the pay button that repeats period, price and
//     how to cancel (English in this wave; the localized, recorded
//     acknowledgement is on our own plan sheet).
//   - Rule A11: Stripe never serves GoApply. An order whose brand does not
//     list `stripe` is refused before a customer, a price or a session exists.
// Promotion codes are V2 (F-BILL-11) and stay off unless
// `STRIPE_PROMOTION_CODES=true`; never on student plans; no offer ships at
// launch. V2 (WP-79): a Taiwan buyer is charged the plan's TWD price when the
// owner configured one (`order.country === 'TW'`), and student plans need
// `order.studentVerified === true`.
// Tax (ST-8; MARKET_STRATEGY §5.1 "Tax"): off by default. With
// `STRIPE_TAX_ENABLED=true` the session asks Stripe Tax to compute tax,
// collects a tax id and requires the billing address (`stripeTaxEnabled`).
// Prices are tax-inclusive (stripeCatalog.ts), so the price shown stays the
// price charged. It needs Stripe Tax and the registrations in the Dashboard.

import type Stripe from 'stripe';
import { parseBoolEnv, type EnvSource } from '../../brand/brandEnv.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { BillingError } from '../errors.js';
import { appOrigin, withQueryParam } from '../origins.js';
import { getStripe as defaultGetStripe, type StripeClient } from '../stripeClient.js';
import { stripeRailReady } from '../stripeEnv.js';
import { resolveStripePriceId, type StripeCatalogCurrency } from '../stripeCatalog.js';
import { CHECKOUT_ACK_PROSE_VERSION } from '../acknowledgements.js';
import { isStudentPlan, type CatalogPlan } from '../planCatalog.js';
import { acceptsPromotionCode, usesTwdPrice } from '../planViews.js';
import type { CheckoutOrder, CheckoutResult, PaymentRailImpl } from './types.js';

export type StripeRailDb = Pick<ExtendedPrismaClient, 'seekerSubscription'>;

export interface StripeRailDeps {
  getStripe?: (env: EnvSource) => StripeClient | null;
  getDb?: () => Promise<StripeRailDb>;
  env?: EnvSource;
  /** The clock behind the fallback attempt bucket. */
  now?: () => Date;
}

const defaultGetDb = async (): Promise<StripeRailDb> => (await import('../../../lib/prisma.js')).default;

/** Metadata stamped on every Stripe object we create for a checkout. */
export function stripeCheckoutMetadata(order: CheckoutOrder): Record<string, string> {
  return {
    product: 'roboapply',
    brand: order.brand.id,
    planKey: order.plan.key,
    userId: order.user.id,
    seekerProfileId: order.seekerProfileId,
    autoRenewAck: order.plan.requiresAutoRenewAck ? (order.acknowledgements.autoRenewAck ? 'yes' : 'no') : 'n/a',
    withdrawalWaiver: order.acknowledgements.withdrawalWaiver ? 'yes' : 'no',
    ackVersion: CHECKOUT_ACK_PROSE_VERSION,
    currency: usesTwdPrice(order.plan, order.country) ? 'twd' : order.plan.currency.toLowerCase(),
  };
}

// ── Tax switch ───────────────────────────────────────────────────────────

/** The one switch for Stripe Tax (default unset = off). */
export const STRIPE_TAX_ENV = 'STRIPE_TAX_ENABLED';

/**
 * Stripe Tax is on for this deployment. The one rule for Checkout (automatic
 * tax, tax id collection, required billing address) and for switch quotes
 * (subscriptions.ts `quoteSwitch`).
 */
export function stripeTaxEnabled(env: EnvSource): boolean {
  return parseBoolEnv(env[STRIPE_TAX_ENV]);
}

/** What `STRIPE_TAX_ENABLED` adds to a Checkout Session; with the switch off, only today's address rule. */
export function checkoutTaxParams(env: EnvSource): Pick<Stripe.Checkout.SessionCreateParams, 'automatic_tax' | 'tax_id_collection' | 'billing_address_collection'> {
  if (!stripeTaxEnabled(env)) return { billing_address_collection: 'auto' };
  // `customer_update: { address: 'auto', name: 'auto' }` is always sent below:
  // Stripe requires both for automatic tax and tax ids on an existing customer.
  return { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: 'required' };
}

// ── Checkout attempt → Stripe idempotency key ────────────────────────────

/** What the web may send as `Idempotency-Key` (a UUID fits). */
export const CHECKOUT_ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Width of the fallback bucket: long enough for a double click, short enough that a second purchase is a new session. */
export const CHECKOUT_ATTEMPT_BUCKET_MS = 60_000;

/** The trimmed attempt key when it is well formed, else undefined. */
export function checkoutAttemptKey(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return CHECKOUT_ATTEMPT_KEY_PATTERN.test(value) ? value : undefined;
}

/** `checkout:<userId>:<planKey>:<currency>:<attempt>`; without a usable attempt key, a 60-second bucket. */
export function checkoutIdempotencyKey(input: { userId: string; planKey: string; currency: string; attemptKey?: string | null; now: Date }): string {
  const attempt = checkoutAttemptKey(input.attemptKey) ?? `b${Math.floor(input.now.getTime() / CHECKOUT_ATTEMPT_BUCKET_MS)}`;
  return `checkout:${input.userId}:${input.planKey}:${input.currency.toLowerCase()}:${attempt}`;
}

// ── Locale ───────────────────────────────────────────────────────────────

type CheckoutLocale = NonNullable<Stripe.Checkout.SessionCreateParams['locale']>;

/** App locale (lower case) → Stripe Checkout locale. Anything else lets Stripe choose ('auto'). */
const CHECKOUT_LOCALES: Readonly<Record<string, CheckoutLocale>> = {
  en: 'en',
  zh: 'zh',
  'zh-tw': 'zh-TW',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  de: 'de',
  pt: 'pt-BR',
};

export function stripeCheckoutLocale(appLocale: string | null | undefined): CheckoutLocale {
  const key = (appLocale ?? '').trim().replace('_', '-').toLowerCase();
  return CHECKOUT_LOCALES[key] ?? 'auto';
}

// ── The line above the pay button ────────────────────────────────────────

/** Stripe's limit for `custom_text.submit.message`. */
export const CHECKOUT_SUBMIT_TEXT_MAX = 1200;

/** "$24.99" / "NT$749": the amount as the buyer is charged, from minor units. */
function formatCharge(amountMinor: number, currency: StripeCatalogCurrency): string {
  const major = amountMinor / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

function periodWords(plan: Pick<CatalogPlan, 'interval'>): string {
  if (plan.interval === 'week') return 'week';
  if (plan.interval === 'quarter') return '3 months';
  return 'month';
}

/**
 * Period, price and how to cancel, repeated next to Stripe's pay button. Built
 * from the plan and the amount that is charged, never from copy. English in
 * this wave.
 */
export function checkoutSubmitMessage(plan: Pick<CatalogPlan, 'kind' | 'interval'>, charged: { amountMinor: number; currency: StripeCatalogCurrency }, origin: string): string {
  const price = formatCharge(charged.amountMinor, charged.currency);
  const text =
    plan.kind === 'subscription'
      ? `Renews every ${periodWords(plan)} at ${price} until you cancel. Cancel any time in Settings or at ${origin}/cancel.`
      : `One payment of ${price}. It does not renew.`;
  return text.slice(0, CHECKOUT_SUBMIT_TEXT_MAX);
}

/** Stripe refused a repeated idempotency key because the parameters differ. */
export function isStripeIdempotencyConflict(err: unknown): boolean {
  const e = err as { type?: unknown; rawType?: unknown } | null;
  return e?.type === 'StripeIdempotencyError' || e?.rawType === 'idempotency_error';
}

function providerError(message: string, err: unknown): BillingError {
  if (err instanceof BillingError) return err;
  return new BillingError('payment_provider_error', message, {
    provider: 'stripe',
    ...(isStripeIdempotencyConflict(err) ? { reason: 'idempotency_conflict' } : {}),
    message: err instanceof Error ? err.message.slice(0, 200) : String(err),
  });
}

export function createStripeRail(deps: StripeRailDeps = {}): PaymentRailImpl {
  const getStripe = deps.getStripe ?? defaultGetStripe;
  const getDb = deps.getDb ?? defaultGetDb;
  const now = deps.now ?? (() => new Date());

  async function ensureCustomer(stripe: StripeClient, order: CheckoutOrder): Promise<string> {
    if (order.stripeCustomerId) return order.stripeCustomerId;
    let customer;
    try {
      customer = await stripe.customers.create(
        {
          email: order.user.email,
          metadata: { userId: order.user.id, seekerProfileId: order.seekerProfileId, product: 'roboapply', brand: order.brand.id },
        },
        // One customer per seeker profile, however many requests race here.
        { idempotencyKey: `customer:${order.seekerProfileId}` },
      );
    } catch (err) {
      throw providerError('The payment page could not be opened', err);
    }
    const db = await getDb();
    await db.seekerSubscription.upsert({
      where: { seekerProfileId: order.seekerProfileId },
      update: { stripeCustomerId: customer.id },
      create: { seekerProfileId: order.seekerProfileId, tier: 'free', status: 'active', stripeCustomerId: customer.id, brand: order.brand.id },
    });
    return customer.id;
  }

  return {
    id: 'stripe',
    // A usable key AND a webhook secret (ST-0): a key alone would take money and never fulfil.
    isConfigured: (_brand, env) => stripeRailReady(env),
    async createCheckout(order: CheckoutOrder): Promise<CheckoutResult> {
      const env = deps.env ?? process.env;
      const plan = order.plan;
      // Rule A11, before anything else: Stripe never serves a brand that does
      // not list it. A GoApply plan is sellable with a CNY amount, so the
      // brand is what refuses it here, before a customer or a price exists.
      if (!order.brand.paymentRails.includes('stripe')) {
        throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key, reason: 'rail_not_allowed' });
      }
      const stripe = getStripe(env);
      if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
      if (!plan.sellable || plan.amountMinor === null) {
        throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key, reason: plan.unsellableReason ?? 'unknown' });
      }
      if (isStudentPlan(plan) && order.studentVerified !== true) {
        throw new BillingError('student_verification_required', 'Verify your school email to get the student price', { planKey: plan.key });
      }
      const twd = usesTwdPrice(plan, order.country);
      const currency: StripeCatalogCurrency = twd ? 'TWD' : 'USD';
      const amountMinor = twd ? plan.twdPrice!.amountMinor : plan.amountMinor;
      // A pin, else the price found or created under the plan's lookup key.
      const priceId = await resolveStripePriceId(stripe, plan, currency);
      const customer = await ensureCustomer(stripe, order);
      const metadata = stripeCheckoutMetadata(order);
      const origin = appOrigin(order.brand, env);
      const successPath = order.successPath ?? '/settings/billing/return';
      const cancelPath = order.cancelPath ?? '/settings/billing';
      const success_url = `${origin}${withQueryParam(withQueryParam(successPath, 'billing', 'success'), 'session_id', '{CHECKOUT_SESSION_ID}')}`;
      const cancel_url = `${origin}${withQueryParam(cancelPath, 'billing', 'cancel')}`;
      const subscription = plan.kind === 'subscription';

      let session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: subscription ? 'subscription' : 'payment',
            customer,
            line_items: [{ price: priceId, quantity: 1 }],
            client_reference_id: order.user.id,
            metadata,
            ...(subscription
              ? { subscription_data: { metadata, description: `${order.brand.name} ${plan.defaultLabel}`.slice(0, 500) } }
              : { payment_intent_data: { metadata }, invoice_creation: { enabled: true, invoice_data: { metadata } } }),
            // ST-8: tax fields only with STRIPE_TAX_ENABLED; otherwise the address stays optional.
            ...checkoutTaxParams(env),
            // Keep what the buyer types at checkout on the customer (invoices, tax).
            customer_update: { address: 'auto', name: 'auto' },
            // The buyer pays the currency and amount our plan sheet showed.
            adaptive_pricing: { enabled: false },
            locale: stripeCheckoutLocale(order.locale),
            custom_text: { submit: { message: checkoutSubmitMessage(plan, { amountMinor, currency }, origin) } },
            success_url,
            cancel_url,
            allow_promotion_codes: acceptsPromotionCode(plan, env),
          },
          {
            idempotencyKey: checkoutIdempotencyKey({
              userId: order.user.id,
              planKey: plan.key,
              currency,
              attemptKey: order.attemptKey,
              now: now(),
            }),
          },
        );
      } catch (err) {
        throw providerError('The payment page could not be opened', err);
      }
      if (!session.url) throw new BillingError('payment_provider_error', 'Stripe did not return a checkout URL', { provider: 'stripe' });
      return { kind: 'redirect', url: session.url, orderId: session.id };
    },
  };
}
