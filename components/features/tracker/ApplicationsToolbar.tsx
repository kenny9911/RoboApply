'use client';

// ApplicationsToolbar — the view tabs plus "Add a job" and "Download as CSV"
// (5 downloads a day; the server enforces it) on /applications (WP-38).

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { trackerExportCsvUrl } from '../../../lib/api/tracker';
import { useBrowserTimeZone, withTimeZone } from './shared';
import styles from './tracker.module.css';

export interface ApplicationsToolbarProps {
  /** The view tabs. */
  tabs: ReactNode;
  onAdd: () => void;
}

export function ApplicationsToolbar({ tabs, onAdd }: ApplicationsToolbarProps) {
  const t = useTranslations('applications');
  // The file's dates are the ones this page shows: the reader's own time zone.
  const exportUrl = withTimeZone(trackerExportCsvUrl(), useBrowserTimeZone());
  return (
    <div className={styles.toolbar}>
      {tabs}
      <div className={styles.toolbarActions}>
        <Btn variant="primary" onClick={onAdd}>
          {t('toolbar.add')}
        </Btn>
        <Btn as="a" variant="default" href={exportUrl} download title={t('toolbar.export_note')}>
          {t('toolbar.export')}
        </Btn>
      </div>
    </div>
  );
}
