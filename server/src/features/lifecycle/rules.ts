// server/src/features/lifecycle/rules.ts
//
// PRODUCT §7.3 rows 2–10 as pure rules (TASK_PLAN.md WP-39a). The hourly
// `lifecycle-emails` cron sends rows 2–6 and 10; rows 7–9 come from the
// reminder producers (WP-38 tracker, WP-52) through `notifyUser` or the
// `email.send` queue, and count toward the same one-a-day budget.
//
//   2 welcome              right after onboarding completes, or 1 h after signup
//   3 finish_setup         24 h after signup while the stage is before `resume`; once
//   4 resume_check_ready   the onboarding resume check is ready and unopened after 24 h; once
//   5 tips_first_tailor    day 3, no tailored resume yet ("Tips and reminders")
//   6 tips_practice        day 5, no practice yet and the free credit unused ("Tips and reminders";
//                          replaces the old Friday nudge)
//  10 tips_re_engagement   14 and 30 days inactive; real N ≥ 3 new jobs; stops after 2 unanswered
//                          ("Tips and reminders")
// Global: at most one lifecycle message per person per day; quiet hours and
// the "Tips and reminders" preference are checked by the caller.

import { NOTIFY_TEMPLATES, type NotifyTemplateKey } from '../../platform/email/templates/notify/index.js';
import { ONBOARDING_STAGE_ORDER, type OnboardingStage } from '../onboarding/index.js';

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
export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

/** Steps sent only when the "Tips and reminders" preference is on. */
export const TIPS_STEPS: readonly LifecycleStep[] = ['tips_first_tailor', 'tips_practice', 'tips_re_engagement'];

/** Steps the lifecycle cron sends itself (the rest come from reminder producers). */
export const CRON_STEPS: readonly LifecycleStep[] = [
  'welcome',
  'finish_setup',
  'resume_check_ready',
  'tips_first_tailor',
  'tips_practice',
  'tips_re_engagement',
];

export const STEP_TEMPLATE: Readonly<Record<LifecycleStep, NotifyTemplateKey>> = {
  welcome: NOTIFY_TEMPLATES.welcome,
  finish_setup: NOTIFY_TEMPLATES.finishSetup,
  resume_check_ready: NOTIFY_TEMPLATES.resumeCheckReady,
  tips_first_tailor: NOTIFY_TEMPLATES.tipsFirstTailor,
  tips_practice: NOTIFY_TEMPLATES.tipsPractice,
  follow_up_reminder: NOTIFY_TEMPLATES.followUpReminder,
  interview_date_reminder: NOTIFY_TEMPLATES.interviewReminder,
  ready_list_ready: NOTIFY_TEMPLATES.readyListReady,
  tips_re_engagement: NOTIFY_TEMPLATES.tipsReEngagement,
};

/** Every template that counts as a lifecycle message (one a day across all of them). */
export const LIFECYCLE_TEMPLATE_KEYS: readonly string[] = Object.values(STEP_TEMPLATE);

const TEMPLATE_STEP = new Map<string, LifecycleStep>(Object.entries(STEP_TEMPLATE).map(([s, k]) => [k, s as LifecycleStep]));

export function stepForTemplate(templateKey: string): LifecycleStep | null {
  return TEMPLATE_STEP.get(templateKey) ?? null;
}

