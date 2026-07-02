// backend/src/roboapply/services/RoboApplySubmitterService.ts
//
// 09:00 user-local submission engine. Per arch §4:
//
//   - Picks every `RoboApplyRun` with `status='previewing' AND
//     plannedSubmitAt <= now`.
//   - For each, materializes a (seeker, job, resume, connection) bundle
//     and calls the appropriate board adapter:
//       * 'greenhouse' → GreenhouseAdapter
//       * 'lever'      → LeverAdapter (NOT YET IMPLEMENTED — see TODO)
//       * 'manual_link' → status stays `previewing` and a `manualLinkUrl`
//                         is written via boardResponse so the frontend can
//                         surface the deep link.
//   - On adapter success → `status='submitted'`, `actualSubmitAt=now()`,
//     `boardSubmissionId=…`. Increments mission.totalSubmitted.
//   - On adapter failure → `status='failed'`, `failureReason=errorCode`.
//     Increments mission.totalFailed. NO quota deduction is unwound;
//     adapter failures are non-billable (the matcher already paid for the
//     match, the author for the letter — submission is free at the SKU
//     level, only adapters that successfully submit write the seeker_apply
//     audit row).
//
// Quota model:
//   - Match credit: debited by the matcher (`runMatchWithQuota`).
//   - Cover letter audit: debited by the author agent on CG-pass.
//   - Submission: writes a `seeker_apply` audit row via writeDeductionLog
//     on adapter success only. Failures cost zero — failure is free.
//
// Idempotency:
//   - In-memory mutex per missionId so a re-entry doesn't double-fire one
//     mission's queue.
//   - Per-run guard: only previewing runs are picked up; a successful flip
//     to `submitted` is a one-way door.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { runConcurrent } from '../../utils/concurrency.js';
import { writeDeductionLog } from '../../lib/matchBilling.js';
import internalAdapter from '../engine/services/boards/InternalAdapter.js';
import greenhouseAdapter from '../engine/services/boards/GreenhouseAdapter.js';
import type {
  SeekerBoardAdapter,
  BoardAdapterSubmitInput,
  BoardAdapterSubmitResult,
  JobLike,
  SeekerLike,
} from '../engine/services/boards/SeekerBoardAdapter.js';

// ─── Constants ──────────────────────────────────────────────────────────

const PER_BATCH_CONCURRENCY = 3;
/** How far past plannedSubmitAt a run lingers before catchup marks it failed. */
const CATCHUP_HARD_FAIL_MS = 6 * 60 * 60 * 1000;

// In-memory mutex — same shape as SeekerAutoApplyService.lastRunByUser. Lost
// on restart, which is acceptable because the catchup cron immediately picks
// up the next 15-min tick.
const inflightByMission = new Set<string>();

// ─── Public types ───────────────────────────────────────────────────────

export type SubmissionStatus =
  | 'submitted'
  | 'failed'
  | 'skipped_manual_link'
  | 'skipped_not_due'
  | 'skipped_inflight'
  | 'not_found';

export interface SubmissionOutcome {
  runId: string;
  status: SubmissionStatus;
  boardSubmissionId?: string | null;
  manualLinkUrl?: string | null;
  failureReason?: string | null;
}

