// server/src/features/visitor/emails.ts — logged-out job alert emails (WP-78; F-NOTIF-03).
//
//   visitor.alert_confirm  transactional  the double opt-in link (sent once per signup)
//   visitor.alert_digest   alert (list `alerts`)  new public jobs for the saved filters
//
// The digest is non-transactional, so EmailService adds the signed
// unsubscribe link (no account: the token names a hash of the address) and
// the RFC 8058 headers, and the platform preference gate lets it through only
// for a CONFIRMED subscription of this brand (WP-39b's gate). We also check
// the subscription status ourselves before sending.
//
// Strings: `visitor.email.*` in the email bundles
// (server/src/i18n/email/staging/visitor.en.json, copied from
// `VISITOR_EMAIL_EN` at the Wave 5 gate; keep the two equal until INT merges
// staging). The English below stays the fallback, formatted with the same ICU
// formatter and %BRAND% substitution.
//
// Honesty: counts are real counts of matching jobs; pay only as the posting
// lists it; no fit (there is no profile); never a zero-job email.

import { button, escapeHtml, heading, paragraph, safeUrl } from '../../platform/email/templates/_shell.js';
import { defineEmailTemplate, getEmailTemplate, type EmailTemplate } from '../../platform/email/templates/registry.js';
import { formatMessage, substituteBrand, type EmailTranslator, type MessageParams } from '../../platform/email/i18n.js';

/** English source strings (`visitor.email.*`). */
export const VISITOR_EMAIL_EN = {
  visitor: {
    email: {
      confirm: {
        subject: 'Confirm your job alerts from %BRAND%',
        heading: 'Confirm your job alerts',
        body: 'Someone, hopefully you, asked %BRAND% to email new jobs for "{search}" to this address {cadence, select, daily {once a day} other {once a week}}.',
        cta: 'Confirm job alerts',
        ignore: 'If this was not you, ignore this email. Nothing will be sent unless the link is pressed, and it stops working after {hours} hours.',
        preheader: 'Press the button to start your job alerts.',
      },
      digest: {
        subject: '{count, plural, one {# new job} other {# new jobs}} for "{search}"',
        heading: '{count, plural, one {# new job for your alert} other {# new jobs for your alert}}',
        intro: 'New since your last email, for "{search}".',
        more: '{count, plural, one {# more job also matches.} other {# more jobs also match.}}',
        payNotListed: 'Pay not listed',
        pay: '{amount} {period, select, year {a year} month {a month} week {a week} day {a day} hour {an hour} other {}}',
        placeNotListed: 'Place not listed',
        remote: 'Remote',
        viewJob: 'View job',
        signup: 'Create a free account to see how well each job fits your resume.',
        signupCta: 'Create a free account',
        reason: 'You get this email because you confirmed job alerts for "{search}" on %BRAND%. You do not have an account.',
        preheader: 'New jobs for your alert.',
      },
      searchAny: 'any job',
    },
  },
} as const;

type Dict = { [k: string]: string | Dict };

function lookupEn(key: string): string | undefined {
  let cur: string | Dict | undefined = VISITOR_EMAIL_EN as unknown as Dict;
  for (const part of key.split('.')) {
    if (!cur || typeof cur === 'string') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** `t(key)` from the bundles when present, else the English source above. */
export function visitorText(t: EmailTranslator, key: string, params: MessageParams = {}): string {
  if (t.has(key)) return t(key, params);
  const pattern = lookupEn(key);
  if (pattern === undefined) throw new Error(`visitor email string missing: ${key}`);
  return substituteBrand(formatMessage(pattern, params, 'en'), t.brand);
}

export const VISITOR_EMAIL_TEMPLATES = {
  confirm: 'visitor.alert_confirm',
  digest: 'visitor.alert_digest',
} as const;

export interface AlertConfirmParams {
  /** Absolute confirm URL (`<origin>/alerts/confirm/<token>`). */
  url: string;
  /** The search in plain words (role, place); '' = any job. */
  search: string;
  cadence: 'daily' | 'weekly';
  hours: number;
}

export interface AnonDigestPay {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
  /** The posting's own pay words (e.g. "15-25K·13薪"), preferred when present. */
  text: string | null;
}

const INTL: Record<string, string> = { zh: 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', pt: 'pt-BR', de: 'de-DE' };

/** The posting's pay: its own text, else its range with its own currency and period; null when not listed. Never an estimate. */
export function formatDigestPay(pay: AnonDigestPay | null, t: EmailTranslator): string | null {
  if (!pay) return null;
  if (pay.text?.trim()) return pay.text.trim();
  const ok = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!pay.currency || !/^[A-Z]{3}$/.test(pay.currency) || (!ok(pay.min) && !ok(pay.max))) return null;
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat(INTL[t.locale] ?? 'en-US', { style: 'currency', currency: pay.currency!, maximumFractionDigits: 0 }).format(n);
    } catch {
      return `${n} ${pay.currency}`;
    }
  };
  const amount = ok(pay.min) && ok(pay.max) && pay.min !== pay.max ? `${fmt(pay.min)}–${fmt(pay.max)}` : fmt((ok(pay.min) ? pay.min : pay.max) as number);
  return visitorText(t, 'visitor.email.digest.pay', { amount, period: pay.period ?? 'other' }).trim();
}

