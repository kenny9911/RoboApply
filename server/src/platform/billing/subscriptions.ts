// server/src/platform/billing/subscriptions.ts
//
// The user's plan as billing sees it, and the changes a user makes to an
// auto-renewing plan (PRODUCT_PLAN.md §6.3–§6.5, F-BILL-03;
// docs/jobright-clone/market/MARKET_STRATEGY.md §5.1 "Switch", "Cancel and
// resume", "Idempotency keys", "Tax"):
//
//   cancelSubscription  one click, no survey needed (an optional reason/note
//                       goes to Stripe's cancellation details); access runs to
//                       the period end. Passes never renew, so there is
//                       nothing to cancel ('already_cancelled').
//   resumeSubscription  "Keep my plan": turns renewal back on while the period
//                       is live, with the auto-renewal acknowledgement for the
//                       price that is charged (recorded before Stripe is
//                       asked). A pass, a plan whose period ended and a plan
//                       that still renews have nothing to resume.
//   quoteSwitch         the "Switch plan" sheet: amount charged today (Stripe
//                       proration preview), the new renewal price and the next
//                       renewal date. Charges nothing.
//   confirmSwitch       charges only here, with the quoted proration date so
//                       the amount equals the quote, and only with the
//                       auto-renewal acknowledgement for the new terms
//                       (recorded as `auto_renew_ack` before the charge). The
//                       plan changes only if the proration is paid
//                       (`payment_behavior: 'pending_if_incomplete'`): a
//                       declined or unauthenticated payment leaves the plan as
//                       it was and answers `requiresAction` with Stripe's
//                       hosted invoice page.
//
// Every write to Stripe here carries an idempotency key (see
// `renewalChangeIdempotencyKey` and `confirmSwitch`).
//
// Reads use flat queries (user → seekerProfile → seekerSubscription) so tests
// run on the in-memory fake Prisma.

import type Stripe from 'stripe';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import type { EnvSource } from '../brand/brandEnv.js';
import { getBrand, parseBrandId, type BrandId } from '../brand/registry.js';
import { BillingError } from './errors.js';
import { PLAN_DEFINITIONS, isLegacyPlanKey, isPlanKey, isStudentPlan, type CatalogPlan, type PlanDefinition } from './planCatalog.js';
import { isStripeIdempotencyConflict, stripeTaxEnabled } from './rails/stripe.js';
import { resolveStripePriceId, type StripeCatalogCurrency } from './stripeCatalog.js';
import type { StripeClient } from './stripeClient.js';

export type BillingDb = Pick<ExtendedPrismaClient, 'user' | 'seekerProfile' | 'seekerSubscription'>;

export interface SubscriptionRow {
  id: string;
  tier: string;
  status: string;
  planKey: string | null;
  interval: string | null;
  rail: string | null;
  brand: string | null;
  market: string | null;
  currency: string | null;
  amountMinor: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  startedAt: Date | null;
  billingCountry: string | null;
  /**
   * When the row was last written (Prisma `@updatedAt`). Part of the cancel /
   * resume idempotency key, so a later change of the same kind never repeats
   * the key of an earlier one. Absent on rows built by hand.
   */
  updatedAt?: Date | null;
}

export interface BillingAccount {
  userId: string;
  email: string;
  name: string | null;
  brand: BrandId;
  seekerProfileId: string | null;
  locale: string | null;
  market: string | null;
  subscription: SubscriptionRow | null;
}

const SUB_SELECT = {
  id: true,
  tier: true,
  status: true,
  planKey: true,
  interval: true,
  rail: true,
  brand: true,
  market: true,
  currency: true,
  amountMinor: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  stripePriceId: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  startedAt: true,
  billingCountry: true,
  updatedAt: true,
} as const;

