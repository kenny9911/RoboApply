'use client';

// ResultsTop — the report hero (proto `.iv-results-top`). Overall ScoreDonut +
// delta-vs-last-session caption on the left; the per-dimension breakdown bars on
// the right (proto `.iv-bk-row`). Data: mock.score → { overall, delta, breakdown }.

import { useTranslations } from 'next-intl';
import { ScoreDonut } from '../primitives/ScoreDonut';

interface BreakdownRow {
  key: string;
  value: number;
  note: string;
}

interface Props {
  overall: number;
  delta: number | null;
  breakdown: BreakdownRow[];
}

export function ResultsTop({ overall, delta, breakdown }: Props) {
  const t = useTranslations('mock');
  return (
    <div className="iv-results-top">
      <div className="iv-results-score">
        <ScoreDonut value={overall} size={120} hideNumber={false} label="" />
        <div className="iv-results-score-meta">
          <div className="iv-results-score-lbl">{t('report.overall')}</div>
          {delta != null ? (
            <div className="iv-results-score-delta">
              {delta >= 0
                ? t('report.deltaUp', { delta })
                : t('report.deltaDown', { delta: Math.abs(delta) })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="iv-results-breakdown">
        {breakdown.map((b) => (
          <div key={b.key} className="iv-bk-row">
            <div className="iv-bk-k">{b.key}</div>
            <div className="iv-bk-bar">
              <div
                className="iv-bk-fill"
                style={{ width: `${Math.max(0, Math.min(100, b.value))}%` }}
              />
            </div>
            <div className="iv-bk-v">{b.value}</div>
            <div className="iv-bk-note">{b.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
