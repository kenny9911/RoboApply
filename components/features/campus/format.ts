// components/features/campus/format.ts — pure helpers of the campus calendar
// UI (WP-58). Dates render in Beijing time: the official pages state them so.

import type { CampusEventView } from '../../../lib/api/contracts/cn/campus';

export const CAMPUS_TIME_ZONE = 'Asia/Shanghai';
/** 届别 the contract accepts (ListCampusEventsQuerySchema / the draft regex). */
export const CLASS_YEARS = [2025, 2026, 2027, 2028, 2029, 2030] as const;
export const STAGE_KINDS = ['wangshen', 'ceping', 'bishi', 'mianshi', 'offer', 'info_session'] as const;
export const EVENT_KINDS = ['application', 'test', 'interview', 'info_session'] as const;

/** '2027届' → 2027. */
export function yearOfClass(cls: string | null | undefined): number | null {
  const m = /^(20\d\d)届$/.exec(cls ?? '');
  return m ? Number(m[1]) : null;
}

export type WindowState = 'open' | 'not_yet' | 'closed' | 'unknown';

/** Where a programme's 网申 window stands now (unknown = no close date stated). */
export function windowState(ev: Pick<CampusEventView, 'applyOpensAt' | 'applyClosesAt'>, now: Date): WindowState {
  const closes = ev.applyClosesAt ? Date.parse(ev.applyClosesAt) : NaN;
  if (Number.isNaN(closes)) {
    const opens = ev.applyOpensAt ? Date.parse(ev.applyOpensAt) : NaN;
    return !Number.isNaN(opens) && opens > now.getTime() ? 'not_yet' : 'unknown';
  }
  if (closes < now.getTime()) return 'closed';
  const opens = ev.applyOpensAt ? Date.parse(ev.applyOpensAt) : NaN;
  if (!Number.isNaN(opens) && opens > now.getTime()) return 'not_yet';
  return 'open';
}

/** Only http(s) links are rendered. */
export function safeExternal(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Split an admin list field on commas (ASCII or Chinese), 、, semicolons or new lines. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO → `YYYY-MM-DDTHH:mm` in Beijing time (for <input type="datetime-local">). */
export function toBeijingLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `YYYY-MM-DDTHH:mm` (Beijing) → ISO, or undefined when empty/invalid. */
export function fromBeijingLocal(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const t = Date.parse(`${value}:00+08:00`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** `/campus/[company]` href. */
export function companyHref(slug: string): string {
  return `/campus/${encodeURIComponent(slug)}`;
}
