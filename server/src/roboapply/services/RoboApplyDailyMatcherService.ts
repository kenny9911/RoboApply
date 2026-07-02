// backend/src/roboapply/services/RoboApplyDailyMatcherService.ts
//
// 05:00 UTC cron. For each enabled mission:
//   1. Load eligible jobs (recruiter-side `Job` rows from boards we can
//      submit to: Greenhouse + Lever OAuth; `manual_link` for the rest).
//   2. Apply hard filters from parsedIntent (excludeCompanies, location,
//      compensation floor, freshness window).
//   3. For each candidate job, call `runMatchWithQuota` — billable per
//      successful match. Failures cost zero.
//   4. Rank by score, take top N by tier daily cap (3 / 15 / 30).
//   5. Persist one RoboApplyRun(status='queued') per pick. Dedup on
//      (missionId, jobContentHash) — the unique constraint enforces this.
//
// Author step is downstream — RoboApplyAuthorService picks up `queued` rows
// and produces cover letters.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { runMatchWithQuota, MatchQuotaExhaustedError } from '../../lib/matchBilling.js';
import { runConcurrent } from '../../utils/concurrency.js';
import type { MatchResult } from '../../types/index.js';
import type { RoboApplyParsedIntent } from '../agents/RoboApplyIntentParserAgent.js';
import { nextUserLocalHour } from '../lib/localTime.js';
import { createHash } from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────────

/** Recency window — only consider jobs published/updated in the last 14 days. */
const JOB_FRESHNESS_DAYS = 14;
/** Per-pair concurrency inside a single mission's matcher run. */
const PER_MISSION_CONCURRENCY = 4;
/** How many candidate jobs to consider before ranking. */
const CANDIDATE_POOL_LIMIT = 60;
/** Floor score under which we never queue (per arch §7). */
const MATCH_SCORE_FLOOR = 60;
/** Soft-dedup window — don't re-queue (mission, jobContentHash) within N days
 *  EVEN if the previous run was skipped/failed/undone. The unique constraint
 *  prevents same-day dupes regardless. */
const DEDUP_WINDOW_DAYS = 14;

// ─── Public types ───────────────────────────────────────────────────────

export interface MatcherRunSummary {
  status: 'ran' | 'no_mission' | 'paused' | 'disabled' | 'quota_exhausted' | 'no_eligible_jobs' | 'no_resume';
  considered: number;
  matched: number;
  queued: number;
  failed: number;
}

interface CandidateJob {
  id: string;
  contentHash: string;
  title: string;
  companyName: string | null;
  description: string | null;
  qualifications: string | null;
  hardRequirements: string | null;
  source: 'greenhouse' | 'lever' | 'manual_link' | 'internal';
}

// ─── Public API ─────────────────────────────────────────────────────────

/** Run the daily matcher for ONE mission. Idempotent within the 14-day
 *  dedup window — repeated calls only queue new jobs we haven't seen. */
