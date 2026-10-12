// server/src/platform/billing/stripeCatalog.ts
//
// Stripe Products and Prices follow the plan catalog (requirement ST-1;
// docs/jobright-clone/market/MARKET_STRATEGY.md §5.1 "Catalog sync"). Nothing
// is set up by hand: the first checkout of a plan finds its Stripe price by
// lookup key, or creates it, and later calls answer from memory.
//
//   Products   fixed ids, created on first use (`resource_already_exists` is
//              success): ra_pro, ra_pro_student, ra_pro_week_pass,
//              ra_practice_pack. The `ra_` prefix keeps them apart from other
//              products on a shared Stripe account.
//   Prices     one per plan, currency and amount, found by the lookup key
//              `ra_<planKey>_<currency>_<amountMinor>_incl`
//              (ra_pro_monthly_usd_2499_incl). A changed catalog amount is a
//              new lookup key and therefore a new price; the old price is
//              left alone and existing subscribers keep it. A lookup key is
//              never moved to another price.
//   Pins       `STRIPE_PRICE_<PLANKEY>` (with an amount variable) and
//              `STRIPE_PRICE_<PLANKEY>_TWD` skip the sync entirely.
//
// Rule A11 (Stripe never serves GoApply): a plan whose catalog currency is
// not USD is refused before any Stripe call, so a CNY product or price can
// never be created.
//
// `getPlanCatalog()` stays synchronous and never calls Stripe; only checkout,
// a plan switch and the optional warm-up (`syncStripeCatalog`) come here.
// Every Stripe failure becomes BillingError('payment_provider_error') (502).

import type Stripe from 'stripe';
import { logger } from '../../services/LoggerService.js';
import type { EnvSource } from '../brand/brandEnv.js';
import { getBrand } from '../brand/registry.js';
import { BillingError } from './errors.js';
import { getPlanCatalog, isPlanKey, planKeyForStripePrice, type CatalogPlan, type PlanKey } from './planCatalog.js';
import type { StripeClient } from './stripeClient.js';

/** The currencies the Stripe rail charges. */
export type StripeCatalogCurrency = 'USD' | 'TWD';

export const STRIPE_PRODUCT_IDS = ['ra_pro', 'ra_pro_student', 'ra_pro_week_pass', 'ra_practice_pack'] as const;
export type StripeProductId = (typeof STRIPE_PRODUCT_IDS)[number];

/** Which Stripe product each plan is a price of. */
export const STRIPE_PRODUCT_FOR_PLAN: Readonly<Partial<Record<PlanKey, StripeProductId>>> = {
  pro_weekly: 'ra_pro',
  pro_monthly: 'ra_pro',
  pro_quarterly: 'ra_pro',
  student_monthly: 'ra_pro_student',
  student_quarterly: 'ra_pro_student',
  pro_week_pass: 'ra_pro_week_pass',
  practice_pack_5: 'ra_practice_pack',
  practice_pack_15: 'ra_practice_pack',
};

/** What the product is called on Stripe's pages and invoices (our own names). */
function productName(id: StripeProductId): string {
  const brand = getBrand('roboapply').name;
  switch (id) {
    case 'ra_pro':
      return `${brand} Pro`;
    case 'ra_pro_student':
      return `${brand} Pro (student)`;
    case 'ra_pro_week_pass':
      return `${brand} Pro 7-day pass`;
    case 'ra_practice_pack':
      return `${brand} practice pack`;
  }
}

/** Stripe allows at most 10 lookup keys in one `prices.list` call. */
export const STRIPE_LOOKUP_KEYS_PER_CALL = 10;

/** `ra_<planKey>_<currency lower case>_<amountMinor>_incl`, e.g. `ra_pro_monthly_usd_2499_incl`. */
export function stripeLookupKey(planKey: PlanKey, currency: StripeCatalogCurrency, amountMinor: number): string {
  return `ra_${planKey}_${currency.toLowerCase()}_${amountMinor}_incl`;
}

