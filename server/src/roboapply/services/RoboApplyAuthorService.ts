// backend/src/roboapply/services/RoboApplyAuthorService.ts
//
// Cover-letter authoring orchestrator. Per arch §3.2:
//   1. For each `status='queued'` RoboApplyRun, load (resume, job, mission,
//      parsedIntent).
//   2. Compute cover-letter cache key (resumeId|jobId|intentVersion|toneHash).
//   3. Cache-first via RoboApplyCoverLetterCache. On HIT, hydrate the run
//      with the cached output WITHOUT touching the LLM or writing any
//      `roboapply_cover_letter` audit row (caller already paid for the
//      original generation).
//   4. On MISS: invoke RoboApplyAuthorAgent (Opus for Premium/Premium+,
//      Sonnet for Free). Agent runs CitationGuard internally; on success it
//      writes the `roboapply_cover_letter` audit row. On final rejection
//      (CG failed twice OR LLM unavailable), the run is marked failed with
//      `failureReason='cover_letter_unavailable'` and ZERO deduction is
//      written. Failure is free.
//   5. On success → flip run to `status='previewing'`, set
//      plannedSubmitAt = next 09:00 user-local (or keep matcher's planned
//      value if already set).

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { runConcurrent } from '../../utils/concurrency.js';
import roboApplyAuthorAgent, {
  RoboApplyAuthorRejectedError,
  type RoboApplyAuthorInput,
  type RoboApplyAuthorOutput,
} from '../agents/RoboApplyAuthorAgent.js';
import type { RoboApplyParsedIntent, RoboApplyLocale } from '../agents/RoboApplyIntentParserAgent.js';
import type { MatchResult, ParsedResume } from '../../types/index.js';
import { buildCoverLetterCacheKey } from '../lib/cacheKey.js';
import { nextUserLocalHour } from '../lib/localTime.js';
import { createHash } from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────────

const CACHE_TTL_DAYS = 30;
const PER_RUN_AUTHOR_CONCURRENCY = 3;

// ─── Public types ───────────────────────────────────────────────────────

export interface AuthorRunSummary {
  status: 'authored' | 'cache_hit' | 'failed' | 'skipped' | 'not_found';
  runId: string;
  modelUsed?: string;
  failureReason?: string;
}

export interface AuthorBatchSummary {
  scanned: number;
  authored: number;
  cacheHits: number;
  failed: number;
  skipped: number;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Author cover letters for all `status='queued'` runs belonging to ONE
 * mission. Called by:
 *   - The 05:00 UTC matcher cron immediately after queueing (chained).
 *   - The catchup sweep when previous attempts hard-failed.
 *
 * Per-run failures don't poison the batch; one bad run logs + continues.
 */
export async function authorQueuedRunsForMission(
  missionId: string,
  ctx: { requestId?: string | null } = {},
): Promise<AuthorBatchSummary> {
  const queued = await prisma.roboApplyRun.findMany({
    where: { missionId, status: 'queued' },
    select: { id: true },
    take: 50, // hard cap per mission per cycle — tier cap is 30 max
  });

  if (queued.length === 0) {
    return { scanned: 0, authored: 0, cacheHits: 0, failed: 0, skipped: 0 };
  }

  let authored = 0;
  let cacheHits = 0;
  let failed = 0;
  let skipped = 0;

  const tasks = queued.map((r) => async () => {
    try {
      const summary = await authorOneRun(r.id, { requestId: ctx.requestId ?? null });
      if (summary.status === 'authored') authored += 1;
      else if (summary.status === 'cache_hit') cacheHits += 1;
      else if (summary.status === 'failed') failed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        'ROBOAPPLY_AUTHOR',
        'unexpected error authoring run',
        {
          runId: r.id,
          missionId,
          error: err instanceof Error ? err.message : String(err),
        },
        ctx.requestId ?? undefined,
      );
    }
  });

  await runConcurrent(tasks, PER_RUN_AUTHOR_CONCURRENCY);

  return { scanned: queued.length, authored, cacheHits, failed, skipped };
}

/**
 * Author the cover letter for ONE run. Idempotent — if the run is already
 * `previewing` (cover letter already authored), returns 'skipped' without
 * doing work. Cache-first; on MISS invokes the Opus author agent.
 *
 * Quota: cache HITs cost zero; LLM successes commit one
 * `roboapply_cover_letter` audit row via the agent. LLM failures cost zero.
 */
