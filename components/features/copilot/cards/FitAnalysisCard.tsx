'use client';

// fit_analysis — the structured fit for one job (F-ORION-03): the tier word,
// what lines up, what the post asks for that the resume does not show, and
// the permanent line "This is not your chance of getting hired." (C5).

import { useTranslations } from 'next-intl';

import { FitTierLabel, HonestyLine } from '../../../v3/primitives';
import { AiGeneratedBadge } from '../../market';
import { CardFrame } from './CardFrame';
import { parseFitAnalysis } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h4 className={styles.subTitle}>{title}</h4>
      <ul className={styles.bullets}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </>
  );
}

export function FitAnalysisCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards.fit');
  const data = parseFitAnalysis(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <div className={styles.row}>
        <FitTierLabel tier={data.tier} score={data.score} />
        <AiGeneratedBadge />
      </div>
      <Section title={t('aligned')} items={data.aligned} />
      <Section title={t('missing')} items={data.missing} />
      <Section title={t('highlights')} items={data.highlights} />
      <HonestyLine kind="fit" />
    </CardFrame>
  );
}
