'use client';

// resume_tips — what the latest resume check found (WP-50 `resume_issues`
// tool), with a link to the check where each issue can be fixed. Each issue
// renders the localized `resumeCheck.issue.<type>` text with its `params`
// (issueText, the same as the resume check page); the stored English `why`
// shows only for a type this build does not know.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { GradeIssue } from '../../../../lib/api/contracts/resume';
import { issueText } from '../../resume';
import { CardFrame } from './CardFrame';
import { parseResumeTips } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function ResumeTipsCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.resumeTips');
  const tCheck = useTranslations('resumeCheck');
  const data = parseResumeTips(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      {data.stale ? <p className={styles.cardText}>{t('stale')}</p> : null}
      {data.issues.length ? (
        <ul className={styles.cardList}>
          {data.issues.slice(0, 5).map((issue) => (
            <li key={issue.id} className={styles.cardText}>
              {issueText(tCheck, issue as unknown as GradeIssue).title}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.cardText}>{t('none')}</p>
      )}
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
