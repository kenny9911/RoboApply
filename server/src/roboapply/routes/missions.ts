// backend/src/roboapply/routes/missions.ts
//
// Mounted at /api/v1/roboapply/missions/* in backend/src/index.ts.
//
//   GET   /me                    — return the user's mission (404 if none).
//   POST  /                      — onboarding-complete: create the real
//                                  mission row. Requires intent + tier.
//                                  Bumps an existing shell row instead of
//                                  rejecting (signup creates a shell).
//   PATCH /me/intent             — edit intent text. Re-fires the parser
//                                  and bumps intentVersion.
//   POST  /me/pause              — body { durationHours?: 24|168|null }.
//                                  null/missing = indefinite.
//   POST  /me/resume             — clear pausedUntil.
//
// All routes go through (requireAuth, requireSeekerProfile) so a RoboApply
// session is required.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireSeekerProfile } from '../engine/middleware/seekerAuth.js';
import {
  createMission,
  getMissionForUser,
  updateIntent,
  pauseMission,
  resumeMission,
  RoboApplyMissionError,
  type RoboApplyTier,
} from '../services/RoboApplyMissionService.js';
import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';

const router = Router();

function errorStatus(code: string): number {
  switch (code) {
    case 'mission_not_found':
      return 404;
    case 'mission_exists':
      return 409;
    case 'invalid_input':
    case 'intent_parse_failed':
      return 400;
    default:
      return 500;
  }
}

function isValidTier(value: unknown): value is RoboApplyTier {
  return value === 'free' || value === 'premium' || value === 'premium_plus';
}

function isValidLocale(value: unknown): boolean {
  return typeof value === 'string'
    && ['en', 'zh', 'zh-TW', 'ja', 'es', 'fr', 'pt', 'de'].includes(value);
}

// ─── GET /me ────────────────────────────────────────────────────────────

router.get('/me', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const mission = await getMissionForUser(req.user!.id);
    if (!mission) {
      return res.status(404).json({
        success: false,
        code: 'mission_not_found',
        error: 'No RoboApply mission for this user',
      });
    }
    return res.json({ success: true, data: { mission } });
  } catch (err) {
    logger.error('ROBOAPPLY_MISSION', 'GET /me failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'get_mission_failed', error: 'Failed to load mission' });
  }
});

// ─── POST / ─────────────────────────────────────────────────────────────
//
// Onboarding-complete. Body:
//   {
//     intentText:  string (required),
//     tier:        'free' | 'premium' | 'premium_plus' (required),
//     dailyCap?:   number,
//     timezone:    IANA TZ string (required),
//     locale:      RoboApply locale (required),
//     resumeId?:   string,
//     reviewMode?: 'auto' | 'review_first',
//   }

