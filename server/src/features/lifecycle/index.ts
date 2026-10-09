// server/src/features/lifecycle/index.ts — public surface of lifecycle messages (FND-5; owner WP-39a).
//
// PRODUCT §7.3 rows 2–10: one lifecycle message a day at most, quiet hours
// 21:00–08:00, consent checks; rows 5, 6 and 10 (and the former Friday
// practice nudge) are "Tips and reminders" and send only with that
// preference on. The cron entry (`lifecycle-emails`) calls ./cron.ts.

import { NotImplementedError } from '../../platform/http.js';

/** PRODUCT §7.3 rows 2–10, in order. `tips_*` rows are "Tips and reminders". */
export const LIFECYCLE_STEPS = [
  'welcome', // 2
  'finish_setup', // 3
  'resume_check_ready', // 4
  'tips_first_tailor', // 5
  'tips_practice', // 6 (replaces the Friday nudge)
  'follow_up_reminder', // 7
  'interview_date_reminder', // 8
  'ready_list_ready', // 9
  'tips_re_engagement', // 10 (14 and 30 days inactive; never when N < 3)
] as const;

/** Steps sent only when the "Tips and reminders" preference is on. */
export const TIPS_STEPS: readonly LifecycleStep[] = ['tips_first_tailor', 'tips_practice', 'tips_re_engagement'];
export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

export interface LifecycleService {
  /** Whether a step is allowed for this user now (consent, quiet hours, one-a-day). */
  canSend(userId: string, step: LifecycleStep, now?: Date): Promise<boolean>;
}

export const lifecycleService: LifecycleService = {
  async canSend() {
    throw new NotImplementedError('lifecycle.canSend');
  },
};
