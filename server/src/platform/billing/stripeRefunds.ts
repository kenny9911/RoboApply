// server/src/platform/billing/stripeRefunds.ts
//
// The refund engine of the Stripe rail (RoboApply only; requirements ST-4 and
// ST-9; docs/jobright-clone/market/MARKET_STRATEGY.md §4.4 "How a refund is
// executed", "Statutory withdrawal" and §5.1 "Refunds and disputes").
//
//   issueRefund        sends one refund to Stripe for an invoice or a one-time
//                      Checkout Session of the user. It changes NO entitlement
//                      and writes nothing: access changes only when Stripe
//                      tells us the money went back (`charge.refunded`), so a
//                      refund made in the Stripe Dashboard behaves the same.
//   charge.refunded    the webhook: one readable RABillingRefund row per
//                      refund, and for a FULL refund the reversal of what the
//                      charge bought. A partial refund is recorded and changes
//                      no access.
//   charge.dispute.created
//                      reversed like a full refund and flagged with a row of
//                      kind 'dispute' (the admin console lists them).
//   withdrawalQuote    the statutory withdrawal (EU, EEA, UK, Taiwan; 14 days)
//   withdrawPurchase   for the user's latest paid Stripe purchase: the quote,
//                      and the execution. A withdrawal ends the subscription
//                      FIRST and then refunds, so access ends whatever amount
//                      goes back: it is the one partial refund that ends access.
//
// What a full refund reverses:
//   a practice pack    what is left of that pack leaves the practice balance
//                      and the grant row is set to 0 (used credits are gone;
//                      the balance never goes below 0);
//   the running pass   one pass length comes off the end date; when nothing is
//                      left the plan ends now and the practice balance goes
//                      back to the Free allotment (passes stack, so a refunded
//                      pass under another pass shortens access, it does not
//                      end it). Only a pass that is part of the run that is
//                      live now: a pass that was bought, used and over before
//                      this run started takes nothing off a newer pass;
//   a subscription     the subscription is cancelled now (access ends through
//                      `customer.subscription.deleted`) and the period's
//                      practice credits go back to the Free allotment.
//
// Replays and concurrent deliveries. Stripe sends an event more than once and
// sometimes twice at the same moment, so every step holds on its own:
//   - the event claim (`billing:refund:<charge>:<amount_refunded>`,
//     `billing:dispute:<dispute>`) says whether a delivery is the first one;
//   - the refund row is unique on (rail, externalRef);
//   - a pack is reversed by whoever wins the conditional update of its grant
//     row; a pass by whoever takes `billing:reversal:<charge>` in the same
//     transaction as the row change; the Stripe cancel carries an idempotency
//     key and an already cancelled subscription is success;
//   - the mail has its own claim.
// A delivery that failed half way (the webhook answered 500) is finished by
// the next one: a replay returns early only when the row says the work is
// done. One charge is reversed once, whether a refund or a dispute comes first.
//
// GoApply: Stripe never serves it. `issueRefund`, `withdrawalQuote` and
// `withdrawPurchase` refuse a GoApply account before any Stripe call, and the
// webhook never changes a row whose brand is not 'roboapply' (rule A11).
//
// Every Stripe call goes through `getStripe` (stripeClient.ts); the webhook
// uses the client the route verified the event with. Money is integer minor
// units throughout. Dependencies are injectable; the defaults are imported on
// first use, so importing this module only registers the two event handlers
// and the two mail templates.

import type Stripe from 'stripe';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import type {
  adjustCredits as defaultAdjustCredits,
  allocatePackRemaining as defaultAllocatePackRemaining,
  grantForPlan as defaultGrantForPlan,
} from '../../lib/mockCreditService.js';
import { logger } from '../../services/LoggerService.js';
import type { BrandId } from '../brand/registry.js';
import type { RefundIssuedParams, WithdrawalConfirmedParams } from '../email/templates/billing/refunds.js';
import '../email/templates/billing/refunds.js';
import { BillingError } from './errors.js';
import { packGrantId } from './packs.js';
import { computeRefund, isWithdrawalRule, type RefundDecision, type WithdrawalRule } from './refunds.js';
import { getStripe as platformGetStripe, type StripeClient } from './stripeClient.js';
import {
  billingEventClaimKey,
  claimBillingEvent,
  findBillingOwnerByCustomer,
  invoiceSubscriptionId,
  registerStripeEventHandler,
  type BillingOwner,
  type StripeEventContext,
  type StripeEventResult,
} from './stripeEvents.js';
import { loadBillingAccount, planDefinitionFor, stripePeriod, type BillingAccount } from './subscriptions.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** What a refund is made against: a paid invoice, or a one-time Checkout Session. */
export type RefundTarget = { invoiceId: string } | { checkoutSessionId: string };

/** 'withdrawal' marks the refund of a statutory withdrawal (`withdrawPurchase`). */
export type RefundKind = 'refund' | 'withdrawal';

export interface IssueRefundInput {
  userId: string;
  target: RefundTarget;
  /** Minor units; omitted = everything that is still refundable. */
  amountMinor?: number;
  /** Why (staff text or 'withdrawal'); kept on the Stripe refund and on our row. */
  reason: string;
  /** An admin's user id, 'self' or 'public_link'. */
  actor: string;
  kind?: RefundKind;
}

export interface IssuedRefund {
  refundId: string;
  paymentIntentId: string;
  chargeId: string | null;
  amountMinor: number;
  currency: string;
  /** Nothing of the payment is left to refund after this one. */
  full: boolean;
}

/** The purchase a withdrawal is about (the paid Stripe invoice). */
export interface WithdrawalPurchase {
  source: 'stripe';
  /** The invoice id; pass it back as `purchaseId`. */
  id: string;
  planKey: string;
  chargedAt: string;
  amountMinor: number;
  currency: string;
}

export interface WithdrawalQuote {
  purchase: WithdrawalPurchase;
  /** Always eligible, under rule `withdrawal_14d` or `withdrawal_14d_prorata`. */
  decision: RefundDecision;
}

export interface WithdrawPurchaseInput {
  userId: string;
  /** `WithdrawalQuote.purchase.id` as quoted. */
  purchaseId: string;
  /** 'self' or 'public_link'. */
  actor: string;
}

export interface WithdrawalResult {
  status: 'withdrawn';
  refundMinor: number;
  currency: string;
  accessEnded: true;
  rule: WithdrawalRule;
}

/** What reversing a refunded purchase did to the account. */
export type ReversalOutcome = 'pack_zeroed' | 'pass_ended' | 'pass_shortened' | 'subscription_cancelled' | 'none';

export type RefundDb = Pick<
  ExtendedPrismaClient,
  '$transaction' | 'user' | 'seekerProfile' | 'seekerSubscription' | 'seekerConsentRecord' | 'rACreditLedger' | 'rACreditGrant' | 'rABillingRefund'
