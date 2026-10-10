'use client';

// JobsAddedPage — /jobs/added, "Added by you" (WP-35; PRODUCT_PLAN.md
// F-TRK-04, §3.4). Add a job from a link or by hand, then the list of the
// user's added jobs. Imported jobs are private: only their owner sees them,
// and they never count in any total. When the `jobs.import` capability is off
// (or cannot be resolved) the page offers nothing (R-04: fail closed).

import { useTranslations } from 'next-intl';

import { EmptyState, PageHeader } from '../../v3/primitives';
import { useCapabilities, useFlag } from '../../../lib/flags';
import { AddJobPanel } from './AddJobPanel';
import { AddedJobsList } from './AddedJobsList';
import styles from './JobImport.module.css';

export function JobsAddedPage() {
  const t = useTranslations('jobImport.page');
  const { status } = useCapabilities();
  const on = useFlag('jobs.import');

  return (
    <div className={styles.page} data-surface="jobs-added">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      {on ? (
        <>
          <AddJobPanel />
          <AddedJobsList />
        </>
      ) : status === 'loading' ? (
        <p className={styles.meta} role="status">
          {t('loading')}
        </p>
      ) : (
        <EmptyState title={t('unavailableTitle')} sub={t('unavailableSub')} />
      )}
    </div>
  );
}

export default JobsAddedPage;