export function toSubscriptionRow(raw: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(raw.id),
    tier: String(raw.tier ?? 'free'),
    status: String(raw.status ?? 'active'),
    planKey: (raw.planKey as string | null) ?? null,
    interval: (raw.interval as string | null) ?? null,
    rail: (raw.rail as string | null) ?? null,
    brand: (raw.brand as string | null) ?? null,
    market: (raw.market as string | null) ?? null,
    currency: (raw.currency as string | null) ?? null,
    amountMinor: (raw.amountMinor as number | null) ?? null,
    stripeCustomerId: (raw.stripeCustomerId as string | null) ?? null,
    stripeSubscriptionId: (raw.stripeSubscriptionId as string | null) ?? null,
    stripePriceId: (raw.stripePriceId as string | null) ?? null,
    currentPeriodEnd: (raw.currentPeriodEnd as Date | null) ?? null,
    cancelAtPeriodEnd: Boolean(raw.cancelAtPeriodEnd),
    startedAt: (raw.startedAt as Date | null) ?? null,
    billingCountry: (raw.billingCountry as string | null) ?? null,
    updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt : null,
  };
}

export async function loadBillingAccount(db: BillingDb, userId: string): Promise<BillingAccount | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, brand: true } });
  if (!user) return null;
  const profile = await db.seekerProfile.findUnique({ where: { userId }, select: { id: true, locale: true, market: true } });
  const sub = profile ? await db.seekerSubscription.findUnique({ where: { seekerProfileId: profile.id }, select: SUB_SELECT }) : null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
    brand: parseBrandId(user.brand) ?? 'roboapply',
    seekerProfileId: profile?.id ?? null,
    locale: profile?.locale ?? null,
    market: profile?.market ?? null,
    subscription: sub ? toSubscriptionRow(sub as unknown as Record<string, unknown>) : null,
  };
}

// ── What the user has ────────────────────────────────────────────────────

export type PlanState = 'free' | 'subscription' | 'pass' | 'legacy_subscription' | 'legacy_pass';

export interface PlanStatus {
  state: PlanState;
  planKey: string;
  /** Live right now (paid features on). */
  live: boolean;
  /** Renews automatically (and has not been cancelled). */
  autoRenews: boolean;
  cancelAtPeriodEnd: boolean;
  /** Stripe is retrying a failed renewal; features stay on until the last retry. */
  paymentFailed: boolean;
  accessUntil: Date | null;
  definition: PlanDefinition | null;
}

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function planDefinitionFor(brand: BrandId, planKey: string | null | undefined): PlanDefinition | null {
  if (!isPlanKey(planKey)) return null;
  return PLAN_DEFINITIONS[brand].find((d) => d.key === planKey) ?? PLAN_DEFINITIONS.roboapply.find((d) => d.key === planKey) ?? null;
}

export function describePlan(account: Pick<BillingAccount, 'brand' | 'subscription'>, now: Date): PlanStatus {
  const sub = account.subscription;
  const free: PlanStatus = {
    state: 'free',
    planKey: 'free',
    live: false,
    autoRenews: false,
    cancelAtPeriodEnd: false,
    paymentFailed: false,
    accessUntil: null,
    definition: null,
  };
  if (!sub || sub.tier === 'free') return free;
  const ended = sub.currentPeriodEnd ? sub.currentPeriodEnd.getTime() <= now.getTime() : false;
  const live = LIVE_STATUSES.has(sub.status) && !ended;
  if (!live) return free;
  const legacyKey = isLegacyPlanKey(sub.tier) ? sub.tier : isLegacyPlanKey(sub.planKey) ? sub.planKey : null;
  const brand = parseBrandId(sub.brand) ?? account.brand;
  const def = planDefinitionFor(brand, sub.planKey);
  const stripeRenewing = Boolean(sub.stripeSubscriptionId);
  if (legacyKey) {
    return {
      state: stripeRenewing ? 'legacy_subscription' : 'legacy_pass',
      planKey: legacyKey,
      live,
      autoRenews: stripeRenewing && !sub.cancelAtPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      paymentFailed: sub.status === 'past_due',
      accessUntil: sub.currentPeriodEnd,
      definition: null,
    };
  }
  const isPass = def ? !def.autoRenews : !stripeRenewing;
  return {
    state: isPass ? 'pass' : 'subscription',
    planKey: sub.planKey ?? (isPass ? 'pro_week_pass' : 'pro_monthly'),
    live,
    autoRenews: !isPass && stripeRenewing && !sub.cancelAtPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    paymentFailed: sub.status === 'past_due',
    accessUntil: sub.currentPeriodEnd,
    definition: def,
  };
}

// ── Cancel ───────────────────────────────────────────────────────────────

export interface CancelInput {
  reason?: string;
  note?: string;
  source: 'in_app' | 'public_link' | 'legacy_route';
}

