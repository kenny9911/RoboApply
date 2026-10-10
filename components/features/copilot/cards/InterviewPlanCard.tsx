'use client';

// interview_plan — questions to prepare for a job, each labelled by where it
// came from (question bank, the job post, or written by AI), plus "Practice
// for this job" (WP-43's route contract; nothing is spent until the session
// starts).

import { useTranslations } from 'next-intl';

import { useLaunchPractice } from '../../../../hooks/shared/useLaunchPractice';
import { Btn } from '../../../v3/primitives';
import { AiGeneratedBadge } from '../../market';
import { CardFrame } from './CardFrame';
import { parseInterviewPlan } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function InterviewPlanCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.interview');
  const launch = useLaunchPractice();
  const data = parseInterviewPlan(card.data);
  if (!data) return null;
  const anyAi = data.questions.some((q) => q.sourceKind === 'ai');
  return (
    <CardFrame card={card} title={t('title')}>
      {anyAi ? <AiGeneratedBadge /> : null}
      <ul className={styles.cardList}>
        {data.questions.map((q, i) => (
          <li key={i} className={styles.jobRow}>
            <span className={styles.cardText} style={{ color: 'var(--text)' }}>
              {q.text}
            </span>
            {q.sourceKind ? <span className={styles.label}>{t(`source.${q.sourceKind}`)}</span> : null}
          </li>
        ))}
      </ul>
      <div className={styles.cardActions}>
        <Btn
          variant="primary"
          onClick={() => {
            ctx.onNavigate?.();
            launch({ jobId: data.jobId, from: 'assistant' });
          }}
        >
          {t('practice')}
        </Btn>
      </div>
    </CardFrame>
  );
}
