// backend/src/roboapply/routes/settings.ts
//
// Mounted at /api/v1/roboapply/settings/* in backend/src/index.ts.
//
//   GET   /                       — full RoboSettings payload for the
//                                   Settings page (mission + tier + caps +
//                                   reviewMode + tone + boardConnections).
//   PATCH /                       — partial update (reviewMode, dailyCap,
//                                   coverLetterToneOverride, enabled).
//   POST  /tone                   — legacy tone-only endpoint, kept for
//                                   back-compat with prior frontends.
//   GET   /billing                — basic billing snapshot (legacy shape).
//   GET   /billing/tiers          — static 3-tier catalogue for the
//                                   Settings tier/billing card.
//   POST  /billing/portal         — Stripe customer portal redirect URL
//                                   (V1: returns 503 when not configured).
//   POST  /account/delete         — GDPR delete confirm flow: soft-disable +
//                                   session revoke (same shared flow as
//                                   account.ts POST /delete); the nightly
//                                   account-purge cron hard-purges later.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireSeekerProfile } from '../engine/middleware/seekerAuth.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { seekerAuthService } from '../engine/services/SeekerAuthService.js';
import {
  updateSettings,
  getMissionForUser,
  RoboApplyMissionError,
  type RoboApplyTier,
} from '../services/RoboApplyMissionService.js';
import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────

const DAILY_CAP_MAX: Record<RoboApplyTier, number> = {
  free: 3,
  premium: 15,
  premium_plus: 30,
  starter: 15,
  growth: 30,
};

const TIER_PRICE_MONTHLY_USD: Record<RoboApplyTier, number> = {
  free: 0,
  premium: 19,
  premium_plus: 49,
  starter: 15,
  growth: 29,
};

const TIER_DESCRIPTION: Record<RoboApplyTier, string> = {
  free: 'Get matched and applied to up to 3 jobs per day. Watermarked cover letters.',
  premium: 'Up to 15 applications per day. Opus-quality cover letters. Auto-apply by default.',
  premium_plus: 'Up to 30 applications per day. Tone steering. Per-job manual override.',
  starter: '10 mock-interview credits per month. Resume tailoring + interview practice.',
  growth: '28 mock-interview credits per month. Everything in Starter, more practice.',
};

function settingsPayload(
  mission: NonNullable<Awaited<ReturnType<typeof getMissionForUser>>>,
) {
  const tier = mission.tier as RoboApplyTier;
  return {
    mission,
    tier,
    dailyCap: mission.dailyCap,
    dailyCapMax: DAILY_CAP_MAX[tier] ?? 3,
    reviewMode: mission.reviewMode,
    coverLetterToneOverride: mission.coverLetterToneOverride ?? null,
    boardConnections: [
      // Static for V1 — Lever lands in V1.1. Greenhouse OAuth state is
      // not yet per-user-scoped on RoboApply.
      { adapter: 'greenhouse', connected: true, lastVerifiedAt: null },
      { adapter: 'lever', connected: false, lastVerifiedAt: null },
    ],
  };
}

// ─── GET / ──────────────────────────────────────────────────────────────

router.get('/', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const mission = await getMissionForUser(req.user!.id);
    if (!mission) {
      return res
        .status(404)
        .json({ success: false, code: 'mission_not_found', error: 'No RoboApply mission' });
    }
    return res.json({ success: true, data: settingsPayload(mission) });
  } catch (err) {
    logger.error(
      'ROBOAPPLY_SETTINGS',
      'GET / failed',
      { error: err instanceof Error ? err.message : String(err) },
      req.requestId,
    );
    return res
      .status(500)
      .json({ success: false, code: 'settings_failed', error: 'Failed to load settings' });
  }
});

// ─── PATCH / ────────────────────────────────────────────────────────────

router.patch('/', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const update: Parameters<typeof updateSettings>[1] = {};
    if (body.reviewMode === 'auto' || body.reviewMode === 'review_first') {
      update.reviewMode = body.reviewMode;
    }
    if (typeof body.dailyCap === 'number') update.dailyCap = body.dailyCap;
    if (
      body.coverLetterToneOverride === null ||
      typeof body.coverLetterToneOverride === 'string'
    ) {
      update.coverLetterToneOverride = body.coverLetterToneOverride as string | null;
    }

    // `enabled` is on the mission row directly; updateSettings doesn't expose
    // it yet, so we patch via prisma when present. Keeps the service surface
    // narrow without forcing a service-shape change for one field.
    if (typeof body.enabled === 'boolean') {
      const existing = await prisma.roboApplyMission.findUnique({
        where: { userId: req.user!.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ success: false, code: 'mission_not_found', error: 'No RoboApply mission' });
      }
      await prisma.roboApplyMission.update({
        where: { id: existing.id },
        data: { enabled: body.enabled },
      });
    }

    const updated = await updateSettings(req.user!.id, update);
    return res.json({ success: true, data: settingsPayload(updated) });
  } catch (err) {
    if (err instanceof RoboApplyMissionError) {
      const status =
        err.code === 'invalid_input' ? 400 : err.code === 'mission_not_found' ? 404 : 500;
      return res.status(status).json({
        success: false,
        code: err.code,
        error: err.message,
        ...(err.detail ?? {}),
      });
    }
    logger.error(
      'ROBOAPPLY_SETTINGS',
      'PATCH / failed',
      { error: err instanceof Error ? err.message : String(err) },
      req.requestId,
    );
    return res
      .status(500)
      .json({ success: false, code: 'settings_update_failed', error: 'Failed to update settings' });
  }
});