export interface CancelOutcome {
  status: 'cancelled' | 'already_cancelled';
  accessUntil: Date | null;
  planKey: string;
  /** True when this call turned auto-renewal off (send the confirmation email). */
  changed: boolean;
}

const STRIPE_FEEDBACK = new Set([
  'customer_service',
  'low_quality',
  'missing_features',
  'other',
  'switched_service',
  'too_complex',
  'too_expensive',
  'unused',
]);

export interface StripeDeps {
  getStripe: () => StripeClient | null;
  db: BillingDb;
  now?: () => Date;
  /**
   * The account holds a live student verification (WP-79). A switch TO a
   * student plan is refused unless this is exactly `true`.
   */
  studentVerified?: boolean;
  /** Read for `STRIPE_TAX_ENABLED` (when it is on, a switch quote asks for automatic tax if the subscription carries it). Default: `process.env`. */
  env?: EnvSource;
}

// ── Stripe failures and idempotency keys of this module ─────────────────

/** Logs the Stripe failure (never the request) and answers the 502 the routes send. */
function providerFailure(what: string, message: string, userId: string, err: unknown): BillingError {
  if (err instanceof BillingError) return err;
  logger.error('RA_BILLING', `stripe ${what} failed`, { userId, error: err instanceof Error ? err.message : String(err) });
  return new BillingError('payment_provider_error', message, {
    provider: 'stripe',
    ...(isStripeIdempotencyConflict(err) ? { reason: 'idempotency_conflict' } : {}),
  });
}

/** Width of the retry window of a cancel / resume key: long enough for a double click. */
export const RENEWAL_CHANGE_RETRY_MS = 60_000;

/**
 * The Stripe idempotency key of a cancel or a resume:
 * `<cancel|resume>:<subscription>:<period end, Unix seconds>:v<row version>:b<minute>`.
 *
 * The first three parts are MARKET_STRATEGY §5.1 "Idempotency keys". They are
 * not enough for a setting that can be turned off and on again: Stripe answers
 * a repeated key with the STORED answer of the first request for at least 24
 * hours, failures included, without doing anything. With the three parts alone
 *   - cancel → "Keep my plan" → cancel again in one period would replay the
 *     first cancel's answer: we would say "cancelled" while Stripe still
 *     renews and charges;
 *   - a cancel that Stripe answered with a 500 could not be retried for a day.
 * So two more parts:
 *   - the row version (`updatedAt` of our subscription row, which every cancel
 *     and resume writes): a later change of the same kind gets a new key;
 *   - a one-minute bucket: a retry after a failure is a new request soon.
 * Two clicks at once read the same row in the same minute and send one key.
 */
export function renewalChangeIdempotencyKey(
  verb: 'cancel' | 'resume',
  sub: Pick<SubscriptionRow, 'stripeSubscriptionId' | 'currentPeriodEnd' | 'updatedAt'>,
  now: Date,
): string {
  const periodEnd = sub.currentPeriodEnd ? Math.floor(sub.currentPeriodEnd.getTime() / 1000) : 0;
  const version = sub.updatedAt ? sub.updatedAt.getTime() : 0;
  const bucket = Math.floor(now.getTime() / RENEWAL_CHANGE_RETRY_MS);
  return `${verb}:${sub.stripeSubscriptionId ?? ''}:${periodEnd}:v${version}:b${bucket}`;
}

/** Rule A11: Stripe never serves a brand that does not list it. */
function stripeServes(brand: BrandId): boolean {
  return getBrand(brand).paymentRails.includes('stripe');
}

