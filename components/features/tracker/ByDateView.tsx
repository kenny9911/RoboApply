'use client';

// ByDateView — /applications?view=date: the weekly card on top (ruling C40),
// then every application grouped by the week it was applied to (or saved, if
// not applied yet), newest first.

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import { EntryRow } from './EntryRow';
import { dayKeyOf, useDateFormat, weekStartOfDay } from './shared';
import { WeeklyInsightCard } from './WeeklyInsightCard';
import styles from './tracker.module.css';

export interface ByDateViewProps {
  entries: readonly TrackerEntryView[];
  onOpen: (id: string) => void;
}

/**
 * The Sunday that starts the week of a tracker date, counted in the reader's
 * own calendar: something applied at 02:25 on Sunday in Taipei belongs to the
 * week that starts that Sunday, not to the UTC week that ended hours later.
 */
export function weekOf(iso: string): string {
  return weekStartOfDay(dayKeyOf(iso) || iso.slice(0, 10));
}

export function groupByWeek(entries: readonly TrackerEntryView[]): Array<{ week: string; entries: TrackerEntryView[] }> {
  const key = (e: TrackerEntryView) => e.dateApplied ?? e.dateSaved;
  const sorted = [...entries].sort((a, b) => key(b).localeCompare(key(a)));
  const groups = new Map<string, TrackerEntryView[]>();
  for (const e of sorted) {
    const w = weekOf(key(e));
    groups.set(w, [...(groups.get(w) ?? []), e]);
  }
  return [...groups.entries()].map(([week, list]) => ({ week, entries: list }));
}

export function ByDateView({ entries, onOpen }: ByDateViewProps) {
  const t = useTranslations('applications');
  const { day } = useDateFormat();
  const groups = useMemo(() => groupByWeek(entries), [entries]);
  return (
    <div>
      <WeeklyInsightCard entries={entries} />
      {groups.length === 0 ? <p className={styles.muted}>{t('date_view.empty')}</p> : null}
      {groups.map((g) => (
        <section key={g.week} className={styles.group} aria-label={t('date_view.week_of', { date: day(g.week) })}>
          <h3 className={styles.groupTitle}>{t('date_view.week_of', { date: day(g.week) })}</h3>
          <ul className={styles.rows}>
            {g.entries.map((e) => (
              <EntryRow key={e.id} entry={e} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
