'use client';

// CnQuestionTiming — the per-question timing line of the GoApply AI-interview
// practice (WP-66): "{prep} seconds to think, then up to {answer} seconds to
// answer." The numbers come from the plan the server stores on the blueprint
// (`blueprint.cnFormat.questions[i].prepSeconds / answerSeconds`); the words
// come from the practiceCn bundle, so the server never writes this copy.
// Renders nothing when either number is missing or not a positive number.

import { useTranslations } from 'next-intl';

import styles from './practiceCn.module.css';

export interface CnQuestionTimingProps {
  prepSeconds: number | null | undefined;
  answerSeconds: number | null | undefined;
}

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function CnQuestionTiming({ prepSeconds, answerSeconds }: CnQuestionTimingProps) {
  const t = useTranslations('practiceCn.format');
  if (!positive(prepSeconds) || !positive(answerSeconds)) return null;
  return (
    <p className={styles.source} data-testid="cn-question-timing">
      {t('timing', { prep: Math.round(prepSeconds), answer: Math.round(answerSeconds) })}
    </p>
  );
}

export default CnQuestionTiming;
