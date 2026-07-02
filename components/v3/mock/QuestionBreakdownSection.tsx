'use client';

// QuestionBreakdownSection — the per-question deep dive section of the report.
// Renders one collapsible QuestionBreakdownItem per analyzed question. Shows a
// graceful pending/unavailable note while (or if) LLM enrichment hasn't landed.

import { useTranslations } from 'next-intl';
import type { IEQuestionAnalysisItem } from '../../../lib/api/interviewEngine';
import { QuestionBreakdownItem } from './QuestionBreakdownItem';

interface Props {
  items: IEQuestionAnalysisItem[] | null;
  enrichmentPending?: boolean;
}

export function QuestionBreakdownSection({ items, enrichmentPending }: Props) {
  const t = useTranslations('ie');

  // null → enrichment hasn't produced this section. [] → nothing to show.
  const showPlaceholder = items === null;
  if (!showPlaceholder && items!.length === 0) return null;

  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
          {t('report.questionBreakdown.title')}
        </h2>
        {!showPlaceholder ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' }}>
            {t('report.questionBreakdown.count', { count: items!.length })}
          </span>
        ) : null}
      </div>

      {showPlaceholder ? (
        <div
          style={{
            border: '1px dashed var(--rule)',
            borderRadius: 12,
            padding: '18px 16px',
            color: 'var(--text-2)',
            fontSize: 13.5,
          }}
        >
          {enrichmentPending
            ? t('report.questionBreakdown.pending')
            : t('report.questionBreakdown.unavailable')}
        </div>
      ) : (
        items!.map((item, i) => (
          <QuestionBreakdownItem key={item.questionIndex} item={item} defaultOpen={i === 0} />
        ))
      )}
    </section>
  );
}