export async function cancelSubscription(account: BillingAccount, input: CancelInput, deps: StripeDeps): Promise<CancelOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const plan = describePlan(account, now);
  const sub = account.subscription;
  if (!plan.live || !sub) throw new BillingError('no_subscription', 'There is no paid plan to cancel');
  if (!plan.autoRenews) {
    // Passes never renew; an already-cancelled subscription has nothing left to stop.
    return { status: 'already_cancelled', accessUntil: plan.accessUntil, planKey: plan.planKey, changed: false };
  }
  const stripe = deps.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
  const feedback = input.reason && STRIPE_FEEDBACK.has(input.reason) ? input.reason : input.reason ? 'other' : undefined;
  try {
    await stripe.subscriptions.update(
      sub.stripeSubscriptionId!,
      {
        cancel_at_period_end: true,
        ...(feedback || input.note
          ? {
              cancellation_details: {
                ...(feedback ? { feedback: feedback as Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback } : {}),
                ...(input.note ? { comment: input.note.slice(0, 500) } : {}),
              },
            }
          : {}),
        metadata: { cancelSource: input.source },
      },
      { idempotencyKey: renewalChangeIdempotencyKey('cancel', sub, now) },
    );
  } catch (err) {
    throw providerFailure('cancel', 'The cancellation could not be sent to the payment provider. Try again.', account.userId, err);
  }
  await deps.db.seekerSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  logger.info('RA_BILLING', 'cancel at period end', { userId: account.userId, planKey: plan.planKey, source: input.source });
  return { status: 'cancelled', accessUntil: plan.accessUntil, planKey: plan.planKey, changed: true };
}

// ── Resume ("Keep my plan") ──────────────────────────────────────────────

/** The plan that keeps renewing, at the price and currency that is charged. */
export interface ResumeCharge {
  planKey: string;
  interval: PlanDefinition['interval'];
  /** Minor units of `currency`. */
  amountMinor: number;
  currency: string;
}

export interface ResumeAck {
  /** The user ticked "I agree this renews automatically every {period} at {price} until I cancel". */
  autoRenewAck: boolean;
  /** Writes the consent record; runs after every check and before Stripe is asked to turn renewal back on. */
  record: (charged: ResumeCharge) => Promise<unknown>;
}

export interface ResumeOutcome {
  status: 'resumed';
  planKey: string;
  /** The next renewal (the end of the running period). */
  renewsAt: Date | null;
}

/**
 * What the plan renews at. Our row knows it (the webhook stores the amount
 * and currency of the subscription's price); when it does not, Stripe is
 * asked, because the acknowledgement must name the price that is charged and
 * a catalog amount may differ from an older subscriber's price.
 */
async function renewalPrice(stripe: StripeClient, sub: SubscriptionRow, userId: string): Promise<{ amountMinor: number; currency: string }> {
  if (sub.amountMinor !== null && sub.amountMinor > 0 && sub.currency) return { amountMinor: sub.amountMinor, currency: sub.currency.toUpperCase() };
  let price: Stripe.Price | undefined;
  try {
    price = (await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!)).items?.data?.[0]?.price;
  } catch (err) {
    throw providerFailure('resume (price lookup)', 'Your plan could not be reached at the payment provider. Try again.', userId, err);
  }
  if (typeof price?.unit_amount !== 'number' || price.unit_amount <= 0 || !price.currency) {
    logger.error('RA_BILLING', 'resume: the subscription has no fixed price to acknowledge', { userId });
    throw new BillingError('payment_provider_error', 'Your renewal price could not be confirmed. Try again.', { provider: 'stripe', reason: 'renewal_price_unknown' });
  }
  return { amountMinor: price.unit_amount, currency: price.currency.toUpperCase() };
}

/**
 * Turn auto-renewal back on for a plan that was cancelled and is still
 * running. Order: every refusal first, then the acknowledgement record, then
 * Stripe, then our row. A failed Stripe call leaves the row cancelled.
 */
export async function resumeSubscription(account: BillingAccount, deps: StripeDeps, ack: ResumeAck): Promise<ResumeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const plan = describePlan(account, now);
  const sub = account.subscription;
  const definition = plan.definition;
  // Nothing to resume: no live plan (free, or the period ended), a pass or a
  // one-time purchase (nothing renews), a plan that still renews, a legacy
  // plan (it has no terms to acknowledge), and any account Stripe does not
  // serve (rule A11: a GoApply account never reaches Stripe).
  if (
    !sub ||
    !plan.live ||
    !sub.stripeSubscriptionId ||
    !sub.cancelAtPeriodEnd ||
    !definition?.autoRenews ||
    !stripeServes(account.brand) ||
    !stripeServes(parseBrandId(sub.brand) ?? account.brand)
  ) {
    throw new BillingError('nothing_to_resume', 'There is no cancelled plan to keep');
  }
  if (ack.autoRenewAck !== true) {
    throw new BillingError('auto_renew_ack_required', 'Tick the box to agree that this plan renews automatically');
  }
  const stripe = deps.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
  const price = await renewalPrice(stripe, sub, account.userId);
  await ack.record({ planKey: plan.planKey, interval: definition.interval, amountMinor: price.amountMinor, currency: price.currency });
  try {
    await stripe.subscriptions.update(
      sub.stripeSubscriptionId,
      // The empty string removes our cancel marker, so a later cancellation in
      // Stripe's portal is recognised as one made outside the app.
      { cancel_at_period_end: false, metadata: { cancelSource: '' } },
      { idempotencyKey: renewalChangeIdempotencyKey('resume', sub, now) },
    );
  } catch (err) {
    throw providerFailure('resume', 'Your plan could not be kept at the payment provider. Try again.', account.userId, err);
  }
  await deps.db.seekerSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
  logger.info('RA_BILLING', 'renewal resumed', { userId: account.userId, planKey: plan.planKey });
  return { status: 'resumed', planKey: plan.planKey, renewsAt: plan.accessUntil };
}

