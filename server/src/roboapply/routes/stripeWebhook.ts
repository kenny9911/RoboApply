// server/src/roboapply/routes/stripeWebhook.ts
//
// Self-contained RoboApply Stripe webhook. In the RoboHire monorepo the
// RoboApply subscription webhook events were dispatched off the recruiter's
// shared /api/v1/webhooks/stripe endpoint (by metadata.product === 'roboapply').
// Standalone RoboApply owns its own endpoint here and delegates every event to
// RoboApplyBillingService.handleRoboApplyStripeEvent, which already ignores any
// event whose metadata.product isn't 'roboapply'.
//
// Mounted with express.raw({ type: 'application/json' }) in app.ts so
// stripe.webhooks.constructEvent sees the untouched request Buffer.

import { Router, type Request, type Response } from 'express';
import { getStripe, handleRoboApplyStripeEvent } from '../services/RoboApplyBillingService.js';
import { logger } from '../../services/LoggerService.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }

  const secret =
    process.env.ROBOAPPLY_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('ROBOAPPLY_STRIPE', 'No STRIPE_WEBHOOK_SECRET configured');
    return res.status(500).json({ error: 'webhook_secret_missing' });
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      signature as string,
      secret,
    );
  } catch (err) {
    logger.warn('ROBOAPPLY_STRIPE', 'Signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    const result = await handleRoboApplyStripeEvent(event, stripe);
    return res.json({ received: true, handled: result.handled });
  } catch (err) {
    logger.error('ROBOAPPLY_STRIPE', 'Event handler threw', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    // 200 so Stripe does not retry a poison event forever; we've logged it.
    return res.json({ received: true, handled: false });
  }
});

export default router;