export interface SubmitterBatchSummary {
  scanned: number;
  submitted: number;
  failed: number;
  manualLinks: number;
  skipped: number;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Submit ONE run. Called by both the 09:00 user-local cron and the
 * catchup sweep. Returns a typed outcome; never throws on adapter failure.
 */
export async function submitRun(
  runId: string,
  ctx: { requestId?: string | null } = {},
): Promise<SubmissionOutcome> {
  const run = await prisma.roboApplyRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      missionId: true,
      status: true,
      jobId: true,
      resumeId: true,
      tailoredResumeText: true,
      coverLetter: true,
      boardAdapter: true,
      plannedSubmitAt: true,
      mission: {
        select: {
          id: true,
          userId: true,
          tier: true,
          locale: true,
          user: {
            select: { email: true, name: true },
          },
          // For activity / display name fallback.
        },
      },
    },
  });

  if (!run) return { runId, status: 'not_found' };
  if (run.status !== 'previewing') {
    return { runId, status: 'skipped_not_due', failureReason: `current status: ${run.status}` };
  }
  if (run.plannedSubmitAt.getTime() > Date.now()) {
    return { runId, status: 'skipped_not_due' };
  }

  // ── Manual link adapter — V1 doesn't auto-submit; surfaces a deep link.
  if (run.boardAdapter === 'manual_link') {
    const url = await buildManualLinkUrl(run.jobId);
    await prisma.roboApplyRun.update({
      where: { id: run.id },
      data: {
        boardResponse: { kind: 'manual_link', url } as unknown as Prisma.InputJsonValue,
        // Stays in `previewing` — the user-facing UI surfaces the manual link.
      },
    });
    return { runId, status: 'skipped_manual_link', manualLinkUrl: url };
  }

  // ── Pick the seeker-side adapter.
  const adapter = pickAdapter(run.boardAdapter);
  if (!adapter) {
    logger.error(
      'ROBOAPPLY_SUBMITTER',
      'no adapter for boardAdapter',
      { runId: run.id, boardAdapter: run.boardAdapter },
      ctx.requestId ?? undefined,
    );
    await markFailed(run.id, run.missionId, 'unsupported_board_adapter');
    return { runId, status: 'failed', failureReason: 'unsupported_board_adapter' };
  }

  // ── Look up the seeker profile + an active connection for this board.
  const seekerProfile = await prisma.seekerProfile.findUnique({
    where: { userId: run.mission.userId },
    select: { id: true, locale: true },
  });

  if (!seekerProfile) {
    await markFailed(run.id, run.missionId, 'seeker_profile_missing');
    return { runId, status: 'failed', failureReason: 'seeker_profile_missing' };
  }

  const conn = await prisma.seekerBoardConnection.findFirst({
    where: {
      seekerProfileId: seekerProfile.id,
      board: run.boardAdapter,
      status: 'connected',
    },
    select: {
      id: true,
      board: true,
      status: true,
      scopes: true,
      expiresAt: true,
    },
  });

  // ── Materialize the adapter input.
  const job = await prisma.job.findUnique({
    where: { id: run.jobId ?? '__none__' },
    select: {
      id: true,
      title: true,
      companyName: true,
      description: true,
      qualifications: true,
      hardRequirements: true,
      niceToHave: true,
      location: true,
      workType: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
    },
  });

  if (!job) {
    await markFailed(run.id, run.missionId, 'job_missing');
    return { runId, status: 'failed', failureReason: 'job_missing' };
  }

  // Use the tailored resume text from the run; if empty (matcher didn't
  // tailor, or matcher only ran screening), fall back to the master resume.
  let resumeContent = run.tailoredResumeText;
  if (!resumeContent || resumeContent.trim().length < 50) {
    const resume = await prisma.resume.findUnique({
      where: { id: run.resumeId },
      select: { resumeText: true },
    });
    resumeContent = resume?.resumeText ?? '';
  }

  if (!resumeContent || resumeContent.trim().length < 50) {
    await markFailed(run.id, run.missionId, 'resume_missing');
    return { runId, status: 'failed', failureReason: 'resume_missing' };
  }

  const adapterJobSource: JobLike['source'] = run.boardAdapter === 'greenhouse' ? 'greenhouse'
    : run.boardAdapter === 'lever' ? 'lever' : 'internal';

  const jobLike: JobLike = {
    id: job.id,
    title: job.title ?? '',
    companyName: job.companyName,
    description: job.description,
    qualifications: job.qualifications,
    hardRequirements: job.hardRequirements,
    niceToHave: job.niceToHave,
    source: adapterJobSource,
    location: job.location,
    workType: job.workType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
  };

  const seekerLike: SeekerLike = {
    userId: run.mission.userId,
    seekerProfileId: seekerProfile.id,
    locale: seekerProfile.locale ?? run.mission.locale,
    displayName: run.mission.user?.name ?? null,
    email: run.mission.user?.email ?? null,
  };

  const input: BoardAdapterSubmitInput = {
    job: jobLike,
    seeker: seekerLike,
    resumeContent,
    coverLetter: run.coverLetter || null,
    connection: conn
      ? {
          id: conn.id,
          board: conn.board,
          status: conn.status,
          accessToken: null, // Adapter reads env keys directly in V1.
          refreshToken: null,
          scopes: conn.scopes,
          expiresAt: conn.expiresAt,
        }
      : null,
    requestId: ctx.requestId ?? null,
  };

  // ── Fire the adapter.
  let result: BoardAdapterSubmitResult;
  try {
    result = await adapter.submit(input);
  } catch (err) {
    logger.error(
      'ROBOAPPLY_SUBMITTER',
      'adapter threw',
      {
        runId: run.id,
        boardAdapter: run.boardAdapter,
        error: err instanceof Error ? err.message : String(err),
      },
      ctx.requestId ?? undefined,
    );
    await markFailed(run.id, run.missionId, 'adapter_threw');
    return { runId, status: 'failed', failureReason: 'adapter_threw' };
  }

  if (!result.success) {
    await prisma.roboApplyRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        failedAt: new Date(),
        failureReason: result.errorCode,
        boardResponse: (result.boardMetadata ?? null) as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.roboApplyMission.update({
      where: { id: run.missionId },
      data: { totalFailed: { increment: 1 } },
    });

    // If the board says credentials are toast, flip the connection so the
    // next morning's digest can prompt the user to reconnect.
    if (result.errorCode === 'auth_expired' && conn) {
      await prisma.seekerBoardConnection.update({
        where: { id: conn.id },
        data: { status: 'error', lastErrorMessage: result.error },
      });
    }

    logger.warn(
      'ROBOAPPLY_SUBMITTER',
      'adapter rejected submission',
      {
        runId: run.id,
        missionId: run.missionId,
        userId: run.mission.userId,
        boardAdapter: run.boardAdapter,
        errorCode: result.errorCode,
        retryable: result.retryable,
      },
      ctx.requestId ?? undefined,
    );

    return { runId, status: 'failed', failureReason: result.errorCode };
  }

  // ── Success path. Persist + audit + mission counter.
  const now = new Date();
  await prisma.roboApplyRun.update({
    where: { id: run.id },
    data: {
      status: 'submitted',
      actualSubmitAt: now,
      boardSubmissionId: result.externalApplicationId ?? null,
      boardResponse: (result.boardMetadata ?? null) as unknown as Prisma.InputJsonValue,
      simulated: result.simulated === true,
    },
  });
  await prisma.roboApplyMission.update({
    where: { id: run.missionId },
    data: {
      totalSubmitted: { increment: 1 },
      lastSubmissionAt: now,
    },
  });

  await writeDeductionLog({
    userId: run.mission.userId,
    sku: 'seeker_apply',
    source: 'plan',
    tierAtCommit: String(run.mission.tier),
    requestId: ctx.requestId ?? null,
    relatedEntityType: 'roboapply_run',
    relatedEntityId: run.id,
    metadata: {
      source: 'roboapply.submitter',
      boardAdapter: run.boardAdapter,
      missionId: run.missionId,
      jobId: run.jobId,
      simulated: result.simulated === true,
      externalApplicationId: result.externalApplicationId ?? null,
    },
  });

  return {
    runId,
    status: 'submitted',
    boardSubmissionId: result.externalApplicationId ?? null,
  };
}

