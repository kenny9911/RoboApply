// server/src/platform/email/templates/notify/index.ts
//
// Notification emails (TASK_PLAN.md WP-39a; PRODUCT_PLAN.md §7.2–§7.3;
// ARCHITECTURE.md §8.1). Strings: server/src/i18n/email/staging/notify.en.json
// (`notify.*`, English; INT translates into the other locales).
//
// None of these is transactional: every one carries the signed unsubscribe
// link and the RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers
// (EmailService adds them for any template with a list), and every one passes
// the preference gate WP-39a registers (alerts/preferences.ts).
//
//   notify.job_alert_instant    alerts list     new jobs for a saved search (up to 5)
//   notify.job_alert_digest     digest list     daily / weekly summary (10 / 15 jobs)
//   notify.welcome              reminders list  PRODUCT §7.3 row 2
//   notify.finish_setup         reminders list  row 3
//   notify.resume_check_ready   reminders list  row 4
//   notify.tips_first_tailor    tips list       row 5  ("Tips and reminders")
//   notify.tips_practice        tips list       row 6  ("Tips and reminders"; replaces the Friday nudge)
//   notify.tips_re_engagement   tips list       row 10 ("Tips and reminders")
//   notify.follow_up_reminder   reminders list  row 7  (producer: WP-38 tracker)
//   notify.interview_reminder   reminders list  row 8  (producer: WP-38 tracker)
//   notify.ready_list_ready     reminders list  row 9  (producer: WP-52)
//   notify.kit_not_opened       reminders list  F-NOTIF-08 (producer: WP-52)
//   notify.campus_deadline      reminders list  GoApply 网申截止 (producer: WP-58)
//   notify.campus_followed      reminders list  GoApply only: a followed company published a
//                                               campus programme (producer: WP-58 follow notices).
//                                               Not the alerts list: alert email is off for
//                                               everyone while `jobs.alerts` is off (GoApply with
//                                               the recruitment-info mode off), and the campus
//                                               calendar is open in that mode.
//
// Honesty: every number in these emails is a real count passed in by the
// sender; pay is the posting's own figure or "Pay not listed"; no emoji in
// subjects; no "you're missing out" wording.

import { button, escapeHtml, heading, paragraph, safeUrl } from '../_shell.js';
import { defineEmailTemplate, type EmailTemplate, type TemplateBody, type TemplateContext } from '../registry.js';
import type { EmailTranslator } from '../../i18n.js';

export const NOTIFY_TEMPLATES = {
  jobAlertInstant: 'notify.job_alert_instant',
  jobAlertDigest: 'notify.job_alert_digest',
  welcome: 'notify.welcome',
  finishSetup: 'notify.finish_setup',
  resumeCheckReady: 'notify.resume_check_ready',
  tipsFirstTailor: 'notify.tips_first_tailor',
  tipsPractice: 'notify.tips_practice',
  tipsReEngagement: 'notify.tips_re_engagement',
  followUpReminder: 'notify.follow_up_reminder',
  interviewReminder: 'notify.interview_reminder',
  readyListReady: 'notify.ready_list_ready',
  kitNotOpened: 'notify.kit_not_opened',
  campusDeadline: 'notify.campus_deadline',
  campusFollowed: 'notify.campus_followed',
} as const;

export type NotifyTemplateKey = (typeof NOTIFY_TEMPLATES)[keyof typeof NOTIFY_TEMPLATES];
export const NOTIFY_TEMPLATE_KEYS: readonly NotifyTemplateKey[] = Object.values(NOTIFY_TEMPLATES);

// ── Formatting helpers ───────────────────────────────────────────────────

const INTL_LOCALE: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  ja: 'ja-JP',
  ko: 'ko-KR',
  es: 'es-ES',
  fr: 'fr-FR',
  pt: 'pt-BR',
  de: 'de-DE',
};

function intlLocale(t: EmailTranslator): string {
  return INTL_LOCALE[t.locale] ?? 'en-US';
}

