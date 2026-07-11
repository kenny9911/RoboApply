'use client';

// QuestionBreakdownItem — one collapsible question in the per-question deep
// dive. Header shows the index, the question, a RatingChip, and an off-script
// tag for improvised questions. The body shows the candidate's answer, the
// analysis (分析), the correction (纠正), the suggestion (建议), and a model
// answer. All LLM prose renders through the sanitized Markdown primitive.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import type { IEQuestionAnalysisItem } from '../../../lib/api/interviewEngine';
import { Markdown } from '../primitives/Markdown';
import { RatingChip } from './RatingChip';

interface Props {
  item: IEQuestionAnalysisItem;
  defaultOpen?: boolean;
}

const sectionLabel = (text: string) => (
  <div className="qb-section-label">{text}</div>
);

export function QuestionBreakdownItem({ item, defaultOpen = false }: Props) {
  const t = useTranslations('ie');
  const [open, setOpen] = useState(defaultOpen);
  const num = String(item.questionIndex + 1).padStart(2, '0');

  return (
    <details
      className="qb-item"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 12,
        background: 'var(--surface)',
        marginBottom: 10,
        overflow: 'hidden',
      }}
    >
      <summary
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          cursor: 'pointer',
          listStyle: 'none',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)', fontWeight: 600 }}>{num}</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>
          {item.question}
        </span>
        {item.blueprintIndex === null && !item.missed ? (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-2)',
              background: 'var(--surface-2)',
              border: '1px solid var(--rule)',
              borderRadius: 99,
              padding: '2px 8px',
              whiteSpace: 'nowrap',
            }}
          >
            {t('report.questionBreakdown.offScript')}
          </span>
        ) : null}
        <RatingChip rating={item.rating} score={item.score} />
        <ChevronDownIcon className="qb-chevron" style={{ width: 16, height: 16, color: 'var(--text-2)', flexShrink: 0, transition: 'transform 0.18s ease' }} />
      </summary>

      <div style={{ padding: '4px 16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Why they asked — the interviewer's intent. Shown first (even for a
            missed question) so the candidate learns the purpose behind it. */}
        {item.intent ? (
          <div
            style={{
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-text)',
              borderRadius: 10,
              padding: '12px 14px',
            }}
          >
            {sectionLabel(t('report.questionBreakdown.intentLabel'))}
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <Markdown block>{item.intent}</Markdown>
            </div>
          </div>
        ) : null}

        {/* Missed → single explanatory note; otherwise the candidate's words. */}
        {item.missed ? (
          <div style={{ fontSize: 13, color: 'var(--text-2)', fontStyle: 'italic' }}>
            {t('report.questionBreakdown.missed')}
          </div>
        ) : item.keyQuote ? (
          <div>
            {sectionLabel(t('report.questionBreakdown.keyQuoteLabel'))}
            <blockquote
              style={{
                margin: 0,
                padding: '8px 14px',
                borderLeft: '3px solid var(--rule)',
                color: 'var(--text-2)',
                fontSize: 13.5,
                lineHeight: 1.5,
                fontStyle: 'italic',
              }}
            >
              {item.keyQuote}
            </blockquote>
          </div>
        ) : null}

        {!item.missed && item.answerSummary ? (
          <div>
            {sectionLabel(t('report.questionBreakdown.answerSummaryLabel'))}
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <Markdown block>{item.answerSummary}</Markdown>
            </div>
          </div>
        ) : null}

        {item.analysis ? (
          <div>
            {sectionLabel(t('report.questionBreakdown.analysisLabel'))}
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <Markdown block>{item.analysis}</Markdown>
            </div>
          </div>
        ) : null}

        {item.correction ? (
          <div
            style={{
              background: 'var(--warn-soft)',
              border: '1px solid var(--warn)',
              borderRadius: 10,
              padding: '12px 14px',
            }}
          >
            {sectionLabel(t('report.questionBreakdown.correctionLabel'))}
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <Markdown block>{item.correction}</Markdown>
            </div>
          </div>
        ) : null}

        {item.suggestion ? (
          <div>
            {sectionLabel(t('report.questionBreakdown.suggestionLabel'))}
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <Markdown block>{item.suggestion}</Markdown>
            </div>
          </div>
        ) : null}

        {/* Pro tips — the sharp, tactical professional/technical pointers. */}
        {item.tips && item.tips.length ? (
          <div
            style={{
              background: 'var(--ok-soft)',
              border: '1px solid var(--ok)',
              borderRadius: 10,
              padding: '12px 14px',
            }}
          >
            {sectionLabel(t('report.questionBreakdown.tipsLabel'))}
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {item.tips.map((tip, i) => (
                <li key={i} style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
                  <Markdown>{tip}</Markdown>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {item.modelAnswer ? (
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--accent-text)',
              borderRadius: 10,
              padding: '12px 14px',
            }}
          >
            {sectionLabel(t('report.questionBreakdown.modelAnswerLabel'))}
            <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <Markdown block>{item.modelAnswer}</Markdown>
            </div>
          </div>
        ) : null}

        {item.tags && item.tags.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {item.tags.map((tag, i) => (
              <span
                key={i}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  color: 'var(--text-2)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 99,
                  padding: '2px 8px',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