/** One job in a digest. JSON-safe. */
export interface AnonDigestJob {
  id: string;
  title: string;
  company: string;
  place: string | null;
  remote: boolean;
  /** Pay exactly as the posting states it, or null ("Pay not listed"). */
  pay: AnonDigestPay | null;
  /** Absolute link: the public job page, or signup with `next` where the brand has none. */
  href: string;
}

export interface AlertDigestParams {
  search: string;
  cadence: 'daily' | 'weekly';
  /** Real count of matching jobs since the last email. */
  total: number;
  jobs: AnonDigestJob[];
  /** Absolute signup URL. */
  signupUrl: string;
}

function register<P>(template: EmailTemplate<P>): EmailTemplate<P> {
  // Re-importing the module (vitest module resets) must not throw on the second registration.
  return (getEmailTemplate(template.key) as EmailTemplate<P> | undefined) ?? defineEmailTemplate(template);
}

export const alertConfirmTemplate = register<AlertConfirmParams>({
  key: VISITOR_EMAIL_TEMPLATES.confirm,
  category: 'transactional',
  render: ({ t, params }) => {
    const v = (k: string, p: MessageParams = {}) => visitorText(t, `visitor.email.confirm.${k}`, p);
    const p = { search: params.search || visitorText(t, 'visitor.email.searchAny'), cadence: params.cadence, hours: params.hours };
    return {
      subject: v('subject'),
      preheader: v('preheader'),
      bodyHtml: heading(v('heading')) + paragraph(v('body', p)) + button(v('cta'), params.url) + paragraph(v('ignore', p)),
      bodyText: [v('heading'), v('body', p), `${v('cta')}: ${params.url}`, v('ignore', p)].join('\n\n'),
    };
  },
});

export const alertDigestTemplate = register<AlertDigestParams>({
  key: VISITOR_EMAIL_TEMPLATES.digest,
  category: 'alert',
  list: 'alerts',
  render: ({ t, params }) => {
    const v = (k: string, p: MessageParams = {}) => visitorText(t, `visitor.email.digest.${k}`, p);
    const shown = params.jobs.length;
    const rest = Math.max(0, params.total - shown);
    const htmlJobs = params.jobs
      .map((j) => {
        const place = j.remote ? v('remote') : (j.place ?? v('placeNotListed'));
        const facts = [j.company, place, formatDigestPay(j.pay, t) ?? v('payNotListed')].map(escapeHtml).join(' · ');
        return `<li style="margin:0 0 14px;"><a href="${escapeHtml(safeUrl(j.href))}" style="font-weight:600;color:#4f3dca;text-decoration:none;">${escapeHtml(j.title)}</a><br/><span style="font-size:13px;color:#656274;">${facts}</span></li>`;
      })
      .join('');
    const textJobs = params.jobs.map((j) => `- ${j.title} · ${j.company} · ${j.remote ? v('remote') : (j.place ?? v('placeNotListed'))} · ${formatDigestPay(j.pay, t) ?? v('payNotListed')}\n  ${j.href}`).join('\n');
    const search = params.search || visitorText(t, 'visitor.email.searchAny');
    const p = { search, cadence: params.cadence };
    return {
      subject: v('subject', { count: params.total, search }),
      preheader: v('preheader'),
      reasonText: v('reason', p),
      bodyHtml:
        heading(v('heading', { count: params.total })) +
        paragraph(v('intro', p)) +
        `<ul style="padding-left:18px;margin:0 0 12px;">${htmlJobs}</ul>` +
        (rest > 0 ? paragraph(v('more', { count: rest })) : '') +
        paragraph(v('signup')) +
        button(v('signupCta'), params.signupUrl),
      bodyText: [v('heading', { count: params.total }), v('intro', p), textJobs, rest > 0 ? v('more', { count: rest }) : '', `${v('signup')} ${params.signupUrl}`].filter(Boolean).join('\n\n'),
    };
  },
});
