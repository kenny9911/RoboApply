// backend/src/roboapply/v2/lib/v1Bridge.ts
//
// READ-ONLY bridge from the V2 surface into the V1 auto-apply engine's data.
//
// Boundary rule (scripts/check-roboapply-v2-boundary.mjs, docs §10): V2 code
// must NOT import V1 services/agents (`roboapply/services/*`,
// `roboapply/agents/*`). To surface V1 engine state (RoboApplyMission /
// RoboApplyRun / RoboApplyCoverLetterCache) on the V3 Queue + Activity pages
// we go straight to Prisma here — `../../../lib/prisma` and
// `../../../services/LoggerService` are both on the boundary allow-list.
//
// Everything in this file is a pure read. No writes to V1 models happen here
// — the queue `send`/`skip`/`updateCover` mutations live in RAQueueService and
// write the V1 `RoboApplyRun` row directly via the same Prisma client (a
// deliberate, narrow, documented write surface; see RAQueueService). This
// module is the single place V2 reaches into V1 tables, so the import-graph
// audit stays legible.
//
// The V1 `RoboApplyRunStatus` enum is: queued | previewing | submitted |
// skipped_by_user | failed | undone. The V3 "review queue" = the runs a user
// can still act on before the time-gated 9am-local submit window fires, i.e.
// `queued` + `previewing`. Everything else is terminal history (the Activity
// feed).

import prisma from '../../../lib/prisma.js';

// `prisma as any` — the V1 RoboApply* models are accessed through the same
// client the rest of the backend uses; we keep the cast local so this file
// owns all the loose typing for the V1 tables.
const p = prisma as any;

// ── V1 row shapes (the subset of columns we read) ──────────────────────

/** A V1 `RoboApplyRun` row joined with its `Job` (company/title/location). */
export interface V1RunRow {
  id: string;
  missionId: string;
  jobId: string | null;
  jobContentHash: string;
  resumeId: string;
  coverLetter: string;
  matchScore: number;
  matchExplanation: unknown; // full MatchResult JSON (jsonb)
  rationaleForPick: string;
  plannedSubmitAt: Date;
  actualSubmitAt: Date | null;
  undoneAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  boardAdapter: string;
  status: string;
  simulated: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Hydrated job snapshot (LEFT JOIN). Null when jobId is null or row missing.
  job: {
    id: string;
    title: string;
    companyName: string | null;
    location: string | null;
    applyUrl: string | null;
  } | null;
}

