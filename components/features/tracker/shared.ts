'use client';

// components/features/tracker/shared.ts — small helpers shared by the
// /applications views and the detail drawer (WP-38).

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import { columnsFor, stageLabelKey, type PipelineColumnDef, type TrackerMarket } from '../../v3/pipeline/columns';

/** The stage columns of the current brand (RoboApply C1 ladder, GoApply cn ladder). */
export function useTrackerColumns(): { market: TrackerMarket; columns: PipelineColumnDef[] } {
  const market = useBrand().market as TrackerMarket;
  return useMemo(() => ({ market, columns: columnsFor(market) }), [market]);
}

/** `status → label` for the current brand's ladder. */
export function useStageLabel(): (status: string) => string {
  const t = useTranslations('applications');
  const { columns } = useTrackerColumns();
  return useCallback((status: string) => t(`columns.${stageLabelKey(status, columns)}`), [t, columns]);
}

export function entryCompany(e: Pick<TrackerEntryView, 'job' | 'externalSnapshot'>): string {
  return e.job?.companyName ?? e.externalSnapshot?.companyName ?? '';
}

export function entryRole(e: Pick<TrackerEntryView, 'job' | 'externalSnapshot'>): string {
  return e.job?.title ?? e.externalSnapshot?.title ?? '';
}

export function entryLink(e: Pick<TrackerEntryView, 'job' | 'externalSnapshot'>): string | null {
  return e.job?.applyUrl ?? e.externalSnapshot?.applyUrl ?? null;
}

/**
 * Two kinds of date reach the tracker under the same fields:
 *   · a moment ("applied" stamped when the user clicked: `2026-10-10T18:25:07.412Z`).
 *     It is shown in the reader's own time zone: at 02:25 on Oct 11 in Taipei
 *     that click happened on Oct 11, not on the UTC date Oct 10;
 *   · a calendar day the user picked in a date field, or the server sends as a
 *     day (`2026-10-11`, stored as UTC midnight `2026-10-11T00:00:00.000Z`).
 *     It has no time zone and is shown as that day everywhere.
 */
export function isDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00))?$/.test(iso);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a Date in the reader's own time zone. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The calendar day of a tracker date for the reader: a picked day as it is, a moment in the reader's zone. '' when unreadable. */
export function dayKeyOf(iso: string | null | undefined): string {
  if (!iso) return '';
  if (isDateOnly(iso)) return iso.slice(0, 10);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : localDayKey(d);
}

/** Date formatters in the UI locale: a calendar day as that day, a moment in the reader's time zone. */
export function useDateFormat() {
  const locale = useLocale();
  return useMemo(() => {
    const dayOpts = { year: 'numeric', month: 'short', day: 'numeric' } as const;
    // Calendar days are formatted from their UTC-midnight form; moments use the reader's zone (no `timeZone`).
    const calendarDay = new Intl.DateTimeFormat(locale, { ...dayOpts, timeZone: 'UTC' });
    const dayTime = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const safe = (fmt: Intl.DateTimeFormat) => (iso: string | null | undefined) => {
      if (!iso) return '—';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '—' : fmt.format(d);
    };
    const day = (iso: string | null | undefined) => {
      const key = dayKeyOf(iso);
      return key ? calendarDay.format(new Date(`${key}T00:00:00.000Z`)) : '—';
    };
    return { day, dayTime: safe(dayTime) };
  }, [locale]);
}

/** `YYYY-MM-DD` of a tracker date for `<input type="date">`: the day the reader sees (see `dayKeyOf`). */
export function toDateInput(iso: string | null | undefined): string {
  return dayKeyOf(iso);
}

/** Local `YYYY-MM-DDTHH:mm` of an ISO string (for <input type="datetime-local">). */
export function toDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${localDayKey(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** An `<input type="datetime-local">` value back to ISO (null when empty). */
export function fromDateTimeInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An `<input type="date">` value as a calendar day (UTC midnight; null when empty). */
export function fromDateInput(value: string): string | null {
  return value ? `${value}T00:00:00.000Z` : null;
}

/** Sunday that starts the week of a calendar day (`YYYY-MM-DD` in, `YYYY-MM-DD` out). */
export function weekStartOfDay(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dayKey;
  return new Date(d.getTime() - d.getUTCDay() * 86_400_000).toISOString().slice(0, 10);
}

/** The Sunday that starts the reader's current week, in their own time zone. */
export function localWeekStart(now: Date = new Date()): string {
  return weekStartOfDay(localDayKey(now));
}

const noSubscription = () => () => {};
function readBrowserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The reader's time zone (IANA name), the one every date on the page is shown
 * in. Null on the server and for the first client render, so the markup the
 * server sent is the markup the browser starts from.
 */
export function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(noSubscription, readBrowserTimeZone, () => null);
}

/**
 * Add the reader's time zone to a tracker link the server writes dates for
 * (the CSV), so the file carries the dates the page shows: the stored zone is
 * set once at signup and is missing on older accounts. A zone name is not
 * personal data; nothing else is added.
 */
export function withTimeZone(url: string, timeZone: string | null): string {
  if (!timeZone) return url;
  const [path, hash = ''] = url.split('#');
  return `${path}${path!.includes('?') ? '&' : '?'}tz=${encodeURIComponent(timeZone)}${hash ? `#${hash}` : ''}`;
}
