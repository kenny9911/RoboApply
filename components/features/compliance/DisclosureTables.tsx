'use client';

// DisclosureTables — the AI models and data processors this deployment is
// configured with (GET /api/v1/public/legal/disclosures). Unknown countries
// render "Not listed"; filing numbers appear only when set; no model → AI off.
//
// ProcessingFacts, LlmEndpoints and DataAttributions render what the server
// derives from the code that enforces it (the residency summary, the AI
// routing policy lists, the job data sources). No vendor, host or dataset name
// is written in this file or in the bundles: every one comes from the response.

import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';

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

/** Where and how this deployment processes the brand's data ({{processing_facts}}). */
export function ProcessingFacts({ data }: { data?: DisclosuresResponse }) {
  const t = useTranslations('legal');
  const fmt = useFormatter();
  const q = useDisclosures(data);
  const d = data ?? q.data;
  if (!d) return <p className={styles.muted}>{q.isError ? t('disclosures.error') : t('disclosures.loading')}</p>;
  const f = d.processing;
  const kinds = f.redactedBeforeStorage.map((k) => t(`processing.pii.${k}`));
  return (
    <ul className={styles.factList} data-testid="processing-facts" data-stage={f.stage}>
      <li data-fact="region">{t('processing.region', { where: f.region === 'cn-mainland' ? 'mainland' : 'offshore' })}</li>
      <li data-fact="files">{t('processing.files', { state: f.originalFiles })}</li>
      {/* The parser's name comes from the server; without one the line states only that no outside parser is used. */}
      <li data-fact="parsing" data-mode={f.resumeParsing}>
        {t('processing.parsing', { mode: f.resumeParser && f.resumeParsing !== 'local' ? 'outside_mainland' : 'local', service: f.resumeParser ?? '' })}
      </li>
      {kinds.length > 0 ? <li data-fact="redacted">{t('processing.redacted', { kinds: fmt.list(kinds, { type: 'conjunction' }) })}</li> : null}
      {f.imagesDiscarded ? <li data-fact="images">{t('processing.images')}</li> : null}
    </ul>
  );
}

/** The AI endpoints the routing policy allows and refuses ({{llm_endpoints}}). */
export function LlmEndpoints({ data }: { data?: DisclosuresResponse }) {
  const t = useTranslations('legal');
  const q = useDisclosures(data);
  const d = data ?? q.data;
  if (!d) return <p className={styles.muted}>{q.isError ? t('disclosures.error') : t('disclosures.loading')}</p>;
  const e = d.llmEndpoints;
  return (
    <div data-testid="llm-endpoints" data-rule={e.rule}>
      <p>{t('llmEndpoints.rule', { rule: e.rule })}</p>
      {e.providers.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('llmEndpoints.colProvider')}</th>
                <th scope="col">{t('llmEndpoints.colHost')}</th>
              </tr>
            </thead>
            <tbody>
              {e.providers.map((p) => (
                <tr key={p.provider} data-provider={p.provider}>
                  <td>{p.provider}</td>
                  <td className={styles.host}>{p.host}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.muted}>{t('disclosures.notListed')}</p>
      )}
      <p>{t('llmEndpoints.hosts', { rule: e.rule })}</p>
      <ul className={styles.hostList} data-list="mainland-hosts">
        {e.mainlandHosts.map((h) => (
          <li key={h} className={styles.host}>
            {h}
          </li>
        ))}
      </ul>
      {e.excludedUpstreams.length > 0 ? (
        <>
          <p>{t('llmEndpoints.excluded')}</p>
          <ul className={styles.hostList} data-list="excluded-upstreams">
            {e.excludedUpstreams.map((u) => (
              <li key={u} className={styles.host}>
                {u}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/**
 * Datasets whose licence requires attribution ({{data_attributions}}).
 *
 * Five columns do not fit a phone (at 375px the table ran 54px past the
 * screen edge), so below 640px each row is laid out as a labelled list
 * (`tableStack`): every cell carries its column name in `data-label`.
 */
export function DataAttributions({ data }: { data?: DisclosuresResponse }) {
  const t = useTranslations('legal');
  const q = useDisclosures(data);
  const d = data ?? q.data;
  if (!d) return <p className={styles.muted}>{q.isError ? t('disclosures.error') : t('disclosures.loading')}</p>;
  if (d.dataAttributions.length === 0) return <p className={styles.muted}>{t('attributions.none')}</p>;
  const cols = {
    dataset: t('attributions.colDataset'),
    publisher: t('attributions.colPublisher'),
    usedFor: t('attributions.colUsedFor'),
    licence: t('attributions.colLicence'),
    asOf: t('attributions.colAsOf'),
  };
  return (
    <div className={`${styles.tableWrap} ${styles.tableWrapStack}`} data-testid="data-attributions">
      <table className={`${styles.table} ${styles.tableStack}`}>
        <thead>
          <tr>
            <th scope="col">{cols.dataset}</th>
            <th scope="col">{cols.publisher}</th>
            <th scope="col">{cols.usedFor}</th>
            <th scope="col">{cols.licence}</th>
            <th scope="col">{cols.asOf}</th>
          </tr>
        </thead>
        <tbody>
          {d.dataAttributions.map((a) => (
            <tr key={a.id} data-source={a.id}>
              <td data-label={cols.dataset}>
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.name}
                  </a>
                ) : (
                  a.name
                )}
              </td>
              <td data-label={cols.publisher}>{a.publisher}</td>
              <td data-label={cols.usedFor}>{t(`attributions.purpose.${a.purpose}`)}</td>
              <td data-label={cols.licence}>{a.license}</td>
              <td data-label={cols.asOf}>{a.asOf}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
