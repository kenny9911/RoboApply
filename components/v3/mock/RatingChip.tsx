'use client';

// RatingChip — a compact rating + score chip for the per-question report rows.
// Self-contained (not built on Pill, which is fixed at 99px/10.5px) so it can
// carry the embedded score and a squarer shape. Tone follows the rating band.

import { useTranslations } from 'next-intl';
import type { IEQuestionRating } from '../../../lib/api/interviewEngine';

interface Props {
  rating: IEQuestionRating;
  score: number;
  /** Hide the numeric score (e.g. for a "missed" item). Default false. */
  hideScore?: boolean;
}

const TONE: Record<IEQuestionRating, { color: string; bg: string; border: string }> = {
  strong: { color: 'var(--ok)', bg: 'var(--ok-soft)', border: 'var(--ok)' },
  adequate: { color: 'var(--accent-text)', bg: 'var(--accent-soft)', border: 'var(--accent-text)' },
  weak: { color: 'var(--warn)', bg: 'var(--warn-soft)', border: 'var(--warn)' },
  missed: { color: 'var(--text-2)', bg: 'var(--surface-2)', border: 'var(--rule)' },
};

export function RatingChip({ rating, score, hideScore = false }: Props) {
  const t = useTranslations('ie');
  const s = TONE[rating] ?? TONE.adequate;
  const label = t(`report.questionBreakdown.rating.${rating}`);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 12,
        whiteSpace: 'nowrap',
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
      }}
    >
      {!hideScore && rating !== 'missed' ? <span className="robo-tnum">{score}</span> : null}
      <span>{label}</span>
    </span>
  );
}
