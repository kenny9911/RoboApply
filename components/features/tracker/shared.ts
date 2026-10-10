'use client';

// components/features/tracker/shared.ts — small helpers shared by the
// /applications views and the detail drawer (WP-38).

import { useCallback, useMemo } from 'react';
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

/** Date formatters in the UI locale (UTC for date-only values). */
export function useDateFormat() {
  const locale = useLocale();
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const dayTime = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const safe = (fmt: Intl.DateTimeFormat) => (iso: string | null | undefined) => {
      if (!iso) return '—';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '—' : fmt.format(d);
    };
    return { day: safe(day), dayTime: safe(dayTime) };
  }, [locale]);
}

/** `YYYY-MM-DD` of an ISO string (for <input type="date">). */
export function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Local `YYYY-MM-DDTHH:mm` of an ISO string (for <input type="datetime-local">). */
export function toDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** An `<input type="datetime-local">` value back to ISO (null when empty). */
export function fromDateTimeInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An `<input type="date">` value to an ISO instant at UTC midnight (null when empty). */
export function fromDateInput(value: string): string | null {
  return value ? `${value}T00:00:00.000Z` : null;
}