// ── Switch (legacy → Pro, or between Pro intervals) ──────────────────────

export interface SwitchQuote {
  planKey: string;
  currency: string;
  /** Charged today when you confirm (proration), minor units. */
  amountDueTodayMinor: number;
  /** The new plan's renewal price, minor units. */
  newRenewalPriceMinor: number;
  /** When the new price is next charged. */
  nextRenewalDate: string;
  /** Pass back on confirm (Unix seconds); the quote holds for an hour. */
  prorationDate: number;
}

export const QUOTE_TTL_SEC = 3600;

function itemOf(sub: Stripe.Subscription): Stripe.SubscriptionItem {
  const item = sub.items?.data?.[0];
  if (!item) throw new BillingError('switch_not_available', 'This subscription has no plan item');
  return item;
}

function assertSwitchable(account: BillingAccount, target: CatalogPlan, now: Date, deps: Pick<StripeDeps, 'studentVerified'>): SubscriptionRow {
  const plan = describePlan(account, now);
  const sub = account.subscription;
  if (!sub || !plan.live || !sub.stripeSubscriptionId) throw new BillingError('no_subscription', 'There is no auto-renewing plan to switch');
  // A sellable subscription with an amount is switchable: its Stripe price is
  // resolved by the catalog sync (a pin is optional).
  if (target.kind !== 'subscription' || !target.sellable || target.amountMinor === null) {
    throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: target.key });
  }
  if (sub.planKey === target.key) throw new BillingError('switch_not_available', 'You are already on this plan');
  if (isStudentPlan(target) && deps.studentVerified !== true) {
    throw new BillingError('student_verification_required', 'Verify your school email to get the student price', { planKey: target.key });
  }
  return sub;
}

/**
 * The target price in the running subscription's currency: a Taiwan (TWD)
 * subscription switches to the target's TWD price, or not at all (Stripe
 * cannot mix currencies on one subscription, and we never guess a price).
 * The price id is a pin from the environment, else the price the catalog
 * sync finds or creates (stripeCatalog.ts); the amount is the catalog's.
 */
export async function switchPriceFor(
  stripe: StripeClient,
  stripeSub: { currency?: string | null },
  target: CatalogPlan,
): Promise<{ priceId: string; amountMinor: number; currency: StripeCatalogCurrency }> {
  if ((stripeSub.currency ?? '').toLowerCase() === 'twd') {
    if (!target.twdPrice) throw new BillingError('switch_not_available', 'This plan has no Taiwan price yet', { planKey: target.key });
    return { priceId: await resolveStripePriceId(stripe, target, 'TWD'), amountMinor: target.twdPrice.amountMinor, currency: 'TWD' };
  }
  if (target.amountMinor === null) throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: target.key });
  return { priceId: await resolveStripePriceId(stripe, target, 'USD'), amountMinor: target.amountMinor, currency: 'USD' };
}

/** Stripe Tax could not place the customer (no address, or one it cannot use). */
function isTaxLocationError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'customer_tax_location_invalid';
}