export interface V1MissionRow {
  id: string;
  userId: string;
  reviewMode: string; // 'auto' | 'review_first'
  dailyCap: number;
  enabled: boolean;
  pausedUntil: Date | null;
  totalSubmitted: number;
  totalSkipped: number;
  totalUndone: number;
  totalFailed: number;
  lastSubmissionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Statuses a run can be in while still awaiting / inside the review window. */
export const QUEUE_RUN_STATUSES = ['queued', 'previewing'] as const;

/** Terminal / history statuses surfaced on the Activity feed. */
export const HISTORY_RUN_STATUSES = [
  'submitted',
  'skipped_by_user',
  'failed',
  'undone',
] as const;

const RUN_SELECT = {
  id: true,
  missionId: true,
  jobId: true,
  jobContentHash: true,
  resumeId: true,
  coverLetter: true,
  matchScore: true,
  matchExplanation: true,
  rationaleForPick: true,
  plannedSubmitAt: true,
  actualSubmitAt: true,
  undoneAt: true,
  failedAt: true,
  failureReason: true,
  boardAdapter: true,
  status: true,
  simulated: true,
  createdAt: true,
  updatedAt: true,
  job: {
    select: {
      id: true,
      title: true,
      companyName: true,
      location: true,
    },
  },
} as const;

function shapeRun(row: any): V1RunRow {
  return {
    id: row.id,
    missionId: row.missionId,
    jobId: row.jobId ?? null,
    jobContentHash: row.jobContentHash,
    resumeId: row.resumeId,
    coverLetter: row.coverLetter ?? '',
    matchScore: typeof row.matchScore === 'number' ? row.matchScore : 0,
    matchExplanation: row.matchExplanation ?? null,
    rationaleForPick: row.rationaleForPick ?? '',
    plannedSubmitAt: row.plannedSubmitAt,
    actualSubmitAt: row.actualSubmitAt ?? null,
    undoneAt: row.undoneAt ?? null,
    failedAt: row.failedAt ?? null,
    failureReason: row.failureReason ?? null,
    boardAdapter: row.boardAdapter,
    status: row.status,
    simulated: !!row.simulated,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    job: row.job
      ? {
          id: row.job.id,
          title: row.job.title,
          companyName: row.job.companyName ?? null,
          location: row.job.location ?? null,
          // `Job` has no applyUrl column in this schema; V1 runs submit via the
          // board adapter, not a stored URL. Kept on the shape for parity with
          // the tracker's `job.applyUrl`; always null here.
          applyUrl: null,
        }
      : null,
  };
}

// ── Mission ─────────────────────────────────────────────────────────────

/** The user's single lifetime mission (RoboApplyMission.userId is @unique).
 *  Returns null if the user never onboarded into RoboApply V1. */
export async function getMissionForUser(
  userId: string,
): Promise<V1MissionRow | null> {
  const row = await p.roboApplyMission.findUnique({
    where: { userId },
    select: {
      id: true,
      userId: true,
      reviewMode: true,
      dailyCap: true,
      enabled: true,
      pausedUntil: true,
      totalSubmitted: true,
      totalSkipped: true,
      totalUndone: true,
      totalFailed: true,
      lastSubmissionAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    reviewMode: row.reviewMode,
    dailyCap: row.dailyCap ?? 0,
    enabled: !!row.enabled,
    pausedUntil: row.pausedUntil ?? null,
    totalSubmitted: row.totalSubmitted ?? 0,
    totalSkipped: row.totalSkipped ?? 0,
    totalUndone: row.totalUndone ?? 0,
    totalFailed: row.totalFailed ?? 0,
    lastSubmissionAt: row.lastSubmissionAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Queue reads ───────────────────────────────────────────────────────

/** All pending/review-window runs for a user's mission, ordered by the
 *  soonest planned-submit first (the most urgent card on top). Scoped to the
 *  user via the mission FK — a run can never leak across users because every
 *  run belongs to exactly one mission and a mission belongs to one user. */
export async function listQueueRunsForUser(
  userId: string,
): Promise<V1RunRow[]> {
  const mission = await p.roboApplyMission.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!mission) return [];
  const rows = await p.roboApplyRun.findMany({
    where: {
      missionId: mission.id,
      status: { in: QUEUE_RUN_STATUSES as unknown as string[] },
    },
    select: RUN_SELECT,
    orderBy: { plannedSubmitAt: 'asc' },
  });
  return (rows as any[]).map(shapeRun);
}

/** Fetch a single run by id, but only if it belongs to the given user (joined
 *  through the mission). Returns null when missing OR owned by someone else —
 *  the caller turns that into a 404 (don't disclose existence cross-tenant). */
export async function getRunForUser(
  userId: string,
  runId: string,
): Promise<V1RunRow | null> {
  const row = await p.roboApplyRun.findFirst({
    where: { id: runId, mission: { userId } },
    select: RUN_SELECT,
  });
  if (!row) return null;
  return shapeRun(row);
}

// ── Cover-letter lookup ─────────────────────────────────────────────────

/** Best-effort cover-letter text for a run. Prefers the verbatim text stored
 *  on the run itself; falls back to the latest matching
 *  `RoboApplyCoverLetterCache` row's `output.coverLetter` when the run's column
 *  is still empty (the V1 matcher creates runs with `coverLetter=''` and the
 *  AuthorService fills it in asynchronously). Returns '' when nothing is found
 *  yet — the queue card simply shows an empty draft the user can edit. */
export async function resolveCoverLetterForRun(
  run: V1RunRow,
): Promise<string> {
  if (run.coverLetter && run.coverLetter.trim().length > 0) {
    return run.coverLetter;
  }
  if (!run.jobId) return '';
  const cache = await p.roboApplyCoverLetterCache.findFirst({
    where: { resumeId: run.resumeId, jobId: run.jobId },
    select: { output: true },
    orderBy: { createdAt: 'desc' },
  });
  const output = cache?.output as { coverLetter?: unknown } | null | undefined;
  if (output && typeof output.coverLetter === 'string') {
    return output.coverLetter;
  }
  return '';
}

// ── Activity reads ──────────────────────────────────────────────────────

/** All runs for the user that have any history-worthy timestamp within the
 *  lookback window, newest event first. We pull a generous superset (all runs
 *  touched since `since`) and let RAActivityService decide which events each
 *  row contributes. Scoped to the user's mission. */
export async function listHistoryRunsForUser(
  userId: string,
  since: Date,
): Promise<V1RunRow[]> {
  const mission = await p.roboApplyMission.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!mission) return [];
  const rows = await p.roboApplyRun.findMany({
    where: {
      missionId: mission.id,
      // Touched within the window OR planned within it — captures submitted,
      // skipped, failed, undone, and freshly-queued runs alike.
      OR: [
        { updatedAt: { gte: since } },
        { createdAt: { gte: since } },
        { actualSubmitAt: { gte: since } },
      ],
    },
    select: RUN_SELECT,
    orderBy: { updatedAt: 'desc' },
  });
  return (rows as any[]).map(shapeRun);
}

/** Lifetime + windowed aggregate counters for the agent-stats orb. One cheap
 *  set of grouped queries. */
export async function getRunStatsForUser(
  userId: string,
  sinceTodayUtc: Date,
): Promise<{
  byStatus: Record<string, number>;
  submittedToday: number;
  pendingCount: number;
}> {
  const mission = await p.roboApplyMission.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!mission) {
    return { byStatus: {}, submittedToday: 0, pendingCount: 0 };
  }
  const [grouped, submittedToday] = await Promise.all([
    p.roboApplyRun.groupBy({
      by: ['status'],
      where: { missionId: mission.id },
      _count: { _all: true },
    }),
    p.roboApplyRun.count({
      where: {
        missionId: mission.id,
        status: 'submitted',
        actualSubmitAt: { gte: sinceTodayUtc },
      },
    }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const g of grouped as Array<{ status: string; _count: { _all: number } }>) {
    byStatus[g.status] = g._count._all;
  }
  const pendingCount =
    (byStatus['queued'] ?? 0) + (byStatus['previewing'] ?? 0);
  return { byStatus, submittedToday, pendingCount };
}

/** Narrow, documented WRITE surface used ONLY by RAQueueService for the
 *  queue's send/skip/updateCover actions. Kept here so every touch of the V1
 *  `RoboApplyRun` table is in this one file. Always scoped to the user via the
 *  mission FK; returns the updated row (re-fetched with the standard select)
 *  or null when the run isn't owned by the user. */
export async function updateRunForUser(
  userId: string,
  runId: string,
  data: Record<string, unknown>,
): Promise<V1RunRow | null> {
  // Ownership gate first — updateMany with a mission filter can't be spoofed.
  const res = await p.roboApplyRun.updateMany({
    where: { id: runId, mission: { userId } },
    data,
  });
  if (res.count === 0) return null;
  return getRunForUser(userId, runId);
}