/** The inverse of `stripeLookupKey`; null for anything that is not one of ours. */
export function parseStripeLookupKey(key: string | null | undefined): { planKey: PlanKey; currency: StripeCatalogCurrency; amountMinor: number } | null {
  const m = typeof key === 'string' ? /^ra_([a-z0-9_]+)_(usd|twd)_([1-9]\d*)_incl$/.exec(key) : null;
  if (!m || !isPlanKey(m[1])) return null;
  const amountMinor = Number(m[3]);
  if (!Number.isSafeInteger(amountMinor)) return null;
  return { planKey: m[1], currency: m[2] === 'twd' ? 'TWD' : 'USD', amountMinor };
}

type Recurring = { interval: 'week' | 'month'; interval_count: number };

/** How a plan renews on Stripe; null for the pass and the packs (one payment). A quarter is 3 months. */
export function stripeRecurringFor(plan: Pick<CatalogPlan, 'kind' | 'interval'>): Recurring | null {
  if (plan.kind !== 'subscription') return null;
  if (plan.interval === 'week') return { interval: 'week', interval_count: 1 };
  if (plan.interval === 'month') return { interval: 'month', interval_count: 1 };
  if (plan.interval === 'quarter') return { interval: 'month', interval_count: 3 };
  return null;
}

interface PriceSpec {
  planKey: PlanKey;
  currency: StripeCatalogCurrency;
  amountMinor: number;
  lookupKey: string;
  productId: StripeProductId;
  recurring: Recurring | null;
  /** The pinned price id, when the operator pinned one (no sync). */
  pin: string | null;
}

function notSellable(plan: Pick<CatalogPlan, 'key'>, reason: string): BillingError {
  return new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key, reason });
}

/**
 * What Stripe must hold for this plan in this currency. Refuses, before any
 * Stripe call, everything Stripe must never charge: a plan that is not
 * RoboApply's or is not priced in USD (rule A11), the free plan, a plan with
 * no amount, a subscription with no interval, a TWD price nobody configured.
 */
function priceSpec(plan: CatalogPlan, currency: StripeCatalogCurrency): PriceSpec {
  if (plan.brand !== 'roboapply' || plan.currency !== 'USD') throw notSellable(plan, 'not_a_stripe_plan');
  const productId = STRIPE_PRODUCT_FOR_PLAN[plan.key];
  if (plan.kind === 'free' || !productId) throw notSellable(plan, 'no_stripe_product');
  const recurring = stripeRecurringFor(plan);
  if (plan.kind === 'subscription' && !recurring) throw notSellable(plan, 'no_interval');
  const amountMinor = currency === 'TWD' ? (plan.twdPrice?.amountMinor ?? null) : plan.amountMinor;
  if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw notSellable(plan, currency === 'TWD' ? 'no_twd_price' : 'no_amount');
  const pin = currency === 'TWD' ? (plan.twdPrice?.stripePriceId ?? null) : plan.stripePriceId;
  return { planKey: plan.key, currency, amountMinor, lookupKey: stripeLookupKey(plan.key, currency, amountMinor), productId, recurring, pin };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function providerError(what: string, spec: Pick<PriceSpec, 'planKey' | 'lookupKey'> | null, err: unknown): BillingError {
  if (err instanceof BillingError) return err;
  logger.error('RA_BILLING', `stripe catalog: ${what} failed`, { planKey: spec?.planKey ?? null, lookupKey: spec?.lookupKey ?? null, error: errorText(err) });
  return new BillingError('payment_provider_error', 'The payment provider could not prepare this plan. Try again.', {
    provider: 'stripe',
    step: what,
    ...(spec ? { planKey: spec.planKey } : {}),
  });
}

// One cache per Stripe client (a client is one key, so one account and mode):
// the in-flight or settled promise per lookup key, and per product id.
interface ClientCache {
  prices: Map<string, Promise<string>>;
  products: Map<string, Promise<void>>;
}
let caches = new WeakMap<object, ClientCache>();

function cacheOf(stripe: StripeClient): ClientCache {
  let c = caches.get(stripe);
  if (!c) {
    c = { prices: new Map(), products: new Map() };
    caches.set(stripe, c);
  }
  return c;
}

/** Tests only: forget every resolved price and product. */
export function resetStripeCatalogCacheForTests(): void {
  caches = new WeakMap();
}

/** The product exists (created now, or earlier by any instance). One call per product and client. */
function ensureProduct(stripe: StripeClient, id: StripeProductId): Promise<void> {
  const cache = cacheOf(stripe).products;
  const hit = cache.get(id);
  if (hit) return hit;
  const run = (async () => {
    try {
      await stripe.products.create({ id, name: productName(id), metadata: { product: 'roboapply' } }, { idempotencyKey: `catalog:product:${id}` });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'resource_already_exists') return;
      throw err;
    }
  })();
  cache.set(id, run);
  run.catch(() => {
    if (cache.get(id) === run) cache.delete(id);
  });
  return run;
}