/**
 * Submit every due `previewing` run for one mission. Idempotent — runs
 * already submitted are skipped. In-memory mutex prevents the catchup
 * sweep from double-firing while the 09:00 cron is still working.
 */
export async function submitDueRunsForMission(
  missionId: string,
  ctx: { requestId?: string | null } = {},
): Promise<SubmitterBatchSummary> {
  if (inflightByMission.has(missionId)) {
    logger.info(
      'ROBOAPPLY_SUBMITTER',
      'submit already in-flight for mission, skipping',
      { missionId },
      ctx.requestId ?? undefined,
    );
    return { scanned: 0, submitted: 0, failed: 0, manualLinks: 0, skipped: 0 };
  }
  inflightByMission.add(missionId);
  try {
    const due = await prisma.roboApplyRun.findMany({
      where: {
        missionId,
        status: 'previewing',
        plannedSubmitAt: { lte: new Date() },
      },
      select: { id: true },
      take: 100,
    });

    let submitted = 0;
    let failed = 0;
    let manualLinks = 0;
    let skipped = 0;

    const tasks = due.map((r) => async () => {
      const outcome = await submitRun(r.id, ctx);
      if (outcome.status === 'submitted') submitted += 1;
      else if (outcome.status === 'failed') failed += 1;
      else if (outcome.status === 'skipped_manual_link') manualLinks += 1;
      else skipped += 1;
    });

    await runConcurrent(tasks, PER_BATCH_CONCURRENCY);
    return { scanned: due.length, submitted, failed, manualLinks, skipped };
  } finally {
    inflightByMission.delete(missionId);
  }
}

/**
 * Cron entry point: submit due runs across ALL enabled+unpaused missions.
 * Used by both the 09:00 user-local cron AND the catchup sweep that runs
 * every 15 minutes between 09:15 and 15:45 UTC.
 */
