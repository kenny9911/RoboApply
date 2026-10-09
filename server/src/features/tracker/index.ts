// server/src/features/tracker/index.ts — public surface of TRK (FND-5; owner WP-38).
//
// Seams: `updateOffer()` (WP-64 offers), `summary()` (Assistant's
// application_summary tool), `produceReminders()` (reminders cron producer).

import { NotImplementedError } from '../../platform/http.js';
import type { FollowUpView, TrackerOffer } from './contract.js';

export * from './contract.js';
export { createTrackerRouter } from './routes.js';

export interface TrackerSummary {
  byStatus: Record<string, number>;
  followUps: FollowUpView[];
}

export interface TrackerService {
  updateOffer(userId: string, entryId: string, offer: TrackerOffer | null): Promise<void>;
  summary(userId: string): Promise<TrackerSummary>;
  /** Moves (or creates) the entry for a job to `applied`; shared by apply-click and Ready to apply `open`. */
  markApplied(userId: string, jobId: string, via: 'apply_click' | 'agent_open' | 'manual' | 'extension'): Promise<{ entryId: string }>;
  undoApplied(userId: string, jobId: string): Promise<void>;
}

export const trackerService: TrackerService = {
  async updateOffer() {
    throw new NotImplementedError('tracker.updateOffer');
  },
  async summary() {
    throw new NotImplementedError('tracker.summary');
  },
  async markApplied() {
    throw new NotImplementedError('tracker.markApplied');
  },
  async undoApplied() {
    throw new NotImplementedError('tracker.undoApplied');
  },
};

export const updateOffer = (userId: string, entryId: string, offer: TrackerOffer | null) => trackerService.updateOffer(userId, entryId, offer);
