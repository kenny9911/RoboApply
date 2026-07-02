// backend/src/roboapply/v2/routes/admin.ts
//
// RoboApply ADMIN analytics + profitability console API. Mounted at
// /api/v1/roboapply/v2/admin/* (see routes/index.ts). Admin-only
// (requireAuth → requireAdmin). Read-only except POST /users/:id/plan and
// PATCH /rate-card. Cost numbers come from the canonical
// UsageDeductionLog.platformCostUsd ledger (see RAAdminAnalyticsService).
//
// Boundary: imports only lib/* + middleware/* (both allowed for V2). No
// recruiter routes/* or non-llm services/*.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { logger } from '../../../services/LoggerService.js';
import {
  getRateCardWithSource,
  saveRateCardOverride,
  invalidateRateCard,
  type RateCardOverride,
} from '../../../lib/rateCard.js';
import { getActiveEnvironment } from '../../../lib/llm/llmStackConfigSchema.js';
import prisma from '../../../lib/prisma.js';
import {
  resolveRange,
  getOverview,
  getUsers,
  getUserDetail,
  getSessions,
  getSessionDetail,
  setUserPlan,
} from '../services/RAAdminAnalyticsService.js';

const router = Router();

// All routes admin-gated.
router.use(requireAuth, requireAdmin);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ─── CSV helper (small inline port; V2 can't import recruiter routes/*) ───────
function escapeCsv(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const r of rows) lines.push(r.map(escapeCsv).join(','));
  return lines.join('\n');
}

// ─── GET /overview ────────────────────────────────────────────────────────────
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const range = resolveRange(str(req.query.from), str(req.query.to), str(req.query.tz));
    const data = await getOverview(range);
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /overview failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'overview_failed', error: 'Failed to load overview' });
  }
});

// ─── GET /users ─────────────────────────────────────────────────────────────
router.get('/users', async (req: Request, res: Response) => {
  try {
    const range = resolveRange(str(req.query.from), str(req.query.to), str(req.query.tz));
    const data = await getUsers({
      range,
      q: str(req.query.q),
      sort: str(req.query.sort),
      dir: req.query.dir === 'asc' ? 'asc' : req.query.dir === 'desc' ? 'desc' : undefined,
      page: intOr(req.query.page, 1),
      pageSize: intOr(req.query.pageSize, 25),
    });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /users failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'users_failed', error: 'Failed to load users' });
  }
});

// ─── GET /users.csv ─────────────────────────────────────────────────────────
router.get('/users.csv', async (req: Request, res: Response) => {
  try {
    const range = resolveRange(str(req.query.from), str(req.query.to), str(req.query.tz));
    const data = await getUsers({ range, q: str(req.query.q), pageSize: 5000, page: 1 });
    const csv = toCsv(
      ['email', 'name', 'tier', 'status', 'mrrUsd', 'periodCostUsd', 'marginUsd', 'marginPct', 'sessions', 'lastActiveAt'],
      data.rows.map((r) => [r.email, r.name, r.tier, r.status, r.mrrUsd, r.periodCostUsd, r.marginUsd, r.marginPct, r.sessions, r.lastActiveAt]),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="roboapply-users.csv"');
    return res.send(csv);
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /users.csv failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'users_csv_failed', error: 'Failed to export users' });
  }
});

// ─── GET /users/:userId ───────────────────────────────────────────────────────
router.get('/users/:userId', async (req: Request, res: Response) => {
  try {
    const range = resolveRange(str(req.query.from), str(req.query.to), str(req.query.tz));
    const data = await getUserDetail(req.params.userId, range);
    if (!data) return res.status(404).json({ success: false, code: 'user_not_found', error: 'User not found' });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /users/:id failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'user_detail_failed', error: 'Failed to load user' });
  }
});

