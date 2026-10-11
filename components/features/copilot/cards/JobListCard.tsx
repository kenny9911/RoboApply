'use client';

// job_list — jobs a tool returned (search_jobs, top_fit_jobs, added_jobs). Ids
// come only from tool results (server guard). Fit is the tier word, never a
// chance of being hired; pay is what the post lists, with its unit ("a year",
// "an hour"), or "Pay not listed" (D3). A unit the post did not state is never
// shown (model.payOf keeps only the post's own text then).
//
// The card is the list the answer talks about, so each row shows what the
// list was made by: the work model next to the place (a remote job whose post
// names a city is still "Remote"), and "Added by you" for the user's own
// jobs. A job whose pay was not read (the user's own added jobs) shows no pay
// line at all: "Pay not listed" is only said of a post that was read.

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { useBrand } from '../../../../lib/brand';
import { FitTierLabel, HonestyLine } from '../../../v3/primitives';
import { payText } from '../../feed';
import { jobDetailHref } from '../../job';
import { CardFrame } from './CardFrame';
import { parseJobList } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function JobListCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.jobList');
  const locale = useLocale();
  const brand = useBrand();
  const data = parseJobList(card.data);
  if (!data || data.items.length === 0) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <ul className={styles.cardList}>
        {data.items.map((job) => {
          const pay = payText(job.pay, {
            locale,
            market: brand.market,
            range: (min, max) => t('range', { min, max }),
            from: (amount) => t('from', { amount }),
            upTo: (amount) => t('upTo', { amount }),
          });
          return (
            <li key={job.jobId} className={styles.jobRow} data-job={job.jobId}>
              <Link href={jobDetailHref(job.jobId)} className={styles.jobLink} onClick={ctx.onNavigate}>
                {job.title}
              </Link>
              <div className={styles.jobMeta}>
                {job.company ? <span>{job.company}</span> : null}
                {job.location ? <span>{job.location}</span> : null}
                {job.workModel ? <span data-work-model={job.workModel}>{t(`workModel.${job.workModel}`)}</span> : null}
                {job.addedByUser ? <span data-added="true">{t('addedByYou')}</span> : null}
                {pay || job.payKnown ? <span>{pay ? (pay.period ? t(`payPeriod.${pay.period}`, { amount: pay.amount }) : pay.amount) : t('payNotListed')}</span> : null}
                {job.tier || job.score !== null ? <FitTierLabel tier={job.tier} score={job.score} estimate={job.estimate} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {data.items.some((j) => j.tier || j.score !== null) ? <HonestyLine kind="fit" /> : null}
      <Link href="/jobs" className={styles.link} onClick={ctx.onNavigate}>
        {t('seeAll')}
      </Link>
    </CardFrame>
  );
}
