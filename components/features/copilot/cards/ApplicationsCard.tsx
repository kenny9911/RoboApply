'use client';

// applications — the user's own tracker counts and follow-ups
// (application_summary). These are the user's own records, not market data.
//
// Status labels follow the tracker's vocabulary (server/src/features/tracker/
// contract.ts ALL_TRACKER_STATUSES, folded like the /applications board in
// components/v3/pipeline/columns.ts): `bookmarked` is "Saved", legacy
// `applying` counts as Applied and `negotiating`/`accepted` as Offer. Rows
// that share a label are summed, in ladder order; a status the tracker does
// not know is counted under "Other".

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import type { TrackerStatus } from '../../../../lib/api/contracts/tracker';
import { shortDate } from '../../feed';
import { jobDetailHref } from '../../job';
import { CardFrame } from './CardFrame';
import { parseApplications } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

/** Tracker status → label key under `assistant.cards.applications.status.*`, in ladder order. */
export const STATUS_LABEL: Readonly<Record<TrackerStatus, string>> = {
  bookmarked: 'saved',
  applying: 'applied',
  applied: 'applied',
  first_call: 'first_call',
  assessment: 'assessment',
  written_test: 'written_test',
  ai_interview: 'ai_interview',
  interviewing: 'interviewing',
  final_round: 'final_round',
  offer: 'offer',
  negotiating: 'offer',
  accepted: 'offer',
  signed: 'signed',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  closed: 'closed',
};
const LABEL_ORDER = [...new Set(Object.values(STATUS_LABEL)), 'other'];

/** Sum counts per label, in ladder order, unknown statuses under "other". Pure. */
export function countsByLabel(counts: Array<{ status: string; count: number }>): Array<{ label: string; count: number }> {
  const sums = new Map<string, number>();
  for (const c of counts) {
    const label = (STATUS_LABEL as Partial<Record<string, string>>)[c.status] ?? 'other';
    sums.set(label, (sums.get(label) ?? 0) + c.count);
  }
  return LABEL_ORDER.filter((l) => sums.has(l)).map((label) => ({ label, count: sums.get(label)! }));
}

export function ApplicationsCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.applications');
  const locale = useLocale();
  const data = parseApplications(card.data);
  if (!data) return null;
  const rows = countsByLabel(data.counts);
  return (
    <CardFrame card={card} title={t('title')}>
      {rows.length ? (
        <ul className={styles.counts}>
          {rows.map((r) => (
            <li key={r.label} className={styles.count}>
              {t(`status.${r.label}`)}: {r.count}
            </li>
          ))}
        </ul>
      ) : null}
      {data.followUps.length ? (
        <>
          <h4 className={styles.subTitle}>{t('followUps')}</h4>
          <ul className={styles.cardList}>
            {data.followUps.map((f) => {
              const due = shortDate(f.dueAt, locale);
              return (
                <li key={f.jobId} className={styles.jobRow}>
                  <Link href={jobDetailHref(f.jobId)} className={styles.jobLink} onClick={ctx.onNavigate}>
                    {f.title}
                  </Link>
                  <span className={styles.jobMeta}>
                    {f.company ? <span>{f.company}</span> : null}
                    {due ? <span>{t('due', { date: due })}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <Link href="/applications" className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
