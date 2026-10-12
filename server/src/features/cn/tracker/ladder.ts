// server/src/features/cn/tracker/ladder.ts — the GoApply application ladder
// (TASK_PLAN.md WP-38; PRODUCT_PLAN.md F-TRK-02 cn column; CN_TW_LAUNCH_PLAN).
//
//   收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 (一面 / 二面 / HR面) → Offer → 三方 / 未通过
//
// Canonical status codes are shared with RoboApply where the meaning is the
// same (`bookmarked`, `applied`, `interviewing`, `offer`, `rejected`); the
// GoApply-only rungs are `assessment` (测评), `written_test` (笔试),
// `ai_interview` (AI面试) and `signed` (三方). Interview rounds are the entry's
// `stageDetail` while it is at `interviewing`. 放弃 is the shared `withdrawn`
// status and 职位关闭 the shared `closed` status (both written by the outcome
// control, not a column of their own).
//
// Labels live in the web bundles (`applications.columns.*`,
// `applications.rounds.*`); this module holds codes only.

import type { TrackerStatus } from '../../tracker/contract.js';

/** Column order on the GoApply board (the last column also shows `withdrawn` and `closed`). */
export const CN_TRACKER_LADDER = [
  'bookmarked',
  'applied',
  'assessment',
  'written_test',
  'ai_interview',
  'interviewing',
  'offer',
  'signed',
  'rejected',
] as const satisfies readonly TrackerStatus[];

/** `stageDetail` values allowed while the entry is at `interviewing` (一面 / 二面 / HR面). */
export const CN_INTERVIEW_ROUNDS = ['mianshi_1', 'mianshi_2', 'hr_mianshi'] as const;
export type CnInterviewRound = (typeof CN_INTERVIEW_ROUNDS)[number];

/** Days before a saved job's 网申截止 at which a reminder is due (PRODUCT F-NOTIF-08 cn). */
export const CN_DEADLINE_REMINDER_DAYS = [3, 1] as const;

/** Is `detail` a valid GoApply stage detail for `status`? (`null` always is.) */
export function isCnStageDetail(status: string, detail: string | null): boolean {
  if (detail === null) return true;
  return status === 'interviewing' && (CN_INTERVIEW_ROUNDS as readonly string[]).includes(detail);
}
