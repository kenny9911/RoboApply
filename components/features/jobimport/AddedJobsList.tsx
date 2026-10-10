'use client';

// AddedJobsList — the user's "Added by you" jobs (WP-35; F-TRK-04). Real
// records only: unknown values say so ("Location not listed"); the source line
// is the host of the link the user gave, or "Typed in by you". Each job has
// the same next steps as any job: View job (the fit score lives on the job
// page), Save to tracker (until it is tracked; then its status shows), Tailor
// resume, Practice interview — and Remove.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, EmptyState } from '../../v3/primitives';
import { jobHref } from '../../v3/shell/destinations';
import { tailorHref } from '../../../hooks/shared/useLaunchTailor';
import { practiceHref } from '../../../hooks/shared/useLaunchPractice';
import { useAddedJobs, useRemoveAddedJob } from '../../../hooks/jobimport/useJobImport';
import type { AddedJobItem } from '../../../lib/api/contracts/jobs/import';
import { ImportWarnings } from './ImportWarnings';
import { TrackJobButton } from './TrackJobButton';
import styles from './JobImport.module.css';

const STATUS_KEYS = new Set(['bookmarked', 'applying', 'applied', 'interviewing', 'negotiating', 'accepted', 'rejected', 'withdrawn']);

function AddedJobRow({ item }: { item: AddedJobItem }) {
  const t = useTranslations('jobImport');
  const format = useFormatter();
  const remove = useRemoveAddedJob();
  const [confirming, setConfirming] = useState(false);
  const added = new Date(item.addedAt);

  return (
    <li className={styles.item} data-job-id={item.jobId}>
      <div className={styles.itemTop}>
        <div>
          <h3 className={styles.itemTitle}>{item.title}</h3>
          <p className={styles.itemCompany}>{item.companyName}</p>
        </div>
        {item.trackerStatus && STATUS_KEYS.has(item.trackerStatus) ? (
          <span className={styles.status}>{t(`list.status.${item.trackerStatus}` as 'list.status.applied')}</span>
        ) : null}
      </div>
      <ul className={styles.facts}>
        <li>{item.location ?? t('list.locationUnknown')}</li>
        <li>{item.sourceHost ? t('list.fromHost', { host: item.sourceHost }) : t('list.typed')}</li>
        {Number.isNaN(added.getTime()) ? null : <li>{t('list.added', { date: format.dateTime(added, { dateStyle: 'medium' }) })}</li>}
      </ul>
      {item.warnings.length ? <ImportWarnings warnings={item.warnings} /> : null}
      {confirming ? (
        <div className={styles.confirm} role="group" aria-label={t('actions.confirmRemove')}>
          <span className={styles.sub}>{t('actions.confirmRemove')}</span>
          <Btn
            variant="primary"
            disabled={remove.isPending}
            onClick={() => remove.mutate(item.jobId, { onSettled: () => setConfirming(false) })}
          >
            {t('actions.confirmRemoveYes')}
          </Btn>
          <Btn variant="ghost" onClick={() => setConfirming(false)}>
            {t('actions.cancel')}
          </Btn>
        </div>
      ) : (
        <div className={styles.actions}>
          <Btn as="a" href={jobHref(item.jobId)} variant="primary">
            {t('actions.view')}
          </Btn>
          <TrackJobButton jobId={item.jobId} trackerStatus={item.trackerStatus} title={item.title} />
          <Btn as="a" href={tailorHref({ jobId: item.jobId, from: 'job_import' })}>
            {t('actions.tailor')}
          </Btn>
          <Btn as="a" href={practiceHref({ jobId: item.jobId, from: 'job_import' })}>
            {t('actions.practice')}
          </Btn>
          <Btn variant="ghost" onClick={() => setConfirming(true)} aria-label={t('actions.removeAria', { title: item.title })}>
            {t('actions.remove')}
          </Btn>
        </div>
      )}
      {remove.isError ? (
        <p className={styles.fieldError} role="alert">
          {t('list.removeFailed')}
        </p>
      ) : null}
    </li>
  );
}

export function AddedJobsList() {
  const t = useTranslations('jobImport');
  const query = useAddedJobs();
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className={styles.form} aria-labelledby="added-jobs-heading" aria-busy={query.isLoading || undefined}>
      <h2 id="added-jobs-heading" className={styles.heading}>
        {t('list.heading')}
      </h2>
      {query.isLoading ? (
        <p className={styles.meta} role="status">
          {t('list.loading')}
        </p>
      ) : query.isError ? (
        <div className={styles.actions}>
          <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
            {t('list.error')}
          </p>
          <Btn onClick={() => void query.refetch()}>{t('list.retry')}</Btn>
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={t('list.emptyTitle')} sub={t('list.emptySub')} />
      ) : (
        <>
          <ul className={styles.list}>
            {items.map((item) => (
              <AddedJobRow key={item.jobId} item={item} />
            ))}
          </ul>
          {query.hasNextPage ? (
            <Btn className={styles.loadMore} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {t('actions.loadMore')}
            </Btn>
          ) : null}
        </>
      )}
    </section>
  );
}
