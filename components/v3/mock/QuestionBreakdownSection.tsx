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
  /** The report page supplies its own disclosure summary. Default true keeps
   *  the standalone component and its existing tests/back-compat unchanged. */
  showHeading?: boolean;
  /** Open the first question when the section itself is already visible. */
  defaultOpenFirst?: boolean;
}

export function QuestionBreakdownSection({
  items,
  enrichmentPending,
  showHeading = true,
  defaultOpenFirst = true,
}: Props) {
  const t = useTranslations('practice');

  // null → enrichment hasn't produced this section. [] → nothing to show.
  const showPlaceholder = items === null;
  if (!showPlaceholder && items!.length === 0) return null;

  return (
    <section style={{ marginTop: showHeading ? 28 : 0 }}>
      {showHeading ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <h2 style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color: 'var(--text)', margin: 0 }}>
            {t('report.questionBreakdown.title')}
          </h2>
          {!showPlaceholder ? (
            <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-2)' }}>
              {t('report.questionBreakdown.count', { count: items!.length })}
            </span>
          ) : null}
        </div>
      ) : null}

      {showPlaceholder ? (
        <div
          style={{
            border: '1px dashed var(--rule)',
            borderRadius: 12,
            padding: '18px 16px',
            color: 'var(--text-2)',
            fontSize: 'var(--fs-meta)',
          }}
        >
          {enrichmentPending
            ? t('report.questionBreakdown.pending')
            : t('report.questionBreakdown.unavailable')}
        </div>
      ) : (
        items!.map((item, i) => (
          <QuestionBreakdownItem
            key={item.questionIndex}
            item={item}
            defaultOpen={defaultOpenFirst && i === 0}
          />
        ))
      )}
    </section>
  );
}
