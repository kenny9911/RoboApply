'use client';

// cover_letter — a cover letter was written (after a confirmed action). The
// preview is AI text: labelled on GoApply (AiGeneratedBadge) and rendered as
// sanitized markdown; the full letter opens in the letters editor.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Markdown } from '../../../v3/primitives';
import { AiGeneratedBadge } from '../../market';
import { CardFrame } from './CardFrame';
import { parseCoverLetter } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function CoverLetterCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.coverLetter');
  const data = parseCoverLetter(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      {data.jobTitle ? <p className={styles.cardText}>{data.company ? `${data.jobTitle} · ${data.company}` : data.jobTitle}</p> : null}
      {data.preview ? (
        <>
          <AiGeneratedBadge kind="document" />
          <div className={styles.fact}>
            <Markdown block>{data.preview}</Markdown>
          </div>
        </>
      ) : null}
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
