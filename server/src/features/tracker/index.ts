// server/src/features/tracker/index.ts — public surface of TRK (FND-5; owner WP-38).
//
// Seams: `updateOffer()` (WP-64 offers), `summary()` (Assistant's
// application_summary tool), `markApplied()` / `undoApplied()` (job detail
// apply-click WP-34, Ready to apply `open` WP-52, extension WP-55a),
// `produceReminders()` (reminders cron producer, ./cron.ts).

import type { FollowUpView, TrackerOffer } from './contract.js';
import { trackerCore, type ApplyMark, type ApplyVia, type UndoAppliedOptions } from './service.js';

export * from './contract.js';
export { createTrackerRouter } from './routes.js';
export { ladderFor, isStatusAllowed, isStageDetailAllowed, INTL_TRACKER_LADDER, type TrackerMarket } from './stages.js';
export { computeFollowUps, computeWeeklyFacts, weekStartFor } from './facts.js';
export {
  createTrackerCore,
  toTrackerView,
  trackerCore,
  TrackerDuplicateError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  UNDO_WINDOW_MS,
  type ApplyMark,
  type ApplyVia,
  type UndoAppliedOptions,
  type TrackerCore,
  type TrackerCoreDeps,
} from './service.js';

export interface TrackerSummary {
  byStatus: Record<string, number>;
  followUps: FollowUpView[];
}

export interface TrackerService {
  updateOffer(userId: string, entryId: string, offer: TrackerOffer | null): Promise<void>;
  summary(userId: string): Promise<TrackerSummary>;
  /**
   * Moves (or creates) the entry for a job to `applied`; shared by apply-click,
   * Ready to apply `open` and the extension. Never moves an entry that is
   * already at Applied or further along (`changed: false`). Keep the returned
   * token and pass it to `undoApplied` as `{ mark }`.
   */
  markApplied(userId: string, jobId: string, via: ApplyVia): Promise<ApplyMark>;
  /**
   * Reverts only the move the matching markApplied made: pass `{ mark }`, or,
   * when the caller cannot keep the token, `{ via }` (then only a move by that
   * channel in the last 10 minutes is reverted). Anything else is a no-op.
   */
  undoApplied(userId: string, jobId: string, opts?: UndoAppliedOptions): Promise<{ undone: boolean }>;
}

export const trackerService: TrackerService = {
  updateOffer: (userId, entryId, offer) => trackerCore.updateOffer(userId, entryId, offer),
  summary: (userId) => trackerCore.summary(userId),
  markApplied: (userId, jobId, via) => trackerCore.markApplied(userId, jobId, via),
  undoApplied: (userId, jobId, opts) => trackerCore.undoApplied(userId, jobId, opts),
};

export const updateOffer = (userId: string, entryId: string, offer: TrackerOffer | null) => trackerService.updateOffer(userId, entryId, offer);