export async function runDailyMatcherForMission(
  missionId: string,
  ctx: { requestId?: string | null } = {},
): Promise<MatcherRunSummary> {
  const mission = await prisma.roboApplyMission.findUnique({
    where: { id: missionId },
    select: {
      id: true,
      userId: true,
      intentText: true,
      parsedIntent: true,
      intentVersion: true,
      tier: true,
      dailyCap: true,
      enabled: true,
      pausedUntil: true,
      timezone: true,
      locale: true,
      resumeId: true,
    },
  });
  if (!mission) return { status: 'no_mission', considered: 0, matched: 0, queued: 0, failed: 0 };
  if (!mission.enabled) return { status: 'disabled', considered: 0, matched: 0, queued: 0, failed: 0 };
  if (mission.pausedUntil && mission.pausedUntil.getTime() > Date.now()) {
    return { status: 'paused', considered: 0, matched: 0, queued: 0, failed: 0 };
  }
  if (!mission.resumeId) {
    logger.warn(
      'ROBOAPPLY_MATCHER',
      'Mission has no resumeId — skipping matcher pass',
      { missionId, userId: mission.userId },
      ctx.requestId ?? undefined,
    );
    return { status: 'no_resume', considered: 0, matched: 0, queued: 0, failed: 0 };
  }

  const parsedIntent = (mission.parsedIntent as RoboApplyParsedIntent | null) ?? null;
  const candidates = await loadCandidateJobs({
    parsedIntent,
    excludeMissionId: mission.id,
    limit: CANDIDATE_POOL_LIMIT,
  });

  if (candidates.length === 0) {
    return { status: 'no_eligible_jobs', considered: 0, matched: 0, queued: 0, failed: 0 };
  }

  let failedMatches = 0;
  type ScoredCandidate = { candidate: CandidateJob; result: MatchResult };
  const scored: ScoredCandidate[] = [];

  const tasks = candidates.map((c) => async () => {
    try {
      const result = await runMatchWithQuota(
        { resume: mission.resumeId!, jd: c.id },
        {
          userId: mission.userId,
          requestId: ctx.requestId ?? null,
          // Seeker's saved mission locale — match output (digest reasons,
          // gap text) lands in their language, not the JD's.
          locale: mission.locale ?? null,
          relatedEntityType: 'roboapply_run',
          relatedEntityId: mission.id,
          metadata: { source: 'roboapply.dailyMatcher', missionId: mission.id, jobSource: c.source },
        },
      );
      const score = result.overallMatchScore?.score ?? 0;
      if (score >= MATCH_SCORE_FLOOR) {
        scored.push({ candidate: c, result });
      }
    } catch (err) {
      if (err instanceof MatchQuotaExhaustedError) {
        // Quota gate refused — terminate this mission's matcher pass cleanly.
        // The remaining candidates won't be considered today; tomorrow's
        // sweep starts fresh.
        throw err;
      }
      failedMatches += 1;
      logger.warn(
        'ROBOAPPLY_MATCHER',
        'per-pair match failed',
        {
          userId: mission.userId,
          missionId: mission.id,
          jobId: c.id,
          error: err instanceof Error ? err.message : String(err),
        },
        ctx.requestId ?? undefined,
      );
    }
  });

  try {
    await runConcurrent(tasks, PER_MISSION_CONCURRENCY);
  } catch (err) {
    if (err instanceof MatchQuotaExhaustedError) {
      logger.warn(
        'ROBOAPPLY_MATCHER',
        'mission terminated early — quota exhausted',
        { userId: mission.userId, missionId: mission.id, code: err.code },
        ctx.requestId ?? undefined,
      );
      // Fall through with whatever we managed to score; we still queue them.
    } else {
      throw err;
    }
  }

  scored.sort((a, b) => (b.result.overallMatchScore?.score ?? 0) - (a.result.overallMatchScore?.score ?? 0));
  const picks = scored.slice(0, mission.dailyCap);

  // Persist runs. Hit the unique-constraint dedup if we collide on
  // (missionId, jobContentHash) — caller treats this as "already queued".
  let queued = 0;
  const plannedSubmitAt = nextUserLocalHour(mission.timezone, 9);
  for (const pick of picks) {
    const boardAdapter = mapSourceToAdapter(pick.candidate.source);
    try {
      await prisma.roboApplyRun.create({
        data: {
          missionId: mission.id,
          jobId: pick.candidate.id,
          jobContentHash: pick.candidate.contentHash,
          resumeId: mission.resumeId!,
          tailoredResumeText: '', // filled in by AuthorService
          coverLetter: '',
          coverLetterModel: '',
          matchScore: pick.result.overallMatchScore?.score ?? 0,
          matchExplanation: pick.result as unknown as Prisma.InputJsonValue,
          rationaleForPick:
            pick.result.overallFit?.summary?.slice(0, 280) ||
            pick.result.overallFit?.topReasons?.[0]?.slice(0, 280) ||
            'High overall fit.',
          plannedSubmitAt,
          boardAdapter,
          status: 'queued',
        },
      });
      queued += 1;
    } catch (err) {
      // Unique-constraint hit means we already queued this (mission, jobContentHash)
      // within the dedup window — soft skip.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        continue;
      }
      logger.error(
        'ROBOAPPLY_MATCHER',
        'failed to persist run',
        {
          userId: mission.userId,
          missionId: mission.id,
          jobId: pick.candidate.id,
          error: err instanceof Error ? err.message : String(err),
        },
        ctx.requestId ?? undefined,
      );
    }
  }

  // Bump the mission's nextSweepAt so the cron knows we're done for today.
  await prisma.roboApplyMission.update({
    where: { id: mission.id },
    data: { nextSweepAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });

  return {
    status: 'ran',
    considered: candidates.length,
    matched: scored.length,
    queued,
    failed: failedMatches,
  };
}

/** Run the matcher for ALL enabled+unpaused missions. Concurrency-capped
 *  across missions so we don't blow up the LLM bill in one go. */
