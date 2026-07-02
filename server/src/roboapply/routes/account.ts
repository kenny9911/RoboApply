// backend/src/roboapply/routes/account.ts
//
// RoboApply user account + security + own-usage. Mounted at
// /api/v1/roboapply/account/* in backend/src/index.ts.
//
//   GET  /          — account profile (name, email, member-since, tier, ...)
//   PATCH /         — update display name
//   POST /password  — change password (verify current, revoke other sessions)
//   POST /signout-all — revoke every session
//   GET  /usage     — own usage by date + feature vs tier allowance (COUNTS
//                     ONLY — never exposes internal cost/margin to the user)
//   POST /delete    — GDPR delete (soft-disable + session revoke + audit)
//
// V1 namespace (imports engine freely). Importing v2/lib/raFeatureCatalog is
// allowed (the boundary only restricts what v2 itself imports).

import { Router, type Request, type Response } from 'express';
// Gate on requireAuth ONLY (not requireSeekerProfile): "your account" must work
// for any signed-in RoboApply user, including admins (who have no SeekerProfile).
// Every handler here is scoped to req.user.id and null-safe for a missing
// profile (usage queries by userId; delete updates 0 profile rows; password is
// on the User row).
import { requireAuth } from '../../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import {
  seekerAuthService,
  SeekerWrongPasswordError,
  SeekerNoPasswordError,
} from '../engine/services/SeekerAuthService.js';
import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { resolveTimeZone, sqlLocalTime } from '../../lib/timeBuckets.js';
import { getRateCard, tierDailyCap } from '../../lib/rateCard.js';
import { featureForSku } from '../v2/lib/raFeatureCatalog.js';

const router = Router();

function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── GET / (account profile) ──────────────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        provider: true,
        createdAt: true,
        passwordHash: true,
        seekerProfile: {
          select: {
            readinessScore: true,
            weeklyNudgeOptOut: true,
            subscription: { select: { tier: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true } },
          },
        },
      },
    });
    if (!user) return res.status(404).json({ success: false, code: 'not_found', error: 'Account not found' });
    return res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider ?? 'email',
        hasPassword: !!user.passwordHash,
        memberSince: user.createdAt.toISOString(),
        readinessScore: user.seekerProfile?.readinessScore ?? 0,
        tier: user.seekerProfile?.subscription?.tier ?? 'free',
        subscriptionStatus: user.seekerProfile?.subscription?.status ?? 'active',
        currentPeriodEnd: user.seekerProfile?.subscription?.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: user.seekerProfile?.subscription?.cancelAtPeriodEnd ?? false,
        weeklyNudgeOptOut: user.seekerProfile?.weeklyNudgeOptOut ?? false,
      },
    });
  } catch (err) {
    logger.error('RA_ACCOUNT', 'GET / failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'account_failed', error: 'Failed to load account' });
  }
});

// ─── PATCH / (update display name) ────────────────────────────────────────────
router.patch('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    if (name === undefined) {
      return res.status(400).json({ success: false, code: 'no_change', error: 'Nothing to update' });
    }
    if (name.length > 120) {
      return res.status(400).json({ success: false, code: 'invalid_name', error: 'Name must be ≤ 120 characters' });
    }
    await prisma.user.update({ where: { id: req.user!.id }, data: { name: name || null } });
    return res.json({ success: true, data: { name: name || null } });
  } catch (err) {
    logger.error('RA_ACCOUNT', 'PATCH / failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'update_failed', error: 'Failed to update account' });
  }
});

// ─── POST /email-preferences (weekly nudge opt-in/out) ────────────────────────
router.post('/email-preferences', requireAuth, async (req: Request, res: Response) => {
  try {
    const optOut = req.body?.weeklyNudgeOptOut;
    if (typeof optOut !== 'boolean') {
      return res.status(400).json({ success: false, code: 'invalid_input', error: 'weeklyNudgeOptOut must be a boolean' });
    }
    const updated = await prisma.seekerProfile.updateMany({
      where: { userId: req.user!.id },
      data: { weeklyNudgeOptOut: optOut },
    });
    if (updated.count === 0) {
      return res.status(404).json({ success: false, code: 'no_profile', error: 'No RoboApply profile' });
    }
    return res.json({ success: true, data: { weeklyNudgeOptOut: optOut } });
  } catch (err) {
    logger.error('RA_ACCOUNT', 'POST /email-preferences failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'prefs_failed', error: 'Failed to update preferences' });
  }
});

// ─── POST /password ──────────────────────────────────────────────────────────
router.post('/password', requireAuth, async (req: Request, res: Response) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, code: 'weak_password', error: 'New password must be at least 8 characters' });
    }
    // Keep the caller's current session alive; revoke the rest.
    const keepSessionToken =
      (req.cookies?.[SESSION_COOKIE_NAME] as string | undefined) ||
      (req.headers['x-session-token'] as string | undefined) ||
      null;
    await seekerAuthService.changePassword({
      userId: req.user!.id,
      currentPassword,
      newPassword,
      keepSessionToken,
    });
    await prisma.adminAdjustment
      .create({
        data: {
          userId: req.user!.id,
          adminId: req.user!.id,
          type: 'password_change',
          reason: 'roboapply self-serve password change',
        },
      })
      .catch(() => {
        /* audit best-effort */
      });
    return res.json({ success: true, data: { ok: true } });
  } catch (err) {
    if (err instanceof SeekerWrongPasswordError) {
      return res.status(400).json({ success: false, code: 'wrong_password', error: 'Current password is incorrect' });
    }
    if (err instanceof SeekerNoPasswordError) {
      return res.status(409).json({ success: false, code: 'no_password', error: 'This account uses social sign-in and has no password' });
    }
    logger.error('RA_ACCOUNT', 'POST /password failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'password_failed', error: 'Failed to change password' });
  }
});

