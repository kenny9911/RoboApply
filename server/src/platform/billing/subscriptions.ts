// server/src/platform/billing/subscriptions.ts
//
// The user's plan as billing sees it, and the two changes a user makes to an
// auto-renewing plan (PRODUCT_PLAN.md §6.3–§6.5, F-BILL-03):
//
//   cancelSubscription  one click, no survey needed (an optional reason/note
//                       goes to Stripe's cancellation details); access runs to
//                       the period end. Passes never renew, so there is
//                       nothing to cancel ('already_cancelled').
//   quoteSwitch         the legacy "Switch to Pro" sheet: amount charged today
//                       (Stripe proration preview), the new renewal price and
//                       the next renewal date. Charges nothing.
//   confirmSwitch       charges only here, with the quoted proration date so
//                       the amount equals the quote, and only with the
//                       auto-renewal acknowledgement for the new terms
//                       (recorded as `auto_renew_ack` before the charge).
//
// Reads use flat queries (user → seekerProfile → seekerSubscription) so tests
// run on the in-memory fake Prisma.

import type Stripe from 'stripe';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { parseBrandId, type BrandId } from '../brand/registry.js';
import { BillingError } from './errors.js';
import { PLAN_DEFINITIONS, isLegacyPlanKey, isPlanKey, isStudentPlan, type CatalogPlan, type PlanDefinition } from './planCatalog.js';
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
    await stripe.subscriptions.update(sub.stripeSubscriptionId!, {
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
    });
  } catch (err) {
    logger.error('RA_BILLING', 'stripe cancel failed', { userId: account.userId, error: err instanceof Error ? err.message : String(err) });
    throw new BillingError('payment_provider_error', 'The cancellation could not be sent to the payment provider. Try again.', { provider: 'stripe' });
  }
  await deps.db.seekerSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  logger.info('RA_BILLING', 'cancel at period end', { userId: account.userId, planKey: plan.planKey, source: input.source });
  return { status: 'cancelled', accessUntil: plan.accessUntil, planKey: plan.planKey, changed: true };
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
  if (target.kind !== 'subscription' || !target.sellable || !target.stripePriceId || target.amountMinor === null) {
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
 */
export function switchPrice(stripeSub: { currency?: string | null }, target: CatalogPlan): { priceId: string; amountMinor: number } {
  if ((stripeSub.currency ?? '').toLowerCase() === 'twd') {
    if (!target.twdPrice) throw new BillingError('switch_not_available', 'This plan has no Taiwan price yet', { planKey: target.key });
    return { priceId: target.twdPrice.stripePriceId, amountMinor: target.twdPrice.amountMinor };
  }
  return { priceId: target.stripePriceId!, amountMinor: target.amountMinor! };
}

export async function quoteSwitch(account: BillingAccount, target: CatalogPlan, deps: StripeDeps): Promise<SwitchQuote> {
  const now = (deps.now ?? (() => new Date()))();
  const sub = assertSwitchable(account, target, now, deps);
  const stripe = deps.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
  const prorationDate = Math.floor(now.getTime() / 1000);
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  const item = itemOf(stripeSub);
  const price = switchPrice(stripeSub, target);
  const preview = await stripe.invoices.createPreview({
    customer: typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id,
    subscription: stripeSub.id,
    subscription_details: {
      items: [{ id: item.id, price: price.priceId }],
      proration_behavior: 'always_invoice',
      proration_date: prorationDate,
    },
  });
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

export async function confirmSwitch(
  account: BillingAccount,
  target: CatalogPlan,
  prorationDate: number,
  deps: StripeDeps,
  ack: ConfirmSwitchAck,
): Promise<{ planKey: string; stripeSubscriptionId: string }> {
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
  const price = switchPrice(stripeSub, target);
  await ack.record({ amountMinor: price.amountMinor, currency: (stripeSub.currency ?? '').toLowerCase() === 'twd' ? 'TWD' : target.currency });
  await stripe.subscriptions.update(stripeSub.id, {
    items: [{ id: item.id, price: price.priceId }],
    proration_behavior: 'always_invoice',
    proration_date: prorationDate,
    cancel_at_period_end: false,
    metadata: { ...(stripeSub.metadata ?? {}), planKey: target.key, brand: account.brand, tier: 'pro', product: 'roboapply' },
  });
  logger.info('RA_BILLING', 'plan switched', { userId: account.userId, from: sub.planKey ?? sub.tier, to: target.key });
  return { planKey: target.key, stripeSubscriptionId: stripeSub.id };
}

/** Period bounds of a Stripe subscription (item-level on current API versions, top-level on old ones). */
export function stripePeriod(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const start = item?.current_period_start ?? legacy.current_period_start ?? null;
  const end = item?.current_period_end ?? legacy.current_period_end ?? null;
  return { start: start ? new Date(start * 1000) : null, end: end ? new Date(end * 1000) : null };
}