export function isTipsStep(step: LifecycleStep): boolean {
  return TIPS_STEPS.includes(step);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const LIFECYCLE_TIMING = {
  welcomeAfterSignupMs: HOUR,
  finishSetupAfterMs: DAY,
  resumeCheckUnopenedMs: DAY,
  tailorFromMs: 3 * DAY,
  practiceFromMs: 5 * DAY,
  /** Onboarding rows are not sent to accounts older than this (no catch-up mail for old accounts). */
  onboardingWindowMs: 7 * DAY,
  tipsWindowMs: 12 * DAY,
  resumeCheckWindowMs: 14 * DAY,
  reEngageFirstMs: 14 * DAY,
  reEngageSecondMs: 30 * DAY,
  /** "Per day": a rolling 24 h window. */
  dayMs: DAY,
} as const;

/** Re-engagement is never sent with fewer new jobs than this (PRODUCT §7.3 row 10). */
export const RE_ENGAGEMENT_MIN_JOBS = 3;
/** Re-engagement stops after this many unanswered sends. */
export const RE_ENGAGEMENT_MAX_UNANSWERED = 2;

/** A past lifecycle message (any channel). */
export interface SentRecord {
  templateKey: string;
  at: Date;
}

/** What the rules read about one person; the lazy parts (top job, credits, N) are checked by the service. */
export interface LifecycleFacts {
  createdAt: Date;
  lastActiveAt: Date | null;
  onboardingStep: string | null;
  onboardingCompletedAt: Date | null;
  history: readonly SentRecord[];
  /**
   * `viewed`: true / false when known, null when there is no reliable signal.
   * Null counts as viewed (fail closed): row 4 is sent only on a known
   * "not viewed" (SR-39a-1 `RAResumeGrade.viewedAt`, stamped by WP-22).
   */
  resumeCheck: { resumeId: string; completedAt: Date; issueCount: number | null; viewed: boolean | null } | null;
  hasTailored: boolean;
  practiceUsed: boolean;
  hasSearch: boolean;
}

export function sentCount(history: readonly SentRecord[], step: LifecycleStep, since?: Date | null): number {
  const key = STEP_TEMPLATE[step];
  return history.filter((h) => h.templateKey === key && (!since || h.at > since)).length;
}

export function lastLifecycleAt(history: readonly SentRecord[]): Date | null {
  let last: Date | null = null;
  for (const h of history) if (TEMPLATE_STEP.has(h.templateKey) && (!last || h.at > last)) last = h.at;
  return last;
}

/** True when a lifecycle message already went out in the last 24 h. */
export function dayBudgetUsed(history: readonly SentRecord[], now: Date): boolean {
  const last = lastLifecycleAt(history);
  return !!last && now.getTime() - last.getTime() < LIFECYCLE_TIMING.dayMs;
}

function stageBefore(stage: string | null, target: OnboardingStage): boolean {
  if (!stage) return false;
  const order = (ONBOARDING_STAGE_ORDER as Record<string, number>)[stage];
  // An unknown stage reads as done (R-06: unknown values are 'done').
  return typeof order === 'number' && order < ONBOARDING_STAGE_ORDER[target];
}

/** The inactive-since instant for re-engagement. */
export function inactiveSince(f: Pick<LifecycleFacts, 'lastActiveAt' | 'createdAt'>): Date {
  return f.lastActiveAt ?? f.createdAt;
}

/**
 * Rows that are due now by their timing and the person's own activity,
 * in PRODUCT order. Does not check the day budget, quiet hours or the
 * "Tips and reminders" preference (`tipsOn` filters the tips rows).
 */
export function eligibleSteps(f: LifecycleFacts, now: Date, tipsOn: boolean): LifecycleStep[] {
  const out: LifecycleStep[] = [];
  const age = now.getTime() - f.createdAt.getTime();
  const once = (step: LifecycleStep) => sentCount(f.history, step) === 0;

  // 2 welcome
  const onboarded = f.onboardingStep === 'done' && !!f.onboardingCompletedAt;
  if (age <= LIFECYCLE_TIMING.onboardingWindowMs && once('welcome') && (onboarded || age >= LIFECYCLE_TIMING.welcomeAfterSignupMs)) {
    out.push('welcome');
  }
  // 3 finish setup
  if (
    age >= LIFECYCLE_TIMING.finishSetupAfterMs &&
    age <= LIFECYCLE_TIMING.onboardingWindowMs &&
    once('finish_setup') &&
    stageBefore(f.onboardingStep, 'resume')
  ) {
    out.push('finish_setup');
  }
  // 4 resume check ready and unopened (only on a known "not viewed")
  if (f.resumeCheck && f.resumeCheck.viewed === false && once('resume_check_ready')) {
    const since = now.getTime() - f.resumeCheck.completedAt.getTime();
    if (since >= LIFECYCLE_TIMING.resumeCheckUnopenedMs && since <= LIFECYCLE_TIMING.resumeCheckWindowMs) out.push('resume_check_ready');
  }
  if (tipsOn) {
    // 5 first tailored resume
    if (age >= LIFECYCLE_TIMING.tailorFromMs && age <= LIFECYCLE_TIMING.tipsWindowMs && !f.hasTailored && once('tips_first_tailor')) {
      out.push('tips_first_tailor');
    }
    // 6 practice
    if (age >= LIFECYCLE_TIMING.practiceFromMs && age <= LIFECYCLE_TIMING.tipsWindowMs && !f.practiceUsed && once('tips_practice')) {
      out.push('tips_practice');
    }
    // 10 re-engagement: 14 days, then 30 days; stop after 2 unanswered
    if (f.hasSearch) {
      const idleSince = inactiveSince(f);
      const idle = now.getTime() - idleSince.getTime();
      const unanswered = sentCount(f.history, 'tips_re_engagement', idleSince);
      if (unanswered < RE_ENGAGEMENT_MAX_UNANSWERED) {
        const needed = unanswered === 0 ? LIFECYCLE_TIMING.reEngageFirstMs : LIFECYCLE_TIMING.reEngageSecondMs;
        if (idle >= needed) out.push('tips_re_engagement');
      }
    }
  }
  return out;
}
