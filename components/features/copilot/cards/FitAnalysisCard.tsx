'use client';

// fit_analysis — the structured fit for one job (F-ORION-03): the tier word,
// what lines up and what the post asks for that the resume does not show
// (MATCH's deterministic `skills.aligned` / `skills.missing`), the AI read's
// strengths and gaps when there is one (AiGeneratedBadge on GoApply), and the
// permanent line "This is not your chance of getting hired." (C5).
//
// The card stays in the chat as it was written. The fit itself moves with the
// resume and the saved search, so the card says it is the fit at the time of
// the answer and links to the job page, which always shows the current one
// (both read the same stored score, MATCH `scoreJob`).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { FitTierLabel, HonestyLine } from '../../../v3/primitives';
import { jobDetailHref } from '../../job';
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

export function FitAnalysisCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.fit');
  const data = parseFitAnalysis(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <div className={styles.row}>
        <FitTierLabel tier={data.tier} score={data.score} estimate={data.estimate} />
        {data.aiWritten ? <AiGeneratedBadge /> : null}
      </div>
      <Section title={t('aligned')} items={data.aligned} />
      <Section title={t('missing')} items={data.missing} />
      <Section title={t('highlights')} items={data.highlights} />
      <Section title={t('gaps')} items={data.gaps} />
      <p className={styles.muted} data-testid="fit-snapshot">
        {t('snapshot')}{' '}
        <Link href={jobDetailHref(data.jobId)} className={styles.link} onClick={ctx.onNavigate}>
          {t('openJob')}
        </Link>
      </p>
      <HonestyLine kind="fit" />
    </CardFrame>
  );
}