function sameRecurring(price: Stripe.Price, want: Recurring | null): boolean {
  const got = price.recurring ?? null;
  if (!want) return got === null;
  return got !== null && got.interval === want.interval && (got.interval_count ?? 1) === want.interval_count;
}

/**
 * A price found under our lookup key must be the price the catalog describes.
 * If it is not (someone edited or reused the key), we refuse to sell on it:
 * a wrong charge is worse than no checkout, and a lookup key is never moved.
 */
function assertPriceMatches(price: Stripe.Price, spec: PriceSpec): void {
  const ok = price.unit_amount === spec.amountMinor && (price.currency ?? '').toLowerCase() === spec.currency.toLowerCase() && sameRecurring(price, spec.recurring);
  if (ok) return;
  logger.error('RA_BILLING', 'stripe catalog: the price under our lookup key does not match the catalog; refusing to sell on it', {
    lookupKey: spec.lookupKey,
    priceId: price.id,
    expected: { amountMinor: spec.amountMinor, currency: spec.currency, recurring: spec.recurring },
    found: { amountMinor: price.unit_amount ?? null, currency: price.currency ?? null, recurring: price.recurring ? { interval: price.recurring.interval, interval_count: price.recurring.interval_count } : null },
  });
  throw new BillingError('payment_provider_error', 'The payment provider holds a different price for this plan.', {
    provider: 'stripe',
    reason: 'price_mismatch',
    planKey: spec.planKey,
  });
}

/** Active prices under these lookup keys (at most 10 keys per call), each checked against its spec. */
async function findPrices(stripe: StripeClient, specs: readonly PriceSpec[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < specs.length; i += STRIPE_LOOKUP_KEYS_PER_CALL) {
    const chunk = specs.slice(i, i + STRIPE_LOOKUP_KEYS_PER_CALL);
    const list = await stripe.prices.list({ lookup_keys: chunk.map((s) => s.lookupKey), active: true, limit: chunk.length });
    for (const price of list.data ?? []) {
      const spec = chunk.find((s) => s.lookupKey === price.lookup_key);
      if (!spec || found.has(spec.lookupKey)) continue;
      assertPriceMatches(price, spec);
      found.set(spec.lookupKey, price.id);
    }
  }
  return found;
}

async function createPrice(stripe: StripeClient, spec: PriceSpec): Promise<string> {
  await ensureProduct(stripe, spec.productId);
  try {
    const created = await stripe.prices.create(
      {
        product: spec.productId,
        currency: spec.currency.toLowerCase(),
        unit_amount: spec.amountMinor,
        lookup_key: spec.lookupKey,
        tax_behavior: 'inclusive',
        ...(spec.recurring ? { recurring: { interval: spec.recurring.interval, interval_count: spec.recurring.interval_count } } : {}),
        metadata: { product: 'roboapply', planKey: spec.planKey },
      },
      { idempotencyKey: `catalog:${spec.lookupKey}` },
    );
    return created.id;
  } catch (err) {
    // Another instance may have created the price between our list and our
    // create (the lookup key is then taken). Look once more before giving up.
    const again = await findPrices(stripe, [spec]).catch(() => new Map<string, string>());
    const id = again.get(spec.lookupKey);
    if (id) return id;
    throw err;
  }
}

async function findOrCreate(stripe: StripeClient, spec: PriceSpec): Promise<string> {
  let step = 'find price';
  try {
    const found = (await findPrices(stripe, [spec])).get(spec.lookupKey);
    if (found) return found;
    step = 'create price';
    return await createPrice(stripe, spec);
  } catch (err) {
    throw providerError(step, spec, err);
  }
}

