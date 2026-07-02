'use client';

// RecommendationsCard — the concrete, prioritized action plan. Each item shows
// a priority badge, an imperative title, a grounded detail, a before→after
// example rewrite, and (optionally) a specific drill + a linked-dimension tag.
// All LLM prose renders through the sanitized Markdown primitive.

import { useTranslations } from 'next-intl';
import type {
  IERecommendation,
  IERecommendationPriority,
} from '../../../lib/api/interviewEngine';
import { Markdown } from '../primitives/Markdown';
import { Pill, type PillTone } from '../primitives/Pill';

interface Props {
  recommendations: IERecommendation[] | null;
  enrichmentPending?: boolean;
}

const PRIORITY_TONE: Record<IERecommendationPriority, PillTone> = {
  high: 'warn',
  medium: 'accent',
  low: 'muted',
};

export function RecommendationsCard({ recommendations, enrichmentPending }: Props) {
  const t = useTranslations('ie');
  const showPlaceholder = recommendations === null;

  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
          {t('report.recommendations.title')}
        </h2>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' }}>
          {t('report.recommendations.sub')}
        </span>
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
            ? t('report.recommendations.pending')
            : t('report.recommendations.unavailable')}
        </div>
      ) : recommendations!.length === 0 ? (
        <div
          style={{
            border: '1px solid var(--rule)',
            borderRadius: 12,
            padding: '18px 16px',
            color: 'var(--text-2)',
            fontSize: 13.5,
            background: 'var(--surface)',
          }}
        >
          {t('report.recommendations.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {recommendations!.map((rec, i) => (
            <div
              key={i}
              style={{
                border: '1px solid var(--rule)',
                borderRadius: 12,
                padding: 18,
                background: 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <Pill tone={PRIORITY_TONE[rec.priority] ?? 'accent'}>
                  {t(`report.recommendations.priority.${rec.priority}`)}
                </Pill>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{rec.title}</span>
                {rec.linkedDimension ? (
                  <span
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
                    {t(`report.dim.${rec.linkedDimension}`)}
                  </span>
                ) : null}
              </div>

              <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
                <Markdown block>{rec.detail}</Markdown>
              </div>

              <div
                style={{
                  marginTop: 12,
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  borderRadius: 10,
                  padding: '12px 14px',
                }}
              >
                <div className="qb-section-label">{t('report.recommendations.exampleLabel')}</div>
                <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
                  <Markdown block>{rec.example}</Markdown>
                </div>
              </div>

              {rec.drill ? (
                <div
                  style={{
                    marginTop: 10,
                    background: 'var(--accent-soft)',
                    border: '1px solid var(--accent-text)',
                    borderRadius: 10,
                    padding: '12px 14px',
                  }}
                >
                  <div className="qb-section-label">{t('report.recommendations.drill')}</div>
                  <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
                    <Markdown block>{rec.drill}</Markdown>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
