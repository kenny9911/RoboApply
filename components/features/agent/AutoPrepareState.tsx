'use client';

// AutoPrepareState — what "Prepare my weekly list automatically" did, in the
// past tense and from the server's real counts (rulings C38, D3), on the
// Getting ready page and in the Dashboard's Applications lane
// (docs/agent-driven/REDESIGN.md §9):
//
//   this week's run    "This week's list was prepared automatically on {date}:
//                      N applications used your weekly allowance." Then, when
//                      jobs were left, how many and why (the credit that ran
//                      out, or that they could not be started).
//   on, no run yet     "Your weekly list is prepared automatically when jobs are
//                      added to it."
//   off                nothing, unless this week's list was prepared before it
//                      was turned off (the run stays true; "It is off now").
//
// Nothing is drawn while the view is not known: no line is guessed.

import { useFormatter, useTranslations } from 'next-intl';

import type { AutoPrepareView } from '../../../lib/api/agent';
import styles from './ready.module.css';

export interface AutoPrepareStateProps {
  /** GET /agent/auto-prepare; null or undefined while it is not known (nothing is drawn). */
  view: AutoPrepareView | null | undefined;
}

export function AutoPrepareState({ view }: AutoPrepareStateProps) {
  const t = useTranslations('ready');
  const format = useFormatter();
  if (!view) return null;
  // Only this week's run is reported (an earlier week's allowance has reset since).
  const at = view.lastRun?.thisWeek ? new Date(view.lastRun.at) : null;
  const date = at && !Number.isNaN(at.getTime()) ? format.dateTime(at, { weekday: 'short', month: 'short', day: 'numeric' }) : null;
  const run = date ? view.lastRun : null;
  if (!view.on && !run) return null;

  return (
    <div className={styles.stackTight} data-testid="auto-prepare-state" data-on={view.on ? 'true' : 'false'}>
      {run && date ? (
        <p className={styles.muted}>{run.started > 0 ? t('auto.state.ran', { date, count: run.started }) : t('auto.state.ranNone', { date })}</p>
      ) : (
        <p className={styles.muted}>{t('auto.state.waiting')}</p>
      )}
      {run && run.left > 0 && run.stoppedBy ? <p className={styles.muted}>{t(`auto.state.stopped.${run.stoppedBy}`, { count: run.left })}</p> : null}
      {!view.on ? <p className={styles.muted}>{t('auto.state.offNow')}</p> : null}
    </div>
  );
}