/** Resolve through the per-client cache: one in-flight promise per lookup key; a failure is forgotten. */
function resolveSpec(stripe: StripeClient, spec: PriceSpec, run: () => Promise<string> = () => findOrCreate(stripe, spec)): Promise<string> {
  if (spec.pin) return Promise.resolve(spec.pin);
  const cache = cacheOf(stripe).prices;
  const hit = cache.get(spec.lookupKey);
  if (hit) return hit;
  const pending = run();
  cache.set(spec.lookupKey, pending);
  pending.catch(() => {
    if (cache.get(spec.lookupKey) === pending) cache.delete(spec.lookupKey);
  });
  return pending;
}

/**
 * The Stripe price id to charge for this plan in this currency.
 *   1. A plan Stripe must not charge (GoApply, CNY, free, no amount) is
 *      refused with `plan_not_sellable` and no Stripe call.
 *   2. A pin is returned as it is, with no Stripe call.
 *   3. Memory, per Stripe client: one in-flight promise per lookup key.
 *   4. `prices.list` by lookup key; the found price must match the catalog.
 *   5. `prices.create` (product first), then one more list if the create lost a race.
 */
export async function resolveStripePriceId(stripe: StripeClient, plan: CatalogPlan, currency: StripeCatalogCurrency): Promise<string> {
  return resolveSpec(stripe, priceSpec(plan, currency));
}

interface PriceLike {
  id?: string | null;
  lookup_key?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * The plan a Stripe price belongs to: the `planKey` we stamped on it, then
 * our lookup key, then a pinned id from the environment; null when the price
 * is not one of ours. Takes the price object (webhooks carry it) or a bare
 * id, which can only match a pin. Never calls Stripe. (The legacy practice
 * plans keep their own map, `priceIdToMockPlanKey`, in the billing service.)
 */
export function planKeyForPrice(price: PriceLike | string | null | undefined, env: EnvSource = process.env): PlanKey | null {
  if (!price) return null;
  if (typeof price === 'string') return planKeyForStripePrice(price, env);
  const meta = price.metadata ?? null;
  // The account may be shared: a price that names another product is not ours.
  if (meta?.planKey && isPlanKey(meta.planKey) && (!meta.product || meta.product === 'roboapply')) return meta.planKey;
  const parsed = parseStripeLookupKey(price.lookup_key);
  if (parsed) return parsed.planKey;
  return planKeyForStripePrice(price.id ?? null, env);
}

export interface SyncedPrice {
  planKey: PlanKey;
  currency: StripeCatalogCurrency;
  priceId: string;
}

/**
 * Optional warm-up: resolve every MVP plan once (and its Taiwan price where
 * one is configured), so the first buyer does not wait for the create. It
 * lists up to 10 lookup keys per call and creates only what is missing.
 * Checkout never needs it to have run.
 */
export async function syncStripeCatalog(stripe: StripeClient, env: EnvSource = process.env): Promise<SyncedPrice[]> {
  const specs: PriceSpec[] = [];
  for (const plan of getPlanCatalog('roboapply', env)) {
    if (plan.kind === 'free' || plan.phase !== 'mvp' || plan.amountMinor === null) continue;
    specs.push(priceSpec(plan, 'USD'));
    if (plan.twdPrice) specs.push(priceSpec(plan, 'TWD'));
  }
  const cache = cacheOf(stripe).prices;
  const unknown = specs.filter((s) => !s.pin && !cache.has(s.lookupKey));
  let found = new Map<string, string>();
  try {
    found = await findPrices(stripe, unknown);
  } catch (err) {
    throw providerError('find prices', null, err);
  }
  const out: SyncedPrice[] = [];
  for (const spec of specs) {
    const known = found.get(spec.lookupKey);
    const priceId = await resolveSpec(stripe, spec, known ? async () => known : async () => {
      try {
        return await createPrice(stripe, spec);
      } catch (err) {
        throw providerError('create price', spec, err);
      }
    });
    out.push({ planKey: spec.planKey, currency: spec.currency, priceId });
  }
  return out;
}