export async function quoteSwitch(account: BillingAccount, target: CatalogPlan, deps: StripeDeps): Promise<SwitchQuote> {
  const now = (deps.now ?? (() => new Date()))();
  const sub = assertSwitchable(account, target, now, deps);
  const stripe = deps.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
  const prorationDate = Math.floor(now.getTime() / 1000);
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  const item = itemOf(stripeSub);
  const price = await switchPriceFor(stripe, stripeSub, target);
  const previewParams: Stripe.InvoiceCreatePreviewParams = {
    customer: typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id,
    subscription: stripeSub.id,
    subscription_details: {
      items: [{ id: item.id, price: price.priceId }],
      proration_behavior: 'always_invoice',
      proration_date: prorationDate,
    },
  };
  // ST-8: the quote is computed under the tax setting the CHARGE will use.
  // The charge is an update of this subscription, and a pending update cannot
  // turn automatic tax on (see confirmSwitch), so the charge has automatic tax
  // exactly when the subscription already carries it. With the switch on, the
  // quote asks for it in that case and only then: a subscriber from before the
  // switch was turned on is quoted without it, as they are charged.
  const withTax = stripeTaxEnabled(deps.env ?? process.env) && stripeSub.automatic_tax?.enabled === true;
  let preview: Stripe.Invoice;
  try {
    preview = await stripe.invoices.createPreview(withTax ? { ...previewParams, automatic_tax: { enabled: true } } : previewParams);
  } catch (err) {
    // A safety net: the customer's address may have become one Stripe Tax
    // cannot use. Our prices are tax-inclusive, so the amount due is the same
    // without the tax lines: quote it that way instead of failing. Every
    // other error is thrown as before.
    if (!withTax || !isTaxLocationError(err)) throw err;
    logger.warn('RA_BILLING', 'switch quote: no usable tax location; quoted without automatic tax', { userId: account.userId });
    preview = await stripe.invoices.createPreview(previewParams);
  }
  const priceIdOf = price.priceId;
  const newLine = preview.lines?.data?.find((l) => {
    const price = (l as unknown as { pricing?: { price_details?: { price?: string } }; price?: { id?: string } | null });
    return price.pricing?.price_details?.price === priceIdOf || price.price?.id === priceIdOf;
  });
  const periodEnd = newLine?.period?.end ?? item.current_period_end;
  return {
    planKey: target.key,
    currency: (preview.currency ?? target.currency).toUpperCase(),
    amountDueTodayMinor: Math.max(0, preview.amount_due ?? 0),
    newRenewalPriceMinor: price.amountMinor,
    nextRenewalDate: new Date(periodEnd * 1000).toISOString(),
    prorationDate,
  };
}

export interface ConfirmSwitchAck {
  /** The user ticked "I agree this renews automatically every {period} at {price} until I cancel". */
  autoRenewAck: boolean;
  /**
   * Writes the consent record(s); runs after every check and before Stripe is
   * asked to charge. Gets the renewal price that will be charged (the TWD
   * amount on a Taiwan subscription), so the record names that price.
   */
  record: (charged: { amountMinor: number; currency: string }) => Promise<unknown>;
}

export interface ConfirmSwitchResult {
  planKey: string;
  stripeSubscriptionId: string;
  /**
   * True when the proration is not paid yet (declined, or the bank asks the
   * buyer to authenticate): the plan is UNCHANGED and changes only once the
   * invoice behind `hostedInvoiceUrl` is paid.
   */
  requiresAction: boolean;
  /** Stripe's hosted page of that invoice. Sent only with `requiresAction: true`; null when Stripe gave none. */
  hostedInvoiceUrl?: string | null;
}

/** `switch:<subscription>:<planKey>:<prorationDate>`: confirming one quote twice is one request to Stripe. */
export function switchIdempotencyKey(stripeSubscriptionId: string, planKey: string, prorationDate: number): string {
  return `switch:${stripeSubscriptionId}:${planKey}:${prorationDate}`;
}

/**
 * The open invoice of a pending update: its hosted page, and whether it has
 * been paid since. A repeated confirm gets Stripe's stored first answer, which
 * still shows the pending update after the buyer paid on the hosted page; the
 * invoice says what is true now. That only matters in the short time before
 * the webhook writes the new plan to our row: after it, a repeated confirm is
 * refused earlier ('switch_not_available', the account is already on the
 * plan), so a page reads the plan again after payment instead of confirming
 * again. A failed read answers no link: the plan is unchanged either way.
 */
