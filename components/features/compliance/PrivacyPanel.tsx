'use client';

// PrivacyPanel — /settings#privacy (both brands; WP-13): download your data,
// personal-information requests with their due dates, the retention schedule,
// and a pointer to account deletion (#danger, WP-10).

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';

import { createPiRequest, exportDownloadUrl, listPiRequests, requestDataExport } from '../../../lib/api/compliance';
import { apiErrorDetails } from '../../../lib/api/contracts/wire';
import type { PiRequestKind, PiRequestView } from '../../../lib/api/contracts/compliance';
import { Btn } from '../../v3/primitives/Btn';
import { RetentionTable } from './RetentionTable';
import styles from './compliance.module.css';

export const PI_REQUESTS_QUERY_KEY = ['compliance', 'pi-requests'] as const;

/** Kinds a user can file from the form (copy/portability start the export). */
export const FORM_KINDS: PiRequestKind[] = ['access', 'correction', 'deletion', 'explanation', 'withdraw_consent', 'portability'];

function isPending(r: PiRequestView): boolean {
  return r.status === 'open' || r.status === 'in_progress';
}

/** The newest data-export request (kind copy/portability). */
export function latestExport(items: PiRequestView[]): PiRequestView | null {
  return items.find((r) => r.kind === 'copy' || r.kind === 'portability') ?? null;
}

function conflictMessage(err: unknown): boolean {
  return apiErrorDetails<{ reason?: string }>(err)?.reason === 'pi_request_already_open';
}

export function PrivacyPanel() {
  const t = useTranslations('legal');
  const fmt = useFormatter();
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<PiRequestKind>('access');
  const [detail, setDetail] = useState('');

  const requests = useQuery({
    queryKey: PI_REQUESTS_QUERY_KEY,
    queryFn: () => listPiRequests(),
    // Poll while an export is being built so the download appears without a reload.
    refetchInterval: (q) => {
      const exp = latestExport(q.state.data?.items ?? []);
      return exp && isPending(exp) ? 5000 : false;
    },
  });
  const items = requests.data?.items ?? [];
  const exp = latestExport(items);

  const startExport = useMutation({
    mutationFn: () => requestDataExport(),
    onSettled: () => qc.invalidateQueries({ queryKey: PI_REQUESTS_QUERY_KEY }),
  });
  const file = useMutation({
    mutationFn: () => createPiRequest({ kind, detail: detail.trim() || undefined }),
    onSuccess: () => {
      setFormOpen(false);
      setDetail('');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: PI_REQUESTS_QUERY_KEY }),
  });

  const date = (iso: string) => fmt.dateTime(new Date(iso), { dateStyle: 'medium' });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    file.mutate();
  };

  return (
    <div className={styles.panel} data-testid="privacy-panel">
      <section className={styles.card} aria-labelledby="privacy-export">
        <h3 id="privacy-export" className={styles.cardTitle}>
          {t('privacy.exportTitle')}
        </h3>
        <p className={styles.cardBody}>{t('privacy.exportBody')}</p>
        <div className={styles.actions}>
          {exp?.download ? (
            <Btn as="a" href={exportDownloadUrl(exp.id)} variant="primary" download>
              {t('privacy.download')}
            </Btn>
          ) : null}
          {exp && isPending(exp) ? (
            <span className={styles.status} role="status">
              {t('privacy.exportQueued')}
            </span>
          ) : (
            <Btn variant={exp?.download ? 'default' : 'primary'} onClick={() => startExport.mutate()} disabled={startExport.isPending}>
              {startExport.isPending ? t('privacy.exportStarting') : t('privacy.exportCta')}
            </Btn>
          )}
          {exp?.download ? <span className={styles.status}>{t('privacy.exportReady', { date: date(exp.download.expiresAt) })}</span> : null}
        </div>
        {startExport.isError ? (
          <p className={styles.alert} role="alert">
            {conflictMessage(startExport.error) ? t('privacy.conflict') : t('privacy.error')}
          </p>
        ) : null}
      </section>

      <section className={styles.card} aria-labelledby="privacy-requests">
        <h3 id="privacy-requests" className={styles.cardTitle}>
          {t('privacy.requestsTitle')}
        </h3>
        <p className={styles.cardBody}>{t('privacy.requestsIntro')}</p>
        {requests.isError ? (
          <div className={styles.actions}>
            <p className={styles.alert} role="alert">
              {t('privacy.loadError')}
            </p>
            <Btn onClick={() => void requests.refetch()}>{t('privacy.retry')}</Btn>
          </div>
        ) : requests.isLoading ? (
          <p className={styles.muted}>{t('disclosures.loading')}</p>
        ) : items.length === 0 ? (
          <p className={styles.muted}>{t('privacy.requestsEmpty')}</p>
        ) : (
          <ul className={styles.list}>
            {items.map((r) => (
              <li key={r.id} className={styles.item} data-request={r.id}>
                <div className={styles.itemMain}>
                  <p className={styles.itemTitle}>{t(`privacy.kinds.${r.kind}`)}</p>
                  <p className={styles.itemMeta}>
                    {t('privacy.filed', { date: date(r.createdAt) })}
                    {' · '}
                    {r.resolvedAt ? t('privacy.resolved', { date: date(r.resolvedAt) }) : t('privacy.due', { date: date(r.dueAt) })}
                  </p>
                </div>
                <span className={`${styles.pill} ${r.status === 'done' ? styles.pillOn : ''}`}>{t(`privacy.statuses.${r.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
        {formOpen ? (
          <form className={styles.form} onSubmit={onSubmit}>
            <label className={styles.label}>
              {t('privacy.kindLabel')}
              <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value as PiRequestKind)}>
                {FORM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`privacy.kinds.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              {t('privacy.detailLabel')}
              <span className={styles.hint}>{t('privacy.detailHint')}</span>
              <textarea className={styles.textarea} value={detail} maxLength={4000} onChange={(e) => setDetail(e.target.value)} />
            </label>
            {file.isError ? (
              <p className={styles.alert} role="alert">
                {conflictMessage(file.error) ? t('privacy.conflict') : t('privacy.error')}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Btn type="submit" variant="primary" disabled={file.isPending}>
                {file.isPending ? t('privacy.sending') : t('privacy.submit')}
              </Btn>
              <Btn variant="ghost" onClick={() => setFormOpen(false)}>
                {t('privacy.cancel')}
              </Btn>
            </div>
          </form>
        ) : (
          <div className={styles.actions} style={{ marginTop: 'var(--sp-3)' }}>
            <Btn onClick={() => setFormOpen(true)}>{t('privacy.newRequest')}</Btn>
          </div>
        )}
      </section>

      <section className={styles.card} aria-labelledby="privacy-retention">
        <h3 id="privacy-retention" className={styles.cardTitle}>
          {t('retention.title')}
        </h3>
        <RetentionTable />
      </section>

      <section className={styles.card} aria-labelledby="privacy-delete">
        <h3 id="privacy-delete" className={styles.cardTitle}>
          {t('privacy.deleteTitle')}
        </h3>
        <p className={styles.cardBody}>{t('privacy.deleteBody')}</p>
        <div className={styles.actions}>
          <Btn as="a" href="/settings#danger">
            {t('privacy.deleteLink')}
          </Btn>
        </div>
      </section>
    </div>
  );
}

export default PrivacyPanel;
