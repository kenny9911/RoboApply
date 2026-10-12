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
//
// Follow-ups are the tracker's own facts (`FollowUpView`: no reply for N days,
// the follow-up date the user set, an interview within 24 h, a deadline in N
// days), worded exactly like the /applications "Needs your attention" list.
// Each one links to its own application: `/applications?entry=<entryId>` opens
// that entry's details (an id that no longer exists is ignored by the page).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { TrackerStatus } from '../../../../lib/api/contracts/tracker';
import { CardFrame } from './CardFrame';
import { followUpHref, parseApplications, type ApplicationsData } from './model';
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
  const tApps = useTranslations('applications.follow_ups');
  const data = parseApplications(card.data);
  if (!data) return null;
  const rows = countsByLabel(data.counts);
  const followUp = (f: ApplicationsData['followUps'][number]) => {
    const name = f.company || f.title || tApps('unnamed');
    switch (f.reason) {
      case 'no_reply_10d':
        return tApps('no_reply_item', { name, days: f.days ?? 10 });
      case 'follow_up_due':
        return tApps('follow_up_due_item', { name });
      case 'interview_tomorrow':
        return tApps('interview_item', { name });
      case 'deadline_soon':
        return tApps('deadline_item', { name, days: f.days ?? 0 });
    }
  };
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
            {data.followUps.map((f) => (
              <li key={`${f.entryId}-${f.reason}`} className={styles.jobRow}>
                <Link href={followUpHref(f.entryId)} className={styles.link} onClick={ctx.onNavigate} data-entry={f.entryId}>
                  {followUp(f)}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Link href="/applications" className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
