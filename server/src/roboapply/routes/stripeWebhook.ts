// server/src/roboapply/routes/stripeWebhook.ts
//
// RoboApply's own Stripe webhook (`/api/v1/roboapply/stripe/webhook`), mounted
// with express.raw({ type: 'application/json' }) in app.ts so
// stripe.webhooks.constructEvent sees the untouched request Buffer. Every
// event goes to RoboApplyBillingService.handleRoboApplyStripeEvent, which
// ignores (HTTP 200, `handled: false`) every object that is not ours: the
// Stripe account may be shared with other products.
//
// Signing secrets (MARKET_STRATEGY.md §5.1 "Webhook"): every secret of
// `stripeWebhookSecrets()` is tried in order (both variable names, each a
// comma-separated list, trimmed), and the first that verifies wins, so the
// CLI secret and the Dashboard endpoint secret can both be live during a
// rotation. None verifies → 400; none configured → 500. The rail is open on
// such a list because of this loop: `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` in
// platform/billing/stripeEnv.ts states it, and the two change together.
//
// Replays are safe (TASK_PLAN.md WP-21a "webhook idempotency"): checkout
// sessions and failed invoices are claimed once, credit grants are guarded by
// billing period or an idempotency key, and subscription syncs only write the
// current Stripe state. So a processing failure answers 500 and Stripe
// retries; a replay answers 200 with `duplicate: true`.

import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { getStripe as defaultGetStripe, handleRoboApplyStripeEvent, type StripeEventResult } from '../services/RoboApplyBillingService.js';
import { logger } from '../../services/LoggerService.js';
import { stripeWebhookSecrets } from '../../platform/billing/stripeEnv.js';

export interface StripeWebhookDeps {
  getStripe?: () => Stripe | null;
  handle?: (event: Stripe.Event, stripe: Stripe) => Promise<StripeEventResult>;
  /** Tests: the one secret to verify with. */
  secret?: () => string | undefined;
  /** Tests: every secret to try, in order. Wins over `secret`. */
  secrets?: () => string[];
}

export function createStripeWebhookRouter(deps: StripeWebhookDeps = {}): Router {
  const router = Router();
  const getStripe = deps.getStripe ?? defaultGetStripe;
  const handle = deps.handle ?? handleRoboApplyStripeEvent;
  // Every configured secret, in the order to try them (rotation: the CLI secret and the Dashboard one).
  const secretsOf = (): string[] => {
    if (deps.secrets) return deps.secrets();
    if (!deps.secret) return stripeWebhookSecrets(process.env);
    const one = deps.secret();
    return one ? [one] : [];
  };

  router.post('/', async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    const secrets = secretsOf();
    if (secrets.length === 0) {
      logger.error('ROBOAPPLY_STRIPE', 'No STRIPE_WEBHOOK_SECRET configured');
      return res.status(500).json({ error: 'webhook_secret_missing' });
    }
    // The first secret that verifies wins; 400 only when none does.
    let verified: Stripe.Event | null = null;
    let lastError: unknown = null;
    for (const secret of secrets) {
      try {
        verified = stripe.webhooks.constructEvent(req.body as Buffer, req.headers['stripe-signature'] as string, secret);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!verified) {
      logger.warn('ROBOAPPLY_STRIPE', 'Signature verification failed', { error: lastError instanceof Error ? lastError.message : String(lastError), secretsTried: secrets.length });
      return res.status(400).json({ error: 'invalid_signature' });
    }
    const event: Stripe.Event = verified;
    try {
      const result = await handle(event, stripe);
      if (result.failed) return res.status(500).json({ received: true, handled: false });
      return res.json({ received: true, handled: result.handled, ...(result.duplicate ? { duplicate: true } : {}) });
    } catch (err) {
      logger.error('ROBOAPPLY_STRIPE', 'Event handler threw', { type: event.type, error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ received: true, handled: false });
    }
  });
  return router;
}

const router = createStripeWebhookRouter();
export default router;
