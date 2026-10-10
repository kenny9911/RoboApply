// backend/src/roboapply/v2/services/RATrackerService.ts
//
// Job Tracker CRUD for the legacy /v2/tracker and /v2/jobs/:id/{save,apply}
// routes. Since WP-38 this is a thin adapter over the typed tracker core in
// server/src/features/tracker (service.ts), which records an RATrackerEvent
// for every change, validates statuses against the brand's ladder and stamps
// `dateApplied` on the first move to Applied. The class, its method names, the
// error classes and `_internal_toTrackerView` keep their names for existing
// importers (routes/jobs.ts).

import {
  toTrackerView,
  trackerCore,
  TrackerDuplicateError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  type TrackerBulkBody,
  type TrackerCreateBody,
  type TrackerEntryView,
  type TrackerListQuery,
  type TrackerListResponse,
  type TrackerPatchBody,
  type TrackerStatus,
} from '../../../features/tracker/index.js';

export { TrackerDuplicateError, TrackerInvalidInputError, TrackerNotFoundError };

/** Every status the tracker stores (the clone ladders plus the pre-clone values). */
export type RATrackerStatus = TrackerStatus;
export type RATrackerEntryView = TrackerEntryView;
export type TrackerListParams = TrackerListQuery;
export type TrackerListResult = TrackerListResponse;
export type TrackerCreateInput = TrackerCreateBody;
export type TrackerPatchInput = TrackerPatchBody;
export type TrackerBulkInput = TrackerBulkBody;

export class RATrackerService {
  list(userId: string, params: TrackerListParams = {}): Promise<TrackerListResult> {
    return trackerCore.list(userId, params);
  }

  getById(userId: string, id: string): Promise<RATrackerEntryView> {
    return trackerCore.getById(userId, id);
  }

  create(userId: string, body: TrackerCreateInput): Promise<RATrackerEntryView> {
    return trackerCore.create(userId, body);
  }

  patch(userId: string, id: string, body: TrackerPatchInput): Promise<RATrackerEntryView> {
    return trackerCore.patch(userId, id, body);
  }

  /** Soft delete: the entry drops out of every read path; the row is kept for recovery. */
  delete(userId: string, id: string): Promise<void> {
    return trackerCore.remove(userId, id);
  }

  bulk(userId: string, body: TrackerBulkInput): Promise<{ updated: number; entries: RATrackerEntryView[] }> {
    return trackerCore.bulk(userId, body);
  }

  /** Idempotent save/apply for a job; saving never moves an entry backwards. */
  upsertForJob(
    userId: string,
    jobId: string,
    args: { status: RATrackerStatus; excitementStars?: number; appliedVia?: string | null },
  ): Promise<RATrackerEntryView> {
    return trackerCore.upsertForJob(userId, jobId, args);
  }
}

export const raTrackerService = new RATrackerService();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const _internal_toTrackerView = (row: any, job?: any): RATrackerEntryView => toTrackerView(row, job ?? null);
