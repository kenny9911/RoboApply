'use client';

// ConnectionsImport — /settings#connections (WP-54; H16).
//
// The user uploads their own LinkedIn data export (Connections.csv). We keep
// each person's name, company, position and connected-on date; the email and
// profile-link columns are thrown away when the file is read (server parser).
// Rows are private to the user, used only to show who they know at a
// company, deleted with the account, and "Delete all imported connections"
// is always here. 3 imports a day.

import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, Modal, toast } from '../../v3/primitives';
import { importErrorKind, useConnectionsImport, type ImportErrorKind } from '../../../hooks/network';
import styles from './network.module.css';

export function ConnectionsImport({ canImport = true }: { canImport?: boolean }) {
  const t = useTranslations('people.settings');
  const format = useFormatter();
  const { status, upload, removeAll } = useConnectionsImport();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<ImportErrorKind | null>(null);
  const [result, setResult] = useState<{ imported: number; rows: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const s = status.data;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const r = await upload.mutateAsync(file);
      setResult({ imported: r.importedCount, rows: r.rowCount });
    } catch (err) {
      setError(importErrorKind(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deleteAll = async () => {
    try {
      const r = await removeAll.mutateAsync();
      setConfirming(false);
      setResult(null);
      toast({ message: t('deleted', { count: r.deleted }), tone: 'ok' });
    } catch {
      setConfirming(false);
      setError('failed');
    }
  };

  return (
    <section className={styles.section} data-testid="connections-import" aria-labelledby="connections-title">
      <h3 className={styles.title} id="connections-title">
        {t('title')}
      </h3>
      <p className={styles.body}>{t('intro')}</p>
      <p className={styles.muted}>{t('howTo')}</p>
      <p className={styles.muted}>{t('keep')}</p>
      <p className={styles.muted}>{t('private')}</p>

      {s ? (
        <div className={styles.form}>
          <p className={styles.body} data-testid="connections-count">
            {t('count', { count: s.importedCount })}
          </p>
          {s.lastImportAt ? <p className={styles.muted}>{t('last', { date: format.dateTime(new Date(s.lastImportAt), { dateStyle: 'medium' }) })}</p> : null}
          <p className={styles.muted}>{t('limit', { limit: s.limitPerDay, count: s.importsToday })}</p>
        </div>
      ) : null}

      {canImport ? (
        <div className={styles.row}>
          <input
            ref={fileRef}
            id="connections-file"
            className={styles.fileInput}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0])}
            aria-label={t('upload')}
          />
          <Btn variant="primary" onClick={() => fileRef.current?.click()} disabled={upload.isPending} aria-busy={upload.isPending || undefined}>
            {upload.isPending ? t('uploading') : t('upload')}
          </Btn>
        </div>
      ) : (
        <p className={styles.muted}>{t('unavailable')}</p>
      )}

      {result ? (
        <p className={styles.notice} role="status">
          {t('result', { imported: result.imported, rows: result.rows })}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert" data-error={error}>
          {t(`error.${error}`)}
        </p>
      ) : null}

      <div className={styles.row}>
        <Btn variant="ghost" onClick={() => setConfirming(true)} disabled={removeAll.isPending}>
          {t('deleteAll')}
        </Btn>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmBody')}
        footer={
          <div className={styles.row}>
            <Btn variant="ghost" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Btn>
            <Btn variant="primary" onClick={deleteAll} disabled={removeAll.isPending}>
              {t('deleteConfirm')}
            </Btn>
          </div>
        }
      >
        <p className={styles.muted}>{t('keep')}</p>
      </Modal>
    </section>
  );
}

export default ConnectionsImport;
