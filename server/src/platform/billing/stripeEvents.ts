// server/src/platform/billing/stripeEvents.ts
//
// Shared pieces of the Stripe webhook (docs/jobright-clone/market/
// MARKET_STRATEGY.md §5.1, event table), kept apart from the billing service
// so later modules (refunds, disputes, the webhook lifecycle) can add an
// event without editing the service's switch:
//
//   claimBillingEvent           the one-time claim behind every webhook side
//                               effect: a RACreditLedger row whose unique
//                               idempotency key is `billing:<key>`. True the
//                               first time, false on every replay.
//   invoiceSubscriptionId       where an invoice names its subscription, on
//                               old and current API versions.
//   findBillingOwnerByCustomer  "is this Stripe object ours": the account that
//                               holds this Stripe customer id, or null. The
//                               Stripe account may be shared with other
//                               products, so invoices, charges and disputes of
//                               an unknown customer are ignored (HTTP 200).
//   registerStripeEventHandler  the registry the service's webhook asks for
//                               any event type it does not handle itself. A
//                               handler that throws makes the webhook answer
//                               500, so Stripe retries (every step is
//                               replay-safe through the claim).
//
// Nothing here calls Stripe or changes behaviour by being imported.

import type Stripe from 'stripe';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';

/** What the webhook route answers from. */
export interface StripeEventResult {
  handled: boolean;
  /** The event repeated work already done (replayed delivery); nothing changed twice. */
  duplicate?: boolean;
  /** Processing failed; answer 500 so Stripe retries (every step is replay-safe). */
  failed?: boolean;
}

// ── One-time claims ───────────────────────────────────────────────────────

export type BillingClaimDb = Pick<ExtendedPrismaClient, 'rACreditLedger'>;

/** The ledger idempotency key of a claim (`billing:<key>`). */
export function billingEventClaimKey(key: string): string {
  return `billing:${key}`;
}

/**
 * One-time claim for a billing side effect (a checkout session, a failed
 * invoice, a refund). Rows live in the credit ledger under bucket
 * 'billing_event' (status committed, amount 0); the unique idempotency key
 * does the work. Returns true exactly once per key. Works inside a
 * transaction client too.
 */
export async function claimBillingEvent(db: BillingClaimDb, userId: string, key: string, refType: string, now: Date = new Date()): Promise<boolean> {
  const res = await db.rACreditLedger.createMany({
    data: [
      {
        userId,
        bucket: 'billing_event',
        amount: 0,
        status: 'committed',
        fromSource: 'stripe',
        idempotencyKey: billingEventClaimKey(key),
        refType,
        refId: key,
        settledAt: now,
      },
    ],
    skipDuplicates: true,
  });
  return res.count === 1;
}

// ── Reading Stripe objects ────────────────────────────────────────────────

/** Subscription id of an invoice (top-level on old API versions, under `parent` on current ones). */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object') return legacy.id;
  const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }).parent;
  const s = parent?.subscription_details?.subscription;
  if (typeof s === 'string') return s;
  return s && typeof s === 'object' ? s.id : null;
}

// ── Whose object is it ────────────────────────────────────────────────────

export type BillingOwnerDb = Pick<ExtendedPrismaClient, 'user' | 'seekerProfile' | 'seekerSubscription'>;

export interface BillingOwner {
  userId: string;
  email: string | null;
  locale: string | null;
  seekerProfileId: string;
  /** The SeekerSubscription row that holds the customer id. */
  subscription: {
    id: string;
    seekerProfileId: string;
    tier: string;
    status: string;
    planKey: string | null;
    interval: string | null;
    rail: string | null;
    /** A row whose brand is not 'roboapply' is never Stripe's to change (rule A11). */
    brand: string | null;
    currency: string | null;
    amountMinor: number | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  };
}

const OWNER_SUBSCRIPTION_SELECT = {
  id: true,
  seekerProfileId: true,
  tier: true,
  status: true,
  planKey: true,
  interval: true,
  rail: true,
  brand: true,
  currency: true,
  amountMinor: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
} as const;

/**
 * The account behind a Stripe customer id: its SeekerSubscription row plus
 * the user's id, email and locale. Null when no row holds that customer (the
 * object belongs to another product on the same Stripe account, or to nobody
 * we know): the caller then ignores the event. Accepts the id or the expanded
 * customer object, as Stripe sends either.
 */
export async function findBillingOwnerByCustomer(db: BillingOwnerDb, stripeCustomer: string | { id?: string | null } | null | undefined): Promise<BillingOwner | null> {
  const customerId = typeof stripeCustomer === 'string' ? stripeCustomer : (stripeCustomer?.id ?? null);
  if (!customerId) return null;
  const row = await db.seekerSubscription.findFirst({ where: { stripeCustomerId: customerId }, select: OWNER_SUBSCRIPTION_SELECT });
  if (!row) return null;
  const profile = await db.seekerProfile.findUnique({ where: { id: row.seekerProfileId }, select: { userId: true, locale: true } });
  if (!profile) return null;
  const user = await db.user.findUnique({ where: { id: profile.userId }, select: { email: true } });
  return {
    userId: profile.userId,
    email: user?.email ?? null,
    locale: profile.locale ?? null,
    seekerProfileId: row.seekerProfileId,
    subscription: {
      id: row.id,
      seekerProfileId: row.seekerProfileId,
      tier: String(row.tier),
      status: row.status,
      planKey: row.planKey ?? null,
      interval: row.interval ?? null,
      rail: row.rail ?? null,
      brand: row.brand ?? null,
      currency: row.currency ?? null,
      amountMinor: row.amountMinor ?? null,
      stripeCustomerId: row.stripeCustomerId ?? null,
      stripeSubscriptionId: row.stripeSubscriptionId ?? null,
      currentPeriodEnd: row.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
    },
  };
}

// ── Handler registry ──────────────────────────────────────────────────────

/** The tables a webhook handler may touch (the billing service's own set). */
export type StripeEventDb = Pick<
  ExtendedPrismaClient,
  '$transaction' | 'user' | 'seekerProfile' | 'seekerSubscription' | 'alipayOrder' | 'rACreditLedger' | 'seekerConsentRecord' | 'roboApplyMission'
>;

export interface StripeEventContext {
  /** The client the webhook route verified the event with. */
  stripe: Stripe;
  db: StripeEventDb;
  /** The service clock (tests fix it). */
  now: () => Date;
}

export type StripeEventHandler = (event: Stripe.Event, ctx: StripeEventContext) => Promise<StripeEventResult>;

const handlers = new Map<string, StripeEventHandler>();

/**
 * Handle one more Stripe event type. The billing service asks this registry
 * for every type its own switch does not name; a type the service handles
 * itself never reaches a registered handler. Registering a type again
 * replaces its handler (one handler per type).
 */
export function registerStripeEventHandler(type: string, handler: StripeEventHandler): void {
  handlers.set(type, handler);
}

/** The registered handler of an event type, or undefined. */
export function stripeEventHandler(type: string): StripeEventHandler | undefined {
  return handlers.get(type);
}

/** Tests only. */
export function unregisterStripeEventHandlerForTests(type: string): void {
  handlers.delete(type);
}