export async function authorOneRun(
  runId: string,
  ctx: { requestId?: string | null } = {},
): Promise<AuthorRunSummary> {
  const run = await prisma.roboApplyRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      missionId: true,
      jobId: true,
      resumeId: true,
      status: true,
      matchExplanation: true,
      plannedSubmitAt: true,
      mission: {
        select: {
          id: true,
          userId: true,
          tier: true,
          locale: true,
          timezone: true,
          intentVersion: true,
          parsedIntent: true,
          coverLetterToneOverride: true,
        },
      },
    },
  });

  if (!run) {
    return { status: 'not_found', runId };
  }

  if (run.status !== 'queued') {
    // Already authored / submitted / etc.
    return { status: 'skipped', runId };
  }

  // ── Load the resume + job. Both are required; missing either → fail run.
  const [resume, job] = await Promise.all([
    prisma.resume.findUnique({
      where: { id: run.resumeId },
      select: { id: true, resumeText: true, parsedData: true },
    }),
    run.jobId
      ? prisma.job.findUnique({
          where: { id: run.jobId },
          select: {
            id: true,
            title: true,
            companyName: true,
            description: true,
            qualifications: true,
          },
        })
      : Promise.resolve(null),
  ]);

  if (!resume || !resume.resumeText || resume.resumeText.length < 50) {
    return await markRunFailed(run.id, 'cover_letter_unavailable', 'resume missing or too short', ctx.requestId);
  }
  if (!job) {
    return await markRunFailed(run.id, 'cover_letter_unavailable', 'job no longer exists', ctx.requestId);
  }

  const tier = mapTier(run.mission.tier);
  const locale = (run.mission.locale ?? 'en') as RoboApplyLocale;
  const parsedIntent = (run.mission.parsedIntent as RoboApplyParsedIntent | null) ?? buildEmptyIntent();
  const matchResult = (run.matchExplanation as MatchResult | null) ?? buildEmptyMatchResult();

  const toneOverride = tier === 'premium_plus' ? run.mission.coverLetterToneOverride ?? null : null;

  const cacheKey = buildCoverLetterCacheKey({
    resumeId: run.resumeId,
    jobId: job.id,
    intentVersion: run.mission.intentVersion,
    toneOverride,
  });

  // ── Cache lookup. HIT = no LLM, no audit row, fast path.
  const cached = await prisma.roboApplyCoverLetterCache.findUnique({
    where: { cacheKey },
  });

  let output: RoboApplyAuthorOutput | null = null;
  let cacheHit = false;
  if (cached && cached.expiresAt.getTime() > Date.now()) {
    output = cached.output as unknown as RoboApplyAuthorOutput;
    cacheHit = true;
  }

  // ── Cache MISS: run the agent. Agent writes the audit row on success.
  if (!output) {
    const authorInput: RoboApplyAuthorInput = {
      resume: {
        text: resume.resumeText,
        parsed: (resume.parsedData as ParsedResume | null) ?? null,
      },
      job: {
        id: job.id,
        title: job.title ?? '',
        companyName: job.companyName ?? null,
        description: job.description ?? null,
        qualifications: job.qualifications ?? null,
      },
      parsedIntent,
      matchResult,
      tier,
      toneOverride,
      locale,
    };

    try {
      output = await roboApplyAuthorAgent.author(authorInput, {
        userId: run.mission.userId,
        requestId: ctx.requestId ?? null,
        missionId: run.mission.id,
        runId: run.id,
      });
    } catch (err) {
      if (err instanceof RoboApplyAuthorRejectedError) {
        // Failure is free — agent didn't write the audit row.
        return await markRunFailed(
          run.id,
          'cover_letter_unavailable',
          `author_rejected:${err.code}`,
          ctx.requestId,
        );
      }
      logger.error(
        'ROBOAPPLY_AUTHOR',
        'author threw unexpected error',
        {
          runId: run.id,
          missionId: run.mission.id,
          error: err instanceof Error ? err.message : String(err),
        },
        ctx.requestId ?? undefined,
      );
      return await markRunFailed(run.id, 'cover_letter_unavailable', 'author_unexpected_error', ctx.requestId);
    }

    // ── Persist to cache (best-effort; failure doesn't unwind the run).
    if (output && output.coverLetter && output.citationGuardPassed) {
      try {
        await prisma.roboApplyCoverLetterCache.upsert({
          where: { cacheKey },
          create: {
            cacheKey,
            resumeId: run.resumeId,
            jobId: job.id,
            intentVersion: run.mission.intentVersion,
            toneOverrideHash: toneOverride ? hashToneOverride(toneOverride) : null,
            output: output as unknown as Prisma.InputJsonValue,
            modelUsed: output.modelUsed,
            citationGuardPassed: output.citationGuardPassed,
            expiresAt: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
          },
          update: {
            output: output as unknown as Prisma.InputJsonValue,
            modelUsed: output.modelUsed,
            citationGuardPassed: output.citationGuardPassed,
            expiresAt: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
          },
        });
      } catch (cacheErr) {
        logger.warn(
          'ROBOAPPLY_AUTHOR',
          'cache upsert failed (non-fatal)',
          { runId: run.id, error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr) },
          ctx.requestId ?? undefined,
        );
      }
    }
  }

  if (!output || !output.coverLetter) {
    return await markRunFailed(run.id, 'cover_letter_unavailable', 'empty_author_output', ctx.requestId);
  }

  // ── Update the run: status='previewing', cover letter, planned submit at.
  const plannedSubmitAt = run.plannedSubmitAt ?? nextUserLocalHour(run.mission.timezone || 'UTC', 9);

  await prisma.roboApplyRun.update({
    where: { id: run.id },
    data: {
      status: 'previewing',
      coverLetter: output.coverLetter,
      coverLetterModel: output.modelUsed || 'unknown',
      plannedSubmitAt,
      // For the transparency screen — store the citations + modelUsed in the
      // prompt blob.
      coverLetterPrompt: {
        modelUsed: output.modelUsed,
        confidence: output.confidence,
        citationsToResume: output.citationsToResume,
        customAnswers: output.customAnswers,
        citationGuardPassed: output.citationGuardPassed,
        cacheHit,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    status: cacheHit ? 'cache_hit' : 'authored',
    runId: run.id,
    modelUsed: output.modelUsed,
  };
}

/**
 * Run the author pass for ALL enabled missions with queued runs. Called by
 * the cron immediately after the matcher. Concurrency-capped across
 * missions so we don't blow the Opus bill in one go.
 */
export async function authorAllQueuedRuns(
  ctx: { requestId?: string | null } = {},
): Promise<{ missionsScanned: number; authored: number; cacheHits: number; failed: number }> {
  const missions = await prisma.roboApplyMission.findMany({
    where: {
      enabled: true,
      runs: { some: { status: 'queued' } },
    },
    select: { id: true },
  });

  let authored = 0;
  let cacheHits = 0;
  let failed = 0;

  const concurrency = Math.max(1, Math.min(
    parseInt(process.env.ROBOAPPLY_AUTHOR_CONCURRENCY ?? '2', 10) || 2,
    6,
  ));

  const tasks = missions.map((m) => async () => {
    try {
      const summary = await authorQueuedRunsForMission(m.id, ctx);
      authored += summary.authored;
      cacheHits += summary.cacheHits;
      failed += summary.failed;
    } catch (err) {
      logger.error(
        'ROBOAPPLY_AUTHOR',
        'mission author pass threw',
        { missionId: m.id, error: err instanceof Error ? err.message : String(err) },
        ctx.requestId ?? undefined,
      );
    }
  });

  await runConcurrent(tasks, concurrency);

  return { missionsScanned: missions.length, authored, cacheHits, failed };
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function markRunFailed(
  runId: string,
  reason: string,
  detail: string,
  requestId?: string | null,
): Promise<AuthorRunSummary> {
  try {
    await prisma.roboApplyRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        failedAt: new Date(),
        failureReason: reason,
      },
    });
    await prisma.roboApplyMission.update({
      where: {
        id: (await prisma.roboApplyRun.findUnique({ where: { id: runId }, select: { missionId: true } }))!.missionId,
      },
      data: { totalFailed: { increment: 1 } },
    });
  } catch (err) {
    logger.warn(
      'ROBOAPPLY_AUTHOR',
      'failed to mark run as failed',
      { runId, reason, error: err instanceof Error ? err.message : String(err) },
      requestId ?? undefined,
    );
  }
  return { status: 'failed', runId, failureReason: `${reason}:${detail}` };
}

