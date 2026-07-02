'use client';

// ResultsGrid — the two report cards (proto `.iv-results-grid`): Strengths (keep
// these) and Sharpen-these (top gaps). Each list item is LLM-authored → rendered
// through the sanitized Markdown primitive (CLAUDE.md rule).

import { useTranslations } from 'next-intl';
import { Markdown } from '../primitives/Markdown';

interface Props {
  strengths: string[];
  gaps: string[];
}

export function ResultsGrid({ strengths, gaps }: Props) {
  const t = useTranslations('mock');
  return (
    <div className="iv-results-grid">
      <div className="iv-results-card good">
        <div className="iv-results-card-head">
          <span className="iv-results-tag good">{t('report.strengths')}</span>
          <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
            {t('report.keepThese')}
          </span>
        </div>
        <ul className="iv-results-list">
          {strengths.map((s, i) => (
            <li key={i}>
              <span className="iv-results-bullet good">+</span>
              <Markdown>{s}</Markdown>
            </li>
          ))}
        </ul>
      </div>
      <div className="iv-results-card gap">
        <div className="iv-results-card-head">
          <span className="iv-results-tag warn">{t('report.sharpen')}</span>
          <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
            {t('report.topN', { count: gaps.length })}
          </span>
        </div>
        <ul className="iv-results-list">
          {gaps.map((s, i) => (
            <li key={i}>
              <span className="iv-results-bullet warn">→</span>
              <Markdown>{s}</Markdown>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
