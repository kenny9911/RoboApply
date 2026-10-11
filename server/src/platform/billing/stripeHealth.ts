// server/src/platform/billing/stripeHealth.ts
//
// Read-only checks of what the Stripe account holds against what this code
// expects (requirement ST-3 part 4; docs/jobright-clone/market/
// MARKET_STRATEGY.md §5.1 "Endpoint health"). Nothing here creates, edits or
// archives anything: every call is a list or a retrieve, and every check
// REPORTS. The admin route and panel that show the result come later
// (imported from this file by path until the billing index exports it).
//
//   checkStripeWebhookEndpoint   the webhook endpoint that points at our path
//                                must be subscribed to every event type of
//                                the strategy's event table. A missing type
//                                is silent in production: Stripe simply never
//                                sends it, and (for example) a payment that
//                                needs 3-D Secure is never mailed.
//   checkStripePrices            the prices the catalog charges on: a pinned
//                                price id (`STRIPE_PRICE_<KEY>`) is trusted by
//                                checkout and never looked at, so a pin next
//                                to a wrong amount charges the wrong amount;
//                                and a synced price archived in the Dashboard
//                                keeps being sent by an instance that already
//                                resolved it (checkout answers 502 until that
//                                instance restarts).
//
// A restricted key that cannot read webhook endpoints or prices is a normal
// deployment: the check then says `checked: false` and never throws.

import type Stripe from 'stripe';
import type { EnvSource } from '../brand/brandEnv.js';
import { getPlanCatalog, type CatalogPlan, type PlanKey } from './planCatalog.js';
import { STRIPE_LOOKUP_KEYS_PER_CALL, stripeLookupKey, stripeRecurringFor, type StripeCatalogCurrency } from './stripeCatalog.js';
import type { StripeClient } from './stripeClient.js';

// ── The webhook endpoint ──────────────────────────────────────────────────

/** Where Stripe must deliver (app.ts mounts the webhook router here). */
export const STRIPE_WEBHOOK_PATH = '/api/v1/roboapply/stripe/webhook';

/**
 * The fourteen event types of the strategy's event table. The first twelve
 * are handled by `handleRoboApplyStripeEvent` itself; `charge.refunded` and
 * `charge.dispute.created` are handled by the refund module through the
 * event-handler registry (stripeEvents.ts).
 */
export const EXPECTED_STRIPE_EVENTS = [
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
  'charge.refunded',
  'charge.dispute.created',
] as const;

export type ExpectedStripeEvent = (typeof EXPECTED_STRIPE_EVENTS)[number];

/** The expected types that reach their handler through the registry, not the service's own switch. */
export const STRIPE_EVENTS_REGISTERED_ELSEWHERE: readonly ExpectedStripeEvent[] = ['charge.refunded', 'charge.dispute.created'];

export type StripeCheckSkipReason = 'restricted_key' | 'error';

export interface StripeWebhookEndpointCheck {
  /** False when the check could not be made (the reason says why); the other fields then say nothing. */
  checked: boolean;
  /** The enabled endpoint that points at our webhook path; null when there is none. */
  url: string | null;
  /** Expected event types the endpoint is not subscribed to (all of them when there is no endpoint). */
  missingEvents: string[];
  reason?: 'not_found' | StripeCheckSkipReason;
}

/** The key may not read this resource (a restricted key without the permission). */
function isPermissionError(err: unknown): boolean {
  const e = err as { type?: unknown; statusCode?: unknown; code?: unknown; rawType?: unknown } | null;
  return e?.type === 'StripePermissionError' || e?.statusCode === 403 || e?.code === 'permission_denied' || e?.rawType === 'permission_error';
}

function skipReason(err: unknown): StripeCheckSkipReason {
  return isPermissionError(err) ? 'restricted_key' : 'error';
}

