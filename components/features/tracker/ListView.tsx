'use client';

// ListView — /applications?view=list: search and a stage filter over the
// loaded applications (the 200 most recently changed). The stage counts and
// the total come from the server's counts, so they cover every application;
// when not all of them are loaded the view says so.
// The Saved stage separates postings that are still open from ones the
// company closed or removed (PRODUCT F-TRK-01).

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import { columnIndexForStatus } from '../../v3/pipeline/columns';
import { EntryRow } from './EntryRow';
import { useTrackerColumns } from './shared';
import styles from './tracker.module.css';

export interface ListViewProps {
  entries: readonly TrackerEntryView[];
  onOpen: (id: string) => void;
  /** Server counts per status (all of the user's applications, not only the loaded ones). */
  statusCounts?: Record<string, number>;
  /** Server total (all of the user's applications). */
  total?: number;
  /** Initial stage filter (a column's status, e.g. `bookmarked` for `?status=saved`). */
  initialStage?: string;
}

function matches(e: TrackerEntryView, q: string): boolean {
  if (!q) return true;
  const hay = [e.job?.title, e.job?.companyName, e.externalSnapshot?.title, e.externalSnapshot?.companyName, e.notesMarkdown]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function ListView({ entries, statusCounts, total, onOpen, initialStage = '' }: ListViewProps) {
  const t = useTranslations('applications');
  const { columns } = useTrackerColumns();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState(initialStage);
  const ids = useId();

  const shown = useMemo(() => {
    const stageIdx = stage ? columns.findIndex((c) => c.status === stage) : -1;
    return [...entries]
      .filter((e) => stageIdx < 0 || columnIndexForStatus(e.status, columns) === stageIdx)
      .filter((e) => matches(e, q.trim()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [entries, q, stage, columns]);

  const counts = useMemo(
    () =>
      columns.map((c, i) =>
        statusCounts
          ? c.members.reduce((n, m) => n + (statusCounts[m] ?? 0), 0)
          : entries.filter((e) => columnIndexForStatus(e.status, columns) === i).length,
      ),
    [entries, columns, statusCounts],
  );
  const allCount = Math.max(total ?? entries.length, entries.length);
  const partial = allCount > entries.length;
  const savedSplit = stage === 'bookmarked';
  const open = savedSplit ? shown.filter((e) => !e.job?.closed) : shown;
  const closed = savedSplit ? shown.filter((e) => e.job?.closed) : [];

  return (
    <div>
      <div className={styles.filters}>
        <label className={styles.field} htmlFor={`${ids}-q`}>
          <span className={styles.label}>{t('list.search_label')}</span>
          <input id={`${ids}-q`} className={styles.input} type="search" value={q} placeholder={t('list.search_placeholder')} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className={styles.field} htmlFor={`${ids}-stage`}>
          <span className={styles.label}>{t('list.status_label')}</span>
          <select id={`${ids}-stage`} className={styles.input} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{`${t('list.status_all')} (${allCount})`}</option>
            {columns.map((c, i) => (
              <option key={c.status} value={c.status}>
                {`${t(`columns.${c.labelKey}`)} (${counts[i]})`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.hint} role="status">
        {t('list.count', { shown: shown.length, total: allCount })}
      </p>
      {partial ? <p className={styles.hint}>{t('list.partial', { loaded: entries.length, total: allCount })}</p> : null}
      {shown.length === 0 ? <p className={styles.muted}>{t('list.no_results')}</p> : null}
      {open.length > 0 ? (
        <section className={styles.group} aria-label={savedSplit ? t('list.saved_open') : t('list.status_all')}>
          {savedSplit ? <h3 className={styles.groupTitle}>{t('list.saved_open')}</h3> : null}
          <ul className={styles.rows}>
            {open.map((e) => (
              <EntryRow key={e.id} entry={e} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ) : null}
      {closed.length > 0 ? (
        <section className={styles.group} aria-label={t('list.saved_closed')}>
          <h3 className={styles.groupTitle}>{t('list.saved_closed')}</h3>
          <p className={styles.hint}>{t('list.saved_closed_note')}</p>
          <ul className={styles.rows}>
            {closed.map((e) => (
              <EntryRow key={e.id} entry={e} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
