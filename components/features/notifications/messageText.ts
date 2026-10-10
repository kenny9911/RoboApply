'use client';

// messageText — the localized title/body of one inbox message (ARCHITECTURE.md §8.3).
//
// Producers store a `templateKey` + ICU `params` and an English title/body as
// fallbacks. The client renders `inbox.templates.<templateKey>.{title,body}`
// when that key exists AND every argument it names is present in `params`;
// otherwise the stored text. Nothing is invented: a template that would need
// a missing number falls back to what the producer wrote.
//
// Some templates name a value the stored params only hold in machine form (an
// ISO time, a class label). `DERIVED_PARAMS` turns those into display values
// in the reader's language; when the stored value cannot be read, the derived
// argument is simply absent and the message falls back to the stored text.
//   campus.deadline   closesAt (ISO) → {closesDay} "Oct 31", {closes} "Oct 31, 23:59",
//                     both in the time zone the producer stored (Beijing time)
//   campus.followed   graduationClass "2027届" → {classYear} "2027"

import { useCallback } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { NotificationView } from '../../../lib/api/contracts/notifications';

const KEY_RE = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const ARG_RE = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\}|,\s*(?:plural|select|selectordinal|number|date|time)\b)/g;

/** Top-level and nested ICU argument names in a message (`{count, plural, …}`, `{company}`). */
export function icuArguments(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(ARG_RE)) out.add(m[1]!);
  return [...out];
}

type Params = Record<string, string | number | Date>;

function icuParams(params: Record<string, unknown> | null): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

export interface MessageText {
  title: string;
  body: string | null;
}

/** The date shapes the derived params use (a day, or a day with a 24-hour time), always in a named time zone. */
interface DisplayDateOptions {
  timeZone: string;
  month: 'short';
  day: 'numeric';
  hour?: '2-digit';
  minute?: '2-digit';
  hourCycle?: 'h23';
}
type DateFormatter = (date: Date, options: DisplayDateOptions) => string;

/** The campus calendar states every deadline in Beijing time. */
const CAMPUS_TIME_ZONE = 'Asia/Shanghai';

/** "2027届" → "2027" (a string, so no locale adds a thousands separator); null when there is no year. */
export function classYearOf(graduationClass: unknown): string | null {
  const m = typeof graduationClass === 'string' ? /(20\d{2})/.exec(graduationClass) : null;
  return m ? m[1]! : null;
}

/** Display values a template needs that the stored params hold in machine form. Never invents one. */
export const DERIVED_PARAMS: Readonly<Record<string, (raw: Record<string, unknown>, formatDate: DateFormatter) => Params>> = {
  'campus.deadline': (raw, formatDate): Params => {
    const at = typeof raw.closesAt === 'string' ? new Date(raw.closesAt) : null;
    if (!at || Number.isNaN(at.getTime())) return {};
    const timeZone = typeof raw.timeZone === 'string' && raw.timeZone ? raw.timeZone : CAMPUS_TIME_ZONE;
    return {
      closesDay: formatDate(at, { timeZone, month: 'short', day: 'numeric' }),
      closes: formatDate(at, { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    };
  },
  'campus.followed': (raw): Params => {
    const classYear = classYearOf(raw.graduationClass);
    return classYear ? { classYear } : {};
  },
};

/** One job an alert message is about (the producer's `params.jobs` card). */
export interface MessageJob {
  id: string;
  title: string;
  company: string | null;
  /** In-app link to that job (`/jobs/<id>?…`); never an outside address. */
  href: string;
}

/** Jobs shown under a message; the rest are counted, not listed. */
export const MAX_MESSAGE_JOBS = 5;

/**
 * The jobs a message lists (job alerts store them in `params.jobs`), read
 * defensively: an entry without a title, or whose link is not one of our own
 * job pages, is left out. Nothing is fetched or invented.
 */
export function messageJobs(n: Pick<NotificationView, 'params'>): MessageJob[] {
  const raw = (n.params as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(raw)) return [];
  const out: MessageJob[] = [];
  const seen = new Set<string>();
  for (const j of raw) {
    if (!j || typeof j !== 'object') continue;
    const { id, title, company, href } = j as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim()) continue;
    const link = typeof href === 'string' && /^\/jobs\/[^/?#\s]+(?:[?#]\S*)?$/.test(href) ? href : typeof id === 'string' && /^[\w-]+$/.test(id) ? `/jobs/${encodeURIComponent(id)}` : null;
    if (!link) continue;
    const key = typeof id === 'string' && id ? id : link;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: key, title: title.trim(), company: typeof company === 'string' && company.trim() ? company.trim() : null, href: link });
  }
  return out;
}

export function useMessageText(): (n: NotificationView) => MessageText {
  const t = useTranslations('inbox');
  const format = useFormatter();
  return useCallback(
    (n: NotificationView) => {
      const fallbackTitle = n.title ?? t(`categories.${n.category}`);
      const params = icuParams(n.params);
      // "{count} new jobs": the number of jobs the message itself lists, when the producer did not store it.
      const listed = Array.isArray((n.params as { jobs?: unknown } | null)?.jobs) ? (n.params as { jobs: unknown[] }).jobs.length : 0;
      if (listed > 0 && !('count' in params)) params.count = listed;
      const derive = n.templateKey ? DERIVED_PARAMS[n.templateKey] : undefined;
      if (derive && n.params) {
        try {
          Object.assign(params, derive(n.params, (date, options) => format.dateTime(date, options)));
        } catch {
          /* an unreadable stored value: the template falls back to the stored text */
        }
      }
      const render = (part: 'title' | 'body'): string | null => {
        if (!n.templateKey || !KEY_RE.test(n.templateKey)) return null;
        const key = `templates.${n.templateKey}.${part}`;
        if (!t.has(key)) return null;
        const raw = t.raw(key);
        if (typeof raw !== 'string') return null;
        if (icuArguments(raw).some((a) => !(a in params))) return null;
        try {
          return t(key, params);
        } catch {
          return null;
        }
      };
      const title = render('title');
      // Template and stored text are never mixed: a templated title gets its templated body.
      if (title) return { title, body: render('body') ?? null };
      return { title: fallbackTitle, body: n.body };
    },
    [t, format],
  );
}
