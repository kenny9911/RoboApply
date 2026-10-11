// server/src/platform/billing/stripePortal.ts
//
// The Stripe customer portal configuration, made by code (requirement ST-7;
// docs/jobright-clone/market/MARKET_STRATEGY.md §5.1 "Portal", M-16). Nothing
// is set up in the Dashboard: the first portal session finds our configuration
// or creates it, and later sessions answer from memory.
//
//   What the portal offers   invoices, payment method, customer details
//                            (email, name, address, tax id), cancel at the end
//                            of the paid period with a reason.
//   What it does not offer   changing the plan. Plan changes stay in the app,
//                            where the renewal acknowledgement for the new
//                            terms is recorded before anything is charged.
//   Whose it is              ours: `metadata.product = 'roboapply'` plus a hash
//                            of the desired settings. The Stripe account may be
//                            shared with other products, so the account's
//                            DEFAULT configuration is never read or changed,
//                            and every session names ours explicitly.
//
// Lookup: memory (per Stripe client) → `billingPortal.configurations.list`
// (active ones, ours by metadata and hash) → `billingPortal.configurations.create`
// under the idempotency key `portalcfg:<hash>`. Changed settings give a new
// hash and therefore a new configuration; the old one is left alone (sessions
// already open keep working).
//
// Stripe never serves GoApply (rule A11): a brand that does not list the
// Stripe rail is refused before any call.

import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import type { EnvSource } from '../brand/brandEnv.js';
import type { ProductBrand } from '../brand/registry.js';
import { BillingError } from './errors.js';
import { appOrigin } from './origins.js';
import type { StripeClient } from './stripeClient.js';

/** The legal pages the portal links to (app/legal/[doc]; both slugs exist on every brand). */
export const PORTAL_PRIVACY_PATH = '/legal/privacy';
export const PORTAL_TERMS_PATH = '/legal/terms';

/** `metadata.product` of every Stripe object this product creates. */
const PRODUCT = 'roboapply';

/** How many characters of the settings hash are kept (`metadata.configHash`). */
export const PORTAL_CONFIG_HASH_LENGTH = 16;

/** Page size of the lookup, and how many pages are read before giving up and creating. */
const LIST_LIMIT = 100;
const MAX_LIST_PAGES = 5;

/** The cancellation reasons the portal offers (the same set the in-app cancel accepts). */
const CANCELLATION_REASONS = [
  'customer_service',
  'low_quality',
  'missing_features',
  'other',
  'switched_service',
  'too_complex',
  'too_expensive',
  'unused',
] as const;

type PortalSettings = Pick<Stripe.BillingPortal.ConfigurationCreateParams, 'business_profile' | 'features'>;

/**
 * The settings we want, without metadata: what the hash is taken over.
 * `subscription_update` is OFF on purpose (see the header).
 */
export function desiredPortalSettings(brand: ProductBrand, env: EnvSource = process.env): PortalSettings {
  const origin = appOrigin(brand, env);
  return {
    business_profile: {
      privacy_policy_url: `${origin}${PORTAL_PRIVACY_PATH}`,
      terms_of_service_url: `${origin}${PORTAL_TERMS_PATH}`,
    },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address', 'tax_id'] },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: { enabled: true, options: [...CANCELLATION_REASONS] },
      },
      subscription_update: { enabled: false },
    },
  };
}

/** JSON with object keys in a fixed order, so the same settings always give the same hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** First 16 hex characters of the SHA-256 of the desired settings. */
export function portalConfigHash(settings: PortalSettings): string {
  return createHash('sha256').update(canonicalJson(settings), 'utf8').digest('hex').slice(0, PORTAL_CONFIG_HASH_LENGTH);
}

/** What is sent to `billingPortal.configurations.create`: the settings plus our mark. */
export function desiredPortalConfiguration(brand: ProductBrand, env: EnvSource = process.env): Stripe.BillingPortal.ConfigurationCreateParams {
  const settings = desiredPortalSettings(brand, env);
  return { ...settings, metadata: { product: PRODUCT, configHash: portalConfigHash(settings) } };
}

// One cache per Stripe client (a client is one key, so one account and mode):
// the in-flight or settled promise per settings hash.
let caches = new WeakMap<object, Map<string, Promise<string>>>();

function cacheOf(stripe: StripeClient): Map<string, Promise<string>> {
  let c = caches.get(stripe);
  if (!c) {
    c = new Map();
    caches.set(stripe, c);
  }
  return c;
}

/** Tests only: forget every resolved configuration. */
export function resetStripePortalCacheForTests(): void {
  caches = new WeakMap();
}

/** Our active configuration with this hash, or null. Reads active configurations only; never the default one as such. */
async function findConfiguration(stripe: StripeClient, hash: string): Promise<string | null> {
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const list = await stripe.billingPortal.configurations.list({ active: true, limit: LIST_LIMIT, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const data = list.data ?? [];
    const hit = data.find((c) => c.metadata?.product === PRODUCT && c.metadata?.configHash === hash);
    if (hit) return hit.id;
    const last = data[data.length - 1];
    if (!list.has_more || !last) return null;
    startingAfter = last.id;
  }
  return null;
}

/**
 * The id of our portal configuration for this brand, found or created.
 *   1. A brand that does not list the Stripe rail is refused (rule A11), with no Stripe call.
 *   2. Memory, per Stripe client: one in-flight promise per settings hash; a failure is forgotten.
 *   3. `billingPortal.configurations.list({ active: true })`: ours by `metadata.product` and `metadata.configHash`.
 *   4. `billingPortal.configurations.create` under `portalcfg:<hash>` (two instances that race create one).
 * Throws what Stripe throws; the caller answers 502.
 */
export function ensurePortalConfiguration(stripe: StripeClient, brand: ProductBrand, env: EnvSource = process.env): Promise<string> {
  if (!brand.paymentRails.includes('stripe')) {
    return Promise.reject(new BillingError('rail_not_allowed', 'Card payments are not offered on this site', { rail: 'stripe' }));
  }
  const desired = desiredPortalConfiguration(brand, env);
  const hash = desired.metadata!.configHash as string;
  const cache = cacheOf(stripe);
  const hit = cache.get(hash);
  if (hit) return hit;
  const pending = (async () => {
    const found = await findConfiguration(stripe, hash);
    if (found) return found;
    const created = await stripe.billingPortal.configurations.create(desired, { idempotencyKey: `portalcfg:${hash}` });
    return created.id;
  })();
  cache.set(hash, pending);
  pending.catch(() => {
    if (cache.get(hash) === pending) cache.delete(hash);
  });
  return pending;
}
