// server/src/platform/email/templates/billing/index.ts
//
// Billing emails (TASK_PLAN.md WP-21a; PRODUCT_PLAN.md §6.4–§6.5). All are
// transactional: they are about the person's own plan and money, so they go
// out without a marketing opt-in and carry no unsubscribe link. Strings live
// in server/src/i18n/email/staging/billing.en.json (`billing.*`); names of
// plans come from `billing.planNames.*`, prices and dates are formatted here
// from real amounts (never from copy).
//
//   billing.renewal_reminder   5 days before a monthly/quarterly renewal,
//                              2 days before a weekly one; passes: before they end
//   billing.annual_reminder    a subscription running for more than 12 months
//   billing.cancel_link        public /cancel: single-use link, 30 minutes
//   billing.cancel_none        public /cancel: nothing to cancel on this address
//   billing.cancel_confirmed   after any cancellation (§312k BGB confirmation)
//   billing.payment_failed     a renewal charge failed; Stripe retries

import { button, heading, paragraph } from '../_shell.js';
import { defineEmailTemplate, type TemplateContext } from '../registry.js';
import type { EmailTranslator } from '../../i18n.js';

const KNOWN_PLAN_NAMES = new Set([
  'pro_weekly',
  'pro_monthly',
  'pro_quarterly',
  'pro_week_pass',
  'practice_pack_5',
  'practice_pack_15',
  'student_monthly',
  'student_quarterly',
]);

/** Old starter/growth practice plans (no longer sold). */
export function isLegacyPlan(planKey: string): boolean {
  return planKey === 'starter' || planKey === 'growth';
}

/** Display name of a plan key in the email's language. Legacy starter/growth → "Practice plan (legacy)". */
export function planName(t: EmailTranslator, planKey: string): string {
  if (isLegacyPlan(planKey)) return t('billing.planNames.legacy');
  if (KNOWN_PLAN_NAMES.has(planKey)) {
    // GoApply sells non-renewing passes: its Pro and student plans have their own names (月卡, 学生月卡), never "billed monthly".
    const isPass = planKey.startsWith('pro_') || planKey.startsWith('student_');
    const key = `billing.planNames.${planKey}${t.brand.market === 'cn' && isPass ? 'Cn' : ''}`;
    if (t.has(key)) return t(key);
    return t(`billing.planNames.${planKey}`);
  }
  return t('billing.planNames.pro');
}

const DATE_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', pt: 'pt-BR', de: 'de-DE' };

export function formatDate(iso: string, t: EmailTranslator): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return d.toLocaleDateString(DATE_LOCALE[t.locale] ?? 'en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatDateTime(iso: string, t: EmailTranslator): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return `${d.toLocaleString(DATE_LOCALE[t.locale] ?? 'en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  } catch {
    return iso;
  }
}

