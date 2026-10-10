'use client';

// KitRow — one job on the Ready to apply list (PRODUCT F-AGENT-04/05).
//
// The job's title, company and place come from the list item itself (WP-52's
// `job` summary), so the list makes no read per row. Only when an item has no
// summary does the row read the job (shared cache with the job page). The fit
// label is the one the list sent with the row (`job.fit`), or the job read's
// when there is no summary; a row without either shows none. Nothing is
// filled in when it cannot be read.
// Actions follow the kit's real state only:
//   picked / failed     select for "Prepare kits" · Prepare · Skip
//   preparing           "Preparing…" (the list refreshes itself)
//   expired             "No longer listed" · Remove
//   ready / approved    Review kit
//   opened / applied    Applied · See in Applications
//   skipped             Put back · Remove
//
// A failed action shows a plain message in a toast (never a silent failure).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Btn, FitTierLabel, Pill, toast } from '../../v3/primitives';
import { useJob } from '../../../hooks/job';
import { canPrepare, jobSummaryOf, useKitActions, type KitAction, type ReadyQueueItem } from '../../../hooks/agent';
import { kitErrorKey } from './KitParts';
import { cn } from '../../../lib/utils';
import { STATE_TONE, applicationHref, kitHref } from './states';
import styles from './ready.module.css';

export interface KitRowProps {
  item: ReadyQueueItem;
  /** Show the selection box (To prepare tab). */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
  /** Prepare this one kit (opens the cost sheet). */
  onPrepare?: (id: string) => void;
}

export function KitRow({ item, selectable = false, selected = false, onSelect, onPrepare }: KitRowProps) {
  const t = useTranslations('ready');
  const summary = jobSummaryOf(item);
  const job = useJob(summary ? null : item.jobId);
  const actions = useKitActions(item.id);
  const title = summary?.title ?? job.data?.job.title ?? null;
  const company = (summary ? summary.companyName || null : job.data?.job.companyName) ?? null;
  const place = summary?.location ?? null;
  // The fit the list sent with the row, else the job read's (only made when the row has no summary).
  const fit = summary ? (summary.fit ?? null) : (job.data?.fit ?? null);
  const name = title ?? t('row.unknownJob');
  const showSelect = selectable && canPrepare(item.state);
  const run = async (action: Extract<KitAction, 'skip' | 'restore' | 'remove'>) => {
    try {
      await actions[action]();
    } catch (err) {
      toast({ message: t(kitErrorKey(err)), tone: 'warn' });
    }
  };

  return (
    <li className={cn(styles.kit, !selectable && styles.kitNoSelect)} data-testid="kit-row" data-state={item.state}>
      {selectable ? (
        showSelect ? (
          <label className={styles.check}>
            <input type="checkbox" checked={selected} onChange={(e) => onSelect?.(item.id, e.target.checked)} aria-label={t('row.select', { title: name })} />
          </label>
        ) : (
          <span className={styles.check} aria-hidden />
        )
      ) : null}
      <div className={styles.kitMain}>
        <p className={styles.kitTitle}>
          <Link href={kitHref(item.jobId)}>{!summary && job.isLoading ? t('row.loading') : name}</Link>
        </p>
        <p className={styles.kitMeta}>
          {company ? <span>{company}</span> : null}
          {place ? <span>{place}</span> : null}
          <Pill tone={STATE_TONE[item.state]}>{t(`state.${item.state}`)}</Pill>
          {fit ? <FitTierLabel tier={fit.tier} score={fit.score} /> : null}
          {item.missingFields.length > 0 ? <span>{t('row.missing', { count: item.missingFields.length })}</span> : null}
        </p>
      </div>
      <div className={styles.kitActions}>
        {canPrepare(item.state) ? (
          <>
            <Btn variant="ghost" onClick={() => void run('skip')} disabled={actions.pending !== null}>
              {t('row.skip')}
            </Btn>
            <Btn onClick={() => onPrepare?.(item.id)} disabled={actions.pending !== null}>
              {item.state === 'failed' ? t('row.retry') : t('row.prepare')}
            </Btn>
          </>
        ) : null}
        {item.state === 'preparing' ? <span className={styles.muted}>{t('row.preparingNote')}</span> : null}
        {item.state === 'skipped' ? (
          <Btn variant="ghost" onClick={() => void run('restore')} disabled={actions.pending !== null}>
            {t('row.restore')}
          </Btn>
        ) : null}
        {item.state === 'expired' || item.state === 'skipped' ? (
          <Btn variant="ghost" onClick={() => void run('remove')} disabled={actions.pending !== null}>
            {t('row.remove')}
          </Btn>
        ) : null}
        {item.state === 'ready_for_review' || item.state === 'approved' ? (
          <Link href={kitHref(item.jobId)} className="btn primary">
            {item.state === 'approved' ? t('row.reviewOpen') : t('row.review')}
          </Link>
        ) : null}
        {item.state === 'opened' || item.state === 'applied' ? (
          <Link href={applicationHref(item.trackerEntryId)} className="btn ghost">
            {t('row.seeApplication')}
          </Link>
        ) : null}
      </div>
    </li>
  );
}
