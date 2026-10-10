// server/src/features/lifecycle/service.ts
//
// The `lifecycle-emails` cron (hourly at :15, per brand) and `canSend()`.
// For each candidate person (new in the last 2 weeks, or idle 14–31 days):
//   - skip inside quiet hours (21:00–08:00 local, or their own);
//   - skip when a lifecycle message already went out in the last 24 h
//     (rows 7–9 from the reminder producers count too), and claim the day
//     atomically so two overlapping runs cannot both send;
//   - "Tips and reminders" rows only with that preference on (regional
//     default: off for EEA/UK/CH/CA and GoApply);
//   - send the first due row, in PRODUCT order, in-app first, then email and
//     the registered channels. Rows that need a real number send only with it
//     (re-engagement: N ≥ 3 new jobs, counted, never estimated).

import type { BrandId, Market, ProductBrand } from '../../platform/brand/registry.js';
import type { CronResult, CronTask } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import {
  inQuietHours,
  tipsEnabled,
  type DeliverOutcome,
  type NotifyMessage,
  type PreferenceFacts,
  type PreferencesRepo,
  type Recipient,
} from '../alerts/index.js';
import type { LifecyclePerson, LifecycleRepo } from './repo.js';
import {
  RE_ENGAGEMENT_MIN_JOBS,
  STEP_TEMPLATE,
  TIPS_STEPS,
  dayBudgetUsed,
  eligibleSteps,
  inactiveSince,
  isTipsStep,
  sentCount,
  type LifecycleStep,
} from './rules.js';

export interface LifecycleDeps {
  repo: LifecycleRepo;
  prefs: PreferencesRepo;
  recipients(userIds: readonly string[]): Promise<Map<string, Recipient>>;
  deliver(msg: NotifyMessage): Promise<DeliverOutcome>;
  /**
   * Practice credits left (`getPracticeBalance`) and whether the credit waiting
   * is the free one (free plan with its free allotment), or null when unknown.
   */
  practiceBalance(userId: string): Promise<{ credits: number; free: boolean } | null>;
  /** Exact count of jobs in a saved search first seen after `since`. */
  countNewJobs(input: { market: Market; filters: unknown; since: Date }): Promise<number>;
  /** First-value route for the welcome message (R-14 for GoApply). */
  firstRoute(brand: ProductBrand, cnIdentity: LifecyclePerson['cnIdentity']): string;
  /** Resume-onboarding route for "Finish setup". */
  setupRoute(brandId: BrandId, stage: string | null): string;
  /** Atomic once-a-day claim per person (DB-backed counter). */
  claimDay(userId: string, now: Date): Promise<boolean>;
}

/** People evaluated per chunk (one batch read each). */
const CHUNK = 100;
/** Candidates read per page; a run pages through all of them by id until the budget runs out. */
export const CANDIDATE_PAGE = 500;
const RESERVE_MS = 5_000;

type Plan = { step: LifecycleStep; params: Record<string, unknown>; href: string; category: 'reminder' | 'tips' };

/** Resolve one eligible row into what to send, or null when its real-data condition fails. */
async function planStep(step: LifecycleStep, person: LifecyclePerson, brand: ProductBrand, prefs: PreferenceFacts, deps: LifecycleDeps): Promise<Plan | null> {
  const category = isTipsStep(step) ? 'tips' : 'reminder';
  switch (step) {
    case 'welcome': {
      const firstRoute = deps.firstRoute(brand, person.cnIdentity);
      return { step, category, params: { firstRoute }, href: firstRoute };
    }
    case 'finish_setup': {
      const resumeRoute = deps.setupRoute(brand.id, person.onboardingStep);
      return { step, category, params: { resumeRoute }, href: resumeRoute };
    }
    case 'resume_check_ready': {
      if (!person.resumeCheck) return null;
      const href = `/resume/${encodeURIComponent(person.resumeCheck.resumeId)}/check`;
      return { step, category, params: { resumeId: person.resumeCheck.resumeId, issueCount: person.resumeCheck.issueCount }, href };
    }
    case 'tips_first_tailor': {
      const job = await deps.repo.topFitJob(person.userId, brand.market);
      return { step, category, params: { job }, href: job ? `/jobs/${encodeURIComponent(job.id)}?from=tips` : '/jobs' };
    }
    case 'tips_practice': {
      if (prefs.practiceNudgeOptOut) return null; // they turned off the old Friday practice nudge
      const balance = await deps.practiceBalance(person.userId);
      if (!balance || balance.credits < 1) return null; // only with a real, unused balance
      // "free" only when it really is the free credit (never practised + free plan allotment).
      return { step, category, params: { free: balance.free }, href: '/practice' };
    }
    case 'tips_re_engagement': {
      const search = await deps.repo.activeSearch(person.userId);
      if (!search) return null;
      const since = inactiveSince(person);
      const count = await deps.countNewJobs({ market: brand.market, filters: search.filters, since });
      if (count < RE_ENGAGEMENT_MIN_JOBS) return null;
      return {
        step,
        category,
        params: { search: search.name.trim().slice(0, 80) || '—', count, since: since.toISOString(), timeZone: prefs.timeZone },
        href: '/jobs?from=reengagement',
      };
    }
    default:
      return null; // rows 7–9 come from the reminder producers
  }
}

