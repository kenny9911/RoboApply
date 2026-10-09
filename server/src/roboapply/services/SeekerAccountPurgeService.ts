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
//   3. Delete the exact application files sent with applications
//      (RAApplicationArtifact.storageKey; WP-10) through the registered
//      artifact-storage deleter.
//   4. Delete the user's rows that have no FK to User (WP-10, FND-1b
//      NO_CASCADE list): RAOnboardingSession and RAWorkItem by userId, and the
//      first-party events of the user's linked anonIds via
//      growth.deleteEventsForUser() (rows with the userId cascade anyway).
//   5. Hard-delete the User row — Prisma onDelete: Cascade takes the DB side
//      (SeekerProfile + children, InterviewSession, RAResumeVariant, Resume,
//      sessions, every RA* user-owned table, ...).
//
// Brand-aware (WP-10): each user is purged inside `runWithBrand(user.brand)`
// so per-brand storage and logging resolve to the user's brand, and GoApply
// accounts use a retention window of at most 15 days (PIPL: deletion within 15
// working days); RoboApply keeps ACCOUNT_PURGE_RETENTION_DAYS (default 30).
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
import { runWithBrand } from '../../lib/requestContext.js';
import { parseBrandId } from '../../platform/brand/registry.js';
import { growthService } from '../../features/growth/index.js';
import { purgeAuthTokens } from '../../features/auth/tokens.js';
import {
  partitionPurgeCandidates,
  purgeCutoff,
  resolveRetentionDays,
  retentionDaysFor,
  type PurgeCandidate,
} from './accountPurgeHelpers.js';

/**
 * Deletes one stored application artifact (RAApplicationArtifact.storageKey).
 * Returns true only when the object is confirmed gone (or never existed).
 * The default treats keys as objects of the configured S3/R2 bucket; the
 * artifact writer (WP-38 / WP-55a, per-brand buckets via WP-15) may register
 * its own deleter with `setArtifactStorageDeleter`.
 */
export type ArtifactStorageDeleter = (key: string) => Promise<boolean>;

const defaultArtifactDeleter: ArtifactStorageDeleter = (key) =>
  resumeOriginalFileStorageService.deleteFile({ provider: 's3', key, fileName: null, mimeType: null });

let artifactDeleter: ArtifactStorageDeleter = defaultArtifactDeleter;

export function setArtifactStorageDeleter(deleter: ArtifactStorageDeleter | null): void {
  artifactDeleter = deleter ?? defaultArtifactDeleter;
}

export function getArtifactStorageDeleter(): ArtifactStorageDeleter {
  return artifactDeleter;
}

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
  /**
   * Used or expired sign-in tokens deleted (reset/verify links, OAuth state,
   * pending OAuth sign-ups, expired known-device marks); null when that step
   * failed (logged; retried next run).
   */
  authTokensPurged: number | null;
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

  // ── 3. Application artifacts (the exact files sent with applications). ──
  const artifacts = await prisma.rAApplicationArtifact.findMany({
    where: { userId, storageKey: { not: null } },
    select: { id: true, storageKey: true },
  });
  let applicationFileFailures = 0;
  for (const a of artifacts) {
    let ok = false;
    try {
      ok = await artifactDeleter(a.storageKey as string);
    } catch {
      ok = false;
    }
    if (!ok) applicationFileFailures += 1;
  }

  if (artifactFailures > 0 || resumeOriginalFailures > 0 || applicationFileFailures > 0) {
    return {
      blocked: true,
      reason: `storage_cleanup_incomplete (artifacts=${artifactFailures}, originals=${resumeOriginalFailures}, applicationFiles=${applicationFileFailures})`,
      interviewSessionsCleaned: 0,
      resumeOriginalsDeleted,
    };
  }

  // ── 4. Rows without an FK to User (FND-1b NO_CASCADE list) and the
  //      first-party events of the user's linked anonIds. ──
  await deleteRowsWithoutUserFk(userId);

  // ── 5. Hard-delete the User row; cascades take every dependent table.
  //      deleteMany so a concurrent/duplicate run is an idempotent no-op. ──
  await prisma.user.deleteMany({ where: { id: userId } });

  return { blocked: false, interviewSessionsCleaned: sessions.length, resumeOriginalsDeleted };
}

/**
 * The user-owned rows that a User delete does NOT cascade to (FND-1b
 * schemaInvariants NO_CASCADE, `no_fk` entries that are user data). Run before
 * the User row goes, by the account purge and nowhere else.
 */
export async function deleteRowsWithoutUserFk(userId: string): Promise<{ onboardingSessions: number; workItems: number; anonEvents: number | null }> {
  const [onboardingSessions, workItems] = await prisma.$transaction([
    prisma.rAOnboardingSession.deleteMany({ where: { userId } }),
    prisma.rAWorkItem.deleteMany({ where: { userId } }),
  ]);
  let anonEvents: number | null = null;
  try {
    anonEvents = (await growthService.deleteEventsForUser(userId)).deleted;
  } catch (err) {
    // WP-23 fills the seam; until then only the events stamped with the
    // userId go (by cascade). Logged so the gap is visible.
    logger.warn('RA_ACCOUNT_PURGE', 'linked anonymous events not deleted (growth seam unavailable)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { onboardingSessions: onboardingSessions.count, workItems: workItems.count, anonEvents };
}

/** Run one purge sweep. `now` / `retentionDays` / `limit` are test seams. */
export async function runAccountPurgeSweep(
  opts: { now?: Date; retentionDays?: number; limit?: number } = {},
): Promise<AccountPurgeSummary> {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? resolveRetentionDays(process.env.ACCOUNT_PURGE_RETENTION_DAYS);
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  // Per-brand window: an explicit `retentionDays` (tests) applies to every
  // brand; otherwise GoApply is capped at the PIPL window.
  const daysFor = (c: PurgeCandidate) =>
    opts.retentionDays !== undefined ? opts.retentionDays : retentionDaysFor(c.brand ?? null);
  // Query with the shortest window; partition applies each user's own.
  const cutoff = purgeCutoff(now, Math.min(retentionDays, retentionDaysFor('goapply')));

  const profiles = await prisma.seekerProfile.findMany({
    where: { deletedAt: { lte: cutoff } },
    orderBy: { deletedAt: 'asc' }, // oldest debt first so a backlog drains FIFO
    take: limit,
    select: {
      userId: true,
      deletedAt: true,
      user: { select: { role: true, roles: true, brand: true } },
    },
  });

  const candidates: PurgeCandidate[] = profiles.map((p) => ({
    userId: p.userId,
    deletedAt: p.deletedAt,
    role: p.user.role,
    roles: p.user.roles,
    brand: p.user.brand,
  }));
  const { due, unsafeRole } = partitionPurgeCandidates(candidates, now, daysFor);

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
    authTokensPurged: null,
  };

  for (const c of due) {
    try {
      const outcome = await runWithBrand(parseBrandId(c.brand) ?? 'roboapply', () => purgeUser(c.userId));
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

  // Token retention (F-TRUST-06 "auth tokens 24 h"): every used or expired
  // RAAuthToken row goes, including rows with no user (OAuth state, pending
  // sign-ups) that the per-user purge above never reaches.
  try {
    summary.authTokensPurged = await purgeAuthTokens(prisma, now);
  } catch (err) {
    logger.error('RA_ACCOUNT_PURGE', 'auth token sweep failed — will retry next run', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('RA_ACCOUNT_PURGE', 'sweep complete', { ...summary });
  return summary;
}