export async function runDailyMatcherForAll(ctx: { requestId?: string | null } = {}): Promise<{
  scanned: number;
  missionsRan: number;
  totalQueued: number;
}> {
  const enabled = await prisma.roboApplyMission.findMany({
    where: { enabled: true, OR: [{ pausedUntil: null }, { pausedUntil: { lte: new Date() } }] },
    select: { id: true, userId: true },
  });

  const concurrency = Math.max(1, Math.min(
    parseInt(process.env.ROBOAPPLY_MATCHER_CONCURRENCY ?? '3', 10) || 3,
    10,
  ));

  let totalQueued = 0;
  let missionsRan = 0;
  const tasks = enabled.map((m) => async () => {
    try {
      const summary = await runDailyMatcherForMission(m.id, ctx);
      if (summary.status === 'ran') {
        missionsRan += 1;
        totalQueued += summary.queued;
      }
    } catch (err) {
      logger.error(
        'ROBOAPPLY_MATCHER',
        'cycle failed for mission',
        { userId: m.userId, missionId: m.id, error: err instanceof Error ? err.message : String(err) },
        ctx.requestId ?? undefined,
      );
    }
  });
  await runConcurrent(tasks, concurrency);
  return { scanned: enabled.length, missionsRan, totalQueued };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function mapSourceToAdapter(source: CandidateJob['source']): 'greenhouse' | 'lever' | 'manual_link' {
  if (source === 'greenhouse') return 'greenhouse';
  if (source === 'lever') return 'lever';
  // Internal jobs are submitted via the manual_link adapter — V1 doesn't
  // do automated form-submit for internal jobs; the user gets a deep link.
  return 'manual_link';
}

async function loadCandidateJobs(opts: {
  parsedIntent: RoboApplyParsedIntent | null;
  excludeMissionId: string;
  limit: number;
}): Promise<CandidateJob[]> {
  const since = new Date(Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  const dedupSince = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Find Job rows that:
  //   1. status='open'
  //   2. published in the last 14 days
  //   3. NOT already queued for this mission within the dedup window
  //   4. Pass the parsedIntent hard filters (excludeCompanies, location)
  // Then return up to `limit` candidates.
  //
  // Implementation note: we don't filter on parsedIntent.locations.cities at
  // SQL level — JD location strings are too varied. We let ResumeMatchAgent
  // assess fit (downstream) and filter on its score floor.

  const excludeCompanies = (opts.parsedIntent?.excludeCompanies ?? []).map((c) => c.toLowerCase());

  // Job has no `contentHash` column (resumes do, jobs don't); we derive one
  // from the material content fields. The matcher uses it as a stable dedup
  // key in the RoboApplyRun unique constraint on (missionId, jobContentHash).
  // If the recruiter edits a job significantly, the hash changes and a new
  // run can be queued — that matches the intent of the constraint.
  const jobs = await prisma.job.findMany({
    where: {
      status: 'open',
      OR: [
        { publishedAt: { gte: since } },
        { updatedAt: { gte: since } },
      ],
      NOT: {
        roboApplyRuns: {
          some: {
            missionId: opts.excludeMissionId,
            createdAt: { gte: dedupSince },
          },
        },
      },
      ...(excludeCompanies.length > 0
        ? {
            companyName: {
              not: { in: excludeCompanies },
              mode: 'insensitive',
            },
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      companyName: true,
      description: true,
      qualifications: true,
      hardRequirements: true,
      updatedAt: true,
      contentUpdatedAt: true,
      // No explicit source column on Job — recruiter jobs are "internal".
      // The seeker side has external-board ingest (greenhouse / lever) but
      // those rows live in SeekerJobMatch with a `source` enum, not here.
      // Treat every Job row as 'internal' for V1; the submitter falls back
      // to the manual_link adapter for those (which surfaces "Open
      // application" in the UI).
    },
    orderBy: { publishedAt: 'desc' },
    take: opts.limit,
  });

  return jobs.map((j) => ({
    id: j.id,
    contentHash: buildJobContentHash(j),
    title: j.title ?? '',
    companyName: j.companyName,
    description: j.description,
    qualifications: j.qualifications,
    hardRequirements: j.hardRequirements,
    source: 'internal' as const,
  }));
}

function buildJobContentHash(j: {
  id: string;
  title: string | null;
  companyName: string | null;
  description: string | null;
  qualifications: string | null;
  hardRequirements: string | null;
  contentUpdatedAt: Date | null;
}): string {
  const raw = [
    j.id,
    j.title ?? '',
    j.companyName ?? '',
    j.description ?? '',
    j.qualifications ?? '',
    j.hardRequirements ?? '',
    j.contentUpdatedAt?.toISOString() ?? '',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export const roboApplyDailyMatcherService = {
  runDailyMatcherForMission,
  runDailyMatcherForAll,
};

export const __test = {
  MATCH_SCORE_FLOOR,
  PER_MISSION_CONCURRENCY,
  JOB_FRESHNESS_DAYS,
  mapSourceToAdapter,
};

export default roboApplyDailyMatcherService;