>;

export interface RefundEmailInput {
  template: 'billing.refund_issued' | 'billing.withdrawal_confirmed';
  to: string;
  userId?: string | null;
  locale?: string | null;
  brand?: BrandId;
  params: RefundIssuedParams | WithdrawalConfirmedParams;
}

export interface StripeRefundDeps {
  /** The database, or how to get it (the default imports the Prisma client on first use). */
  db: RefundDb | (() => RefundDb | Promise<RefundDb>);
  getStripe: () => StripeClient | null;
  now: () => Date;
  sendEmail: (input: RefundEmailInput) => Promise<unknown>;
  invalidate: (userId: string) => void | Promise<void>;
  /** lib/mockCreditService.ts `adjustCredits`: moves the practice balance and writes its ledger row. */
  adjustCredits: typeof defaultAdjustCredits;
  /** lib/mockCreditService.ts `grantForPlan`: sets the practice balance to an allotment (plus unspent packs). */
  grantForPlan: typeof defaultGrantForPlan;
  /** lib/mockCreditService.ts `allocatePackRemaining`: how much of each pack is unspent, given the balance. */
  allocatePacks: (...args: Parameters<typeof defaultAllocatePackRemaining>) => ReturnType<typeof defaultAllocatePackRemaining> | Promise<ReturnType<typeof defaultAllocatePackRemaining>>;
}

// ── Dependencies ──────────────────────────────────────────────────────────

// The defaults are loaded on first use (importing this module must not open a
// database client), once: every later call shares the same loaded module.
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | null = null;
  return () => {
    loaded ??= load().catch((err) => {
      loaded = null;
      throw err;
    });
    return loaded;
  };
}

const prismaClient = once(async () => (await import('../../lib/prisma.js')).default);
const creditService = once(() => import('../../lib/mockCreditService.js'));
const emailService = once(() => import('../email/index.js'));
const creditsPlatform = once(() => import('../credits/index.js'));

const defaultDeps: StripeRefundDeps = {
  db: prismaClient,
  getStripe: () => platformGetStripe(),
  now: () => new Date(),
  sendEmail: async (input) => (await emailService()).sendEmail(input as never),
  invalidate: async (userId) => (await creditsPlatform()).entitlementService.invalidate(userId),
  adjustCredits: async (params) => (await creditService()).adjustCredits(params),
  grantForPlan: async (params) => (await creditService()).grantForPlan(params),
  allocatePacks: async (packs, balance) => (await creditService()).allocatePackRemaining(packs, balance),
};

let testDeps: Partial<StripeRefundDeps> = {};

/** Tests only: override some dependencies of the engine and its webhook handlers (no argument restores them). */
export function setStripeRefundDepsForTests(partial?: Partial<StripeRefundDeps>): void {
  testDeps = partial ?? {};
}

function resolveDeps(overrides: Partial<StripeRefundDeps> = {}): StripeRefundDeps {
  return { ...defaultDeps, ...testDeps, ...overrides };
}

/**
 * The dependencies of a webhook handler: the clock and the database of the
 * billing service that dispatched the event (one database per event), unless
 * a test replaced the database here. `StripeEventDb` names the tables the
 * service itself uses; what it hands over is its whole Prisma client.
 */
function webhookDeps(ctx: StripeEventContext): StripeRefundDeps {
  return resolveDeps({ now: ctx.now, ...(testDeps.db ? {} : { db: ctx.db as unknown as RefundDb }) });
}

async function dbOf(d: StripeRefundDeps): Promise<RefundDb> {
  return typeof d.db === 'function' ? await d.db() : d.db;
}

// ── Small helpers ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
const REFUND_ROW_KINDS = ['refund', 'withdrawal'];
/** Clock difference allowed between "the pass was bought" and "the run it started began". */
const PASS_RUN_SLACK_MS = 5 * 60_000;
/** Stripe metadata values hold 500 characters; the staff reason is cut well below. */
const REASON_MAX = 300;

function idOf(value: string | { id?: string | null } | null | undefined): string | null {
  if (typeof value === 'string') return value || null;
  return value?.id ?? null;
}

function upper(currency: string | null | undefined): string {
  return (currency ?? 'usd').toUpperCase();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

function isStripeMissing(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === 'resource_missing' || e?.statusCode === 404;
}

function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { type?: unknown; rawType?: unknown } | null;
  return e?.type === 'StripeIdempotencyError' || e?.rawType === 'idempotency_error';
}

/** Stripe says the request itself is wrong (already refunded, amount above what is left, …), not that Stripe is down. */
function isStripeRequestRefusal(err: unknown): boolean {
  const e = err as { type?: unknown; rawType?: unknown; code?: unknown } | null;
  return e?.type === 'StripeInvalidRequestError' || e?.rawType === 'invalid_request_error' || e?.code === 'charge_already_refunded';
}

function notAvailable(reason: string, details: Record<string, unknown> = {}): BillingError {
  return new BillingError('refund_not_available', 'No refund can be made for this payment', { reason, ...details });
}

function providerError(message: string, err: unknown): BillingError {
  if (err instanceof BillingError) return err;
  return new BillingError('payment_provider_error', message, { provider: 'stripe', message: errorText(err).slice(0, 200) });
}

function isRoboApplyAccount(account: BillingAccount): boolean {
  if (account.brand !== 'roboapply') return false;
  const rowBrand = account.subscription?.brand ?? null;
  return rowBrand === null || rowBrand === 'roboapply';
}

/** Minor units of this payment that our refund rows already account for (refunds and withdrawals; never disputes). */
async function recordedRefundedMinor(db: RefundDb, where: { paymentIntentId: string } | { invoiceId: string }): Promise<number> {
  const rows = await db.rABillingRefund.findMany({ where: { rail: 'stripe', kind: { in: REFUND_ROW_KINDS }, ...where }, select: { amountMinor: true } });
  return rows.reduce((sum, row) => sum + Math.max(0, row.amountMinor), 0);
}

// ── issueRefund ───────────────────────────────────────────────────────────

interface LoadedTarget {
  paymentIntentId: string;
  /** What the buyer paid for this target, minor units. */
  paidMinor: number;
  currency: string;
  invoiceId: string | null;
  checkoutSessionId: string | null;
  planKey: string | null;
}

function metadataPlanKey(...sources: Array<Stripe.Metadata | null | undefined>): string | null {
  for (const meta of sources) {
    const key = meta?.planKey;
    if (typeof key === 'string' && key) return key;
  }
  return null;
}

/** The subscription metadata an invoice carries a copy of (current API versions), or null. */
function invoiceSubscriptionMetadata(invoice: Stripe.Invoice): Stripe.Metadata | null {
  const parent = (invoice as unknown as { parent?: { subscription_details?: { metadata?: Stripe.Metadata | null } | null } | null }).parent;
  const legacy = (invoice as unknown as { subscription_details?: { metadata?: Stripe.Metadata | null } | null }).subscription_details;
  return parent?.subscription_details?.metadata ?? legacy?.metadata ?? null;
}