// ─── POST /tone (legacy) ────────────────────────────────────────────────

router.post('/tone', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const toneOverride =
      typeof req.body?.toneOverride === 'string' ? req.body.toneOverride : null;
    if (toneOverride !== null && toneOverride.length > 2_000) {
      return res
        .status(400)
        .json({
          success: false,
          code: 'invalid_input',
          error: 'toneOverride must be ≤ 2000 characters',
        });
    }
    const mission = await updateSettings(req.user!.id, {
      coverLetterToneOverride: toneOverride,
    });
    return res.json({ success: true, data: { mission } });
  } catch (err) {
    if (err instanceof RoboApplyMissionError) {
      const status =
        err.code === 'invalid_input' ? 403 : err.code === 'mission_not_found' ? 404 : 500;
      return res.status(status).json({
        success: false,
        code: err.code,
        error: err.message,
        ...(err.detail ?? {}),
      });
    }
    logger.error(
      'ROBOAPPLY_SETTINGS',
      'POST /tone failed',
      { error: err instanceof Error ? err.message : String(err) },
      req.requestId,
    );
    return res
      .status(500)
      .json({ success: false, code: 'tone_update_failed', error: 'Failed to update tone' });
  }
});

// ─── GET /billing (legacy) ──────────────────────────────────────────────

router.get('/billing', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const mission = await getMissionForUser(req.user!.id);
    const portalUrl = process.env.STRIPE_BILLING_PORTAL_URL ?? null;
    return res.json({
      success: true,
      data: {
        tier: mission?.tier ?? 'free',
        portalUrl,
        stripeReady: !!portalUrl,
      },
    });
  } catch (err) {
    logger.error(
      'ROBOAPPLY_SETTINGS',
      'GET /billing failed',
      { error: err instanceof Error ? err.message : String(err) },
      req.requestId,
    );
    return res
      .status(500)
      .json({ success: false, code: 'billing_failed', error: 'Failed to load billing info' });
  }
});

// ─── GET /billing/tiers ─────────────────────────────────────────────────

router.get(
  '/billing/tiers',
  requireAuth,
  requireSeekerProfile,
  async (_req: Request, res: Response) => {
    const tiers = (['free', 'premium', 'premium_plus'] as RoboApplyTier[]).map((t) => ({
      tier: t,
      priceUsdMonthly: TIER_PRICE_MONTHLY_USD[t],
      dailyCap: DAILY_CAP_MAX[t],
      description: TIER_DESCRIPTION[t],
      stripePriceId:
        process.env[`STRIPE_ROBOAPPLY_${t.toUpperCase()}_PRICE_ID`] ?? null,
    }));
    return res.json({ success: true, data: { tiers } });
  },
);

// ─── POST /billing/portal ───────────────────────────────────────────────

router.post(
  '/billing/portal',
  requireAuth,
  requireSeekerProfile,
  async (_req: Request, res: Response) => {
    const portalUrl = process.env.STRIPE_BILLING_PORTAL_URL ?? null;
    if (!portalUrl) {
      return res.status(503).json({
        success: false,
        code: 'billing_portal_unavailable',
        error: 'Billing portal not configured for RoboApply yet',
      });
    }
    return res.json({ success: true, data: { url: portalUrl } });
  },
);

// ─── POST /account/delete ───────────────────────────────────────────────

router.post(
  '/account/delete',
  requireAuth,
  requireSeekerProfile,
  async (req: Request, res: Response) => {
    const confirmEmail =
      typeof req.body?.confirmEmail === 'string' ? req.body.confirmEmail.trim() : '';
    const userEmail = (req.user?.email ?? '').toLowerCase();
    if (!confirmEmail || confirmEmail.toLowerCase() !== userEmail) {
      return res.status(400).json({
        success: false,
        code: 'confirm_email_mismatch',
        error: 'confirmEmail must match the signed-in account email',
      });
    }
    // Same shared soft-delete as account.ts POST /delete: stamp
    // SeekerProfile.deletedAt (login then throws SeekerAccountDeletedError)
    // and revoke every session. The nightly account-purge sweep
    // (SeekerAccountPurgeService, cron /api/v1/cron/account-purge) hard-purges
    // R2 artifacts + the User row after the retention window.
    try {
      await seekerAuthService.softDeleteAccount(req.user!.id);
      res.clearCookie(SESSION_COOKIE_NAME);
      logger.warn(
        'ROBOAPPLY_SETTINGS',
        'account soft-deleted (GDPR)',
        { userId: req.user!.id, email: userEmail },
        req.requestId,
      );
      return res.json({ success: true, data: { ok: true, deactivated: true } });
    } catch (err) {
      logger.error(
        'ROBOAPPLY_SETTINGS',
        'POST /account/delete failed',
        { error: err instanceof Error ? err.message : String(err) },
        req.requestId,
      );
      return res.status(500).json({ success: false, code: 'delete_failed', error: 'Failed to delete account' });
    }
  },
);

export default router;