router.post('/', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const intentText = typeof body.intentText === 'string' ? body.intentText.trim() : '';
    const tier = body.tier;
    const timezone = typeof body.timezone === 'string' ? body.timezone : 'UTC';
    const locale = body.locale;
    if (intentText.length < 5) {
      return res.status(400).json({ success: false, code: 'invalid_input', error: 'intentText is required' });
    }
    if (!isValidTier(tier)) {
      return res.status(400).json({ success: false, code: 'invalid_input', error: 'tier must be free|premium|premium_plus' });
    }
    if (!isValidLocale(locale)) {
      return res.status(400).json({ success: false, code: 'invalid_input', error: 'locale is required (en|zh|zh-TW|ja|es|fr|pt|de)' });
    }

    // If a shell mission exists from signup, upgrade it in place; otherwise
    // create a fresh one. Both paths re-fire the intent parser.
    const userId = req.user!.id;
    const existing = await prisma.roboApplyMission.findUnique({ where: { userId } });
    if (existing) {
      // Upgrade the shell: update intent + tier + timezone + locale + enabled.
      await prisma.roboApplyMission.update({
        where: { id: existing.id },
        data: {
          tier,
          timezone,
          locale: locale as string,
          dailyCap: tier === 'premium_plus' ? (typeof body.dailyCap === 'number' ? Math.max(1, Math.min(30, Math.floor(body.dailyCap))) : 30)
            : tier === 'premium' ? (typeof body.dailyCap === 'number' ? Math.max(1, Math.min(15, Math.floor(body.dailyCap))) : 15)
            : (typeof body.dailyCap === 'number' ? Math.max(1, Math.min(3, Math.floor(body.dailyCap))) : 3),
          reviewMode: tier === 'free' ? 'review_first' : (body.reviewMode === 'review_first' ? 'review_first' : 'auto'),
          resumeId: typeof body.resumeId === 'string' ? body.resumeId : existing.resumeId,
          enabled: true,
        },
      });
      const updated = await updateIntent(userId, intentText, { requestId: req.requestId ?? null });
      return res.status(200).json({ success: true, data: { mission: updated } });
    }

    const mission = await createMission({
      userId,
      intentText,
      tier,
      dailyCap: typeof body.dailyCap === 'number' ? body.dailyCap : null,
      timezone,
      locale: locale as 'en' | 'zh' | 'zh-TW' | 'ja' | 'es' | 'fr' | 'pt' | 'de',
      resumeId: typeof body.resumeId === 'string' ? body.resumeId : null,
      reviewMode: body.reviewMode === 'auto' || body.reviewMode === 'review_first' ? body.reviewMode : null,
    }, req.requestId ?? null);

    return res.status(201).json({ success: true, data: { mission } });
  } catch (err) {
    if (err instanceof RoboApplyMissionError) {
      return res.status(errorStatus(err.code)).json({
        success: false,
        code: err.code,
        error: err.message,
        ...(err.detail ?? {}),
      });
    }
    logger.error('ROBOAPPLY_MISSION', 'POST / failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({
      success: false,
      code: 'create_mission_failed',
      error: 'Failed to create mission',
    });
  }
});

// ─── PATCH /me/intent ───────────────────────────────────────────────────

router.patch('/me/intent', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const intentText = typeof req.body?.intentText === 'string' ? req.body.intentText : '';
    if (intentText.trim().length < 5) {
      return res.status(400).json({ success: false, code: 'invalid_input', error: 'intentText is required' });
    }
    const mission = await updateIntent(req.user!.id, intentText, { requestId: req.requestId ?? null });
    return res.json({ success: true, data: { mission } });
  } catch (err) {
    if (err instanceof RoboApplyMissionError) {
      return res.status(errorStatus(err.code)).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }
    logger.error('ROBOAPPLY_MISSION', 'PATCH /me/intent failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'update_intent_failed', error: 'Failed to update intent' });
  }
});

// ─── POST /me/pause ─────────────────────────────────────────────────────

router.post('/me/pause', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const raw = req.body?.durationHours;
    const durationHours = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const allowed = durationHours === null || durationHours === 24 || durationHours === 168;
    if (!allowed && durationHours !== null) {
      return res.status(400).json({
        success: false,
        code: 'invalid_input',
        error: 'durationHours must be 24, 168, or omitted (indefinite)',
      });
    }
    const mission = await pauseMission(req.user!.id, {
      durationHours,
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : null,
    });
    return res.json({ success: true, data: { mission } });
  } catch (err) {
    if (err instanceof RoboApplyMissionError) {
      return res.status(errorStatus(err.code)).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }
    logger.error('ROBOAPPLY_MISSION', 'POST /me/pause failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'pause_failed', error: 'Failed to pause mission' });
  }
});

// ─── POST /me/resume ────────────────────────────────────────────────────

router.post('/me/resume', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const mission = await resumeMission(req.user!.id);
    return res.json({ success: true, data: { mission } });
  } catch (err) {
    if (err instanceof RoboApplyMissionError) {
      return res.status(errorStatus(err.code)).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }
    logger.error('ROBOAPPLY_MISSION', 'POST /me/resume failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'resume_failed', error: 'Failed to resume mission' });
  }
});

export default router;