function invoicePlanKey(invoice: Stripe.Invoice, account: BillingAccount): string | null {
  const fromStripe = metadataPlanKey(invoice.metadata, invoiceSubscriptionMetadata(invoice));
  if (fromStripe) return fromStripe;
  const subId = invoiceSubscriptionId(invoice);
  const row = account.subscription;
  return subId && row?.stripeSubscriptionId === subId ? (row.planKey ?? null) : null;
}

/** The payment intent that paid an invoice: its paid InvoicePayment, else a top-level `payment_intent` (old API versions). */
async function invoicePaymentIntent(stripe: StripeClient, invoice: Stripe.Invoice): Promise<string | null> {
  const topLevel = idOf((invoice as unknown as { payment_intent?: string | { id: string } | null }).payment_intent);
  try {
    const payments = await stripe.invoicePayments.list({ invoice: invoice.id as string, limit: 10 });
    for (const payment of payments.data) {
      const pi = idOf(payment.payment?.payment_intent);
      if (payment.status === 'paid' && pi) return pi;
    }
  } catch (err) {
    if (!topLevel) throw providerError('The payment of this invoice could not be read', err);
  }
  return topLevel;
}

async function loadInvoiceTarget(stripe: StripeClient, account: BillingAccount, customerId: string, invoiceId: string, checkoutSessionId: string | null): Promise<LoadedTarget> {
  let invoice: Stripe.Invoice;
  try {
    invoice = await stripe.invoices.retrieve(invoiceId);
  } catch (err) {
    throw isStripeMissing(err) ? notAvailable('not_found') : providerError('The invoice could not be read', err);
  }
  // Ownership before anything else is read: the invoice must belong to this account's Stripe customer.
  if (idOf(invoice.customer) !== customerId) throw notAvailable('not_yours');
  const paymentIntentId = await invoicePaymentIntent(stripe, invoice);
  if (!paymentIntentId || !((invoice.amount_paid ?? 0) > 0)) throw notAvailable('nothing_paid');
  return {
    paymentIntentId,
    paidMinor: invoice.amount_paid,
    currency: upper(invoice.currency),
    invoiceId: invoice.id as string,
    checkoutSessionId,
    planKey: invoicePlanKey(invoice, account),
  };
}

async function loadRefundTarget(stripe: StripeClient, account: BillingAccount, customerId: string, target: RefundTarget): Promise<LoadedTarget> {
  if ('invoiceId' in target) return loadInvoiceTarget(stripe, account, customerId, target.invoiceId, null);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(target.checkoutSessionId);
  } catch (err) {
    throw isStripeMissing(err) ? notAvailable('not_found') : providerError('The checkout session could not be read', err);
  }
  if (idOf(session.customer) !== customerId) throw notAvailable('not_yours');
  const paymentIntentId = idOf(session.payment_intent);
  if (!paymentIntentId) {
    // A subscription session holds no payment intent: its first invoice does.
    const invoiceId = idOf(session.invoice);
    if (!invoiceId) throw notAvailable('nothing_paid');
    const loaded = await loadInvoiceTarget(stripe, account, customerId, invoiceId, session.id);
    return { ...loaded, planKey: metadataPlanKey(session.metadata) ?? loaded.planKey };
  }
  if (session.payment_status === 'unpaid' || !((session.amount_total ?? 0) > 0)) throw notAvailable('nothing_paid');
  return {
    paymentIntentId,
    paidMinor: session.amount_total as number,
    currency: upper(session.currency),
    invoiceId: idOf(session.invoice),
    checkoutSessionId: session.id,
    planKey: metadataPlanKey(session.metadata),
  };
}

/** The refund a repeated key already made, when Stripe refuses the key because the parameters differ (another actor, another reason). */
async function existingRefund(stripe: StripeClient, paymentIntentId: string, kind: RefundKind, amountMinor: number | null): Promise<Stripe.Refund | null> {
  try {
    const list = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 20 });
    return (
      list.data.find(
        (r) => r.status !== 'failed' && r.status !== 'canceled' && (r.metadata?.kind ?? 'refund') === kind && (amountMinor === null || r.amount === amountMinor),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Refund a payment of this user, in full or in part. One Stripe write
 * (`refunds.create`, idempotency key `refund:<payment intent>:<amount|full>`)
 * and no database write: entitlements change in the `charge.refunded` webhook.
 *
 * Throws BillingError `refund_not_available` (409: not this user's payment,
 * nothing paid, nothing left to refund, an amount above what is left, a
 * GoApply account), `rail_not_configured` (503) or `payment_provider_error`
 * (502).
 */
export async function issueRefund(input: IssueRefundInput, deps: Partial<StripeRefundDeps> = {}): Promise<IssuedRefund> {
  const d = resolveDeps(deps);
  const db = await dbOf(d);
  if (input.amountMinor !== undefined && !(Number.isSafeInteger(input.amountMinor) && input.amountMinor > 0)) {
    throw notAvailable('invalid_amount');
  }
  const account = await loadBillingAccount(db, input.userId);
  if (!account) throw notAvailable('no_account');
  // GoApply never reaches Stripe (rule A11): refused before a client is even asked for.
  if (!isRoboApplyAccount(account)) throw notAvailable('rail_not_allowed');
  const stripe = d.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
  const customerId = account.subscription?.stripeCustomerId ?? null;
  if (!customerId) throw notAvailable('no_customer');

  const target = await loadRefundTarget(stripe, account, customerId, input.target);
  const refundedBefore = await recordedRefundedMinor(db, { paymentIntentId: target.paymentIntentId });
  const refundable = target.paidMinor - refundedBefore;
  if (refundable <= 0) throw notAvailable('already_refunded');
  if (input.amountMinor !== undefined && input.amountMinor > refundable) {
    throw notAvailable('amount_above_refundable', { refundableMinor: refundable });
  }
  // "Everything" is sent without an amount, so Stripe refunds exactly what is left.
  const partialMinor = input.amountMinor !== undefined && input.amountMinor < target.paidMinor ? input.amountMinor : null;
  const kind: RefundKind = input.kind ?? 'refund';
  const reason = input.reason.trim().slice(0, REASON_MAX);
  const metadata: Record<string, string> = {
    product: 'roboapply',
    userId: input.userId,
    actor: input.actor,
    kind,
    ...(target.planKey ? { planKey: target.planKey } : {}),
    ...(reason ? { reason } : {}),
  };

  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(
      { payment_intent: target.paymentIntentId, ...(partialMinor !== null ? { amount: partialMinor } : {}), reason: 'requested_by_customer', metadata },
      { idempotencyKey: `refund:${target.paymentIntentId}:${partialMinor ?? 'full'}` },
    );
  } catch (err) {
    const made = isIdempotencyConflict(err) ? await existingRefund(stripe, target.paymentIntentId, kind, partialMinor) : null;
    if (!made) {
      logger.error('RA_BILLING', 'stripe refund failed', { userId: input.userId, paymentIntentId: target.paymentIntentId, error: errorText(err) });
      if (isIdempotencyConflict(err)) {
        throw new BillingError('payment_provider_error', 'A different refund of this amount was sent a moment ago. Check the payment before trying again.', {
          provider: 'stripe',
          reason: 'idempotency_conflict',
        });
      }
      if (isStripeRequestRefusal(err)) throw notAvailable('refused_by_provider', { message: errorText(err).slice(0, 200) });
      throw providerError('The refund could not be sent to the payment provider. Try again.', err);
    }
    refund = made;
  }
  const amountMinor = typeof refund.amount === 'number' ? refund.amount : (partialMinor ?? refundable);
  logger.info('RA_BILLING', 'refund issued', { userId: input.userId, refundId: refund.id, kind, amountMinor, actor: input.actor });
  return {
    refundId: refund.id,
    paymentIntentId: target.paymentIntentId,
    chargeId: idOf(refund.charge),
    amountMinor,
    currency: upper(refund.currency ?? target.currency),
    full: refundedBefore + amountMinor >= target.paidMinor,
  };
}

// ── Reversing an entitlement ──────────────────────────────────────────────

/** Cancel a Stripe subscription now. An already cancelled subscription is success. */
async function cancelSubscriptionNow(stripe: StripeClient, subscriptionId: string, idempotencyKey: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey });
  } catch (err) {
    // Stripe refuses to cancel what is already cancelled. Whatever shape that
    // refusal has, the subscription's own status decides.
    let status: string | null = null;
    try {
      status = (await stripe.subscriptions.retrieve(subscriptionId)).status;
    } catch {
      status = null;
    }
    if (status !== 'canceled' && status !== 'incomplete_expired') throw err;
  }
}

