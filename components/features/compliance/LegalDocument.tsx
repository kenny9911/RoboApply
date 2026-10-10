'use client';

// LegalDocument — one legal document page body: title, DRAFT banner (until
// counsel approves and ops sets the docs version), the markdown, the live
// blocks ({{retention_schedule}}, {{ai_models}}, {{processors}},
// {{processing_facts}}, {{llm_endpoints}}, {{data_attributions}},
// {{offshore_notice}}) and the list of the brand's other documents.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Markdown } from '../../v3/primitives/Markdown';
import type { ReactNode } from 'react';

import { CrossBorderNotice, DataAttributions, LlmEndpoints, ModelsTable, ProcessingFacts, ProcessorsTable } from './DisclosureTables';
import { RetentionTable } from './RetentionTable';
import { splitLegalBlocks, type LegalBlock, type LegalDocSlug, type LegalMarket } from './legalCatalog';
import styles from './compliance.module.css';

export interface LegalDocumentProps {
  doc: LegalDocSlug;
  title: string;
  body: string;
  draft: boolean;
  version: string | null;
  updated: string | null;
  market: LegalMarket;
  /** Language the document is written in (the page `lang`). */
  lang: 'en' | 'zh';
  /** The UI locale, to say when the text is English-only. */
  uiLocale: string;
  otherDocs: LegalDocSlug[];
}

/** The live component of a block placeholder. */
export function LegalBlockView({ block, market }: { block: LegalBlock; market: LegalMarket }): ReactNode {
  switch (block) {
    case 'retention_schedule':
      return <RetentionTable />;
    case 'ai_models':
      return <ModelsTable market={market} />;
    case 'processors':
      return <ProcessorsTable />;
    case 'processing_facts':
      return <ProcessingFacts />;
    case 'llm_endpoints':
      return <LlmEndpoints />;
    case 'data_attributions':
      return <DataAttributions />;
    case 'offshore_notice':
      return <CrossBorderNotice />;
  }
}

export function LegalDocument(props: LegalDocumentProps) {
  const t = useTranslations('legal');
  const segments = splitLegalBlocks(props.body);
  const englishOnly = props.lang === 'en' && props.uiLocale !== 'en';
  return (
    <div className={styles.doc} data-doc={props.doc} data-draft={props.draft ? 'true' : 'false'}>
      <article className={styles.docMain} lang={props.lang === 'zh' ? 'zh-CN' : 'en'}>
        <span className={styles.eyebrow}>{t('page.eyebrow')}</span>
        <h1 className={styles.docTitle}>{props.title}</h1>
        <div className={styles.docMeta}>
          {props.updated ? <span>{t('page.updated', { date: props.updated })}</span> : null}
          {props.version ? <span>{t('page.version', { version: props.version })}</span> : null}
        </div>
        {props.draft ? (
          <div className={styles.draft} role="note" data-testid="legal-draft-banner">
            <span className={styles.draftTitle}>{t('page.draftTitle')}</span>
            {t('page.draftBody')}
          </div>
        ) : null}
        {englishOnly ? <p className={styles.muted}>{t('page.englishOnly')}</p> : null}
        <div className={styles.prose}>
          {segments.map((s, i) =>
            s.kind === 'markdown' ? (
              <Markdown key={i} block>
                {s.text}
              </Markdown>
            ) : (
              <LegalBlockView key={i} block={s.block} market={props.market} />
            ),
          )}
        </div>
      </article>
      <aside className={styles.aside} aria-labelledby="legal-other-docs">
        <h2 id="legal-other-docs" className={styles.asideTitle}>
          {t('page.otherDocs')}
        </h2>
        <ul className={styles.asideList}>
          {props.otherDocs.map((d) => (
            <li key={d}>
              <Link href={`/legal/${d}`} aria-current={d === props.doc ? 'page' : undefined}>
                {t(`docs.${d}`)}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export default LegalDocument;
