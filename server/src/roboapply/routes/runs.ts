// backend/src/roboapply/routes/runs.ts
//
// Mounted at /api/v1/roboapply/runs/* in backend/src/index.ts.
//
//   GET   /                       — list runs (mission-scoped). Query
//                                   params: status=queued|previewing|submitted|...
//                                           limit (default 50, max 200),
//                                           cursor (last run id).
//   GET   /:id                    — full run detail. Cover letter, prompt
//                                   blob, match explanation, board response.
//   POST  /:id/skip               — user-initiated skip, ONLY while
//                                   status='previewing'. No quota effect.
//   POST  /:id/undo               — undo a submitted run within 24h.
//                                   Best-effort board withdraw.
//   POST  /:id/manual-link-opened — mark a manual_link run as user-handled.
//                                   Flips status to 'submitted' with
//                                   simulated=true so it shows in yesterday's
//                                   numbers.

import { Router, type Request, type Response } from 'express';
import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSeekerProfile } from '../engine/middleware/seekerAuth.js';
import { logger } from '../../services/LoggerService.js';

const router = Router();

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

const VALID_STATUSES = new Set([
  'queued',
  'previewing',
  'submitted',
  'skipped_by_user',
  'failed',
  'undone',
]);

// ─── Helper: resolve the caller's mission (404 if none). ────────────────

async function getMissionIdForUser(userId: string): Promise<string | null> {
  const m = await prisma.roboApplyMission.findUnique({
    where: { userId },
    select: { id: true },
  });
  return m?.id ?? null;
}

// ─── GET / ──────────────────────────────────────────────────────────────

router.get('/', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const missionId = await getMissionIdForUser(req.user!.id);
    if (!missionId) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No mission' });
    }

    // Frontend may send a single `status` or multiple `?status=X&status=Y`
    // (Express parses repeated query params as string[]). Normalise to an
    // array and filter through VALID_STATUSES.
    const rawStatus = req.query.status;
    const statusList: string[] = Array.isArray(rawStatus)
      ? rawStatus.filter((s): s is string => typeof s === 'string')
      : typeof rawStatus === 'string'
        ? [rawStatus]
        : [];
    const validStatuses = statusList.filter((s) => VALID_STATUSES.has(s));

    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string, 10) || 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const where: Prisma.RoboApplyRunWhereInput = {
      missionId,
      ...(validStatuses.length === 1
        ? { status: validStatuses[0] as Prisma.RoboApplyRunWhereInput['status'] }
        : validStatuses.length > 1
          ? { status: { in: validStatuses as Prisma.RoboApplyRunWhereInput['status'][] & string[] } as Prisma.RoboApplyRunWhereInput['status'] }
          : {}),
    };

    const runs = await prisma.roboApplyRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        missionId: true,
        jobId: true,
        status: true,
        matchScore: true,
        rationaleForPick: true,
        plannedSubmitAt: true,
        actualSubmitAt: true,
        failedAt: true,
        failureReason: true,
        undoneAt: true,
        boardAdapter: true,
        boardSubmissionId: true,
        simulated: true,
        coverLetterModel: true,
        createdAt: true,
        updatedAt: true,
        job: {
          select: { id: true, title: true, companyName: true, location: true },
        },
      },
    });

    const hasMore = runs.length > limit;
    const items = hasMore ? runs.slice(0, limit) : runs;
    // Flatten Job snapshot into top-level fields so the frontend RoboRun
    // type can read `jobTitle` / `companyName` directly without traversing
    // `.job.*` (matches the GET /:id shape).
    const shaped = items.map(({ job, ...rest }) => ({
      ...rest,
      jobTitle: job?.title ?? null,
      companyName: job?.companyName ?? null,
      jobLocation: job?.location ?? null,
      jobUrl: null as string | null,
      salaryRange: null as string | null,
    }));
    return res.json({
      success: true,
      data: {
        runs: shaped,
        total: shaped.length,
        nextCursor: hasMore ? items[items.length - 1].id : null,
      },
    });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'GET / failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'list_runs_failed', error: 'Failed to list runs' });
  }
});

// ─── GET /:id ───────────────────────────────────────────────────────────

