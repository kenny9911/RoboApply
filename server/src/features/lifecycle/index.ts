// server/src/features/lifecycle/index.ts — public surface of lifecycle messages (FND-5; owner WP-39a).
//
// PRODUCT §7.3 rows 2–10: one lifecycle message a day at most, quiet hours
// 21:00–08:00, consent checks; rows 5, 6 and 10 (and the former Friday
// practice nudge, now row 6) are "Tips and reminders" and send only with that
// preference on (default off for EEA/UK/CH/CA and GoApply). The cron entry
// (`lifecycle-emails`) calls ./cron.ts; rows 7–9 come from the reminder
// producers and may ask `lifecycleService.canSend` first.

import {
  CRON_STEPS,
  LIFECYCLE_STEPS,
  LIFECYCLE_TEMPLATE_KEYS,
  LIFECYCLE_TIMING,
  RE_ENGAGEMENT_MAX_UNANSWERED,
  RE_ENGAGEMENT_MIN_JOBS,
  STEP_TEMPLATE,
  TIPS_STEPS,
  eligibleSteps,
  stepForTemplate,
  type LifecycleStep,
} from './rules.js';

export {
  CRON_STEPS,
  LIFECYCLE_STEPS,
  LIFECYCLE_TEMPLATE_KEYS,
  LIFECYCLE_TIMING,
  RE_ENGAGEMENT_MAX_UNANSWERED,
  RE_ENGAGEMENT_MIN_JOBS,
  STEP_TEMPLATE,
  TIPS_STEPS,
  eligibleSteps,
  stepForTemplate,
};
export type { LifecycleFacts, LifecycleStep, SentRecord } from './rules.js';
export { canSendWith, createLifecycleTask, runForPerson } from './service.js';
export type { LifecycleDeps } from './service.js';
export type { LifecyclePerson, LifecycleRepo } from './repo.js';

export interface LifecycleService {
  /** Whether a step is allowed for this user now (consent, quiet hours, one-a-day). */
  canSend(userId: string, step: LifecycleStep, now?: Date): Promise<boolean>;
}

export const lifecycleService: LifecycleService = {
  async canSend(userId, step, now = new Date()) {
    const [{ canSendWith }, { createPrismaLifecycleRepo }, { createPrismaPreferencesRepo }] = await Promise.all([
      import('./service.js'),
      import('./repo.js'),
      import('../alerts/index.js'),
    ]);
    return canSendWith(userId, step, now, { repo: createPrismaLifecycleRepo(), prefs: createPrismaPreferencesRepo() });
  },
};
