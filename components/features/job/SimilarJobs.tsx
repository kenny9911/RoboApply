'use client';

// SimilarJobs — same role family and country, best fit first (PRODUCT F-JOB-05).
// Fit is the deterministic quick estimate from the batch (no per-card score
// requests); unknown fit renders "—", never 0, and any score carries the
// honesty line under the list. Pay keeps the post's own period (weekly too)
// or its words; only pay the post doesn't state renders "Pay not listed".
// The caller renders this only while `jobs.recommendations` is on (R-14).

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { HonestyLine } from '../../v3/primitives';
import { useSimilarJobs } from '../../../hooks/job';
import type { SimilarJobItem } from '../../../lib/api/contracts/jobs/detail';
import { jobDetailHref, payLine } from './format';
import styles from './job.module.css';

export { jobDetailHref };

function SimilarCard({ item, onOpen }: { item: SimilarJobItem; onOpen?: (jobId: string) => void }) {
  const t = useTranslations('jobDetail');
  const locale = useLocale();
  const pay = payLine(item.pay, locale);
  const period = pay ? t(`header.period.${pay.period}`) : '';
  const payText = !pay
    ? item.payText
      ? t('header.payAsStated', { text: item.payText })
      : t('header.payNotListed')
    : pay.kind === 'exact'
      ? t('header.payExact', { amount: pay.amount, period })
      : pay.kind === 'range'
        ? t('header.payRange', { min: pay.min, max: pay.max, period })
        : pay.kind === 'from'
          ? t('header.payFrom', { min: pay.min, period })
          : t('header.payUpTo', { max: pay.max, period });
  const fit = item.fit
    ? `${t('similar.fit', { tier: item.fit.tier, score: item.fit.score })}${item.fit.kind === 'pre' ? ` · ${t('similar.quickEstimate')}` : ''}`
    : t('similar.noScore');
  return (
    <li>
      <Link
        className={styles.card}
        href={jobDetailHref(item.jobId)}
        onClick={(e) => {
          if (onOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
            e.preventDefault();
            onOpen(item.jobId);
          }
        }}
        data-job-id={item.jobId}
      >
        <span className={styles.cardMeta}>{item.company.name}</span>
        <span className={styles.cardTitle}>{item.title}</span>
        {item.location ? <span className={styles.cardMeta}>{item.location}</span> : null}
        <span className={styles.cardMeta} data-similar-pay>
          {payText}
        </span>
        <span className={styles.cardMeta}>{fit}</span>
        {item.tracker ? <span className={styles.cardMeta}>{t('similar.inApplications')}</span> : null}
      </Link>
    </li>
  );
}

export function SimilarJobs({ jobId, title, onOpen }: { jobId: string; title?: string; onOpen?: (jobId: string) => void }) {
  const t = useTranslations('jobDetail.similar');
  const q = useSimilarJobs(jobId);
  return (
    <section className={styles.section} aria-label={title ?? t('title')} data-testid="similar-jobs">
      <h2 className={styles.sectionTitle}>{title ?? t('title')}</h2>
      {q.isPending ? (
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      ) : q.isError ? (
        <p className={styles.alert} role="alert">
          {t('error')}
        </p>
      ) : q.data.items.length ? (
        <>
          <ul className={styles.cards}>
            {q.data.items.map((item) => (
              <SimilarCard key={item.jobId} item={item} onOpen={onOpen} />
            ))}
          </ul>
          {q.data.items.some((item) => item.fit) ? <HonestyLine kind="fit" /> : null}
        </>
      ) : (
        <p className={styles.muted}>{t('empty')}</p>
      )}
    </section>
  );
}