router.get('/:id', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const missionId = await getMissionIdForUser(req.user!.id);
    if (!missionId) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No mission' });
    }
    const id = req.params.id;
    const run = await prisma.roboApplyRun.findFirst({
      where: { id, missionId },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            companyName: true,
            description: true,
            qualifications: true,
            location: true,
            workType: true,
            salaryMin: true,
            salaryMax: true,
            salaryCurrency: true,
          },
        },
      },
    });
    if (!run) {
      return res.status(404).json({ success: false, code: 'run_not_found', error: 'Run not found' });
    }
    // Flatten the joined Job snapshot into top-level fields so the frontend
    // can read `run.jobTitle` / `run.companyName` directly — matches the
    // shape declared in roboapply/lib/api/types.ts (RoboRun).
    const { job, ...runRest } = run;
    const salary =
      job?.salaryMin && job?.salaryMax
        ? `$${(job.salaryMin / 1000).toFixed(0)}k - $${(job.salaryMax / 1000).toFixed(0)}k`
        : null;
    const shaped = {
      ...runRest,
      jobTitle: job?.title ?? null,
      companyName: job?.companyName ?? null,
      jobLocation: job?.location ?? null,
      salaryRange: salary,
      jobUrl: null as string | null,
    };
    // Return the run shape flat under `data` so the frontend's
    // `roboApi.get<RoboRun>()` unwrap (data.data → T) yields the run
    // directly — matches the contract of the other run endpoints
    // (skip/undo/apply-early all return flat).
    return res.json({ success: true, data: shaped });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'GET /:id failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'get_run_failed', error: 'Failed to load run' });
  }
});

// ─── POST /:id/skip ─────────────────────────────────────────────────────
//
// Valid ONLY in `previewing`. No quota effect — the matcher already paid
// for the match credit; the author already paid for the cover letter
// credit. Skipping just stops the submitter from firing.

router.post('/:id/skip', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const missionId = await getMissionIdForUser(req.user!.id);
    if (!missionId) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No mission' });
    }
    const id = req.params.id;
    const run = await prisma.roboApplyRun.findFirst({
      where: { id, missionId },
      select: { id: true, status: true },
    });
    if (!run) {
      return res.status(404).json({ success: false, code: 'run_not_found', error: 'Run not found' });
    }
    if (run.status !== 'previewing') {
      return res.status(409).json({
        success: false,
        code: 'invalid_status',
        error: `Skip only valid while previewing (current: ${run.status})`,
      });
    }
    await prisma.roboApplyRun.update({
      where: { id },
      data: { status: 'skipped_by_user' },
    });
    await prisma.roboApplyMission.update({
      where: { id: missionId },
      data: { totalSkipped: { increment: 1 } },
    });
    return res.json({ success: true, data: { id, status: 'skipped_by_user' } });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'POST /:id/skip failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'skip_failed', error: 'Failed to skip run' });
  }
});

// ─── POST /:id/undo ─────────────────────────────────────────────────────
//
// Available within 24h of actualSubmitAt. Stamps `undoneAt` regardless of
// whether the board withdraw call succeeds (we treat the user's intent as
// authoritative; the board side is best-effort). Increments totalUndone.

router.post('/:id/undo', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const missionId = await getMissionIdForUser(req.user!.id);
    if (!missionId) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No mission' });
    }
    const id = req.params.id;
    const run = await prisma.roboApplyRun.findFirst({
      where: { id, missionId },
      select: { id: true, status: true, actualSubmitAt: true },
    });
    if (!run) {
      return res.status(404).json({ success: false, code: 'run_not_found', error: 'Run not found' });
    }
    if (run.status !== 'submitted') {
      return res.status(409).json({
        success: false,
        code: 'invalid_status',
        error: `Undo only valid for submitted runs (current: ${run.status})`,
      });
    }
    if (!run.actualSubmitAt) {
      return res.status(409).json({
        success: false,
        code: 'no_submit_timestamp',
        error: 'Run has no actualSubmitAt — cannot undo',
      });
    }
    const ageMs = Date.now() - run.actualSubmitAt.getTime();
    if (ageMs > UNDO_WINDOW_MS) {
      return res.status(409).json({
        success: false,
        code: 'undo_window_expired',
        error: 'Undo window (24h) expired',
      });
    }
    await prisma.roboApplyRun.update({
      where: { id },
      data: { status: 'undone', undoneAt: new Date() },
    });
    await prisma.roboApplyMission.update({
      where: { id: missionId },
      data: { totalUndone: { increment: 1 } },
    });
    // V1: no automatic board-side withdraw call. The frontend surfaces the
    // adapter contact info so the user can email the recruiter directly.
    return res.json({ success: true, data: { id, status: 'undone' } });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'POST /:id/undo failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'undo_failed', error: 'Failed to undo run' });
  }
});

// ─── POST /:id/manual-link-opened ───────────────────────────────────────

