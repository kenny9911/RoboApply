// server/src/roboapply/routes/stripeWebhook.ts
//
// RoboApply's own Stripe webhook (`/api/v1/roboapply/stripe/webhook`), mounted
// with express.raw({ type: 'application/json' }) in app.ts so
// stripe.webhooks.constructEvent sees the untouched request Buffer. Every
// event goes to RoboApplyBillingService.handleRoboApplyStripeEvent, which
// ignores events whose metadata.product isn't 'roboapply'.
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

export interface StripeWebhookDeps {
  getStripe?: () => Stripe | null;
  handle?: (event: Stripe.Event, stripe: Stripe) => Promise<StripeEventResult>;
  secret?: () => string | undefined;
}

export function createStripeWebhookRouter(deps: StripeWebhookDeps = {}): Router {
  const router = Router();
  const getStripe = deps.getStripe ?? defaultGetStripe;
  const handle = deps.handle ?? handleRoboApplyStripeEvent;
  const secretOf = deps.secret ?? (() => process.env.ROBOAPPLY_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET);

  router.post('/', async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    const secret = secretOf();
    if (!secret) {
      logger.error('ROBOAPPLY_STRIPE', 'No STRIPE_WEBHOOK_SECRET configured');
      return res.status(500).json({ error: 'webhook_secret_missing' });
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, req.headers['stripe-signature'] as string, secret);
    } catch (err) {
      logger.warn('ROBOAPPLY_STRIPE', 'Signature verification failed', { error: err instanceof Error ? err.message : String(err) });
      return res.status(400).json({ error: 'invalid_signature' });
    }
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
