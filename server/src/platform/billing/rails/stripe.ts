// server/src/platform/billing/rails/stripe.ts
//
// StripeRail (RoboApply, USD). ARCHITECTURE.md §7.4; PRODUCT_PLAN.md §6.3.
//   - Pro plans (`pro_weekly`, `pro_monthly`, `pro_quarterly`, student V2) are
//     Stripe subscriptions on `STRIPE_PRICE_<PLANKEY>`;
//   - the 7-day pass and practice packs are one-time payments (mode
//     'payment') on their own one-time prices;
//   - every session, subscription and payment carries metadata `brand`,
//     `planKey`, `userId`, `seekerProfileId`, `product: 'roboapply'` and the
//     checkout acknowledgements, so the webhook can reconcile without guessing.
// Promotion codes are V2 (F-BILL-11) and stay off unless
// `STRIPE_PROMOTION_CODES=true`; no offer ships at launch.

import { parseBoolEnv, type EnvSource } from '../../brand/brandEnv.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { BillingError } from '../errors.js';
import { appOrigin, withQueryParam } from '../origins.js';
import { getStripe as defaultGetStripe, type StripeClient } from '../stripeClient.js';
import { CHECKOUT_ACK_PROSE_VERSION } from '../acknowledgements.js';
import type { CheckoutOrder, CheckoutResult, PaymentRailImpl } from './types.js';

export type StripeRailDb = Pick<ExtendedPrismaClient, 'seekerSubscription'>;

export interface StripeRailDeps {
  getStripe?: (env: EnvSource) => StripeClient | null;
  getDb?: () => Promise<StripeRailDb>;
  env?: EnvSource;
}

const defaultGetDb = async (): Promise<StripeRailDb> => (await import('../../../lib/prisma.js')).default;

/** Metadata stamped on every Stripe object we create for a checkout. */
export function stripeCheckoutMetadata(order: CheckoutOrder): Record<string, string> {
  return {
    product: 'roboapply',
    brand: order.brand.id,
    planKey: order.plan.key,
    userId: order.user.id,
    seekerProfileId: order.seekerProfileId,
    autoRenewAck: order.plan.requiresAutoRenewAck ? (order.acknowledgements.autoRenewAck ? 'yes' : 'no') : 'n/a',
    withdrawalWaiver: order.acknowledgements.withdrawalWaiver ? 'yes' : 'no',
    ackVersion: CHECKOUT_ACK_PROSE_VERSION,
  };
}

export function createStripeRail(deps: StripeRailDeps = {}): PaymentRailImpl {
  const getStripe = deps.getStripe ?? defaultGetStripe;
  const getDb = deps.getDb ?? defaultGetDb;

  async function ensureCustomer(stripe: StripeClient, order: CheckoutOrder): Promise<string> {
    if (order.stripeCustomerId) return order.stripeCustomerId;
    const customer = await stripe.customers.create({
      email: order.user.email,
      metadata: { userId: order.user.id, seekerProfileId: order.seekerProfileId, product: 'roboapply', brand: order.brand.id },
    });
    const db = await getDb();
    await db.seekerSubscription.upsert({
      where: { seekerProfileId: order.seekerProfileId },
      update: { stripeCustomerId: customer.id },
      create: { seekerProfileId: order.seekerProfileId, tier: 'free', status: 'active', stripeCustomerId: customer.id, brand: order.brand.id },
    });
    return customer.id;
  }

  return {
    id: 'stripe',
    isConfigured: (_brand, env) => Boolean(env.STRIPE_SECRET_KEY?.trim()),
    async createCheckout(order: CheckoutOrder): Promise<CheckoutResult> {
      const env = deps.env ?? process.env;
      const stripe = getStripe(env);
      if (!stripe) throw new BillingError('rail_not_configured', 'Card payments are not set up', { rail: 'stripe' });
      const plan = order.plan;
      if (!plan.sellable || !plan.stripePriceId) {
        throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key });
      }
      const customer = await ensureCustomer(stripe, order);
      const metadata = stripeCheckoutMetadata(order);
      const origin = appOrigin(order.brand, env);
      const successPath = order.successPath ?? '/settings/billing/return';
      const cancelPath = order.cancelPath ?? '/settings/billing';
      const success_url = `${origin}${withQueryParam(withQueryParam(successPath, 'billing', 'success'), 'session_id', '{CHECKOUT_SESSION_ID}')}`;
      const cancel_url = `${origin}${withQueryParam(cancelPath, 'billing', 'cancel')}`;
      const subscription = plan.kind === 'subscription';

      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: subscription ? 'subscription' : 'payment',
          customer,
          line_items: [{ price: plan.stripePriceId, quantity: 1 }],
          client_reference_id: order.user.id,
          metadata,
          ...(subscription
            ? { subscription_data: { metadata } }
            : { payment_intent_data: { metadata }, invoice_creation: { enabled: true, invoice_data: { metadata } } }),
          billing_address_collection: 'auto',
          success_url,
          cancel_url,
          allow_promotion_codes: parseBoolEnv(env.STRIPE_PROMOTION_CODES),
        });
      } catch (err) {
        throw new BillingError('payment_provider_error', 'The payment page could not be opened', {
          provider: 'stripe',
          message: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
      if (!session.url) throw new BillingError('payment_provider_error', 'Stripe did not return a checkout URL', { provider: 'stripe' });
      return { kind: 'redirect', url: session.url, orderId: session.id };
    },
  };
}