export interface ReversePackInput {
  userId: string;
  seekerProfileId: string;
  /** The RACreditGrant row of the pack (packs.ts `packGrantId`). */
  grantId: string;
  /** What caused it, for the practice ledger row (a charge id, an order id). */
  ref: string;
  source: string;
}

/**
 * Take back what is left of one practice pack: lower the practice balance by
 * the pack's unspent credits and set the grant row to 0. Used credits are
 * gone and the balance never goes below 0. Whoever wins the conditional
 * update of the grant row does the work, so two callers reverse it once.
 */
export async function reversePackGrant(input: ReversePackInput, deps: Partial<StripeRefundDeps> = {}): Promise<Extract<ReversalOutcome, 'pack_zeroed' | 'none'>> {
  const d = resolveDeps(deps);
  const db = await dbOf(d);
  const now = d.now();
  const packs = await db.rACreditGrant.findMany({
    where: { userId: input.userId, bucket: 'practice', remaining: { gt: 0 } },
    select: { id: true, remaining: true, expiresAt: true },
  });
  const pack = packs.find((p) => p.id === input.grantId);
  if (!pack) return 'none'; // never granted, spent and trimmed, or reversed already
  const row = await db.seekerSubscription.findUnique({ where: { seekerProfileId: input.seekerProfileId }, select: { mockCredits: true } });
  const balance = Number(row?.mockCredits ?? 0) || 0;
  // Expired packs no longer hold credits; the live ones share the balance, the latest-expiring first.
  const live = packs.filter((p) => !p.expiresAt || p.expiresAt.getTime() > now.getTime());
  const left = live.some((p) => p.id === pack.id) ? ((await d.allocatePacks(live, balance)).get(pack.id) ?? 0) : 0;
  const claim = await db.rACreditGrant.updateMany({ where: { id: pack.id, remaining: pack.remaining }, data: { remaining: 0 } });
  if (claim.count !== 1) return 'none'; // another delivery took it
  if (left > 0) {
    const moved = await d.adjustCredits({ userId: input.userId, delta: -left, reason: 'refund', source: input.source, metadata: { packGrantId: pack.id, ref: input.ref } });
    if (!moved) {
      // The balance was not lowered: put the grant back so the next delivery finishes the job.
      await db.rACreditGrant.updateMany({ where: { id: pack.id, remaining: 0 }, data: { remaining: pack.remaining } });
      throw new Error(`practice balance could not be lowered for pack ${pack.id}`);
    }
  }
  return 'pack_zeroed';
}

export interface ReversePassInput {
  userId: string;
  seekerProfileId: string;
  /** The plan key of the refunded pass: only a running pass of this plan is touched. */
  planKey: string;
  passDays: number;
  /** The one-time claim that makes the reversal happen once (e.g. `reversal:<charge id>`). */
  claimKey: string;
  claimRefType: string;
  source: string;
  /**
   * When the refunded pass was bought (the moment it was activated, else the
   * moment it was paid). The plan row's `startedAt` is the start of the run
   * that is live now (fulfilment keeps it across stacked passes and resets it
   * for a fresh run), so a pass bought before it is over already and nothing
   * is taken off the newer one. Omitted, or a row without `startedAt`: not
   * checked.
   */
  purchasedAt?: Date | null;
}

/**
 * Take one pass length off the running pass. Passes stack, so a refunded pass
 * under another one shortens access; when nothing is left the plan ends now
 * and the practice balance goes back to the Free allotment. The claim and the
 * row change are one transaction, so a pass is reversed once. A pass that is
 * not part of the run that is live now (`purchasedAt` before the row's
 * `startedAt`) is over: 'none', and the newer pass keeps its time.
 */
export async function reversePassPeriod(input: ReversePassInput, deps: Partial<StripeRefundDeps> = {}): Promise<Extract<ReversalOutcome, 'pass_ended' | 'pass_shortened' | 'none'>> {
  const d = resolveDeps(deps);
  const db = await dbOf(d);
  const now = d.now();
  const outcome = await db.$transaction(async (tx) => {
    const fresh = await claimBillingEvent(tx, input.userId, input.claimKey, input.claimRefType, now);
    if (!fresh) return 'none' as const;
    const row = await tx.seekerSubscription.findUnique({
      where: { seekerProfileId: input.seekerProfileId },
      select: { id: true, tier: true, status: true, planKey: true, brand: true, stripeSubscriptionId: true, currentPeriodEnd: true, startedAt: true },
    });
    const running =
      row &&
      String(row.tier) !== 'free' &&
      LIVE_STATUSES.has(row.status) &&
      !row.stripeSubscriptionId &&
      (row.planKey === input.planKey || String(row.tier) === input.planKey) &&
      row.currentPeriodEnd &&
      row.currentPeriodEnd.getTime() > now.getTime();
    if (!row || !running || !row.currentPeriodEnd) return 'none' as const; // the pass is over, or another plan runs
    // The refunded pass ended before the run that is live now began: that run was paid for separately.
    if (input.purchasedAt && row.startedAt && input.purchasedAt.getTime() + PASS_RUN_SLACK_MS < row.startedAt.getTime()) return 'none' as const;
    const end = new Date(row.currentPeriodEnd.getTime() - input.passDays * DAY_MS);
    if (end.getTime() > now.getTime()) {
      await tx.seekerSubscription.update({ where: { id: row.id }, data: { currentPeriodEnd: end } });
      return 'pass_shortened' as const;
    }
    await tx.seekerSubscription.update({
      where: { id: row.id },
      data: { tier: 'free', planKey: 'free', status: 'canceled', interval: null, currentPeriodEnd: now, cancelAtPeriodEnd: false, canceledAt: now },
    });
    return 'pass_ended' as const;
  });
  if (outcome === 'pass_ended') {
    await d.grantForPlan({ userId: input.userId, tier: 'free', reason: 'grant_renewal', source: input.source, metadata: { cause: 'refund', ref: input.claimKey } });
  }
  return outcome;
}

