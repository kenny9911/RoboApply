'use client';

// DimensionList — "What we compared" (PRODUCT F-MATCH-01; ruling C6). The five
// published parts with their weights, each part's score out of 100 or "Not
// enough to compare", and the evidence behind it: deterministic facts (named
// by `ref`) or verbatim quotes from your resume or the job post. Nothing here
// is a hiring probability.

import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import type { MatchDimension } from '../../../lib/api/contracts/match';
import { useEvidenceText } from './labels';
import styles from './match.module.css';

/** The order the parts are published in (server MATCH_DIMENSION_KEYS). */
export const DIMENSION_ORDER: readonly MatchDimension['key'][] = ['title_level', 'skills', 'industry', 'logistics', 'career_path'];

export interface DimensionListProps {
  dimensions: MatchDimension[];
  /** Render the section heading (default true). */
  withHeading?: boolean;
}

export function DimensionList({ dimensions, withHeading = true }: DimensionListProps) {
  const t = useTranslations('fit.compared');
  const tCn = useTranslations('jobsCn.fit');
  // GoApply compares location and pay only: there is no visa check on the mainland market, so the part is not named after one.
  const cn = useBrand().market === 'cn';
  const evidenceText = useEvidenceText();
  const byKey = new Map(dimensions.map((d) => [d.key, d]));
  const ordered = DIMENSION_ORDER.map((k) => byKey.get(k)).filter((d): d is MatchDimension => !!d);
  return (
    <section className={styles.section} aria-labelledby={withHeading ? 'fit-compared-heading' : undefined} data-testid="fit-dimensions">
      {withHeading ? (
        <>
          <h3 id="fit-compared-heading" className={styles.heading}>
            {t('title')}
          </h3>
          <p className={styles.intro}>{t('intro')}</p>
        </>
      ) : null}
      <ul className={styles.parts}>
        {ordered.map((d) => {
          const label = cn && d.key === 'logistics' ? tCn('logistics') : t(`keys.${d.key}`);
          const scored = d.status === 'scored' && typeof d.score === 'number';
          return (
            <li key={d.key} className={styles.part} data-part={d.key} data-status={d.status}>
              <div className={styles.partHead}>
                <span className={styles.partLabel}>{label}</span>
                <span className={styles.partMeta}>
                  {scored ? `${d.score} / 100 · ` : ''}
                  {t('weight', { weight: d.weight })}
                </span>
              </div>
              {scored ? (
                <div
                  className={styles.track}
                  role="meter"
                  aria-label={t('partLabel', { label, score: d.score! })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={d.score!}
                >
                  <span className={styles.fill} style={{ width: `${d.score}%` }} />
                </div>
              ) : (
                <p className={styles.muted}>{t('notStated')}</p>
              )}
              {d.evidence.length ? (
                <ul className={styles.evidence}>
                  {d.evidence.map((e, i) => (
                    <li key={`${d.key}-${i}`} className={styles.evidenceItem}>
                      <span className={styles.source}>{t(`source.${e.source}`)}</span>
                      <span>{evidenceText(e)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