/** The path of an endpoint URL without query, fragment or trailing slash; null when it is not a URL. */
function endpointPath(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

const LIST_LIMIT = 100;
const MAX_LIST_PAGES = 5;

/** The origin of a URL (scheme, host, port), lower case; null when it is not a URL. */
function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

export interface StripeWebhookEndpointCheckOptions {
  /**
   * The origin Stripe must deliver to for THIS deployment (the brand's public
   * origin, e.g. `https://roboapply.io`). Give it whenever it is known: one
   * Stripe account may hold endpoints of several deployments on the same path.
   */
  origin?: string | null;
}

/**
 * Compare the enabled events of the webhook endpoint that points at our
 * path with `EXPECTED_STRIPE_EVENTS`. `'*'` means every type, so nothing is
 * missing. Never creates or edits an endpoint and never throws.
 *
 * Several enabled endpoints may sit on our path (production plus a preview or
 * staging deployment in the same key mode). With `origin`, the endpoint at
 * that origin is the one reported. Without it, or when no endpoint is at that
 * origin, the one that misses the MOST events is reported: the check exists
 * because a missing type is silent, so a healthy endpoint of another
 * deployment must never hide a broken one.
 */
export async function checkStripeWebhookEndpoint(stripe: StripeClient, opts: StripeWebhookEndpointCheckOptions = {}): Promise<StripeWebhookEndpointCheck> {
  const all = [...EXPECTED_STRIPE_EVENTS] as string[];
  let endpoints: Stripe.WebhookEndpoint[] = [];
  try {
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const list = await stripe.webhookEndpoints.list({ limit: LIST_LIMIT, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      const data = list.data ?? [];
      endpoints = endpoints.concat(data);
      const last = data[data.length - 1];
      if (!list.has_more || !last) break;
      startingAfter = last.id;
    }
  } catch (err) {
    return { checked: false, url: null, missingEvents: [], reason: skipReason(err) };
  }
  const ours = endpoints.filter((e) => e.status === 'enabled' && typeof e.url === 'string' && (endpointPath(e.url) ?? '').endsWith(STRIPE_WEBHOOK_PATH));
  if (ours.length === 0) return { checked: true, url: null, missingEvents: all, reason: 'not_found' };
  const wanted = originOf(opts.origin);
  const atOrigin = wanted ? ours.filter((e) => originOf(e.url) === wanted) : [];
  let worst: { url: string; missing: string[] } | null = null;
  for (const endpoint of atOrigin.length > 0 ? atOrigin : ours) {
    const enabled = endpoint.enabled_events ?? [];
    const missing = enabled.includes('*') ? [] : all.filter((type) => !enabled.includes(type));
    if (!worst || missing.length > worst.missing.length) worst = { url: endpoint.url, missing };
  }
  return { checked: true, url: worst!.url, missingEvents: worst!.missing };
}

// ── The prices ────────────────────────────────────────────────────────────

/** What the catalog says a price must be. */
export interface ExpectedPrice {
  amountMinor: number;
  currency: StripeCatalogCurrency;
  /** Null for a one-time price (the pass and the packs). */
  recurring: { interval: 'week' | 'month'; intervalCount: number } | null;
}

/** What Stripe holds; null fields were not on the price. */
export interface FoundPrice {
  amountMinor: number | null;
  currency: string | null;
  recurring: { interval: string; intervalCount: number } | null;
  active: boolean;
}

export type StripePriceProblem =
  /** A pinned id that Stripe does not know. Checkout on this plan fails. */
  | 'pin_not_found'
  /** A pinned price whose amount, currency or renewal differs from the catalog. The buyer is shown one price and charged another. */
  | 'pin_mismatch'
  /** A pinned price that was archived. Checkout on this plan fails. */
  | 'pin_archived'
  /** The price under our lookup key was archived and no active one replaces it. An instance that resolved it earlier still sends it. */
  | 'synced_archived'
  /** The active price under our lookup key differs from the catalog (checkout refuses to sell on it). */
  | 'synced_mismatch';

export interface StripePriceIssue {
  planKey: PlanKey;
  currency: StripeCatalogCurrency;
  problem: StripePriceProblem;
  /** The Stripe price id concerned (never a secret). */
  priceId: string | null;
  expected: ExpectedPrice;
  found: FoundPrice | null;
}

export interface StripePriceCheck {
  checked: boolean;
  /** How many pinned prices were retrieved and how many lookup keys were listed. */
  pinsChecked: number;
  lookupKeysChecked: number;
  issues: StripePriceIssue[];
  reason?: StripeCheckSkipReason;
}

interface PriceTarget {
  planKey: PlanKey;
  currency: StripeCatalogCurrency;
  expected: ExpectedPrice;
  pin: string | null;
  lookupKey: string;
}

/** Every price the RoboApply catalog can charge on: each priced plan in USD, and in TWD where a Taiwan price is configured. */
function priceTargets(env: EnvSource): PriceTarget[] {
  const out: PriceTarget[] = [];
  const add = (plan: CatalogPlan, currency: StripeCatalogCurrency, amountMinor: number | null | undefined, pin: string | null | undefined) => {
    if (amountMinor == null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
    const recurring = stripeRecurringFor(plan);
    if (plan.kind === 'subscription' && !recurring) return;
    out.push({
      planKey: plan.key,
      currency,
      expected: { amountMinor, currency, recurring: recurring ? { interval: recurring.interval, intervalCount: recurring.interval_count } : null },
      pin: pin ?? null,
      lookupKey: stripeLookupKey(plan.key, currency, amountMinor),
    });
  };
  for (const plan of getPlanCatalog('roboapply', env)) {
    if (plan.kind === 'free' || plan.currency !== 'USD') continue;
    add(plan, 'USD', plan.amountMinor, plan.stripePriceId);
    if (plan.twdPrice) add(plan, 'TWD', plan.twdPrice.amountMinor, plan.twdPrice.stripePriceId);
  }
  return out;
}

function foundOf(price: Stripe.Price): FoundPrice {
  return {
    amountMinor: typeof price.unit_amount === 'number' ? price.unit_amount : null,
    currency: price.currency ? price.currency.toUpperCase() : null,
    recurring: price.recurring ? { interval: price.recurring.interval, intervalCount: price.recurring.interval_count ?? 1 } : null,
    active: price.active !== false,
  };
}

function matches(found: FoundPrice, expected: ExpectedPrice): boolean {
  if (found.amountMinor !== expected.amountMinor || found.currency !== expected.currency) return false;
  if (!expected.recurring) return found.recurring === null;
  return found.recurring !== null && found.recurring.interval === expected.recurring.interval && found.recurring.intervalCount === expected.recurring.intervalCount;
}

/**
 * Look at the prices the catalog charges on. A pinned price is retrieved once
 * and compared with the catalog (amount, currency, renewal) and must be
 * active. A plan with no pin is looked up by its lookup key: nothing found is
 * fine (the first checkout creates the price); an archived price with no
 * active one is reported, and so is an active one that differs.
 *
 * Reports only: it never creates, archives or moves a price, and never throws.
 */
export async function checkStripePrices(stripe: StripeClient, env: EnvSource = process.env): Promise<StripePriceCheck> {
  const targets = priceTargets(env);
  const issues: StripePriceIssue[] = [];
  const issue = (t: PriceTarget, problem: StripePriceProblem, priceId: string | null, found: FoundPrice | null) =>
    issues.push({ planKey: t.planKey, currency: t.currency, problem, priceId, expected: t.expected, found });
  const pinned = targets.filter((t) => t.pin);
  const synced = targets.filter((t) => !t.pin);
  try {
    for (const t of pinned) {
      let price: Stripe.Price;
      try {
        price = await stripe.prices.retrieve(t.pin!);
      } catch (err) {
        const e = err as { code?: unknown; statusCode?: unknown } | null;
        if (e?.code === 'resource_missing' || e?.statusCode === 404) {
          issue(t, 'pin_not_found', t.pin, null);
          continue;
        }
        throw err;
      }
      const found = foundOf(price);
      if (!matches(found, t.expected)) issue(t, 'pin_mismatch', price.id, found);
      else if (!found.active) issue(t, 'pin_archived', price.id, found);
    }
    for (let i = 0; i < synced.length; i += STRIPE_LOOKUP_KEYS_PER_CALL) {
      const chunk = synced.slice(i, i + STRIPE_LOOKUP_KEYS_PER_CALL);
      // No `active` filter: an archived price keeps its lookup key, and that is what we are looking for.
      const list = await stripe.prices.list({ lookup_keys: chunk.map((t) => t.lookupKey), limit: LIST_LIMIT });
      for (const t of chunk) {
        const held = (list.data ?? []).filter((p) => p.lookup_key === t.lookupKey);
        if (held.length === 0) continue;
        const active = held.find((p) => p.active !== false);
        if (!active) {
          issue(t, 'synced_archived', held[0]!.id, foundOf(held[0]!));
          continue;
        }
        const found = foundOf(active);
        if (!matches(found, t.expected)) issue(t, 'synced_mismatch', active.id, found);
      }
    }
  } catch (err) {
    return { checked: false, pinsChecked: 0, lookupKeysChecked: 0, issues: [], reason: skipReason(err) };
  }
  return { checked: true, pinsChecked: pinned.length, lookupKeysChecked: synced.length, issues };
}
