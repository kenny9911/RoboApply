'use client';

// company — sourced company facts only (F-ORION-07, F-JOB-04). Every value
// renders through SourcedValue + its own SourceNote; an unknown value is "—"
// (D3). The card-level `sources` repeat the same facts, so they are not
// rendered a second time.

import { useTranslations } from 'next-intl';

import { SourceNote, SourcedValue } from '../../common';
import { CardFrame } from './CardFrame';
import { parseCompany } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function CompanyCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards.company');
  const data = parseCompany(card.data);
  if (!data || data.facts.length === 0) return null;
  return (
    <CardFrame card={card} title={t('title', { name: data.name })} showSources={false}>
      <dl className={styles.facts}>
        {data.facts.map((f) => (
          <div key={f.key} style={{ display: 'contents' }}>
            <dt>{t(`facts.${f.key}`)}</dt>
            <dd>
              <SourcedValue value={f.value} />
              <SourceNote sourced={f.value} sampleNoun={f.key === 'sponsorship_filings' ? 'filings' : 'companies'} />
            </dd>
          </div>
        ))}
      </dl>
    </CardFrame>
  );
}