async function pendingUpdateInvoice(stripe: StripeClient, updated: Stripe.Subscription, userId: string): Promise<{ url: string | null; paid: boolean }> {
  const latest = updated.latest_invoice;
  const invoiceId = typeof latest === 'string' ? latest : (latest?.id ?? null);
  if (!invoiceId) return { url: null, paid: false };
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    return { url: invoice.hosted_invoice_url ?? null, paid: invoice.status === 'paid' };
  } catch (err) {
    logger.warn('RA_BILLING', 'switch: the open invoice could not be read', { userId, error: err instanceof Error ? err.message : String(err) });
    return { url: null, paid: false };
  }
}

export async function confirmSwitch(
  account: BillingAccount,
  target: CatalogPlan,
  prorationDate: number,
  deps: StripeDeps,
  ack: ConfirmSwitchAck,
): Promise<ConfirmSwitchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const sub = assertSwitchable(account, target, now, deps);
  // The new plan renews on new terms (price and interval), so it needs its own
  // acknowledgement, exactly like a new checkout (PRODUCT §6.3, H24).
  if (target.requiresAutoRenewAck && ack.autoRenewAck !== true) {
    throw new BillingError('auto_renew_ack_required', 'Tick the box to agree that this plan renews automatically');
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  if (!Number.isInteger(prorationDate) || prorationDate > nowSec + 60 || nowSec - prorationDate > QUOTE_TTL_SEC) {
    throw new BillingError('quote_expired', 'The quote is out of date. Review the new amount and confirm again.');
  }
  const stripe = deps.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  const item = itemOf(stripeSub);
  const price = await switchPriceFor(stripe, stripeSub, target);
  await ack.record({ amountMinor: price.amountMinor, currency: (stripeSub.currency ?? '').toLowerCase() === 'twd' ? 'TWD' : target.currency });
  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      stripeSub.id,
      {
        items: [{ id: item.id, price: price.priceId }],
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
        // The plan changes only if the proration is paid (ST-5, PAY S10).
        // Until then the change waits in `pending_update`. Only parameters
        // that pending updates support may be sent with this behaviour, or
        // Stripe refuses the whole update: items, the proration fields,
        // `cancel_at_period_end` and `metadata` are (each is a field of
        // `Stripe.Subscription.PendingUpdate` in the installed SDK);
        // `automatic_tax` is not, so it is not sent here (ST-8; a
        // subscription created by a tax-enabled Checkout already carries
        // automatic tax). The webhook reads the plan from the price first, so
        // it does not matter when Stripe applies the metadata.
        payment_behavior: 'pending_if_incomplete',
        // A switch turns renewal back on (a cancelled, still running plan can
        // be switched), so it clears our cancel marker exactly as "Keep my
        // plan" does: a later cancellation in Stripe's portal is then
        // recognised as one made outside the app.
        cancel_at_period_end: false,
        metadata: { ...(stripeSub.metadata ?? {}), planKey: target.key, brand: account.brand, tier: 'pro', product: 'roboapply', cancelSource: '' },
      },
      { idempotencyKey: switchIdempotencyKey(stripeSub.id, target.key, prorationDate) },
    );
  } catch (err) {
    throw providerFailure('switch', 'The plan change could not be sent to the payment provider. Try again.', account.userId, err);
  }
  if (updated?.pending_update) {
    const invoice = await pendingUpdateInvoice(stripe, updated, account.userId);
    if (!invoice.paid) {
      logger.info('RA_BILLING', 'plan switch waits for payment; plan unchanged', { userId: account.userId, from: sub.planKey ?? sub.tier, to: target.key });
      return { planKey: target.key, stripeSubscriptionId: stripeSub.id, requiresAction: true, hostedInvoiceUrl: invoice.url };
    }
  }
  logger.info('RA_BILLING', 'plan switched', { userId: account.userId, from: sub.planKey ?? sub.tier, to: target.key });
  return { planKey: target.key, stripeSubscriptionId: stripeSub.id, requiresAction: false };
}

/** Period bounds of a Stripe subscription (item-level on current API versions, top-level on old ones). */
export function stripePeriod(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const start = item?.current_period_start ?? legacy.current_period_start ?? null;
  const end = item?.current_period_end ?? legacy.current_period_end ?? null;
  return { start: start ? new Date(start * 1000) : null, end: end ? new Date(end * 1000) : null };
}