export interface LifecycleRunStats {
  people: number;
  sent: number;
  quiet: number;
  dayUsed: number;
  nothingDue: number;
  errors: number;
  bySteps: Partial<Record<LifecycleStep, number>>;
}

/** Evaluate one person and send at most one row. Returns the step sent, or why not. */
export async function runForPerson(
  person: LifecyclePerson,
  recipient: Recipient,
  prefs: PreferenceFacts,
  brand: ProductBrand,
  deps: LifecycleDeps,
  now: Date,
): Promise<{ sent: LifecycleStep } | { skipped: 'quiet' | 'day_used' | 'nothing_due' | 'claimed' }> {
  if (inQuietHours(now, prefs.timeZone, prefs.quietHours)) return { skipped: 'quiet' };
  if (dayBudgetUsed(person.history, now)) return { skipped: 'day_used' };
  const tipsOn = tipsEnabled(prefs);
  for (const step of eligibleSteps(person, now, tipsOn)) {
    const plan = await planStep(step, person, brand, prefs, deps);
    if (!plan) continue;
    if (!(await deps.claimDay(person.userId, now))) return { skipped: 'claimed' };
    await deps.deliver({
      recipient,
      kind: 'lifecycle',
      category: plan.category,
      templateKey: STEP_TEMPLATE[plan.step],
      params: plan.params,
      href: plan.href,
      relatedEntity: null,
      prefs: prefs.prefs,
    });
    // Channel-independent record, so a once-only row never repeats when no in-app row or email was written.
    await deps.repo.recordSent(person.userId, STEP_TEMPLATE[plan.step], now).catch((err: unknown) =>
      logger.warn('LIFECYCLE', 'send record failed', { userId: person.userId, step: plan.step, error: err instanceof Error ? err.message : String(err) }),
    );
    return { sent: plan.step };
  }
  return { skipped: 'nothing_due' };
}

