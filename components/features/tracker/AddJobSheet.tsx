'use client';

// AddJobSheet — add a job found elsewhere to /applications by hand (PRODUCT
// F-TRK-02 "add manually"). The entry is private to the user; nothing is
// fetched or sent anywhere. Fetching a posting from a link is /jobs/added
// (WP-35); this form only stores what the user types.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Sheet } from '../../v3/primitives';
import { useCreateTrackerEntry } from '../../../hooks/tracker/useTracker';
import type { TrackerStatus } from '../../../lib/api/contracts/tracker';
import { useTrackerColumns } from './shared';
import styles from './tracker.module.css';

export interface AddJobSheetProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new entry's id (the page opens its details). */
  onAdded?: (id: string) => void;
}

export function AddJobSheet({ open, onClose, onAdded }: AddJobSheetProps) {
  const t = useTranslations('applications');
  const { columns } = useTrackerColumns();
  const create = useCreateTrackerEntry();
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [url, setUrl] = useState('');
  const [location, setLocation] = useState('');
  const [status, setStatus] = useState<string>('applied');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle('');
    setCompany('');
    setUrl('');
    setLocation('');
    setStatus('applied');
    setError(null);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError(t('add.error_title_required'));
    if (!company.trim()) return setError(t('add.error_company_required'));
    setError(null);
    create.mutate(
      {
        externalSnapshot: { title: title.trim(), companyName: company.trim(), location: location.trim() || null, applyUrl: url.trim() || null },
        status: status as TrackerStatus,
        source: 'manual',
      },
      {
        onSuccess: ({ entry }) => {
          reset();
          onClose();
          onAdded?.(entry.id);
        },
        onError: () => setError(t('add.error_generic')),
      },
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('add.title')}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <label className={styles.field}>
          <span className={styles.label}>{t('add.field_title')}</span>
          <input className={styles.input} value={title} placeholder={t('add.field_title_placeholder')} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('add.field_company')}</span>
          <input className={styles.input} value={company} placeholder={t('add.field_company_placeholder')} onChange={(e) => setCompany(e.target.value)} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('add.field_url')}</span>
          <input className={styles.input} type="url" inputMode="url" value={url} placeholder={t('add.field_url_placeholder')} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('add.field_location')}</span>
          <input className={styles.input} value={location} placeholder={t('add.field_location_placeholder')} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('add.field_status')}</span>
          <select className={styles.input} value={status} onChange={(e) => setStatus(e.target.value)}>
            {columns
              .filter((c) => !c.terminal)
              .map((c) => (
                <option key={c.status} value={c.status}>
                  {t(`columns.${c.labelKey}`)}
                </option>
              ))}
          </select>
        </label>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? t('add.submitting') : t('add.submit')}
          </Btn>
        </div>
      </form>
    </Sheet>
  );
}
