// server/src/features/growth/index.ts — public surface of GROW (FND-5; owners WP-23 → WP-60).
//
// Push-model seams (ruling C20):
//   - markChecklistStep(userId, step): WP-34 ('save_job'), WP-36a ('tailor'),
//     WP-43 ('practice') call it; WP-23 fills it (idempotent; grants 1
//     practice credit once all three are done).
//   - recordAttribution(userId, touch): WP-10 signup.
//   - deleteEventsForUser(userId): WP-10 account wipe (rows by userId and linked anonIds).
// All throw NotImplementedError until WP-23; callers must catch it so a stub
// never breaks the action that triggered it.

import { NotImplementedError } from '../../platform/http.js';
import type { ChecklistState, ChecklistStep, Touch } from './contract.js';

export * from './contract.js';
export { createInvitesRouter } from './routes.js';
export { createEventsPublicRouter } from './publicRoutes.js';
export { GROWTH_WORK_KINDS } from './workers.js';

export interface GrowthService {
  markChecklistStep(userId: string, step: ChecklistStep): Promise<ChecklistState>;
  recordAttribution(userId: string, touch: Touch, options?: { anonId?: string; lastTouchOnly?: boolean }): Promise<void>;
  deleteEventsForUser(userId: string): Promise<{ deleted: number }>;
}

export const growthService: GrowthService = {
  async markChecklistStep() {
    throw new NotImplementedError('growth.markChecklistStep');
  },
  async recordAttribution() {
    throw new NotImplementedError('growth.recordAttribution');
  },
  async deleteEventsForUser() {
    throw new NotImplementedError('growth.deleteEventsForUser');
  },
};

export const markChecklistStep = (userId: string, step: ChecklistStep) => growthService.markChecklistStep(userId, step);
export const recordAttribution = (userId: string, touch: Touch, options?: { anonId?: string; lastTouchOnly?: boolean }) =>
  growthService.recordAttribution(userId, touch, options);
export const deleteEventsForUser = (userId: string) => growthService.deleteEventsForUser(userId);