export async function submitDueRunsAll(
  ctx: { requestId?: string | null } = {},
): Promise<{ missionsScanned: number; submitted: number; failed: number; manualLinks: number }> {
  const missions = await prisma.roboApplyMission.findMany({
    where: {
      enabled: true,
      OR: [{ pausedUntil: null }, { pausedUntil: { lte: new Date() } }],
      runs: { some: { status: 'previewing', plannedSubmitAt: { lte: new Date() } } },
    },
    select: { id: true },
  });

  let submitted = 0;
  let failed = 0;
  let manualLinks = 0;

  const tasks = missions.map((m) => async () => {
    try {
      const summary = await submitDueRunsForMission(m.id, ctx);
      submitted += summary.submitted;
      failed += summary.failed;
      manualLinks += summary.manualLinks;
    } catch (err) {
      logger.error(
        'ROBOAPPLY_SUBMITTER',
        'mission submit pass threw',
        { missionId: m.id, error: err instanceof Error ? err.message : String(err) },
        ctx.requestId ?? undefined,
      );
    }
  });

  await runConcurrent(tasks, 3);

  return { missionsScanned: missions.length, submitted, failed, manualLinks };
}

/**
 * Catchup sweep — hard-fail any `previewing` runs whose plannedSubmitAt is
 * more than 6h in the past. Called by the every-15-min cron between
 * 09:15 and 15:45 UTC.
 */
export async function catchupHardFailStaleRuns(
  ctx: { requestId?: string | null } = {},
): Promise<{ marked: number }> {
  const cutoff = new Date(Date.now() - CATCHUP_HARD_FAIL_MS);
  const stale = await prisma.roboApplyRun.findMany({
    where: {
      status: 'previewing',
      plannedSubmitAt: { lt: cutoff },
      boardAdapter: { not: 'manual_link' }, // manual links don't time out
    },
    select: { id: true, missionId: true },
  });

  if (stale.length === 0) return { marked: 0 };

  for (const r of stale) {
    try {
      await prisma.roboApplyRun.update({
        where: { id: r.id },
        data: {
          status: 'failed',
          failedAt: new Date(),
          failureReason: 'cron_missed_window',
        },
      });
      await prisma.roboApplyMission.update({
        where: { id: r.missionId },
        data: { totalFailed: { increment: 1 } },
      });
    } catch (err) {
      logger.warn(
        'ROBOAPPLY_SUBMITTER',
        'failed to mark stale run as failed',
        { runId: r.id, error: err instanceof Error ? err.message : String(err) },
        ctx.requestId ?? undefined,
      );
    }
  }

  logger.warn(
    'ROBOAPPLY_SUBMITTER',
    'cron-missed-window',
    { count: stale.length },
    ctx.requestId ?? undefined,
  );

  return { marked: stale.length };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pickAdapter(boardAdapter: string): SeekerBoardAdapter | null {
  if (boardAdapter === 'greenhouse') return greenhouseAdapter;
  // TODO: LeverAdapter — not implemented yet in backend/src/roboapply/engine/services/boards/.
  // When it lands, return leverAdapter here; until then Lever runs hit the
  // manual_link fallback at queue time. The matcher currently never emits
  // boardAdapter='lever' (sources are 'greenhouse' / 'manual_link' / 'internal'),
  // but defensively log if one slips through.
  if (boardAdapter === 'lever') return null;
  // Internal RoboHire jobs — V1 maps these to manual_link at queue time.
  // Defensive: if a run somehow has boardAdapter='internal', route to
  // the internal adapter (DB-only path).
  // (RoboApply schema doesn't include 'internal' in RoboApplyBoardAdapter
  // enum — only 'greenhouse' | 'lever' | 'manual_link' — but we keep this
  // guard so a future enum addition doesn't silently fall through.)
  if (boardAdapter === 'internal') return internalAdapter;
  return null;
}

async function markFailed(runId: string, missionId: string, reason: string): Promise<void> {
  await prisma.roboApplyRun.update({
    where: { id: runId },
    data: {
      status: 'failed',
      failedAt: new Date(),
      failureReason: reason,
    },
  });
  await prisma.roboApplyMission.update({
    where: { id: missionId },
    data: { totalFailed: { increment: 1 } },
  });
}

async function buildManualLinkUrl(jobId: string | null): Promise<string | null> {
  if (!jobId) return null;
  // V1 manual link points at the recruiter-side public job page. The
  // frontend rewrites this for the seeker-facing deep link if needed.
  const base = process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.FRONTEND_URL || 'https://robohire.io';
  return `${base.replace(/\/$/, '')}/job-bank/${encodeURIComponent(jobId)}`;
}

export const roboApplySubmitterService = {
  submitRun,
  submitDueRunsForMission,
  submitDueRunsAll,
  catchupHardFailStaleRuns,
};

export const __test = {
  PER_BATCH_CONCURRENCY,
  CATCHUP_HARD_FAIL_MS,
  pickAdapter,
  buildManualLinkUrl,
  // Test-only: clear the in-memory mutex between cases.
  __resetInflight: () => inflightByMission.clear(),
};

export default roboApplySubmitterService;