// ─── POST /users/:userId/plan ───────────────────────────────────────────────
router.post('/users/:userId/plan', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tier = body.tier;
    if (tier !== 'free' && tier !== 'premium' && tier !== 'premium_plus') {
      return res.status(400).json({ success: false, code: 'invalid_tier', error: 'tier must be free | premium | premium_plus' });
    }
    const reason = str(body.reason);
    if (!reason) {
      return res.status(400).json({ success: false, code: 'reason_required', error: 'A reason is required for this admin action' });
    }
    const amountMinor =
      typeof body.amountMinor === 'number' && Number.isFinite(body.amountMinor) && body.amountMinor >= 0
        ? Math.round(body.amountMinor)
        : undefined;
    const result = await setUserPlan({
      userId: req.params.userId,
      tier,
      amountMinor,
      currency: str(body.currency) ?? null,
      reason,
      adminId: req.user!.id,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    if ((err as any)?.code === 'no_profile') {
      return res.status(409).json({ success: false, code: 'no_profile', error: 'User has no RoboApply (seeker) profile' });
    }
    logger.error('RA_ADMIN', 'POST /users/:id/plan failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'set_plan_failed', error: 'Failed to set plan' });
  }
});

// ─── GET /sessions ────────────────────────────────────────────────────────────
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const range = resolveRange(str(req.query.from), str(req.query.to), str(req.query.tz));
    const data = await getSessions({
      range,
      userId: str(req.query.userId),
      status: str(req.query.status),
      page: intOr(req.query.page, 1),
      pageSize: intOr(req.query.pageSize, 25),
    });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /sessions failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'sessions_failed', error: 'Failed to load sessions' });
  }
});

// ─── GET /sessions.csv ────────────────────────────────────────────────────────
router.get('/sessions.csv', async (req: Request, res: Response) => {
  try {
    const range = resolveRange(str(req.query.from), str(req.query.to), str(req.query.tz));
    const data = await getSessions({ range, userId: str(req.query.userId), status: str(req.query.status), page: 1, pageSize: 5000 });
    const csv = toCsv(
      ['id', 'email', 'role', 'status', 'durationSec', 'blueprint', 'liveLlm', 'stt', 'tts', 'evaluation', 'coach', 'recording', 'totalUsd', 'createdAt'],
      data.rows.map((s) => [s.id, s.email, s.role, s.status, s.durationSec, s.cost.blueprint, s.cost.liveLlm, s.cost.stt, s.cost.tts, s.cost.evaluation, s.cost.coach, s.cost.recording, s.cost.total, s.createdAt]),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="roboapply-sessions.csv"');
    return res.send(csv);
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /sessions.csv failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'sessions_csv_failed', error: 'Failed to export sessions' });
  }
});

// ─── GET /sessions/:id ────────────────────────────────────────────────────────
router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const data = await getSessionDetail(req.params.id);
    if (!data) return res.status(404).json({ success: false, code: 'session_not_found', error: 'Session not found' });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('RA_ADMIN', 'GET /sessions/:id failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'session_detail_failed', error: 'Failed to load session' });
  }
});

// ─── GET /rate-card ───────────────────────────────────────────────────────────
router.get('/rate-card', async (_req: Request, res: Response) => {
  try {
    const data = await getRateCardWithSource();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, code: 'rate_card_failed', error: 'Failed to load rate card' });
  }
});

// ─── PATCH /rate-card (Phase 2 — write an override blob) ──────────────────────
router.patch('/rate-card', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const blob = body.override as RateCardOverride | undefined;
    const reason = str(body.reason);
    if (!blob || typeof blob !== 'object') {
      return res.status(400).json({ success: false, code: 'invalid_override', error: 'override blob required' });
    }
    if (!reason) {
      return res.status(400).json({ success: false, code: 'reason_required', error: 'A reason is required' });
    }
    const env = getActiveEnvironment();
    const before = await prisma.appConfig.findUnique({ where: { key: `rate_card.${env}` } });
    const card = await saveRateCardOverride(blob, env);
    await prisma.adminAdjustment.create({
      data: {
        userId: req.user!.id, // self — rate card is global, recorded against the admin
        adminId: req.user!.id,
        type: 'subscription',
        oldValue: before?.value ?? null,
        newValue: JSON.stringify(blob).slice(0, 4000),
        reason: `rate_card: ${reason}`,
      },
    });
    invalidateRateCard();
    return res.json({ success: true, data: { card } });
  } catch (err) {
    logger.error('RA_ADMIN', 'PATCH /rate-card failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return res.status(500).json({ success: false, code: 'rate_card_save_failed', error: 'Failed to save rate card' });
  }
});

export default router;
