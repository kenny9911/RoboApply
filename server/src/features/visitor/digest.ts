// server/src/features/visitor/digest.ts — sends logged-out job alerts (WP-78; F-NOTIF-03).
//
// A CronTask for the `job-alerts` cron (every 15 min, per brand, inside
// runWithBrand). INT wires it next to WP-39a's task:
//   brandCronJob('job-alerts', …, [{ name: 'alerts', task: runJobAlerts },
//                                  { name: 'visitor-alerts', task: runAnonAlertDigests }])
//
// Per run:
//   - purges never-confirmed rows 72 h after their last confirm link and
//     unsubscribed rows (with their address) 30 days after they left —
//     always, even when `jobs.alerts` is off for the brand;
//   - `jobs.alerts` off → `{ skipped: 'disabled', purged }` (nothing sent);
//   - takes up to 50 CONFIRMED subscriptions whose email is due (daily: 24 h
//     since the last one, weekly: 7 days; 30 min of slack for the 15-min
//     schedule), oldest first; none → `{ skipped: 'no_work' }` (well under 2 s);
//   - lists the public jobs (ARCH §9.4 predicate) first seen since the last
//     email that match the saved filters: up to 10 in the email, the real
//     total in the subject; never a zero-job email — with nothing new the
//     window simply moves on (`lastSentAt` = "jobs counted through");
//   - stops starting new sends when 5 s of the budget remain.
// Nothing here knows the visitor: no fit, no profile, only the filters they chose.

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { SendEmailResult } from '../../platform/email/EmailService.js';
import type { CronContext, CronResult, CronTask } from '../../platform/queue/index.js';
import { jobPath } from '../seo/index.js';
import {
  ANON_ALERT_CONFIRM_TTL_HOURS,
  ANON_ALERT_JOBS_PER_EMAIL,
  ANON_ALERT_PURGE_UNSUBSCRIBED_DAYS,
  AnonAlertFiltersSchema,
  type AnonAlertFilters,
} from './contract.js';
import { searchLabel } from './alerts.js';
import type { AlertDigestParams, AnonDigestJob } from './emails.js';
import type { AlertJobRow, AnonAlertRow, VisitorAlertsRepo } from './repo.js';

const HOUR_MS = 3_600_000;
const SLACK_MS = 30 * 60_000;
export const DIGEST_BATCH = 50;
const RESERVE_MS = 5_000;

export interface AnonDigestDeps {
  repo: VisitorAlertsRepo;
  alertsEnabled(brand: ProductBrand): Promise<boolean>;
  send(input: { brand: ProductBrand; to: string; locale: string; params: AlertDigestParams }): Promise<SendEmailResult>;
  origin(brand: ProductBrand): string;
}

/** Absolute link for one job: its public page, or (no public pages on the brand) signup that then opens the job. */
export function digestJobHref(job: Pick<AlertJobRow, 'id' | 'title' | 'companyName'>, brand: ProductBrand, origin: string): string {
  if (brand.market === 'cn') return `${origin}/signup?from=alert&next=${encodeURIComponent(`/jobs/${job.id}`)}`;
  return `${origin}${jobPath(job.id, job.title, job.companyName)}?from=alert`;
}

export function toDigestJob(row: AlertJobRow, brand: ProductBrand, origin: string): AnonDigestJob {
  const listed = row.salaryDisclosed || !!row.salaryText?.trim();
  return {
    id: row.id,
    title: row.title,
    company: row.companyName,
    place: row.location ?? row.locationCity ?? null,
    remote: row.workModel === 'remote',
    pay: listed ? { min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod, text: row.salaryText } : null,
    href: digestJobHref(row, brand, origin),
  };
}

function filtersOf(row: AnonAlertRow): AnonAlertFilters {
  const parsed = AnonAlertFiltersSchema.safeParse(row.filters);
  return parsed.success ? parsed.data : {};
}

export function createAnonAlertDigestTask(deps: AnonDigestDeps): CronTask {
  return async (ctx: CronContext): Promise<CronResult> => {
    const { brand, now } = ctx;
    // Retention runs whatever the switch says: turning alerts off (e.g. GoApply's
    // recruitment-info mode back to `off`) must not keep unconfirmed or departed
    // addresses past the published 72 h / 30 days.
    const purged = await deps.repo.purge(brand.id, {
      pendingBefore: new Date(now.getTime() - ANON_ALERT_CONFIRM_TTL_HOURS * HOUR_MS),
      unsubscribedBefore: new Date(now.getTime() - ANON_ALERT_PURGE_UNSUBSCRIBED_DAYS * 24 * HOUR_MS),
    });
    if (!(await deps.alertsEnabled(brand))) return { skipped: 'disabled', purged };
    const due = await deps.repo.due(
      brand.id,
      { daily: new Date(now.getTime() - 24 * HOUR_MS + SLACK_MS), weekly: new Date(now.getTime() - 7 * 24 * HOUR_MS + SLACK_MS) },
      DIGEST_BATCH,
    );
    if (!due.length) return { skipped: 'no_work', purged };

    const origin = deps.origin(brand);
    let sent = 0;
    let empty = 0;
    let failed = 0;
    let suppressed = 0;
    for (const sub of due) {
      if (ctx.budget.remainingMs() < RESERVE_MS) break;
      const since = sub.lastSentAt ?? sub.confirmedAt ?? sub.createdAt;
      const filters = filtersOf(sub);
      const { rows, total } = await deps.repo.newJobs({ market: brand.market, filters, since, now, take: ANON_ALERT_JOBS_PER_EMAIL });
      if (total === 0 || rows.length === 0) {
        await deps.repo.update(sub.id, { lastSentAt: now });
        empty += 1;
        continue;
      }
      const result = await deps.send({
        brand,
        to: sub.email,
        locale: sub.locale,
        params: {
          search: searchLabel(filters),
          cadence: sub.cadence === 'daily' ? 'daily' : 'weekly',
          total,
          jobs: rows.map((r) => toDigestJob(r, brand, origin)),
          signupUrl: `${origin}/signup?from=alert`,
        },
      });
      if (result.status === 'sent') {
        await deps.repo.update(sub.id, { lastSentAt: now });
        sent += 1;
      } else if (result.status === 'suppressed' && result.reason === 'transport_not_configured') {
        // No email on this deployment: stop, keep every window as it is.
        return { skipped: 'transport_not_configured', processed: sent, sent, empty, purged };
      } else if (result.status === 'suppressed') {
        // The gate said no (e.g. the address left the list a moment ago): wait a full period before asking again.
        await deps.repo.update(sub.id, { lastSentAt: now });
        suppressed += 1;
      } else {
        // A failed send is retried on the next run.
        failed += 1;
      }
    }
    return { processed: sent + empty + suppressed, sent, empty, suppressed, failed, purged };
  };
}