function mapTier(tier: string): 'free' | 'premium' | 'premium_plus' {
  if (tier === 'premium') return 'premium';
  if (tier === 'premium_plus') return 'premium_plus';
  return 'free';
}

function hashToneOverride(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

function buildEmptyIntent(): RoboApplyParsedIntent {
  return {
    roles: [],
    seniority: null,
    industries: [],
    companyStages: [],
    excludeCompanies: [],
    locations: { countries: [], cities: [], remoteOk: null, hybridOk: null },
    compensation: { baseFloor: null, currency: null, equityImportant: false },
    hardExclusions: [],
    softPreferences: [],
    confidence: 'low',
    bestEffortFields: ['parsedIntent missing — using empty fallback'],
  };
}

function buildEmptyMatchResult(): MatchResult {
  return {
    overallMatchScore: {
      score: 0,
      grade: 'C',
      breakdown: {
        skillMatchWeight: 0,
        skillMatchScore: 0,
        experienceWeight: 0,
        experienceScore: 0,
        potentialWeight: 0,
        potentialScore: 0,
      },
      confidence: 'low',
    },
    overallFit: {
      verdict: 'unknown',
      summary: '',
      topReasons: [],
      interviewFocus: [],
      hiringRecommendation: '',
      suggestedRole: '',
    },
  } as unknown as MatchResult;
}

export const roboApplyAuthorService = {
  authorOneRun,
  authorQueuedRunsForMission,
  authorAllQueuedRuns,
};

export const __test = {
  CACHE_TTL_DAYS,
  PER_RUN_AUTHOR_CONCURRENCY,
  mapTier,
  hashToneOverride,
};

export default roboApplyAuthorService;
