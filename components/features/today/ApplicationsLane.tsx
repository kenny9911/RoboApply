'use client';

// ApplicationsLane — the "Applications" lane of /today (docs/agent-driven/REDESIGN.md §5.4).
//
// Real counts only (ruling D3), each "—" until its own read has answered:
//   Being prepared    the list's `preparing` items            (Ready to apply)
//   Waiting for you   `ready_for_review` + `approved`         (Ready to apply; the nav badge's rule)
//   Sent this week    marked applied in the reader's week     (the tracker; the weeks /applications groups by)
// Then what "Prepare my weekly list automatically" did this week, when it is on
// or ran (AutoPrepareState: the run's date and how many used the allowance,
// the server's real counts; nothing while it is not known), the week's
// allowance (KitAllowance), "You submit each application yourself." and the
// way to the applications.
//
// Without Ready to apply (flag `agent` off) there are no kits to count: the
// lane shows the tracker's own numbers (Saved · Sent this week) and no allowance.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { HonestyLine } from '../../v3/primitives';
import type { Loadable, TodayFlags, TodaySources } from '../../../hooks/today';
import { AutoPrepareState, KitAllowance } from '../agent';
import { Count, FailedNote, Lane } from './parts';
import { applicationNumbers } from './todayModel';
import styles from './today.module.css';

export interface ApplicationsLaneProps {
  flags: TodayFlags;
  queue: TodaySources['queue'];
  board: TodaySources['board'];
  /** "Prepare my weekly list automatically" and its latest run; left out = not shown. */
  autoPrepare?: TodaySources['autoPrepare'];
  /** For "this week"; injectable for tests. */
  now?: Date;
}

export function ApplicationsLane({ flags, queue, board, autoPrepare, now }: ApplicationsLaneProps) {
  const t = useTranslations('today');
  const numbers = applicationNumbers({ queue, board }, now);
  const failures = [queue, board].filter((r): r is Extract<Loadable<unknown>, { status: 'error' }> => r.status === 'error');
  const rows: Array<{ key: string; label: string; value: number | null }> = flags.agent
    ? [
        { key: 'preparing', label: t('applications.preparing'), value: numbers.preparing },
        { key: 'waiting', label: t('applications.waiting'), value: numbers.waiting },
        { key: 'sent', label: t('applications.sent'), value: numbers.sentThisWeek },
      ]
    : [
        { key: 'saved', label: t('applications.saved'), value: numbers.saved },
        { key: 'sent', label: t('applications.sent'), value: numbers.sentThisWeek },
      ];

  return (
    <Lane title={t('applications.title')} agent={flags.agent} busy={queue.status === 'loading' || board.status === 'loading'} testId="today-applications">
      {flags.ready ? (
        <dl className={styles.numbers} aria-label={t('applications.numbersLabel')}>
          {rows.map((row) => (
            <div key={row.key} className={styles.number} data-testid={`today-number-${row.key}`}>
              <dt>{row.label}</dt>
              <dd>
                <Count value={row.value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        // Which numbers this account has is not known yet (the flags fail closed while they load).
        <div className={styles.skeletonRow} aria-hidden="true" />
      )}

      {failures.length > 0 ? <FailedNote message={t('applications.failed')} onRetry={() => failures.forEach((f) => f.retry())} /> : null}

      {flags.agent && autoPrepare?.status === 'ready' ? <AutoPrepareState view={autoPrepare.data} /> : null}
      {flags.agent ? <KitAllowance /> : null}
      <HonestyLine kind="you_submit" />

      <div className={styles.laneFoot}>
        <Link href="/applications" className="btn">
          {t('applications.open')}
        </Link>
      </div>
    </Lane>
  );
}