/** What a Stripe charge paid for. */
interface ChargePurchase {
  kind: 'pack' | 'pass' | 'subscription' | 'unknown';
  planKey: string | null;
  paymentIntentId: string | null;
  checkoutSessionId: string | null;
  invoiceId: string | null;
  subscriptionId: string | null;
  /** The purchase carries a brand that is not Stripe's to serve (never reversed here). */
  foreignBrand: boolean;
}

async function invoiceOfPaymentIntent(stripe: StripeClient, paymentIntentId: string): Promise<Stripe.Invoice | null> {
  const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1, expand: ['data.invoice'] });
  const invoice = payments.data[0]?.invoice ?? null;
  if (!invoice) return null;
  if (typeof invoice === 'string') return stripe.invoices.retrieve(invoice);
  return 'deleted' in invoice && invoice.deleted ? null : (invoice as Stripe.Invoice);
}

/**
 * What the charge bought. A subscription charge is found through its invoice;
 * a pass or a pack through the plan key that checkout wrote on the payment
 * (charge, invoice, session or payment intent metadata) and the Checkout
 * Session of the payment intent.
 */
async function resolveChargePurchase(stripe: StripeClient, charge: Stripe.Charge, owner: BillingOwner): Promise<ChargePurchase> {
  const paymentIntentId = idOf(charge.payment_intent);
  const unknown: ChargePurchase = { kind: 'unknown', planKey: null, paymentIntentId, checkoutSessionId: null, invoiceId: null, subscriptionId: null, foreignBrand: false };
  if (!paymentIntentId) return unknown;

  const invoice = await invoiceOfPaymentIntent(stripe, paymentIntentId);
  const invoiceId = (invoice?.id as string | undefined) ?? null;
  const subscriptionId = invoice ? invoiceSubscriptionId(invoice) : null;
  if (subscriptionId) {
    const subMeta = invoice ? invoiceSubscriptionMetadata(invoice) : null;
    const rowPlan = owner.subscription.stripeSubscriptionId === subscriptionId ? owner.subscription.planKey : null;
    return {
      kind: 'subscription',
      planKey: metadataPlanKey(subMeta, invoice?.metadata) ?? rowPlan,
      paymentIntentId,
      checkoutSessionId: null,
      invoiceId,
      subscriptionId,
      foreignBrand: Boolean(subMeta?.brand && subMeta.brand !== 'roboapply'),
    };
  }

  const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  const session = sessions.data[0] ?? null;
  let meta: Stripe.Metadata | null = [charge.metadata, invoice?.metadata, session?.metadata].find((m) => metadataPlanKey(m)) ?? null;
  if (!meta) meta = (await stripe.paymentIntents.retrieve(paymentIntentId)).metadata ?? null;
  const planKey = metadataPlanKey(meta);
  const def = planDefinitionFor('roboapply', planKey);
  const kind = def?.kind === 'pack' ? 'pack' : def?.kind === 'pass' ? 'pass' : 'unknown';
  return {
    kind,
    planKey,
    paymentIntentId,
    checkoutSessionId: session?.id ?? null,
    invoiceId,
    subscriptionId: null,
    foreignBrand: Boolean(meta?.brand && meta.brand !== 'roboapply'),
  };
}

/**
 * When the pass a charge paid for joined the account: the moment its Checkout
 * Session was fulfilled (the claim `checkout:<session>` the billing service
 * writes in the same transaction as the activation), else the moment of the
 * charge. A delayed webhook fulfils long after the charge, so the claim is the
 * better clock when there is one.
 */
async function passPurchasedAt(db: RefundDb, charge: Pick<Stripe.Charge, 'created'>, checkoutSessionId: string | null): Promise<Date | null> {
  if (checkoutSessionId) {
    const claim = await db.rACreditLedger.findUnique({
      where: { idempotencyKey: billingEventClaimKey(`checkout:${checkoutSessionId}`) },
      select: { settledAt: true, createdAt: true },
    });
    const activatedAt = claim?.settledAt ?? claim?.createdAt ?? null;
    if (activatedAt) return activatedAt;
  }
  return typeof charge.created === 'number' && charge.created > 0 ? new Date(charge.created * 1000) : null;
}

/** The full-refund reversal for what a charge bought (also run for a dispute). One charge is reversed once. */
async function reversePurchase(
  stripe: StripeClient,
  d: StripeRefundDeps,
  owner: BillingOwner,
  charge: Pick<Stripe.Charge, 'id' | 'created'>,
  purchase: ChargePurchase,
): Promise<ReversalOutcome> {
  const db = await dbOf(d);
  const chargeId = charge.id;
  if (purchase.foreignBrand) return 'none';
  switch (purchase.kind) {
    case 'pack': {
      if (!purchase.checkoutSessionId) return 'none';
      return reversePackGrant(
        { userId: owner.userId, seekerProfileId: owner.seekerProfileId, grantId: packGrantId(owner.userId, `stripe:${purchase.checkoutSessionId}`), ref: chargeId, source: 'stripe' },
        d,
      );
    }
    case 'pass': {
      const def = planDefinitionFor('roboapply', purchase.planKey);
      if (!def || !purchase.planKey) return 'none';
      return reversePassPeriod(
        {
          userId: owner.userId,
          seekerProfileId: owner.seekerProfileId,
          planKey: purchase.planKey,
          passDays: def.passDays ?? 7,
          claimKey: `reversal:${chargeId}`,
          claimRefType: 'stripe_refund',
          source: 'stripe',
          purchasedAt: await passPurchasedAt(db, charge, purchase.checkoutSessionId),
        },
        d,
      );
    }
    case 'subscription': {
      if (!purchase.subscriptionId) return 'none';
      // Access ends through customer.subscription.deleted, which the billing service handles.
      await cancelSubscriptionNow(stripe, purchase.subscriptionId, `refundcancel:${purchase.subscriptionId}:${chargeId}`);
      // The period's practice credits, once per charge and only for the subscription the account is on.
      if (owner.subscription.stripeSubscriptionId === purchase.subscriptionId && (await claimBillingEvent(db, owner.userId, `reversal:${chargeId}`, 'stripe_refund', d.now()))) {
        await d.grantForPlan({ userId: owner.userId, tier: 'free', reason: 'grant_renewal', source: 'stripe', metadata: { cause: 'refund', ref: `reversal:${chargeId}` } });
      }
      return 'subscription_cancelled';
    }
    default:
      return 'none';
  }
}

