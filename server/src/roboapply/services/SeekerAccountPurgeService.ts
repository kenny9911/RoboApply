// backend/src/roboapply/services/SeekerAccountPurgeService.ts
//
// Nightly GDPR hard-purge sweep. POST /api/v1/roboapply/account/delete only
// soft-disables (SeekerProfile.deletedAt + session revocation) so the seeker
// gets a grace window; this sweep finishes the job once the retention window
// (default 30 days, ACCOUNT_PURGE_RETENTION_DAYS) has elapsed:
//
//   1. Delete R2 interview artifacts — interviews/<sessionId>/recording.mp4
//      (the user's voice), transcript.json/.txt, report.json — for every
//      InterviewSession the user owns.
//   2. Delete stored resume originals (RAResumeVariant.originalFileKey,
//      candidate keyspace of ResumeOriginalFileStorageService).
//   3. Hard-delete the User row — Prisma onDelete: Cascade takes the DB side
//      (SeekerProfile + children, InterviewSession, RAResumeVariant, Resume,
//      sessions, ...).
//
// ORDER MATTERS: storage objects are deleted BEFORE the DB rows because the
// rows hold the only pointers to the object keys. If any storage delete cannot
// be confirmed the user is left in place (counted as `blocked`) and retried on
// the next run — we never orphan objects by dropping their pointer first.
//
// Selection is guarded twice: the DB query filters deletedAt <= cutoff, and
// the pure helpers in accountPurgeHelpers.ts (unit-tested) re-check the cutoff
// and require a purely seeker/candidate role set — a multi-role or admin row
// is never cascaded away by this sweep; it is logged for manual review.
//
// Invoked from cron/handlers.ts (/api/v1/cron/account-purge, Vercel Cron) and
// the in-process node-cron scheduler (RoboApplyCronService). Idempotent and
// resumable: every step is a no-op when re-run.

import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { interviewR2Storage } from '../../interview-engine/storage/r2Storage.js';
import { resumeOriginalFileStorageService } from '../../services/ResumeOriginalFileStorageService.js';
import {
  partitionPurgeCandidates,
  purgeCutoff,
  resolveRetentionDays,
  type PurgeCandidate,
} from './accountPurgeHelpers.js';

/** Accounts processed per run — keeps the cron invocation well under the
 *  function timeout even on a backlog; the nightly cadence drains the rest. */
const DEFAULT_BATCH_LIMIT = 200;

export interface AccountPurgeSummary {
  retentionDays: number;
  /** Soft-deleted profiles past the cutoff found this run (≤ batch limit). */
  scanned: number;
  /** Users fully purged (storage clean + User row hard-deleted). */
  purged: number;
  /** Users whose storage cleanup could not be confirmed — kept for retry. */
  blocked: number;
  /** Users skipped because their role set is not purely seeker/candidate. */
  unsafeRole: number;
  /** Users that threw unexpectedly (logged; retried next run). */
  failed: number;
  /** Interview sessions whose R2 artifacts were removed. */
  interviewSessionsCleaned: number;
  /** Resume original files removed from storage. */
  resumeOriginalsDeleted: number;
}

interface UserPurgeOutcome {
  blocked: boolean;
  reason?: string;
  interviewSessionsCleaned: number;
  resumeOriginalsDeleted: number;
}

/**
 * Purge one user's stored artifacts, then the user row. Returns blocked=true
 * (row kept, retried next run) when any storage delete cannot be confirmed.
 */