/** A date in the reader's language and time zone (`timeZone` falls back to UTC). */
export function formatNotifyDate(iso: string | null | undefined, t: EmailTranslator, timeZone?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return d.toLocaleDateString(intlLocale(t), { year: 'numeric', month: 'long', day: 'numeric', timeZone: timeZone || 'UTC' });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Date and time in the reader's language and time zone. */
export function formatNotifyDateTime(iso: string | null | undefined, t: EmailTranslator, timeZone?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const tz = timeZone || 'UTC';
  try {
    const s = d.toLocaleString(intlLocale(t), { dateStyle: 'long', timeStyle: 'short', timeZone: tz });
    return timeZone ? s : `${s} UTC`;
  } catch {
    return iso;
  }
}

/** Pay exactly as the posting states it (D3). */
export interface AlertJobPay {
  min: number | null;
  max: number | null;
  currency: string | null;
  /** 'year' | 'month' | 'week' | 'day' | 'hour' */
  period: string | null;
  /** Pay text verbatim from the posting (e.g. "15-25K·13薪", 面議). */
  text: string | null;
}

/** One job in an alert or digest. JSON-safe: it travels through the queue and SeekerNotification.params. */
export interface AlertJobCard {
  id: string;
  title: string;
  company: string;
  /** Display place from the posting, or null. */
  place: string | null;
  remote: boolean;
  pay: AlertJobPay | null;
  tier: 'great' | 'good' | 'possible';
  /** A quick estimate, not an AI read (strategy 2.2 I6). Absent on cards stored before MKT-2F: printed as before. */
  kind?: 'ai' | 'estimate';
  /** Top skill the post asks for that the resume does not show (pre-score), or null. */
  gap: string | null;
  /** App path, e.g. `/jobs/<id>?from=alert&imp=<deliveryId>`. */
  href: string;
}

function money(amount: number, currency: string, t: EmailTranslator): string {
  try {
    return new Intl.NumberFormat(intlLocale(t), { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const PERIOD_KEY: Record<string, string> = {
  year: 'notify.common.payPerYear',
  month: 'notify.common.payPerMonth',
  week: 'notify.common.payPerWeek',
  day: 'notify.common.payPerDay',
  hour: 'notify.common.payPerHour',
};

/** "$120,000–$150,000 a year", the posting's own pay text, or "Pay not listed". Never an estimate. */
export function formatPay(pay: AlertJobPay | null | undefined, t: EmailTranslator): string {
  if (!pay) return t('notify.common.payNotListed');
  const { min, max, currency, period } = pay;
  const valid = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (currency && /^[A-Z]{3}$/.test(currency) && (valid(min) || valid(max))) {
    const amount =
      valid(min) && valid(max) && min !== max
        ? `${money(min, currency, t)}–${money(max, currency, t)}`
        : money((valid(min) ? min : max) as number, currency, t);
    const key = period ? PERIOD_KEY[period] : undefined;
    return key ? t(key, { amount }) : amount;
  }
  if (pay.text && pay.text.trim()) return pay.text.trim().slice(0, 80);
  return t('notify.common.payNotListed');
}

export function tierLabel(tier: AlertJobCard['tier'], t: EmailTranslator): string {
  return t(tier === 'great' ? 'notify.common.tierGreat' : tier === 'good' ? 'notify.common.tierGood' : 'notify.common.tierPossible');
}

/** The tier line of a job card: "Good fit", or "Good fit · Quick estimate" for an estimated job. */
export function fitLine(job: Pick<AlertJobCard, 'tier' | 'kind'>, t: EmailTranslator): string {
  const tier = tierLabel(job.tier, t);
  return job.kind === 'estimate' ? t('notify.common.tierEstimate', { tier }) : tier;
}

function abs(origin: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${origin}${href.startsWith('/') ? '' : '/'}${href}`;
}

function jobListHtml(jobs: readonly AlertJobCard[], ctx: TemplateContext<unknown>): string {
  const { t, origin } = ctx;
  const items = jobs.map((j) => {
    const place = j.remote ? t('notify.common.remote') : j.place || t('notify.common.placeNotListed');
    const meta = [j.company, place, formatPay(j.pay, t)].map(escapeHtml).join(' &middot; ');
    const gap = j.gap ? `<div style="font-size:13px;color:#666666;margin-top:2px;">${escapeHtml(t('notify.common.gapLine', { skill: j.gap }))}</div>` : '';
    return (
      `<div style="border-top:1px solid #ececf1;padding:12px 0;">` +
      `<a href="${escapeHtml(safeUrl(abs(origin, j.href)))}" style="font-size:16px;font-weight:600;color:#111111;text-decoration:none;">${escapeHtml(j.title)}</a>` +
      `<div style="font-size:14px;color:#444444;margin-top:2px;">${meta}</div>` +
      `<div style="font-size:13px;color:#444444;margin-top:2px;">${escapeHtml(fitLine(j, t))}</div>` +
      gap +
      `</div>`
    );
  });
  return `<div style="margin:8px 0 12px;">${items.join('')}</div>`;
}

function jobListText(jobs: readonly AlertJobCard[], ctx: TemplateContext<unknown>): string {
  const { t, origin } = ctx;
  return jobs
    .map((j) => {
      const place = j.remote ? t('notify.common.remote') : j.place || t('notify.common.placeNotListed');
      const lines = [`- ${j.title}`, `  ${[j.company, place, formatPay(j.pay, t)].join(' · ')}`, `  ${fitLine(j, t)}`];
      if (j.gap) lines.push(`  ${t('notify.common.gapLine', { skill: j.gap })}`);
      lines.push(`  ${abs(origin, j.href)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function fitNote(t: EmailTranslator): string {
  return `<p style="font-size:12px;color:#666666;line-height:1.5;margin:4px 0 12px;">${escapeHtml(t('notify.common.fitNote'))}</p>`;
}

/** A simple heading + paragraphs + one button body. */
function simpleBody(
  ctx: TemplateContext<unknown>,
  parts: { subject: string; heading: string; paragraphs: string[]; cta: string; href: string; preheader?: string; reasonText?: string },
): TemplateBody {
  const url = abs(ctx.origin, parts.href);
  return {
    subject: parts.subject,
    preheader: parts.preheader,
    reasonText: parts.reasonText,
    bodyHtml: heading(parts.heading) + parts.paragraphs.map(paragraph).join('') + button(parts.cta, url),
    bodyText: [parts.heading, '', ...parts.paragraphs, '', `${parts.cta}: ${url}`].join('\n'),
  };
}

function remindersReason(t: EmailTranslator): string {
  return t('notify.reasons.reminders');
}

// ── Job alerts ───────────────────────────────────────────────────────────

export interface JobAlertInstantParams {
  /** Saved search name. */
  search: string;
  jobs: AlertJobCard[];
}

export const jobAlertInstantEmail = defineEmailTemplate<JobAlertInstantParams>({
  key: NOTIFY_TEMPLATES.jobAlertInstant,
  category: 'alert',
  list: 'alerts',
  render(ctx) {
    const { t, params } = ctx;
    const jobs = params.jobs ?? [];
    if (!jobs.length) throw new Error('notify.job_alert_instant: never send an alert with zero jobs');
    const count = jobs.length;
    const vars = { count, search: params.search };
    const url = abs(ctx.origin, '/jobs');
    const intro = t('notify.jobAlertInstant.intro', vars);
    return {
      subject: t('notify.jobAlertInstant.subject', vars),
      preheader: intro,
      reasonText: t('notify.reasons.alerts', { search: params.search }),
      bodyHtml:
        heading(t('notify.jobAlertInstant.heading', vars)) +
        paragraph(intro) +
        jobListHtml(jobs, ctx) +
        fitNote(t) +
        button(t('notify.jobAlertInstant.cta'), url),
      bodyText: [
        t('notify.jobAlertInstant.heading', vars),
        '',
        intro,
        '',
        jobListText(jobs, ctx),
        '',
        t('notify.common.fitNote'),
        '',
        `${t('notify.jobAlertInstant.cta')}: ${url}`,
      ].join('\n'),
    };
  },
});

export interface JobAlertDigestParams {
  search: string;
  cadence: 'daily' | 'weekly';
  jobs: AlertJobCard[];
  /**
   * Real number of other qualifying jobs. Null when it is not known exactly:
   * then no total is claimed anywhere (subject, intro, in-app title) and the
   * "more" line is left out; the shown number counts only the listed jobs.
   */
  moreCount: number | null;
  /** Weekly only: applications with no reply for 10 days (real count; 0 or null hides the line). */
  noReplyCount?: number | null;
}

/** Subject and intro: with the real total, or count-free (only the listed jobs are counted). */
const DIGEST_COPY = {
  daily: {
    total: { subject: 'notify.jobAlertDigest.subjectDaily', intro: 'notify.jobAlertDigest.introDaily' },
    noTotal: { subject: 'notify.jobAlertDigest.subjectDailyNoTotal', intro: 'notify.jobAlertDigest.introDailyNoTotal' },
  },
  weekly: {
    total: { subject: 'notify.jobAlertDigest.subjectWeekly', intro: 'notify.jobAlertDigest.introWeekly' },
    noTotal: { subject: 'notify.jobAlertDigest.subjectWeeklyNoTotal', intro: 'notify.jobAlertDigest.introWeeklyNoTotal' },
  },
} as const;

export const jobAlertDigestEmail = defineEmailTemplate<JobAlertDigestParams>({
  key: NOTIFY_TEMPLATES.jobAlertDigest,
  category: 'alert',
  list: 'digest',
  render(ctx) {
    const { t, params } = ctx;
    const jobs = params.jobs ?? [];
    if (!jobs.length) throw new Error('notify.job_alert_digest: never send a summary with zero jobs');
    const weekly = params.cadence === 'weekly';
    const totalKnown = typeof params.moreCount === 'number' && Number.isFinite(params.moreCount) && params.moreCount >= 0;
    const more = totalKnown && params.moreCount! > 0 ? params.moreCount! : 0;
    const total = jobs.length + more;
    const keys = DIGEST_COPY[weekly ? 'weekly' : 'daily'][totalKnown ? 'total' : 'noTotal'];
    const vars = { count: totalKnown ? total : jobs.length, search: params.search };
    const intro = t(keys.intro, vars);
    const moreLine = more ? t('notify.jobAlertDigest.more', { count: more }) : null;
    const noReply = weekly && typeof params.noReplyCount === 'number' && params.noReplyCount > 0 ? params.noReplyCount : 0;
    const trackerLine = noReply ? t('notify.jobAlertDigest.trackerLine', { count: noReply }) : null;
    const url = abs(ctx.origin, '/jobs');
    const appsUrl = abs(ctx.origin, '/applications');
    const head = t(weekly ? 'notify.jobAlertDigest.headingWeekly' : 'notify.jobAlertDigest.headingDaily');
    return {
      subject: t(keys.subject, vars),
      preheader: intro,
      reasonText: t(weekly ? 'notify.reasons.digestWeekly' : 'notify.reasons.digestDaily', { search: params.search }),
      bodyHtml:
        heading(head) +
        paragraph(intro) +
        jobListHtml(jobs, ctx) +
        (moreLine ? paragraph(moreLine) : '') +
        fitNote(t) +
        button(t('notify.jobAlertDigest.cta'), url) +
        (trackerLine ? paragraph(trackerLine) + button(t('notify.jobAlertDigest.trackerCta'), appsUrl) : ''),
      bodyText: [
        head,
        '',
        intro,
        '',
        jobListText(jobs, ctx),
        ...(moreLine ? ['', moreLine] : []),
        '',
        t('notify.common.fitNote'),
        '',
        `${t('notify.jobAlertDigest.cta')}: ${url}`,
        ...(trackerLine ? ['', trackerLine, `${t('notify.jobAlertDigest.trackerCta')}: ${appsUrl}`] : []),
      ].join('\n'),
    };
  },
});

// ── Lifecycle (PRODUCT §7.3 rows 2–6, 10) ────────────────────────────────

export interface WelcomeParams {
  /** First step: `/jobs` (RoboApply), or GoApply's first-value route (`/campus`, `/jobs` or `/resume`). */
  firstRoute: string;
}

export const welcomeEmail = defineEmailTemplate<WelcomeParams>({
  key: NOTIFY_TEMPLATES.welcome,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    const first = params.firstRoute || '/jobs';
    // Always exactly three steps (the copy says "three things"): the first-value
    // step when it is jobs or campus, then resume and practice, and the tracker
    // when the first-value route is the resume itself (GoApply's default).
    const steps: Array<[string, string]> = [];
    if (first === '/campus') steps.push([t('notify.welcome.stepCampus'), '/campus']);
    else if (first === '/jobs') steps.push([t('notify.welcome.stepJobs'), '/jobs']);
    steps.push([t('notify.welcome.stepResume'), '/resume']);
    steps.push([t('notify.welcome.stepPractice'), '/practice']);
    steps.push([t('notify.welcome.stepTracker'), '/applications']);
    const three = steps.slice(0, 3);
    const html = three
      .map(([label, href], i) =>
        `<p style="font-size:15px;line-height:1.6;margin:0 0 10px;">${i + 1}. <a href="${escapeHtml(safeUrl(abs(ctx.origin, href)))}" style="color:#5b5bd6;font-weight:600;">${escapeHtml(label)}</a></p>`,
      )
      .join('');
    const text = three.map(([label, href], i) => `${i + 1}. ${label}: ${abs(ctx.origin, href)}`).join('\n');
    return {
      subject: t('notify.welcome.subject'),
      preheader: t('notify.welcome.preheader'),
      reasonText: remindersReason(t),
      bodyHtml: heading(t('notify.welcome.heading')) + paragraph(t('notify.welcome.intro')) + html,
      bodyText: [t('notify.welcome.heading'), '', t('notify.welcome.intro'), '', text].join('\n'),
    };
  },
});

export interface FinishSetupParams {
  /** Onboarding route to resume at. */
  resumeRoute: string;
}

export const finishSetupEmail = defineEmailTemplate<FinishSetupParams>({
  key: NOTIFY_TEMPLATES.finishSetup,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    return simpleBody(ctx, {
      subject: t('notify.finishSetup.subject'),
      heading: t('notify.finishSetup.heading'),
      paragraphs: [t('notify.finishSetup.body')],
      cta: t('notify.finishSetup.cta'),
      href: params.resumeRoute || '/onboarding',
      preheader: t('notify.finishSetup.preheader'),
      reasonText: remindersReason(t),
    });
  },
});

export interface ResumeCheckReadyParams {
  /** Resume (variant) id the check belongs to. */
  resumeId: string;
  /** Real number of urgent + critical issues, or null when unknown. */
  issueCount: number | null;
}

export const resumeCheckReadyEmail = defineEmailTemplate<ResumeCheckReadyParams>({
  key: NOTIFY_TEMPLATES.resumeCheckReady,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    const body =
      typeof params.issueCount === 'number' && params.issueCount >= 0
        ? t('notify.resumeCheck.bodyCount', { count: params.issueCount })
        : t('notify.resumeCheck.body');
    return simpleBody(ctx, {
      subject: t('notify.resumeCheck.subject'),
      heading: t('notify.resumeCheck.heading'),
      paragraphs: [body],
      cta: t('notify.resumeCheck.cta'),
      href: `/resume/${encodeURIComponent(params.resumeId)}/check`,
      preheader: t('notify.resumeCheck.preheader'),
      reasonText: remindersReason(t),
    });
  },
});

export interface TipsFirstTailorParams {
  /** The user's top-fit job, when one is known. */
  job: { id: string; title: string; company: string } | null;
  /**
   * Same-site path the button opens when no job is named and the job list is
   * closed for the brand (GoApply with the recruitment-info mode off: `/resume`).
   * Absent: `/jobs`.
   */
  fallbackHref?: string | null;
}

/** A same-site path (`/resume`), or null: never an absolute or protocol-relative URL from params. */
function sitePath(v: unknown): string | null {
  return typeof v === 'string' && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : null;
}

export const tipsFirstTailorEmail = defineEmailTemplate<TipsFirstTailorParams>({
  key: NOTIFY_TEMPLATES.tipsFirstTailor,
  category: 'tips',
  render(ctx) {
    const { t, params } = ctx;
    const job = params.job;
    return simpleBody(ctx, {
      subject: job ? t('notify.tipsTailor.subjectJob', { title: job.title }) : t('notify.tipsTailor.subject'),
      heading: t('notify.tipsTailor.heading'),
      paragraphs: [job ? t('notify.tipsTailor.bodyJob', { title: job.title, company: job.company }) : t('notify.tipsTailor.body')],
      cta: t('notify.tipsTailor.cta'),
      href: job ? `/jobs/${encodeURIComponent(job.id)}?from=tips` : (sitePath(params.fallbackHref) ?? '/jobs'),
      preheader: t('notify.tipsTailor.preheader'),
    });
  },
});

export interface TipsPracticeParams {
  /**
   * True only when the credit waiting is the free practice interview (free
   * plan, never practised). Otherwise (Pro credits, a bought pack, unknown)
   * the copy does not say "free".
   */
  free?: boolean;
}

export const tipsPracticeEmail = defineEmailTemplate<TipsPracticeParams>({
  key: NOTIFY_TEMPLATES.tipsPractice,
  category: 'tips',
  render(ctx) {
    const { t, params } = ctx;
    const free = params?.free === true;
    return simpleBody(ctx, {
      subject: free ? t('notify.tipsPractice.subject') : t('notify.tipsPractice.subjectCredit'),
      heading: t('notify.tipsPractice.heading'),
      paragraphs: [free ? t('notify.tipsPractice.body') : t('notify.tipsPractice.bodyCredit')],
      cta: t('notify.tipsPractice.cta'),
      href: '/practice',
      preheader: t('notify.tipsPractice.preheader'),
    });
  },
});

export interface TipsReEngagementParams {
  search: string;
  /** Real count of new jobs that fit the saved search since `since` (never sent when < 3). */
  count: number;
  /** ISO time of the user's last visit. */
  since: string;
  timeZone?: string | null;
}

export const tipsReEngagementEmail = defineEmailTemplate<TipsReEngagementParams>({
  key: NOTIFY_TEMPLATES.tipsReEngagement,
  category: 'tips',
  render(ctx) {
    const { t, params } = ctx;
    if (!(params.count >= 3)) throw new Error('notify.tips_re_engagement: never sent when fewer than 3 new jobs fit');
    const vars = { count: params.count, search: params.search, date: formatNotifyDate(params.since, t, params.timeZone) };
    return simpleBody(ctx, {
      subject: t('notify.tipsReEngagement.subject', vars),
      heading: t('notify.tipsReEngagement.heading'),
      paragraphs: [t('notify.tipsReEngagement.body', vars)],
      cta: t('notify.tipsReEngagement.cta'),
      href: '/jobs?from=reengagement',
      preheader: t('notify.tipsReEngagement.preheader'),
    });
  },
});

// ── Reminders (producers: WP-38, WP-52, WP-58) ───────────────────────────

export interface FollowUpReminderParams {
  /** RATrackerEntry id. */
  entryId: string;
  title: string;
  company: string;
  /** ISO time the user applied. */
  appliedAt: string;
  /** Whole days without a reply (a real count, e.g. 10). */
  days: number;
  timeZone?: string | null;
}

export const followUpReminderEmail = defineEmailTemplate<FollowUpReminderParams>({
  key: NOTIFY_TEMPLATES.followUpReminder,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    const vars = { title: params.title, company: params.company, days: params.days, date: formatNotifyDate(params.appliedAt, t, params.timeZone) };
    return simpleBody(ctx, {
      subject: t('notify.followUp.subject', vars),
      heading: t('notify.followUp.heading'),
      paragraphs: [t('notify.followUp.body', vars)],
      cta: t('notify.followUp.cta'),
      href: `/applications?entry=${encodeURIComponent(params.entryId)}`,
      preheader: t('notify.followUp.preheader', vars),
      reasonText: remindersReason(t),
    });
  },
});

export interface InterviewReminderParams {
  entryId: string;
  /** RAJob id when the tracker entry has one (links "Practice for this job"). */
  jobId: string | null;
  title: string;
  company: string;
  /** ISO time of the interview. */
  interviewAt: string;
  timeZone?: string | null;
}

export const interviewReminderEmail = defineEmailTemplate<InterviewReminderParams>({
  key: NOTIFY_TEMPLATES.interviewReminder,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    const vars = { title: params.title, company: params.company, date: formatNotifyDateTime(params.interviewAt, t, params.timeZone) };
    return simpleBody(ctx, {
      subject: t('notify.interview.subject', vars),
      heading: t('notify.interview.heading'),
      paragraphs: [t('notify.interview.body', vars)],
      cta: t('notify.interview.cta'),
      href: params.jobId ? `/practice?jobId=${encodeURIComponent(params.jobId)}` : `/applications?entry=${encodeURIComponent(params.entryId)}`,
      preheader: t('notify.interview.preheader', vars),
      reasonText: remindersReason(t),
    });
  },
});

export interface ReadyListReadyParams {
  /** Real number of jobs on this week's list. */
  count: number;
}

export const readyListReadyEmail = defineEmailTemplate<ReadyListReadyParams>({
  key: NOTIFY_TEMPLATES.readyListReady,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    if (!(params.count > 0)) throw new Error('notify.ready_list_ready: never sent for an empty list');
    return simpleBody(ctx, {
      subject: t('notify.readyList.subject'),
      heading: t('notify.readyList.heading'),
      paragraphs: [t('notify.readyList.body', { count: params.count })],
      cta: t('notify.readyList.cta'),
      href: '/ready',
      preheader: t('notify.readyList.preheader'),
      reasonText: remindersReason(t),
    });
  },
});

export interface KitNotOpenedParams {
  jobId: string;
  title: string;
  company: string;
}

export const kitNotOpenedEmail = defineEmailTemplate<KitNotOpenedParams>({
  key: NOTIFY_TEMPLATES.kitNotOpened,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    const vars = { title: params.title, company: params.company };
    return simpleBody(ctx, {
      subject: t('notify.kitReady.subject', vars),
      heading: t('notify.kitReady.heading'),
      paragraphs: [t('notify.kitReady.body', vars)],
      cta: t('notify.kitReady.cta'),
      href: `/ready/${encodeURIComponent(params.jobId)}`,
      preheader: t('notify.kitReady.preheader', vars),
      reasonText: remindersReason(t),
    });
  },
});

