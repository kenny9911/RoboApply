// server/src/platform/billing/stripeClient.ts
//
// The one place that builds the Stripe SDK client (RoboApply only; GoApply
// never uses Stripe, TASK_PLAN.md R-08/§6.1 rule 6). Tests swap the client
// with `setStripeClientForTests` so nothing reaches the network.

import Stripe from 'stripe';
import type { EnvSource } from '../brand/brandEnv.js';

export type StripeClient = Stripe;

let testClient: StripeClient | null | undefined;
let cached: { key: string; client: StripeClient } | null = null;

/** The Stripe client, or null when `STRIPE_SECRET_KEY` is unset. */
export function getStripe(env: EnvSource = process.env): StripeClient | null {
  if (testClient !== undefined) return testClient;
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (cached?.key === key) return cached.client;
  const client = new Stripe(key);
  cached = { key, client };
  return client;
}

/** Tests only: `undefined` restores the real client. */
export function setStripeClientForTests(client: StripeClient | null | undefined): void {
  testClient = client;
}