export function createLifecycleTask(getDeps: () => LifecycleDeps | Promise<LifecycleDeps>): CronTask {
  return async (ctx): Promise<CronResult> => {
    const brand = ctx.brand;
    const now = ctx.now;
    const deps = await getDeps();
    const stats: LifecycleRunStats = { people: 0, sent: 0, quiet: 0, dayUsed: 0, nothingDue: 0, errors: 0, bySteps: {} };
    let afterId: string | null = null;
    let seen = 0;

    pages: for (;;) {
      if (ctx.budget.exhausted(RESERVE_MS)) break;
      const ids = await deps.repo.candidates({ brandId: brand.id, now, afterId, limit: CANDIDATE_PAGE });
      if (!ids.length) break;
      seen += ids.length;
      afterId = ids[ids.length - 1]!;
      for (let i = 0; i < ids.length; i += CHUNK) {
        if (ctx.budget.exhausted(RESERVE_MS)) break pages;
        const chunk = ids.slice(i, i + CHUNK);
        const [people, recipients] = await Promise.all([deps.repo.people(chunk, now), deps.recipients(chunk)]);
        for (const userId of chunk) {
          if (ctx.budget.exhausted(RESERVE_MS)) break pages;
          const person = people.get(userId);
          const recipient = recipients.get(userId);
          if (!person || !recipient || person.brand !== brand.id) continue;
          stats.people += 1;
          try {
            const prefs = await deps.prefs.load(userId);
            if (!prefs) continue;
            const r = await runForPerson(person, recipient, prefs, brand, deps, now);
            if ('sent' in r) {
              stats.sent += 1;
              stats.bySteps[r.sent] = (stats.bySteps[r.sent] ?? 0) + 1;
            } else if (r.skipped === 'quiet') stats.quiet += 1;
            else if (r.skipped === 'day_used' || r.skipped === 'claimed') stats.dayUsed += 1;
            else stats.nothingDue += 1;
          } catch (err) {
            stats.errors += 1;
            logger.warn('LIFECYCLE', 'lifecycle step failed', { userId, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      if (ids.length < CANDIDATE_PAGE) break;
    }
    if (!seen) return { skipped: 'no_work', processed: 0 };
    return { processed: stats.people, ...stats };
  };
}

/**
 * `canSend(userId, step)`: whether a lifecycle row may go to this person now —
 * account exists, not inside quiet hours, no lifecycle message in the last
 * 24 h, "Tips and reminders" on for tips rows, and a once-only row not sent
 * before. Reminder producers (rows 7–9) may call it before `notifyUser`.
 */
export async function canSendWith(userId: string, step: LifecycleStep, now: Date, deps: Pick<LifecycleDeps, 'repo' | 'prefs'>): Promise<boolean> {
  const [people, prefs] = await Promise.all([deps.repo.people([userId], now), deps.prefs.load(userId)]);
  const person = people.get(userId);
  if (!person || !prefs) return false;
  if (inQuietHours(now, prefs.timeZone, prefs.quietHours)) return false;
  if (dayBudgetUsed(person.history, now)) return false;
  if (TIPS_STEPS.includes(step) && !tipsEnabled(prefs)) return false;
  const repeatable: readonly LifecycleStep[] = ['follow_up_reminder', 'interview_date_reminder', 'ready_list_ready', 'tips_re_engagement'];
  if (!repeatable.includes(step) && sentCount(person.history, step) > 0) return false;
  return true;
}

/** Production wiring (lazy). */
export async function defaultLifecycleDeps(): Promise<LifecycleDeps> {
  const [
    { createPrismaLifecycleRepo },
    alerts,
    { getPracticeBalance },
    { isEnabledForBrand },
    { firstValueRoute, routeForStage },
    { consumeRateLimit },
  ] = await Promise.all([
    import('./repo.js'),
    import('../alerts/index.js'),
    import('../../platform/credits/index.js'),
    import('../../platform/flags.js'),
    import('../onboarding/index.js'),
    import('../../platform/ratelimit/index.js'),
  ]);
  const deliverDeps = alerts.defaultDeliverDeps((b) => alerts.deliveryChannels(b.id));
  const alertsRepo = alerts.createPrismaAlertsRepo();
  return {
    repo: createPrismaLifecycleRepo(),
    prefs: alerts.createPrismaPreferencesRepo(),
    recipients: (ids) => alertsRepo.recipients(ids),
    deliver: (msg) => alerts.deliverMessage(msg, deliverDeps),
    practiceBalance: async (userId) => {
      try {
        const b = await getPracticeBalance(userId);
        // The free credit: the free plan (no live paid plan) with its free allotment.
        return { credits: b.credits, free: b.tier === 'free' && (b.periodAllotment ?? 0) >= 1 };
      } catch {
        return null;
      }
    },
    countNewJobs: (input) => alertsRepo.countMatchingJobs(input),
    firstRoute: (b, cnIdentity) =>
      firstValueRoute(b.id, {
        campusCalendar: isEnabledForBrand('jobs.campusCalendar', b),
        jobsFeed: isEnabledForBrand('jobs.feed', b),
        cnIdentity,
      }),
    setupRoute: (brandId, stage) => (stage ? routeForStage(brandId, stage) : null) ?? '/onboarding',
    claimDay: async (userId, now) => {
      const r = await consumeRateLimit({ key: `lifecycle:day:${userId}`, windows: [{ limit: 1, windowSec: 86_400 }], now });
      return r.allowed;
    },
  };
}
