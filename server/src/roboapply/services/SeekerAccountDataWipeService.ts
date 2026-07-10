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

export interface AccountDataWipeSummary {
  /** RATrackerEntry rows removed (the pipeline/tracker board). */
  trackerEntries: number;
  /** RAJobMatchScore rows removed (cached match history). */
  matchScores: number;
  /** RoboApplyRun rows removed (the review queue + activity feed source). */
  runs: number;
  /** RoboApplyDigest rows removed (per-day activity narratives). */
  digests: number;
}

/**
 * Wipe one seeker's application data. Returns per-table removal counts.
 * `userId` is always `req.user.id` — this endpoint only ever clears the
 * caller's own data.
 */
export async function wipeSeekerApplicationData(
  userId: string,
): Promise<AccountDataWipeSummary> {
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
  };
  logger.warn('RA_ACCOUNT', 'application data wiped (self-serve)', {
    userId,
    ...summary,
  });
  return summary;
}