router.post('/:id/manual-link-opened', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const missionId = await getMissionIdForUser(req.user!.id);
    if (!missionId) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No mission' });
    }
    const id = req.params.id;
    const run = await prisma.roboApplyRun.findFirst({
      where: { id, missionId },
      select: { id: true, status: true, boardAdapter: true },
    });
    if (!run) {
      return res.status(404).json({ success: false, code: 'run_not_found', error: 'Run not found' });
    }
    if (run.boardAdapter !== 'manual_link') {
      return res.status(409).json({
        success: false,
        code: 'invalid_adapter',
        error: 'manual-link-opened only valid for manual_link runs',
      });
    }
    if (run.status === 'submitted') {
      return res.json({ success: true, data: { id, status: 'submitted' } });
    }
    await prisma.roboApplyRun.update({
      where: { id },
      data: {
        status: 'submitted',
        actualSubmitAt: new Date(),
        simulated: true,
      },
    });
    await prisma.roboApplyMission.update({
      where: { id: missionId },
      data: { totalSubmitted: { increment: 1 }, lastSubmissionAt: new Date() },
    });
    return res.json({ success: true, data: { id, status: 'submitted', simulated: true } });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'POST /:id/manual-link-opened failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'manual_link_failed', error: 'Failed to mark manual link opened' });
  }
});

// ─── POST /:id/apply-early ──────────────────────────────────────────────
// User skips the 9am preview window and asks the agent to submit this run
// immediately. We flip plannedSubmitAt to "now" — the cron picks it up on
// next tick (every 60s during business hours). V1 keeps it simple: no real
// inline submitter invocation, just an aggressive plannedSubmitAt so the
// next sweep picks it up. Frontend already shows a "sending now" optimistic
// toast.

router.post('/:id/apply-early', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = req.params.id;
    const mission = await prisma.roboApplyMission.findUnique({ where: { userId } });
    if (!mission) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No RoboApply mission' });
    }
    const run = await prisma.roboApplyRun.findUnique({ where: { id } });
    if (!run || run.missionId !== mission.id) {
      return res.status(404).json({ success: false, code: 'not_found', error: 'Run not found' });
    }
    if (run.status !== 'previewing' && run.status !== 'queued') {
      return res.status(409).json({
        success: false,
        code: 'invalid_status',
        error: 'apply-early is only valid for runs in `previewing` or `queued`',
      });
    }
    await prisma.roboApplyRun.update({
      where: { id },
      data: { plannedSubmitAt: new Date(), status: 'previewing' },
    });
    return res.json({ success: true, data: { id, plannedSubmitAt: new Date().toISOString() } });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'POST /:id/apply-early failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({
      success: false,
      code: 'apply_early_failed',
      error: 'Failed to schedule immediate submission',
    });
  }
});

// ─── GET /:id/prompt ────────────────────────────────────────────────────
// Returns the literal system + user prompt the cover-letter agent ran for
// this run. Sourced from RoboApplyRun.coverLetterPrompt (jsonb) populated
// at author time. Used by the Application Detail "show me the prompt"
// affordance for transparency.

router.get('/:id/prompt', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = req.params.id;
    const mission = await prisma.roboApplyMission.findUnique({ where: { userId } });
    if (!mission) {
      return res.status(404).json({ success: false, code: 'mission_not_found', error: 'No RoboApply mission' });
    }
    const run = await prisma.roboApplyRun.findUnique({
      where: { id },
      select: { id: true, missionId: true, coverLetterPrompt: true, coverLetterModel: true },
    });
    if (!run || run.missionId !== mission.id) {
      return res.status(404).json({ success: false, code: 'not_found', error: 'Run not found' });
    }
    // coverLetterPrompt is stored as jsonb { systemPrompt, userPrompt } at
    // author time. If null, return empty stubs so the UI renders an
    // honest "no prompt recorded for this run" line.
    const prompt = (run.coverLetterPrompt ?? {}) as Record<string, unknown>;
    return res.json({
      success: true,
      data: {
        systemPrompt: typeof prompt.systemPrompt === 'string' ? prompt.systemPrompt : '',
        userPrompt: typeof prompt.userPrompt === 'string' ? prompt.userPrompt : '',
        model: run.coverLetterModel,
      },
    });
  } catch (err) {
    logger.error('ROBOAPPLY_RUNS', 'GET /:id/prompt failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({
      success: false,
      code: 'prompt_failed',
      error: 'Failed to load run prompt',
    });
  }
});

export default router;
