// server/src/platform/billing/stripeClient.ts
//
// The one place that builds the Stripe SDK client (RoboApply only; GoApply
// never uses Stripe, rule A11). Every Stripe call in the server goes through
// `getStripe` (stripeSingleClient.test.ts holds that no other file constructs
// a client), so the rule below covers checkout, the catalog sync, cancel,
// switch, portal, refunds, the webhook and the admin payment report alike.
//
// Safety (requirement ST-0; MARKET_STRATEGY.md §5.1 "Safety first"): a live
// key outside a production runtime is refused. `getStripe` answers null, as it
// does with no key at all, and says so once per process. Every key that does
// not start with `sk_test_` or `rk_test_` counts as a live key (stripeEnv.ts
// `stripeKeyMode`). A developer machine or a preview deployment needs an
// `sk_test_` key; the explicit way out is
// STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true.
//
// Tests swap the client with `setStripeClientForTests` so nothing reaches the
// network.

import Stripe from 'stripe';
import { logger } from '../../services/LoggerService.js';
import type { EnvSource } from '../brand/brandEnv.js';
import { STRIPE_LIVE_KEY_OVERRIDE_ENV, stripeKeyUsable, stripeSecretKey } from './stripeEnv.js';

export type StripeClient = Stripe;

/** SDK options of the shared client: two network retries, and our name on every request. */
export const STRIPE_CLIENT_CONFIG = {
  maxNetworkRetries: 2,
  appInfo: { name: 'RoboApply', url: 'https://www.roboapply.io' },
} as const;

let testClient: StripeClient | null | undefined;
let cached: { key: string; client: StripeClient } | null = null;
let liveKeyRefusalLogged = false;

/**
 * The Stripe client, or null when `STRIPE_SECRET_KEY` is unset or is not a
 * test key outside production (stripeEnv.ts `stripeKeyUsable`).
 */
export function getStripe(env: EnvSource = process.env): StripeClient | null {
  if (testClient !== undefined) return testClient;
  const usable = stripeKeyUsable(env);
  if (!usable.usable) {
    if (usable.reason === 'live_key_outside_production' && !liveKeyRefusalLogged) {
      liveKeyRefusalLogged = true;
      // Never the key, nor any part of it: only that it is a live one.
      logger.error('RA_BILLING', 'Stripe is off: STRIPE_SECRET_KEY is not a test key (sk_test_ or rk_test_), so it is treated as a live key, and this is not a production runtime. No Stripe call is made. Use a test key here, or set the override to allow the live key.', {
        keyMode: 'live',
        vercelEnv: env.VERCEL_ENV ?? null,
        override: STRIPE_LIVE_KEY_OVERRIDE_ENV,
      });
    }
    return null;
  }
  const key = stripeSecretKey(env)!;
  if (cached?.key === key) return cached.client;
  const client = new Stripe(key, { ...STRIPE_CLIENT_CONFIG, appInfo: { ...STRIPE_CLIENT_CONFIG.appInfo } });
  cached = { key, client };
  return client;
}

/** Tests only: `undefined` restores the real client. */
export function setStripeClientForTests(client: StripeClient | null | undefined): void {
  testClient = client;
}

/** Tests only: forget the built client and the "refused once" log state. */
export function resetStripeClientForTests(): void {
  cached = null;
  liveKeyRefusalLogged = false;
}
