'use client';

// LegalIndex — the /legal page: the brand's legal documents, and the facts
// this deployment can state about itself — where data is processed, which AI
// endpoints may be used, how long data is kept, and the datasets we must
// credit. Every fact is rendered from the server (the residency summary, the
// AI routing policy lists, the retention schedule, the job data sources);
// nothing here is typed in by hand.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { DataAttributions, LlmEndpoints, ModelsTable, ProcessingFacts, ProcessorsTable } from './DisclosureTables';
import { RetentionTable } from './RetentionTable';
import type { LegalDocSlug, LegalMarket } from './legalCatalog';
import styles from './compliance.module.css';

export interface LegalIndexProps {
  market: LegalMarket;
  docs: Array<{ doc: LegalDocSlug; draft: boolean; updated: string | null }>;
}

export function LegalIndex({ market, docs }: LegalIndexProps) {
  const t = useTranslations('legal');
  return (
    <div className={styles.doc} data-testid="legal-index">
      <article className={styles.docMain}>
        <span className={styles.eyebrow}>{t('page.eyebrow')}</span>
        <h1 className={styles.docTitle}>{t('index.title')}</h1>
        <p className={styles.muted}>{t('index.sub')}</p>
        <div className={styles.prose}>
          <h2 id="legal-index-docs">{t('index.docsTitle')}</h2>
          <ul className={styles.indexList} aria-labelledby="legal-index-docs">
            {docs.map((d) => (
              <li key={d.doc}>
                <Link href={`/legal/${d.doc}`}>
                  <span>{t(`docs.${d.doc}`)}</span>
                  <span className={styles.indexDocMeta}>{d.draft ? t('page.draftTitle') : d.updated ? t('page.updated', { date: d.updated }) : null}</span>
                </Link>
              </li>
            ))}
          </ul>

          <h2>{t('index.processingTitle')}</h2>
          <ProcessingFacts />
          <h3>{t('disclosures.processorsTitle')}</h3>
          <ProcessorsTable />

          <h2>{t('index.aiTitle')}</h2>
          <h3>{t('disclosures.modelsTitle')}</h3>
          <ModelsTable market={market} />
          <h3>{t('index.endpointsTitle')}</h3>
          <LlmEndpoints />

          <h2>{t('retention.title')}</h2>
          <RetentionTable />

          <h2>{t('index.attributionsTitle')}</h2>
          <p>{t('index.attributionsSub')}</p>
          <DataAttributions />
        </div>
      </article>
    </div>
  );
}

export default LegalIndex;
