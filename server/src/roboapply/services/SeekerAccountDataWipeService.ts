// backend/src/roboapply/services/SeekerAccountDataWipeService.ts
//
// Data-only wipe for a signed-in seeker: clears the "application data" the
// /preferences §08 Danger Zone promises ("match history, queue, activity log,
// and pipeline — account and resumes stay"). This is the narrow, self-serve
// sibling of the nightly GDPR hard-purge (SeekerAccountPurgeService): that one
// deletes the whole User row and cascades EVERYTHING; this one clears only the
// application-data subset and leaves the account, profile, résumés, mission
// config, preferences, and integrations intact.
//
// Scope — the exact tables the UI copy names, mapped to storage:
//   • match history   → RAJobMatchScore        (userId-scoped cached scores)
//   • pipeline/tracker → RATrackerEntry         (userId-scoped tracker rows)
//   • queue + activity → RoboApplyRun           (mission-scoped auto-apply runs;
//                        + RoboApplyDigest        the V3 queue AND the activity
//                                                 feed are both projections of
//                                                 these — see RAQueueService /
//                                                 RAActivityService)
//   • Jobright-clone tables (WP-10) holding the same kinds of data:
//       match history → RAFitReport, RAJobUserState (saved/hidden/applied
//                        marks), RAJobInteraction, RAFeedSession,
//                        RAFeedRating, RAUserAffinity (learned ranking)
//       pipeline       → RATrackerEvent, RAApplicationArtifact (+ the stored
//                        file, deleted first; a row whose file cannot be
//                        confirmed deleted is kept and counted)
//       queue/activity → RAAgentQueueItem, RAAgentKitEvent, RAAlertDelivery,
//                        RACareerInsight
//   • the mission's lifetime telemetry counters are zeroed so the agent-stats
//     orb's "hours saved lifetime" reflects the wipe (it reads
//     RoboApplyMission.totalSubmitted, which would otherwise survive the run
//     delete and lie).
//
// Explicitly LEFT INTACT: User, SeekerProfile, RAResumeVariant (+ Resume master)
// and their originals, RoboApplyMission config (intent/tier/cap/schedule),
// RACareerGoal preferences, RAIntegration, RASavedSearch, mock/onboarding
// sessions. SeekerActivityLog is NOT touched — it is the append-only consent/
// audit ledger (prisma.ts `seeker-append-only-guard` would reject the delete
// anyway) and must survive for compliance.
//
// All deletes run in a single $transaction so a partial failure never leaves a
// torn dataset. Every filter is scoped to `userId` (runs/digests via the
// mission relation), and every op is idempotent — a re-run, or a user with no
// mission / no data (e.g. an admin), is a clean no-op returning all-zero counts.

import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { getArtifactStorageDeleter } from './SeekerAccountPurgeService.js';

export interface AccountDataWipeSummary {
  /** RATrackerEntry rows removed (the pipeline/tracker board). */
  trackerEntries: number;
  /** RAJobMatchScore rows removed (cached match history). */
  matchScores: number;
  /** RoboApplyRun rows removed (the review queue + activity feed source). */
  runs: number;
  /** RoboApplyDigest rows removed (per-day activity narratives). */
  digests: number;
  /** Jobright-clone application-data rows removed, per table (WP-10). */
  clone: Record<WipedCloneTable, number>;
  /** Stored application files that could not be confirmed deleted (rows kept; retry later). */
  applicationFilesKept: number;
}

export const WIPED_CLONE_TABLES = [
  'RAFitReport',
  'RAJobUserState',
  'RAJobInteraction',
  'RAFeedSession',
  'RAFeedRating',
  'RAUserAffinity',
  'RATrackerEvent',
  'RAApplicationArtifact',
  'RAAgentQueueItem',
  'RAAgentKitEvent',
  'RAAlertDelivery',
  'RACareerInsight',
] as const;
export type WipedCloneTable = (typeof WIPED_CLONE_TABLES)[number];

/**
 * Wipe one seeker's application data. Returns per-table removal counts.
 * `userId` is always `req.user.id` — this endpoint only ever clears the
 * caller's own data.
 */
export async function wipeSeekerApplicationData(
  userId: string,
): Promise<AccountDataWipeSummary> {
  // Stored application files go first: their rows hold the only pointer.
  const artifacts = await prisma.rAApplicationArtifact.findMany({
    where: { userId },
    select: { id: true, storageKey: true },
  });
  const deleter = getArtifactStorageDeleter();
  const removableArtifactIds: string[] = [];
  let applicationFilesKept = 0;
  for (const a of artifacts) {
    let ok = !a.storageKey;
    if (a.storageKey) {
      try {
        ok = await deleter(a.storageKey);
      } catch {
        ok = false;
      }
    }
    if (ok) removableArtifactIds.push(a.id);
    else applicationFilesKept += 1;
  }

  const cloneOps = await prisma.$transaction([
    prisma.rAFitReport.deleteMany({ where: { userId } }),
    prisma.rAJobUserState.deleteMany({ where: { userId } }),
    prisma.rAJobInteraction.deleteMany({ where: { userId } }),
    prisma.rAFeedSession.deleteMany({ where: { userId } }),
    prisma.rAFeedRating.deleteMany({ where: { userId } }),
    prisma.rAUserAffinity.deleteMany({ where: { userId } }),
    prisma.rATrackerEvent.deleteMany({ where: { userId } }),
    prisma.rAApplicationArtifact.deleteMany({ where: { userId, id: { in: removableArtifactIds } } }),
    prisma.rAAgentQueueItem.deleteMany({ where: { userId } }),
    prisma.rAAgentKitEvent.deleteMany({ where: { userId } }),
    prisma.rAAlertDelivery.deleteMany({ where: { userId } }),
    prisma.rACareerInsight.deleteMany({ where: { userId } }),
  ]);
  const clone = Object.fromEntries(WIPED_CLONE_TABLES.map((t, i) => [t, cloneOps[i]!.count])) as Record<WipedCloneTable, number>;

  // Sequential $transaction (array form) — atomic all-or-nothing across the
  // four tables. Relation-filtered deleteMany (`mission: { userId }`) scopes
  // runs/digests to the user without a separate mission lookup (same pattern
  // as v1Bridge.updateRunForUser). Ordering is unconstrained: we only delete
  // child rows here, never a referenced parent.
  const [tracker, matchScores, runs, digests] = await prisma.$transaction([
    prisma.rATrackerEntry.deleteMany({ where: { userId } }),
    prisma.rAJobMatchScore.deleteMany({ where: { userId } }),
    prisma.roboApplyRun.deleteMany({ where: { mission: { userId } } }),
    prisma.roboApplyDigest.deleteMany({ where: { mission: { userId } } }),
    // Zero the lifetime counters the orb reads. updateMany (not update) so a
    // user with no mission is a no-op, not a P2025.
    prisma.roboApplyMission.updateMany({
      where: { userId },
      data: { totalSubmitted: 0, totalSkipped: 0, totalUndone: 0, totalFailed: 0 },
    }),
  ]);

  const summary: AccountDataWipeSummary = {
    trackerEntries: tracker.count,
    matchScores: matchScores.count,
    runs: runs.count,
    digests: digests.count,
    clone,
    applicationFilesKept,
  };
  logger.warn('RA_ACCOUNT', 'application data wiped (self-serve)', {
    userId,
    ...summary,
  });
  return summary;
}
