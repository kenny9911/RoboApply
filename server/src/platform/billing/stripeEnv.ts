// server/src/platform/billing/stripeEnv.ts
//
// What the environment says about Stripe, as pure functions (requirement
// ST-0; docs/jobright-clone/market/MARKET_STRATEGY.md §5.1 "Safety first").
// No Stripe SDK, no logger and no import of platform/flags.ts: the client
// factory (stripeClient.ts), the rail (rails/stripe.ts), the plan catalog and
// the `pay.stripe` capability all read the same answers from here.
//
//   STRIPE_SECRET_KEY                        the key. `sk_test_` / `rk_test_` is a test key;
//                                            EVERY other key is treated as a live key
//   STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION true lets a live key work when VERCEL_ENV is
//                                            not `production` (default: refused)
//   ROBOAPPLY_STRIPE_WEBHOOK_SECRET,         webhook signing secrets; each may hold a
//   STRIPE_WEBHOOK_SECRET                    comma-separated list (rotation)
//
// Three rules follow:
//   1. A live key is usable only in a production runtime. A developer machine
//      or a preview deployment that carries the live key makes no Stripe call
//      of any kind: `getStripe()` answers null. The test is the TEST prefix,
//      not the live one: a key in a format this file does not know (a new
//      prefix, another case, a pasted label in front) is refused outside
//      production like a live key, never waved through as a test key.
//   2. The rail is ready only with a usable key AND a webhook secret. With a
//      key alone a payment would be taken and never fulfilled (the webhook
//      answers 500 without a secret), so plans list with their amounts and
//      `payments_disabled` instead.
//   3. The secret must be one the webhook route can verify with (strategy
//      M-25: a rail is available only when it can charge AND fulfil). See
//      `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` below.

import { parseBoolEnv, type EnvSource } from '../brand/brandEnv.js';

export type StripeKeyMode = 'none' | 'test' | 'live';

export type StripeKeyRefusal = 'missing' | 'live_key_outside_production';

/** The variable that lets a live key work outside production. */
export const STRIPE_LIVE_KEY_OVERRIDE_ENV = 'STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION';

/** Trimmed `STRIPE_SECRET_KEY`, or null when unset or blank. */
export function stripeSecretKey(env: EnvSource = process.env): string | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  return key ? key : null;
}

const TEST_KEY_PREFIXES = ['sk_test_', 'rk_test_'] as const;

/**
 * `test` only for a secret or restricted TEST key (`sk_test_`, `rk_test_`);
 * `live` for every other key, a format we do not recognise included (fail
 * closed: the guard must never mistake a live key for a test key); `none`
 * without one.
 */
export function stripeKeyMode(env: EnvSource = process.env): StripeKeyMode {
  const key = stripeSecretKey(env);
  if (!key) return 'none';
  return TEST_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) ? 'test' : 'live';
}

/** A live key may be used: this is a production runtime, or the operator said so explicitly. */
export function liveKeyAllowed(env: EnvSource = process.env): boolean {
  return env.VERCEL_ENV === 'production' || parseBoolEnv(env[STRIPE_LIVE_KEY_OVERRIDE_ENV]);
}

/** Whether a Stripe client may be built from this environment, and why not. */
export function stripeKeyUsable(env: EnvSource = process.env): { usable: boolean; reason: StripeKeyRefusal | null } {
  const mode = stripeKeyMode(env);
  if (mode === 'none') return { usable: false, reason: 'missing' };
  if (mode === 'live' && !liveKeyAllowed(env)) return { usable: false, reason: 'live_key_outside_production' };
  return { usable: true, reason: null };
}

/**
 * Webhook signing secrets, in the order to try them:
 * `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` then `STRIPE_WEBHOOK_SECRET`, each split
 * on commas, trimmed, with empties and repeats dropped.
 */
export function stripeWebhookSecrets(env: EnvSource = process.env): string[] {
  const out: string[] = [];
  for (const name of ['ROBOAPPLY_STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET']) {
    for (const part of (env[name] ?? '').split(',')) {
      const secret = part.trim();
      if (secret && !out.includes(secret)) out.push(secret);
    }
  }
  return out;
}

/**
 * Whether the webhook route tries every secret of `stripeWebhookSecrets`.
 *
 * FALSE in this phase: `roboapply/routes/stripeWebhook.ts` still reads
 * `ROBOAPPLY_STRIPE_WEBHOOK_SECRET || STRIPE_WEBHOOK_SECRET` and hands that
 * whole string to `constructEvent` as ONE secret. A comma-separated list (or
 * a blank first variable in front of a real second one) therefore fails every
 * signature, and a rail that opened on it would take money and never fulfil:
 * the case ST-0 exists to close. While this is false the rail is ready only
 * when the string the route reads is a single secret.
 *
 * Set it to true in the SAME change that makes the route loop over
 * `stripeWebhookSecrets()` (MKT-2B item 1), and flip the cases named
 * "until the webhook tries every secret" in stripeEnv.test.ts.
 */
export const STRIPE_WEBHOOK_TRIES_EVERY_SECRET: boolean = false;

/**
 * The webhook can verify a signature with what the environment holds: at
 * least one secret, and (until the route tries every secret) the one string
 * the route reads is a single secret, not a list and not blank.
 */
export function stripeWebhookCanVerify(env: EnvSource = process.env, triesEverySecret: boolean = STRIPE_WEBHOOK_TRIES_EVERY_SECRET): boolean {
  if (stripeWebhookSecrets(env).length === 0) return false;
  if (triesEverySecret) return true;
  const read = env.ROBOAPPLY_STRIPE_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET || '';
  return read.trim() !== '' && !read.includes(',');
}

/** Why the Stripe rail is closed; null when it is ready. */
export type StripeRailBlocker = StripeKeyRefusal | 'webhook_secret_missing' | 'webhook_secret_unverifiable';

/**
 * What keeps the Stripe rail closed, the first reason that applies: no key, a
 * live key outside production, no webhook secret, or a webhook secret the
 * route cannot verify with. Null when the rail can take a payment AND fulfil it.
 */
export function stripeRailBlocker(env: EnvSource = process.env): StripeRailBlocker | null {
  const key = stripeKeyUsable(env);
  if (!key.usable) return key.reason ?? 'missing';
  if (stripeWebhookSecrets(env).length === 0) return 'webhook_secret_missing';
  if (!stripeWebhookCanVerify(env)) return 'webhook_secret_unverifiable';
  return null;
}

/** The Stripe rail can take a payment AND fulfil it: a usable key and a webhook secret the webhook can verify with. */
export function stripeRailReady(env: EnvSource = process.env): boolean {
  return stripeRailBlocker(env) === null;
}
