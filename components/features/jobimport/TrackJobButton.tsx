'use client';

// TrackJobButton — "Save to tracker" for an added job (WP-35; F-TRK-04: an
// imported job gets the same tracking entry point as any other job). Goes
// through the shared job actions seam (useJobActions(jobId).save() → a
// 'bookmarked' tracker entry, never a downgrade of a further status), which
// refreshes every job-related query, so the list then shows the status chip.
// D1: saving to the tracker records the user's own plan; nothing is applied.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useJobActions } from '../../../hooks/shared/useJobActions';
import styles from './JobImport.module.css';

/** The tracker page (nav entry 'applications'). */
export const TRACKER_HREF = '/applications';

export interface TrackJobButtonProps {
  jobId: string;
  /** The job's current tracker status; when set the job is already tracked and nothing is offered. */
  trackerStatus?: string | null;
  /** Accessible name context (the job title) for lists with many rows. */
  title?: string;
}

export function TrackJobButton({ jobId, trackerStatus = null, title }: TrackJobButtonProps) {
  const t = useTranslations('jobImport.actions');
  const actions = useJobActions(jobId);
  const [attempted, setAttempted] = useState(false);

  if (trackerStatus) return null;

  const saving = actions.pending === 'save';
  if (attempted && !saving && !actions.error) {
    return (
      <span className={styles.trackDone} role="status">
        {t('tracked')}{' '}
        <a className={styles.trackLink} href={TRACKER_HREF}>
          {t('openTracker')}
        </a>
      </span>
    );
  }

  return (
    <>
      <Btn
        disabled={saving}
        aria-label={title ? t('trackAria', { title }) : undefined}
        onClick={async () => {
          setAttempted(true);
          await actions.save();
        }}
      >
        {saving ? t('tracking') : t('track')}
      </Btn>
      {attempted && actions.error && !saving ? (
        <p className={styles.fieldError} role="alert">
          {t('trackFailed')}
        </p>
      ) : null}
    </>
  );
}