// ─── POST /signout-all ────────────────────────────────────────────────────────
router.post('/signout-all', requireAuth, async (req: Request, res: Response) => {
  try {
    const count = await seekerAuthService.revokeAllSessions(req.user!.id);
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.json({ success: true, data: { revoked: count } });
  } catch (err) {
    logger.error('RA_ACCOUNT', 'POST /signout-all failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'signout_failed', error: 'Failed to sign out everywhere' });
  }
});

// ─── GET /usage (own usage — counts only, NEVER cost) ─────────────────────────
router.get('/usage', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const tz = resolveTimeZone(typeof req.query.tz === 'string' ? req.query.tz : undefined);
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    const from =
      typeof req.query.from === 'string'
        ? new Date(req.query.from)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [skuRows, dayRows, card, mission] = await Promise.all([
      prisma.$queryRawUnsafe<{ sku: string; count: number }[]>(
        `SELECT "sku", COUNT(*) AS count FROM "UsageDeductionLog"
          WHERE "userId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3
          GROUP BY "sku"`,
        userId,
        from,
        to,
      ),
      prisma.$queryRawUnsafe<{ day: string; count: number }[]>(
        `SELECT ${sqlLocalTime('"createdAt"', '$4')}::date::text AS day, COUNT(*) AS count
           FROM "UsageDeductionLog"
          WHERE "userId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3
          GROUP BY day ORDER BY day ASC`,
        userId,
        from,
        to,
        tz,
      ),
      getRateCard(),
      prisma.roboApplyMission.findUnique({ where: { userId }, select: { tier: true, dailyCap: true } }),
    ]);

    const tier = mission?.tier ?? 'free';
    const featureMap = new Map<string, { key: string; label: string; count: number }>();
    for (const r of skuRows) {
      const f = featureForSku(r.sku);
      const cur = featureMap.get(f.key) ?? { key: f.key, label: f.label, count: 0 };
      cur.count += num(r.count);
      featureMap.set(f.key, cur);
    }

    return res.json({
      success: true,
      data: {
        range: { from: from.toISOString(), to: to.toISOString(), tz },
        tier,
        dailyCap: mission?.dailyCap ?? tierDailyCap(card, tier),
        byFeature: Array.from(featureMap.values()).sort((a, b) => b.count - a.count),
        byDay: dayRows.map((r) => ({ day: r.day, count: num(r.count) })),
        totalActions: skuRows.reduce((s, r) => s + num(r.count), 0),
      },
    });
  } catch (err) {
    logger.error('RA_ACCOUNT', 'GET /usage failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'usage_failed', error: 'Failed to load usage' });
  }
});

// ─── POST /delete (GDPR — soft-disable + revoke + audit) ──────────────────────
router.post('/delete', requireAuth, async (req: Request, res: Response) => {
  try {
    const confirmEmail = typeof req.body?.confirmEmail === 'string' ? req.body.confirmEmail.trim() : '';
    const userEmail = (req.user?.email ?? '').toLowerCase();
    if (!confirmEmail || confirmEmail.toLowerCase() !== userEmail) {
      return res.status(400).json({
        success: false,
        code: 'confirm_email_mismatch',
        error: 'confirmEmail must match the signed-in account email',
      });
    }
    const userId = req.user!.id;
    // Soft-disable: SeekerProfile.deletedAt makes login throw
    // SeekerAccountDeletedError; revoke every session so the account is
    // immediately inaccessible. A nightly sweep performs the hard purge +
    // R2 artifact cleanup (out of scope here).
    await prisma.seekerProfile.updateMany({ where: { userId }, data: { deletedAt: new Date() } });
    await seekerAuthService.revokeAllSessions(userId);
    res.clearCookie(SESSION_COOKIE_NAME);
    logger.warn('RA_ACCOUNT', 'account soft-deleted (GDPR)', { userId, email: userEmail }, req.requestId);
    return res.json({ success: true, data: { ok: true, deactivated: true } });
  } catch (err) {
    logger.error('RA_ACCOUNT', 'POST /delete failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'delete_failed', error: 'Failed to delete account' });
  }
});

export default router;
