'use client';

// DisclosureTables — the AI models and data processors this deployment is
// configured with (GET /api/v1/public/legal/disclosures). Unknown countries
// render "Not listed"; filing numbers appear only when set; no model → AI off.

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { getPublicDisclosures } from '../../../lib/api/compliance';
import type { DisclosuresResponse } from '../../../lib/api/contracts/compliance';
import styles from './compliance.module.css';

export const DISCLOSURES_QUERY_KEY = ['compliance', 'disclosures'] as const;

function useDisclosures(data?: DisclosuresResponse) {
  return useQuery({ queryKey: DISCLOSURES_QUERY_KEY, queryFn: () => getPublicDisclosures(), enabled: !data, staleTime: 5 * 60 * 1000 });
}

export function ModelsTable({ data, market }: { data?: DisclosuresResponse; market: 'intl' | 'cn' }) {
  const t = useTranslations('legal');
  const q = useDisclosures(data);
  const d = data ?? q.data;
  if (!d) return <p className={styles.muted}>{q.isError ? t('disclosures.error') : t('disclosures.loading')}</p>;
  if (d.models.length === 0) return <p className={styles.muted}>{t('disclosures.noModels')}</p>;
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('disclosures.colModel')}</th>
              <th scope="col">{t('disclosures.colVendor')}</th>
              <th scope="col">{market === 'cn' ? t('disclosures.colFiling') : t('disclosures.colCountry')}</th>
            </tr>
          </thead>
          <tbody>
            {d.models.map((m) => (
              <tr key={`${m.vendor}/${m.model}`}>
                <td>{m.model}</td>
                <td>{m.vendor}</td>
                <td>{(market === 'cn' ? m.filingNo : m.region) ?? t('disclosures.notListed')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.statusNote ? <p className={styles.muted}>{t('disclosures.statusNote', { note: d.statusNote })}</p> : null}
    </>
  );
}

export function ProcessorsTable({ data }: { data?: DisclosuresResponse }) {
  const t = useTranslations('legal');
  const q = useDisclosures(data);
  const d = data ?? q.data;
  if (!d) return <p className={styles.muted}>{q.isError ? t('disclosures.error') : t('disclosures.loading')}</p>;
  if (d.processors.length === 0) return <p className={styles.muted}>{t('disclosures.noProcessors')}</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('disclosures.colProcessor')}</th>
            <th scope="col">{t('disclosures.colPurpose')}</th>
            <th scope="col">{t('disclosures.colCountry')}</th>
          </tr>
        </thead>
        <tbody>
          {d.processors.map((p) => (
            <tr key={`${p.name}/${p.purpose}`}>
              <td>{p.name}</td>
              <td>{t(`processors.${p.purpose}`)}</td>
              <td>{[p.country, p.region].filter(Boolean).join(' / ') || t('disclosures.notListed')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
