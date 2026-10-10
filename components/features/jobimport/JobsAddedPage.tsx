'use client';

// JobsAddedPage — /jobs/added, "Added by you" (WP-35; PRODUCT_PLAN.md
// F-TRK-04, §3.4). Add a job from a link or by hand, then the list of the
// user's added jobs. Imported jobs are private: only their owner sees them,
// and they never count in any total. When the `jobs.import` capability is off
// (or cannot be resolved) the page offers nothing (R-04: fail closed).
//
// It is the third tab of /jobs (For you · Explore · Added by you): the same
// tab strip as the feed, with only this tab when the brand has no job feed.
// `?import=<importId>` reopens an unfinished add (AddJobPanel).
//
// GoApply while it lists no third-party posts (`jobs.feed` off, R-14): "Search
// other job sites" sits under the add panel — links the user opens themselves
// (CN L-5), then adds what they find here. Never on RoboApply.

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { EmptyState, PageHeader } from '../../v3/primitives';
import { FeedTabs, feedTabPanelProps } from '../feed';
import { ExternalSearchPanel } from '../market';
import { useBrand } from '../../../lib/brand';
import { useCapabilities, useFlag } from '../../../lib/flags';
import { AddJobPanel } from './AddJobPanel';
import { AddedJobsList } from './AddedJobsList';
import styles from './JobImport.module.css';

export function JobsAddedPage() {
  const t = useTranslations('jobImport.page');
  const { status } = useCapabilities();
  const on = useFlag('jobs.import');
  const feedOn = useFlag('jobs.feed');
  const brand = useBrand();
  const importId = useSearchParams()?.get('import')?.trim() || null;

  return (
    <div className={styles.page} data-surface="jobs-added">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      <FeedTabs active="added" feedOn={feedOn} />
      <div {...feedTabPanelProps('added')} className={styles.page}>
        {on ? (
          <>
            <AddJobPanel resumeImportId={importId} />
            {brand.market === 'cn' && !feedOn ? <ExternalSearchPanel /> : null}
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
    </div>
  );
}

export default JobsAddedPage;