export interface CampusDeadlineParams {
  /** RACampusEvent id. */
  eventId: string;
  company: string;
  program: string;
  /** ISO close time. */
  closesAt: string;
  /** The official application page (only http(s) links render). */
  officialUrl: string;
  timeZone?: string | null;
}

export const campusDeadlineEmail = defineEmailTemplate<CampusDeadlineParams>({
  key: NOTIFY_TEMPLATES.campusDeadline,
  category: 'alert',
  list: 'reminders',
  render(ctx) {
    const { t, params } = ctx;
    const vars = { company: params.company, program: params.program, date: formatNotifyDateTime(params.closesAt, t, params.timeZone) };
    const href = /^https?:\/\//i.test(params.officialUrl ?? '') ? params.officialUrl : `/campus?event=${encodeURIComponent(params.eventId)}`;
    return simpleBody(ctx, {
      subject: t('notify.campusDeadline.subject', vars),
      heading: t('notify.campusDeadline.heading'),
      paragraphs: [t('notify.campusDeadline.body', vars)],
      cta: t('notify.campusDeadline.cta'),
      href,
      preheader: t('notify.campusDeadline.preheader', vars),
      reasonText: remindersReason(t),
    });
  },
});

export interface CampusFollowedParams {
  /** RACampusEvent id. */
  eventId: string;
  company: string;
  /** Path segment of the company's campus page (`/campus/{slug}`), which lists the programme with its official link. */
  companySlug: string;
  program: string;
  /** The 届别 the person follows, as stored (e.g. "2027届"). */
  graduationClass: string;
}