async function purgeUser(userId: string): Promise<UserPurgeOutcome> {
  // ── 1. Interview artifacts (R2) ──
  const sessions = await prisma.interviewSession.findMany({
    where: { userId },
    select: { id: true, recordingKey: true, transcriptKey: true },
  });
  if (sessions.length > 0 && !interviewR2Storage.isConfigured()) {
    // Can't clean what we can't reach. Deleting the rows now would orphan any
    // objects that do exist, so hold the user until R2 creds are present.
    return { blocked: true, reason: 'r2_not_configured', interviewSessionsCleaned: 0, resumeOriginalsDeleted: 0 };
  }
  let artifactFailures = 0;
  for (const s of sessions) {
    const { failed } = await interviewR2Storage.deleteSessionArtifacts(s.id, [s.recordingKey, s.transcriptKey]);
    artifactFailures += failed;
  }

  // ── 2. Resume originals — include soft-deleted variants (deletedAt only
  //      hides them from the UI; the stored file is still there). ──
  const variants = await prisma.rAResumeVariant.findMany({
    where: { userId, originalFileKey: { not: null } },
    select: {
      id: true,
      originalFileProvider: true,
      originalFileKey: true,
      originalFileName: true,
      originalFileMimeType: true,
    },
  });
  let resumeOriginalsDeleted = 0;
  let resumeOriginalFailures = 0;
  for (const v of variants) {
    const ok = await resumeOriginalFileStorageService.deleteFile({
      provider: v.originalFileProvider,
      key: v.originalFileKey,
      fileName: v.originalFileName,
      mimeType: v.originalFileMimeType,
    });
    if (ok) resumeOriginalsDeleted += 1;
    else resumeOriginalFailures += 1;
  }

  if (artifactFailures > 0 || resumeOriginalFailures > 0) {
    return {
      blocked: true,
      reason: `storage_cleanup_incomplete (artifacts=${artifactFailures}, originals=${resumeOriginalFailures})`,
      interviewSessionsCleaned: 0,
      resumeOriginalsDeleted,
    };
  }

  // ── 3. Hard-delete the User row; cascades take every dependent table.
  //      deleteMany so a concurrent/duplicate run is an idempotent no-op. ──
  await prisma.user.deleteMany({ where: { id: userId } });

  return { blocked: false, interviewSessionsCleaned: sessions.length, resumeOriginalsDeleted };
}

/** Run one purge sweep. `now` / `retentionDays` / `limit` are test seams. */
export async function runAccountPurgeSweep(
  opts: { now?: Date; retentionDays?: number; limit?: number } = {},
): Promise<AccountPurgeSummary> {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? resolveRetentionDays(process.env.ACCOUNT_PURGE_RETENTION_DAYS);
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  const cutoff = purgeCutoff(now, retentionDays);

  const profiles = await prisma.seekerProfile.findMany({
    where: { deletedAt: { lte: cutoff } },
    orderBy: { deletedAt: 'asc' }, // oldest debt first so a backlog drains FIFO
    take: limit,
    select: {
      userId: true,
      deletedAt: true,
      user: { select: { role: true, roles: true } },
    },
  });

  const candidates: PurgeCandidate[] = profiles.map((p) => ({
    userId: p.userId,
    deletedAt: p.deletedAt,
    role: p.user.role,
    roles: p.user.roles,
  }));
  const { due, unsafeRole } = partitionPurgeCandidates(candidates, now, retentionDays);

  for (const c of unsafeRole) {
    logger.warn('RA_ACCOUNT_PURGE', 'soft-deleted profile has non-seeker roles — skipping hard delete, needs manual review', {
      userId: c.userId,
      role: c.role,
      roles: c.roles,
      deletedAt: c.deletedAt?.toISOString(),
    });
  }

  const summary: AccountPurgeSummary = {
    retentionDays,
    scanned: candidates.length,
    purged: 0,
    blocked: 0,
    unsafeRole: unsafeRole.length,
    failed: 0,
    interviewSessionsCleaned: 0,
    resumeOriginalsDeleted: 0,
  };

  for (const c of due) {
    try {
      const outcome = await purgeUser(c.userId);
      summary.resumeOriginalsDeleted += outcome.resumeOriginalsDeleted;
      if (outcome.blocked) {
        summary.blocked += 1;
        logger.warn('RA_ACCOUNT_PURGE', 'purge blocked — user kept for retry', {
          userId: c.userId,
          reason: outcome.reason,
        });
      } else {
        summary.purged += 1;
        summary.interviewSessionsCleaned += outcome.interviewSessionsCleaned;
        logger.warn('RA_ACCOUNT_PURGE', 'account hard-purged (GDPR)', {
          userId: c.userId,
          softDeletedAt: c.deletedAt?.toISOString(),
          interviewSessionsCleaned: outcome.interviewSessionsCleaned,
          resumeOriginalsDeleted: outcome.resumeOriginalsDeleted,
        });
      }
    } catch (err) {
      summary.failed += 1;
      logger.error('RA_ACCOUNT_PURGE', 'purge threw for user — will retry next run', {
        userId: c.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('RA_ACCOUNT_PURGE', 'sweep complete', { ...summary });
  return summary;
}
