'use client';

// RetentionTable — the published retention schedule, from the same table the
// compliance-daily cron runs (server/src/features/compliance/retention.ts).
// Each row says how it is deleted, including rows that are not automated yet;
// a period we do not set ourselves and ops has not configured shows "Not listed".
// A `kept_minimum` row is not a deletion: its period is the least time the
// record is kept, and the row says so.

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { getPublicRetention } from '../../../lib/api/compliance';
import type { RetentionRuleView } from '../../../lib/api/contracts/compliance';
import styles from './compliance.module.css';

export const RETENTION_QUERY_KEY = ['compliance', 'retention'] as const;

export function enforcementKey(rule: Pick<RetentionRuleView, 'enforcedBy'>): 'auto' | 'provider' | 'manual' | 'minimum' {
  if (rule.enforcedBy === 'provider') return 'provider';
  if (rule.enforcedBy === 'not_automated') return 'manual';
  if (rule.enforcedBy === 'kept_minimum') return 'minimum';
  // compliance-daily, account-purge, interview-retention, tools-purge, visitor-alerts: a scheduled job deletes it.
  return 'auto';
}

export function RetentionTable({ items, caption }: { items?: RetentionRuleView[]; caption?: string }) {
  const t = useTranslations('legal');
  const query = useQuery({ queryKey: RETENTION_QUERY_KEY, queryFn: () => getPublicRetention(), enabled: !items, staleTime: 5 * 60 * 1000 });
  const rows = items ?? query.data?.items;

  if (!rows) {
    return <p className={styles.muted}>{query.isError ? t('disclosures.error') : t('disclosures.loading')}</p>;
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        {caption ? <caption className={styles.muted}>{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col">{t('retention.colData')}</th>
            <th scope="col">{t('retention.colKept')}</th>
            <th scope="col">{t('retention.colHow')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-rule={r.id}>
              <td>{t(`retention.rows.${r.id}`)}</td>
              <td>{r.keep ? t('retention.keep', { amount: r.keep.amount, unit: r.keep.unit }) : t('disclosures.notListed')}</td>
              <td>{t(`retention.enforced.${enforcementKey(r)}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default RetentionTable;