/** "2027届" → 2027; null when the stored value carries no year (then the copy names no year). */
export function classYearOf(graduationClass: string | null | undefined): number | null {
  const m = /(20\d{2})/.exec(graduationClass ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Follow-a-company notice (GoApply's campus calendar): a company the person
 * follows published a programme for their class year. Facts only: the
 * company, the programme and where it is listed. Non-transactional, on the
 * `reminders` list: the same list as the 网申截止 email and the same switch
 * ("Reminders") as its inbox row, so it does not depend on `jobs.alerts`
 * (off on GoApply while the recruitment-info mode is off, when the campus
 * calendar is still open). It carries the unsubscribe link and passes both
 * email gates; it exists on GoApply only (`markets`).
 */
export const campusFollowedEmail = defineEmailTemplate<CampusFollowedParams>({
  key: NOTIFY_TEMPLATES.campusFollowed,
  category: 'alert',
  list: 'reminders',
  markets: ['cn'],
  render(ctx) {
    const { t, params } = ctx;
    const year = classYearOf(params.graduationClass);
    // A string, so no locale puts a thousands separator in the year.
    const vars = { company: params.company, program: params.program, year: year ? String(year) : '' };
    const href = params.companySlug ? `/campus/${encodeURIComponent(params.companySlug)}` : `/campus?event=${encodeURIComponent(params.eventId)}`;
    return simpleBody(ctx, {
      subject: t(year ? 'notify.campusFollowed.subjectYear' : 'notify.campusFollowed.subject', vars),
      heading: t('notify.campusFollowed.heading', vars),
      paragraphs: [t('notify.campusFollowed.body', vars)],
      cta: t('notify.campusFollowed.cta'),
      href,
      preheader: t('notify.campusFollowed.preheader', vars),
      reasonText: t('notify.reasons.campusFollow', vars),
    });
  },
});

/** Every notify template, by key (for the in-app mirror and tests). */
export const NOTIFY_EMAIL_TEMPLATES: Readonly<Record<NotifyTemplateKey, EmailTemplate<any>>> = {
  [NOTIFY_TEMPLATES.jobAlertInstant]: jobAlertInstantEmail,
  [NOTIFY_TEMPLATES.jobAlertDigest]: jobAlertDigestEmail,
  [NOTIFY_TEMPLATES.welcome]: welcomeEmail,
  [NOTIFY_TEMPLATES.finishSetup]: finishSetupEmail,
  [NOTIFY_TEMPLATES.resumeCheckReady]: resumeCheckReadyEmail,
  [NOTIFY_TEMPLATES.tipsFirstTailor]: tipsFirstTailorEmail,
  [NOTIFY_TEMPLATES.tipsPractice]: tipsPracticeEmail,
  [NOTIFY_TEMPLATES.tipsReEngagement]: tipsReEngagementEmail,
  [NOTIFY_TEMPLATES.followUpReminder]: followUpReminderEmail,
  [NOTIFY_TEMPLATES.interviewReminder]: interviewReminderEmail,
  [NOTIFY_TEMPLATES.readyListReady]: readyListReadyEmail,
  [NOTIFY_TEMPLATES.kitNotOpened]: kitNotOpenedEmail,
  [NOTIFY_TEMPLATES.campusDeadline]: campusDeadlineEmail,
  [NOTIFY_TEMPLATES.campusFollowed]: campusFollowedEmail,
};

export function isNotifyTemplateKey(key: string): key is NotifyTemplateKey {
  return (NOTIFY_TEMPLATE_KEYS as readonly string[]).includes(key);
}