// ── The refund row ────────────────────────────────────────────────────────

type RefundRow = { id: string; kind: string; full: boolean; entitlementReversed: boolean; amountMinor: number };
const REFUND_ROW_SELECT = { id: true, kind: true, full: true, entitlementReversed: true, amountMinor: true } as const;

function findRefundRow(db: RefundDb, externalRef: string): Promise<RefundRow | null> {
  return db.rABillingRefund.findFirst({ where: { rail: 'stripe', externalRef }, select: REFUND_ROW_SELECT });
}

interface RefundRowData {
  userId: string;
  kind: 'refund' | 'withdrawal' | 'dispute';
  externalRef: string;
  chargeId: string;
  purchase: ChargePurchase;
  amountMinor: number;
  currency: string;
  full: boolean;
  reason: string | null;
  actor: string;
}

/** The row of this refund, written once: unique on (rail, externalRef), so a concurrent delivery reads the winner's row. */
async function ensureRefundRow(db: RefundDb, data: RefundRowData): Promise<RefundRow> {
  const existing = await findRefundRow(db, data.externalRef);
  if (existing) return existing;
  try {
    return await db.rABillingRefund.create({
      data: {
        userId: data.userId,
        brand: 'roboapply',
        rail: 'stripe',
        kind: data.kind,
        externalRef: data.externalRef,
        chargeId: data.chargeId,
        paymentIntentId: data.purchase.paymentIntentId,
        invoiceId: data.purchase.invoiceId,
        checkoutSessionId: data.purchase.checkoutSessionId,
        planKey: data.purchase.planKey,
        amountMinor: data.amountMinor,
        currency: data.currency,
        full: data.full,
        entitlementReversed: false,
        reason: data.reason,
        actor: data.actor,
      },
      select: REFUND_ROW_SELECT,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findRefundRow(db, data.externalRef);
    if (!winner) throw err;
    return winner;
  }
}

/** A replay has nothing left to do when the row exists and its reversal is done (or was never due). */
function rowSettled(row: RefundRow | null): boolean {
  return Boolean(row && (!row.full || row.entitlementReversed));
}

// ── charge.refunded ───────────────────────────────────────────────────────

interface ThisRefund {
  amountMinor: number;
  kind: RefundKind;
  actor: string;
  reason: string | null;
}

/**
 * Which refund this event is about. A charge can be refunded in several
 * steps; the event carries the charge with the running total, so the refund
 * whose running total equals `amount_refunded` is the one. A refund made in
 * the Dashboard has no metadata: kind 'refund', actor 'stripe'.
 */
async function refundOfEvent(stripe: StripeClient, db: RefundDb, charge: Stripe.Charge): Promise<ThisRefund> {
  let refunds: Stripe.Refund[] = charge.refunds?.data ?? [];
  if (!refunds.length) refunds = (await stripe.refunds.list({ charge: charge.id, limit: 100 })).data;
  const counted = refunds.filter((r) => r.status !== 'failed' && r.status !== 'canceled').sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  let running = 0;
  let match: Stripe.Refund | null = null;
  for (const r of counted) {
    running += r.amount;
    if (running === charge.amount_refunded) match = r;
  }
  if (match) {
    const kind: RefundKind = match.metadata?.kind === 'withdrawal' ? 'withdrawal' : 'refund';
    return { amountMinor: match.amount, kind, actor: match.metadata?.actor || 'stripe', reason: match.metadata?.reason || match.reason || null };
  }
  // No refund list to read from: what the earlier rows of this charge do not account for.
  const before = (await db.rABillingRefund.findMany({ where: { rail: 'stripe', chargeId: charge.id, kind: { in: REFUND_ROW_KINDS } }, select: { amountMinor: true, externalRef: true } }))
    .filter((row) => row.externalRef !== `${charge.id}:${charge.amount_refunded}`)
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const rest = charge.amount_refunded - before;
  return { amountMinor: rest > 0 ? rest : charge.amount_refunded, kind: 'refund', actor: 'stripe', reason: null };
}

async function handleChargeRefunded(event: Stripe.Event, ctx: StripeEventContext): Promise<StripeEventResult> {
  const charge = event.data.object as Stripe.Charge;
  const d = webhookDeps(ctx);
  const db = await dbOf(d);
  // The Stripe account may be shared with other products: a customer we do not hold is not ours.
  const owner = await findBillingOwnerByCustomer(db, charge.customer);
  if (!owner) return { handled: false };
  if (owner.subscription.brand && owner.subscription.brand !== 'roboapply') {
    // Rule A11: a Stripe event never changes a row of another brand.
    logger.error('RA_BILLING', 'stripe refund for a non-Stripe brand ignored', { chargeId: charge.id, brand: owner.subscription.brand });
    return { handled: true };
  }
  if (!(charge.amount_refunded > 0)) return { handled: true };

  const now = ctx.now();
  const externalRef = `${charge.id}:${charge.amount_refunded}`;
  const fresh = await claimBillingEvent(db, owner.userId, `refund:${externalRef}`, 'stripe_refund', now);
  if (!fresh && rowSettled(await findRefundRow(db, externalRef))) return { handled: true, duplicate: true };

  const purchase = await resolveChargePurchase(ctx.stripe, charge, owner);
  const refund = await refundOfEvent(ctx.stripe, db, charge);
  const full = charge.amount_refunded >= charge.amount;
  const row = await ensureRefundRow(db, {
    userId: owner.userId,
    kind: refund.kind,
    externalRef,
    chargeId: charge.id,
    purchase,
    amountMinor: refund.amountMinor,
    currency: upper(charge.currency),
    full,
    reason: refund.reason,
    actor: refund.actor,
  });

  // Only a full refund changes access. A partial one is recorded and that is all.
  let outcome: ReversalOutcome = 'none';
  if (full && !row.entitlementReversed) {
    outcome = await reversePurchase(ctx.stripe, d, owner, charge, purchase);
    if (outcome !== 'none') await db.rABillingRefund.updateMany({ where: { id: row.id }, data: { entitlementReversed: true } });
  }
  await d.invalidate(owner.userId);

  // The withdrawal has its own confirmation mail (withdrawPurchase); every other refund gets this one, once.
  if (row.kind !== 'withdrawal' && owner.email && (await claimBillingEvent(db, owner.userId, `refundmail:${externalRef}`, 'stripe_refund', now))) {
    try {
      await d.sendEmail({
        template: 'billing.refund_issued',
        to: owner.email,
        userId: owner.userId,
        locale: owner.locale,
        brand: 'roboapply',
        params: {
          planKey: purchase.planKey ?? owner.subscription.planKey ?? 'pro',
          amountMinor: row.amountMinor,
          currency: upper(charge.currency),
          full,
          // The last of several refunds: this amount is the rest, not everything that was paid.
          completesEarlierRefunds: full && row.amountMinor < charge.amount,
          accessEnded: full && (outcome !== 'none' || row.entitlementReversed),
        },
      });
    } catch (err) {
      // The refund is recorded and reversed; a mail that could not be sent never fails the event.
      logger.error('RA_BILLING', 'refund mail failed', { userId: owner.userId, chargeId: charge.id, error: errorText(err) });
    }
  }
  logger.info('RA_BILLING', 'stripe refund recorded', { userId: owner.userId, chargeId: charge.id, kind: row.kind, full, outcome, purchase: purchase.kind });
  return { handled: true, ...(fresh ? {} : { duplicate: true }) };
}

// ── charge.dispute.created ────────────────────────────────────────────────

async function handleDisputeCreated(event: Stripe.Event, ctx: StripeEventContext): Promise<StripeEventResult> {
  const dispute = event.data.object as Stripe.Dispute;
  const d = webhookDeps(ctx);
  const db = await dbOf(d);
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return { handled: false };
  const charge = typeof dispute.charge === 'object' && dispute.charge ? dispute.charge : await ctx.stripe.charges.retrieve(chargeId);
  const owner = await findBillingOwnerByCustomer(db, charge.customer);
  if (!owner) return { handled: false };
  if (owner.subscription.brand && owner.subscription.brand !== 'roboapply') {
    logger.error('RA_BILLING', 'stripe dispute for a non-Stripe brand ignored', { disputeId: dispute.id, brand: owner.subscription.brand });
    return { handled: true };
  }

  const now = ctx.now();
  const externalRef = `dispute:${dispute.id}`;
  const fresh = await claimBillingEvent(db, owner.userId, externalRef, 'stripe_dispute', now);
  if (!fresh && rowSettled(await findRefundRow(db, externalRef))) return { handled: true, duplicate: true };

  const purchase = await resolveChargePurchase(ctx.stripe, charge, owner);
  // The row is the flag: staff see disputes in the admin list of refunds.
  const row = await ensureRefundRow(db, {
    userId: owner.userId,
    kind: 'dispute',
    externalRef,
    chargeId,
    purchase,
    amountMinor: dispute.amount,
    currency: upper(dispute.currency),
    full: true,
    reason: dispute.reason || null,
    actor: 'stripe',
  });
  let outcome: ReversalOutcome = 'none';
  if (!row.entitlementReversed) {
    outcome = await reversePurchase(ctx.stripe, d, owner, { id: chargeId, created: charge.created }, purchase);
    if (outcome !== 'none') await db.rABillingRefund.updateMany({ where: { id: row.id }, data: { entitlementReversed: true } });
  }
  await d.invalidate(owner.userId);
  if (fresh) {
    // One line for staff. No card data, no email address.
    logger.error('RA_BILLING', 'payment disputed: entitlement reversed, account flagged', {
      userId: owner.userId,
      disputeId: dispute.id,
      chargeId,
      amountMinor: dispute.amount,
      currency: upper(dispute.currency),
      reason: dispute.reason || null,
      outcome,
    });
  }
  return { handled: true, ...(fresh ? {} : { duplicate: true }) };
}

registerStripeEventHandler('charge.refunded', handleChargeRefunded);
registerStripeEventHandler('charge.dispute.created', handleDisputeCreated);

/** The event types this module handles (the endpoint must send them). */
export const STRIPE_REFUND_EVENT_TYPES = ['charge.refunded', 'charge.dispute.created'] as const;

// ── Withdrawal ────────────────────────────────────────────────────────────

/** A waiver ticked at this checkout: a consent record from a day before the charge to an hour after it. */
const WAIVER_BEFORE_MS = DAY_MS;
const WAIVER_AFTER_MS = 3_600_000;

interface OpenWithdrawal extends WithdrawalQuote {
  /** The subscription the purchase started, when it is one (cancelled first on withdrawal). */
  subscriptionId: string | null;
}

function withdrawalClaimKey(purchaseId: string): string {
  return `withdraw:${purchaseId}`;
}

/**
 * The period an invoice paid for: the period of its subscription line (not a
 * proration line). The subscription's own "current period" is NOT that: Stripe
 * moves it on when it drafts the renewal invoice, before it collects, so from
 * the end of the first period until the renewal is paid the latest paid
 * invoice is still the first one while the subscription already shows period
 * two.
 */
function invoicePaidPeriod(invoice: Stripe.Invoice): { start: Date; end: Date } | null {
  for (const line of invoice.lines?.data ?? []) {
    const item = line.parent?.subscription_item_details ?? null;
    const legacy = line as unknown as { type?: string; proration?: boolean };
    if (!item && legacy.type !== 'subscription') continue;
    if (item?.proration ?? legacy.proration ?? false) continue;
    const start = line.period?.start;
    const end = line.period?.end;
    if (typeof start === 'number' && typeof end === 'number' && end > start) return { start: new Date(start * 1000), end: new Date(end * 1000) };
  }
  return null;
}

/**
 * The withdrawal that is open on this account right now, or null: the latest
 * paid Stripe invoice (a renewal never qualifies), the waiver ticked at that
 * checkout, the billing country on the account and, for a subscription, the
 * period that invoice paid for (its own line; the subscription's current
 * period only for an invoice that carries no line, and `computeRefund` refuses
 * bounds the charge does not lie in).
 */
async function openWithdrawal(account: BillingAccount, stripe: StripeClient, d: StripeRefundDeps): Promise<OpenWithdrawal | null> {
  const db = await dbOf(d);
  const sub = account.subscription;
  if (!sub?.stripeCustomerId) return null;

  const invoice = (await stripe.invoices.list({ customer: sub.stripeCustomerId, status: 'paid', limit: 1 })).data[0];
  if (!invoice?.id || !((invoice.amount_paid ?? 0) > 0)) return null;
  const purchaseId = invoice.id;

  // A completed withdrawal closes the purchase (the claim is written last, with the confirmation mail).
  const done = await db.rACreditLedger.findUnique({ where: { idempotencyKey: billingEventClaimKey(withdrawalClaimKey(purchaseId)) }, select: { id: true } });
  if (done) return null;
  // So does a full refund made by staff, and a dispute. A withdrawal's own refund row does not: a
  // withdrawal that stopped before its last step must be able to finish.
  const closed = await db.rABillingRefund.findFirst({
    where: { rail: 'stripe', invoiceId: purchaseId, OR: [{ kind: 'dispute' }, { kind: 'refund', full: true }] },
    select: { id: true },
  });
  if (closed) return null;

  const chargedAt = new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000);
  const subscriptionId = invoiceSubscriptionId(invoice);
  const planKey = invoicePlanKey(invoice, account) ?? sub.planKey ?? sub.tier;
  const waiver = account.seekerProfileId
    ? await db.seekerConsentRecord.findFirst({
        where: {
          seekerProfileId: account.seekerProfileId,
          consentType: 'withdrawal_waiver',
          granted: true,
          createdAt: { gte: new Date(chargedAt.getTime() - WAIVER_BEFORE_MS), lte: new Date(chargedAt.getTime() + WAIVER_AFTER_MS) },
        },
        select: { id: true },
      })
    : null;
  const period: { start: Date | null; end: Date | null } = subscriptionId
    ? (invoicePaidPeriod(invoice) ?? stripePeriod(await stripe.subscriptions.retrieve(subscriptionId)))
    : { start: null, end: null };

  const decision = computeRefund({
    brand: account.brand,
    planKey,
    chargeKind: invoice.billing_reason === 'subscription_cycle' ? 'renewal' : 'first_purchase',
    chargedAt,
    amountMinor: invoice.amount_paid,
    currency: upper(invoice.currency),
    now: d.now(),
    billingCountry: sub.billingCountry,
    withdrawalWaiver: Boolean(waiver),
    // Use never changes a withdrawal (rules 1 and 1b are decided before the usage rules).
    paidOnlyCreditsUsed: 0,
    periodStart: period.start,
    periodEnd: period.end,
  });
  if (!decision.eligible || !isWithdrawalRule(decision.rule)) return null;
  return {
    purchase: { source: 'stripe', id: purchaseId, planKey, chargedAt: chargedAt.toISOString(), amountMinor: invoice.amount_paid, currency: upper(invoice.currency) },
    decision,
    subscriptionId,
  };
}

/**
 * The statutory withdrawal open for this user, or null when there is none
 * (outside the EU, EEA, UK and Taiwan; after the 14 days; a renewal; already
 * withdrawn or refunded; no card payments here; a GoApply account).
 * `decision.amountMinor` is what goes back: everything without the waiver,
 * the unused days of the period with it.
 */
export async function withdrawalQuote(userId: string, deps: Partial<StripeRefundDeps> = {}): Promise<WithdrawalQuote | null> {
  const d = resolveDeps(deps);
  const account = await loadBillingAccount(await dbOf(d), userId);
  // GoApply: the mainland rails have no refund call, and Stripe never serves it (no client is asked for).
  if (!account || !isRoboApplyAccount(account)) return null;
  const stripe = d.getStripe();
  if (!stripe) return null;
  let open: OpenWithdrawal | null;
  try {
    open = await openWithdrawal(account, stripe, d);
  } catch (err) {
    throw providerError('The purchase could not be read from the payment provider. Try again.', err);
  }
  return open ? { purchase: open.purchase, decision: open.decision } : null;
}

/**
 * Withdraw from the quoted purchase. A subscription is cancelled first
 * (idempotency key `withdraw:<subscription>`), so access ends whatever amount
 * is refunded; then the refund is issued (kind 'withdrawal'); then the
 * confirmation mail goes out once. A pass or a pack is refunded in full and
 * reversed by the `charge.refunded` webhook.
 *
 * A second call while the first one is still running, or after it failed half
 * way, repeats the same two Stripe calls with the same keys. Once a withdrawal
 * is complete, the next call is refused.
 *
 * Throws BillingError `withdrawal_not_available` (409), `rail_not_configured`
 * (503) or `payment_provider_error` (502).
 */
export async function withdrawPurchase(input: WithdrawPurchaseInput, deps: Partial<StripeRefundDeps> = {}): Promise<WithdrawalResult> {
  const d = resolveDeps(deps);
  const db = await dbOf(d);
  const refuse = () => new BillingError('withdrawal_not_available', 'A withdrawal is not open for this purchase');
  const account = await loadBillingAccount(db, input.userId);
  if (!account || !isRoboApplyAccount(account)) throw refuse();
  const stripe = d.getStripe();
  if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });

  let open: OpenWithdrawal | null;
  try {
    open = await openWithdrawal(account, stripe, d);
  } catch (err) {
    throw providerError('The purchase could not be read from the payment provider. Try again.', err);
  }
  if (!open || open.purchase.id !== input.purchaseId) throw refuse();
  const { purchase, decision } = open;

  // 1. End the subscription now. Access ends through customer.subscription.deleted, whatever is refunded.
  if (open.subscriptionId) {
    try {
      await cancelSubscriptionNow(stripe, open.subscriptionId, `withdraw:${open.subscriptionId}`);
    } catch (err) {
      logger.error('RA_BILLING', 'withdrawal: stripe cancel failed', { userId: input.userId, error: errorText(err) });
      throw providerError('The withdrawal could not be sent to the payment provider. Try again.', err);
    }
  }

  // 2. Refund what the buyer is owed, less what our rows say already went back for this purchase.
  const owed = decision.amountMinor;
  const due = owed - (await recordedRefundedMinor(db, { invoiceId: purchase.id }));
  if (due > 0) {
    await issueRefund(
      { userId: input.userId, target: { invoiceId: purchase.id }, ...(due < purchase.amountMinor ? { amountMinor: due } : {}), reason: 'withdrawal', actor: input.actor, kind: 'withdrawal' },
      d,
    );
  }

  // 3. The confirmation, once. The claim also closes the withdrawal: the next quote is null.
  const now = d.now();
  const fresh = await claimBillingEvent(db, input.userId, withdrawalClaimKey(purchase.id), 'stripe_withdrawal', now);
  if (fresh && account.email) {
    try {
      await d.sendEmail({
        template: 'billing.withdrawal_confirmed',
        to: account.email,
        userId: input.userId,
        locale: account.locale,
        brand: 'roboapply',
        params: { planKey: purchase.planKey, amountMinor: owed, currency: purchase.currency, withdrawnAt: now.toISOString() },
      });
    } catch (err) {
      // The withdrawal happened; a mail that could not be sent never undoes or fails it.
      logger.error('RA_BILLING', 'withdrawal confirmation mail failed', { userId: input.userId, error: errorText(err) });
    }
  }
  await d.invalidate(input.userId);
  logger.info('RA_BILLING', 'withdrawal executed', { userId: input.userId, purchaseId: purchase.id, rule: decision.rule, refundMinor: owed, actor: input.actor });
  return { status: 'withdrawn', refundMinor: owed, currency: purchase.currency, accessEnded: true, rule: decision.rule as WithdrawalRule };
}
