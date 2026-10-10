// server/src/features/admin/healthEmail.ts — the daily health email
// (ARCHITECTURE.md §10.4 "Alerting"): when a System metric passes its alert
// level, the people in `ADMIN_ALERT_EMAILS` get one short email per brand.
// Nothing is sent on a day with no metric past its level, or when the list
// is empty.
//
// `runAdminHealthEmail` is a brand cron step (CronTask) for `jobs-maintain`
// (handoff request to the owner of server/src/cron/handlers.ts). Platform-wide
// metrics (dead queue items, provider calls) are reported once, by the first
// brand this deployment serves.
//
// The email covers the last complete UTC day (`mode: 'last_complete_day'`):
// at 03:30 UTC only ~15% of today has passed, so today's counts would trip
// the ingest rule every morning and almost never reach a budget rule. It must
// stay a brand step: jobs-maintain runs brand steps before its platform
// `pruneRateCounters` step, which deletes yesterday's day counters.
//
// The email goes to staff only, so its text is English and lives here rather
// than in the user-facing email bundles. No personal data: counts only.

import { allowedBrands, type BrandId, type EnvSource } from '../../platform/brand/index.js';
import { defineEmailTemplate, emailOrigin, escapeHtml, heading, paragraph, sendEmail } from '../../platform/email/index.js';
import type { CronContext, CronResult, CronTask } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import type { AlertHit, AlertKey } from './contract.js';
import { buildSystemStatus, createPrismaSystemStore, type SystemStore } from './system.js';

export const ADMIN_HEALTH_TEMPLATE_KEY = 'admin.daily_health';

const LABELS: Record<AlertKey, string> = {
  ingest_new_low: 'New jobs that day were below half of the 7-day daily average',
  dead_items: 'Dead work items in the queue now',
  provider_budget: 'Job provider calls used most of the daily limit',
  enrich_budget: 'Job enrichment used most of its daily limit',
  score_budget: 'AI fit scores used most of the daily budget',
  assistant_budget: 'Assistant spend (USD) used most of the daily budget',
  email_failures: 'Failed emails that day',
};

export interface HealthEmailParams {
  brandName: string;
  dayKey: string;
  alerts: AlertHit[];
  /** Link to the System panel. */
  systemUrl: string;
}

export function alertLine(hit: AlertHit): string {
  const subject = hit.subject ? ` (${hit.subject})` : '';
  return `${LABELS[hit.key]}${subject}: ${hit.value} (alert level ${hit.level})`;
}

export const adminHealthTemplate = defineEmailTemplate<HealthEmailParams>({
  key: ADMIN_HEALTH_TEMPLATE_KEY,
  category: 'transactional',
  render: ({ params }) => {
    const lines = params.alerts.map(alertLine);
    const subject = `${params.brandName} health, ${params.dayKey}: ${lines.length} ${lines.length === 1 ? 'metric needs' : 'metrics need'} a look`;
    const list = `<ul style="font-size:15px;line-height:1.6;margin:0 0 12px;padding-left:20px;">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
    const link = `<p style="font-size:15px;margin:0 0 12px;"><a href="${escapeHtml(params.systemUrl)}">${escapeHtml(params.systemUrl)}</a></p>`;
    return {
      subject,
      bodyHtml: heading(subject) + list + paragraph(`Counts cover the whole UTC day ${params.dayKey}, read from the database. Open the System page for today so far:`) + link,
      bodyText: [subject, '', ...lines.map((l) => `- ${l}`), '', `System page: ${params.systemUrl}`].join('\n'),
      reasonText: 'You get this email because your address is on the admin alert list.',
    };
  },
});

/** `ADMIN_ALERT_EMAILS`: comma or space separated; invalid entries dropped. */
export function parseAdminEmails(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))];
}

export interface HealthEmailDeps {
  store?: SystemStore;
  env?: EnvSource;
  send?: typeof sendEmail;
  origin?: (brand: BrandId) => string;
}

export function createAdminHealthTask(deps: HealthEmailDeps = {}): CronTask {
  return async (ctx: CronContext): Promise<CronResult> => {
    const env = deps.env ?? process.env;
    const recipients = parseAdminEmails(env.ADMIN_ALERT_EMAILS);
    if (!recipients.length) return { skipped: 'no_recipients' };
    const served = allowedBrands(env);
    const status = await buildSystemStatus(deps.store ?? createPrismaSystemStore(), {
      brands: [ctx.brand.id],
      brandsServed: served,
      now: ctx.now,
      env,
      mode: 'last_complete_day',
    });
    const firstBrand = served[0] === ctx.brand.id;
    const alerts = status.alerts.filter((a) => (a.brand === null ? firstBrand : a.brand === ctx.brand.id));
    if (!alerts.length) return { processed: 0, alerts: 0 };
    const origin = deps.origin ? deps.origin(ctx.brand.id) : emailOrigin(ctx.brand, env);
    const send = deps.send ?? sendEmail;
    let sent = 0;
    for (const to of recipients) {
      try {
        const r = await send({
          template: adminHealthTemplate,
          to,
          brand: ctx.brand.id,
          params: { brandName: ctx.brand.name, dayKey: status.dayKey, alerts, systemUrl: `${origin}/admin/system` },
        });
        if (r.status === 'sent') sent += 1;
      } catch (err) {
        logger.warn('ADMIN', 'health email failed', { brand: ctx.brand.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { processed: sent, alerts: alerts.length, recipients: recipients.length };
  };
}

/** jobs-maintain step: `{ name: 'adminHealth', task: runAdminHealthEmail }`. */
export const runAdminHealthEmail: CronTask = createAdminHealthTask();