export function formatPrice(amountMinor: number | null | undefined, currency: string | null | undefined, t: EmailTranslator): string {
  if (amountMinor === null || amountMinor === undefined || !currency) return '—';
  try {
    return new Intl.NumberFormat(DATE_LOCALE[t.locale] ?? 'en-US', { style: 'currency', currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function periodWord(t: EmailTranslator, interval: string | null | undefined): string {
  if (interval === 'week' || interval === 'month' || interval === 'quarter') return t(`billing.periods.${interval}`);
  return t('billing.periods.period');
}

function manageUrl(ctx: TemplateContext<unknown>): string {
  return `${ctx.origin}/settings/billing`;
}

// ── Renewal reminder ─────────────────────────────────────────────────────

export interface RenewalReminderParams {
  planKey: string;
  /** ISO time the plan renews (or a pass ends). */
  date: string;
  amountMinor: number | null;
  currency: string | null;
  interval: string | null;
  /** A pass or a manual renewal: it ends, nothing is charged. */
  manual: boolean;
}

export const renewalReminderEmail = defineEmailTemplate<RenewalReminderParams>({
  key: 'billing.renewal_reminder',
  category: 'transactional',
  render(ctx) {
    const { t, params } = ctx;
    const plan = planName(t, params.planKey);
    const date = formatDate(params.date, t);
    const price = formatPrice(params.amountMinor, params.currency, t);
    const period = periodWord(t, params.interval);
    const url = manageUrl(ctx);
    if (params.manual) {
      // Old practice-plan passes are no longer sold (and are not Pro): point to the current plans instead.
      const legacy = isLegacyPlan(params.planKey);
      const subject = t('billing.renewalReminder.subjectManual', { date });
      const body = t(legacy ? 'billing.renewalReminder.bodyManualLegacy' : 'billing.renewalReminder.bodyManual', { plan, date });
      const cta = t(legacy ? 'billing.renewalReminder.ctaManualLegacy' : 'billing.renewalReminder.ctaManual');
      return {
        subject,
        preheader: body,
        bodyHtml: heading(t('billing.renewalReminder.headingManual')) + paragraph(body) + button(cta, url),
        bodyText: `${t('billing.renewalReminder.headingManual')}\n\n${body}\n\n${cta}: ${url}`,
        reasonText: t('billing.footer'),
      };
    }
    const subject = t('billing.renewalReminder.subjectAuto', { date });
    const body = t('billing.renewalReminder.bodyAuto', { plan, date, price, period });
    const cancel = t('billing.renewalReminder.cancelLine');
    return {
      subject,
      preheader: body,
      bodyHtml: heading(t('billing.renewalReminder.headingAuto')) + paragraph(body) + paragraph(cancel) + button(t('billing.renewalReminder.ctaAuto'), url),
      bodyText: `${t('billing.renewalReminder.headingAuto')}\n\n${body}\n${cancel}\n\n${t('billing.renewalReminder.ctaAuto')}: ${url}`,
      reasonText: t('billing.footer'),
    };
  },
});

// ── Annual reminder ──────────────────────────────────────────────────────

export interface AnnualReminderParams {
  planKey: string;
  startedAt: string;
  nextRenewal: string | null;
  amountMinor: number | null;
  currency: string | null;
  interval: string | null;
}

export const annualReminderEmail = defineEmailTemplate<AnnualReminderParams>({
  key: 'billing.annual_reminder',
  category: 'transactional',
  render(ctx) {
    const { t, params } = ctx;
    const plan = planName(t, params.planKey);
    const vars = {
      plan,
      since: formatDate(params.startedAt, t),
      price: formatPrice(params.amountMinor, params.currency, t),
      period: periodWord(t, params.interval),
      date: params.nextRenewal ? formatDate(params.nextRenewal, t) : '—',
    };
    const body = t('billing.annualReminder.body', vars);
    const cancel = t('billing.renewalReminder.cancelLine');
    const url = manageUrl(ctx);
    return {
      subject: t('billing.annualReminder.subject'),
      preheader: body,
      bodyHtml: heading(t('billing.annualReminder.heading')) + paragraph(body) + paragraph(cancel) + button(t('billing.renewalReminder.ctaAuto'), url),
      bodyText: `${t('billing.annualReminder.heading')}\n\n${body}\n${cancel}\n\n${t('billing.renewalReminder.ctaAuto')}: ${url}`,
      reasonText: t('billing.footer'),
    };
  },
});

// ── Public cancel flow ───────────────────────────────────────────────────

export interface CancelLinkParams {
  /** The single-use confirm link (`<origin>/cancel?token=…`). */
  url: string;
  expiresMinutes: number;
}

export const cancelLinkEmail = defineEmailTemplate<CancelLinkParams>({
  key: 'billing.cancel_link',
  category: 'transactional',
  render({ t, params }) {
    const body = t('billing.cancelLink.body', { minutes: params.expiresMinutes });
    const ignore = t('billing.cancelLink.ignore');
    return {
      subject: t('billing.cancelLink.subject'),
      preheader: body,
      bodyHtml: heading(t('billing.cancelLink.heading')) + paragraph(body) + button(t('billing.cancelLink.cta'), params.url) + paragraph(ignore),
      bodyText: `${t('billing.cancelLink.heading')}\n\n${body}\n\n${t('billing.cancelLink.cta')}: ${params.url}\n\n${ignore}`,
      reasonText: t('billing.footer'),
    };
  },
});

export const cancelNoneEmail = defineEmailTemplate<Record<string, never>>({
  key: 'billing.cancel_none',
  category: 'transactional',
  render(ctx) {
    const { t } = ctx;
    const body = t('billing.cancelNone.body');
    const url = manageUrl(ctx);
    return {
      subject: t('billing.cancelNone.subject'),
      preheader: body,
      bodyHtml: heading(t('billing.cancelNone.heading')) + paragraph(body) + button(t('billing.cancelNone.cta'), url),
      bodyText: `${t('billing.cancelNone.heading')}\n\n${body}\n\n${t('billing.cancelNone.cta')}: ${url}`,
      reasonText: t('billing.footer'),
    };
  },
});

export interface CancelConfirmedParams {
  planKey: string;
  /** When we received the cancellation. */
  cancelledAt: string;
  /** Paid features stay on until then; null when they end now. */
  accessUntil: string | null;
}

export const cancelConfirmedEmail = defineEmailTemplate<CancelConfirmedParams>({
  key: 'billing.cancel_confirmed',
  category: 'transactional',
  render(ctx) {
    const { t, params } = ctx;
    const plan = planName(t, params.planKey);
    const received = t('billing.cancelConfirmed.received', { at: formatDateTime(params.cancelledAt, t) });
    const access = params.accessUntil
      ? t('billing.cancelConfirmed.accessUntil', { date: formatDate(params.accessUntil, t) })
      : t('billing.cancelConfirmed.accessEnded');
    const body = t('billing.cancelConfirmed.body', { plan });
    const url = manageUrl(ctx);
    return {
      subject: t('billing.cancelConfirmed.subject'),
      preheader: body,
      bodyHtml:
        heading(t('billing.cancelConfirmed.heading')) + paragraph(body) + paragraph(access) + paragraph(received) + button(t('billing.cancelConfirmed.cta'), url),
      bodyText: `${t('billing.cancelConfirmed.heading')}\n\n${body}\n${access}\n${received}\n\n${t('billing.cancelConfirmed.cta')}: ${url}`,
      reasonText: t('billing.footer'),
    };
  },
});

// ── Payment failed ───────────────────────────────────────────────────────

export interface PaymentFailedParams {
  planKey: string;
  amountMinor: number | null;
  currency: string | null;
}

export const paymentFailedEmail = defineEmailTemplate<PaymentFailedParams>({
  key: 'billing.payment_failed',
  category: 'transactional',
  render(ctx) {
    const { t, params } = ctx;
    const body = t('billing.paymentFailed.body', { plan: planName(t, params.planKey), price: formatPrice(params.amountMinor, params.currency, t) });
    const keep = t('billing.paymentFailed.keep');
    const url = manageUrl(ctx);
    return {
      subject: t('billing.paymentFailed.subject'),
      preheader: body,
      bodyHtml: heading(t('billing.paymentFailed.heading')) + paragraph(body) + paragraph(keep) + button(t('billing.paymentFailed.cta'), url),
      bodyText: `${t('billing.paymentFailed.heading')}\n\n${body}\n${keep}\n\n${t('billing.paymentFailed.cta')}: ${url}`,
      reasonText: t('billing.footer'),
    };
  },
});

export const BILLING_EMAIL_TEMPLATES = [
  renewalReminderEmail.key,
  annualReminderEmail.key,
  cancelLinkEmail.key,
  cancelNoneEmail.key,
  cancelConfirmedEmail.key,
  paymentFailedEmail.key,
] as const;
