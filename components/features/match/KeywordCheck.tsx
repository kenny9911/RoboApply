'use client';

// KeywordCheck — requirement rows (PRODUCT F-RES-08): job title, years,
// education, skills n/m, keywords n/m, each Met / Partly met / Not met, or
// "Not stated in the post" / "Not shown on your resume" (never counted as a
// miss). Deterministic and free; the 0–100 fit score stays the only number.

import { useTranslations } from 'next-intl';

import { useKeywordCheck } from '../../../hooks/match';
import type { KeywordRow, KeywordRowStatus } from '../../../lib/api/contracts/match';
import { useDegreeLabel } from './labels';
import styles from './match.module.css';

const STATUS_CLASS: Partial<Record<KeywordRowStatus, string>> = {
  met: styles.statusMet,
  partly: styles.statusPartly,
  not_met: styles.statusNotMet,
};

export interface KeywordCheckProps {
  rows: KeywordRow[];
}

export function KeywordCheck({ rows }: KeywordCheckProps) {
  const t = useTranslations('fit.keywordCheck');
  const degree = useDegreeLabel();
  return (
    <section className={styles.section} aria-labelledby="fit-keywords-heading" data-testid="fit-keyword-check">
      <h3 id="fit-keywords-heading" className={styles.heading}>
        {t('title')}
      </h3>
      <p className={styles.intro}>{t('intro')}</p>
      <ul className={styles.rows}>
        {rows.map((r) => (
          <li key={r.key} className={styles.row} data-row={r.key} data-status={r.status}>
            <span className={styles.rowLabel}>{t(`rows.${r.key}`)}</span>
            <span className={[styles.status, STATUS_CLASS[r.status]].filter(Boolean).join(' ')}>{t(`status.${r.status}`)}</span>
            <RowDetail row={r} degree={degree} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RowDetail({ row, degree }: { row: KeywordRow; degree: ReturnType<typeof useDegreeLabel> }) {
  const t = useTranslations('fit.keywordCheck');
  const lines: string[] = [];
  if (row.key === 'title') {
    if (row.need !== null) lines.push(t('titleNeed', { need: String(row.need) }));
    if (row.have !== null) lines.push(t('titleHave', { have: String(row.have) }));
  } else if (row.key === 'years') {
    if (row.need !== null) lines.push(t('yearsNeed', { need: Number(row.need) }));
    if (row.have !== null) lines.push(t('yearsHave', { have: Number(row.have) }));
  } else if (row.key === 'education') {
    const need = degree(row.need);
    const have = degree(row.have);
    if (need) lines.push(need);
    if (have && row.status !== 'not_stated') lines.push(have);
  } else if (row.total !== null && row.found !== null) {
    lines.push(t('count', { found: row.found, total: row.total }));
  }
  if (!lines.length && !row.items.length) return null;
  return (
    <div className={styles.rowDetail}>
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
      {row.items.length ? (
        <ul className={styles.chips}>
          {row.items.map((it) => (
            <li
              key={it.term}
              className={`${styles.chip} ${it.found ? styles.chipHave : styles.chipMissing}`}
              aria-label={`${it.term}: ${it.found ? t('mentioned') : t('notMentioned')}${it.required ? ` (${t('required')})` : ''}`}
            >
              <span className={styles.chipMark} aria-hidden="true">
                {it.found ? '✓' : '–'}
              </span>
              <span aria-hidden="true">{it.term}</span>
              {it.required ? (
                <span className={styles.source} aria-hidden="true">
                  {t('required')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The keyword check for a job, loaded through hooks/match. */
export function JobKeywordCheck({ jobId, resumeVariantId }: { jobId: string; resumeVariantId?: string | null }) {
  const t = useTranslations('fit.keywordCheck');
  const q = useKeywordCheck(jobId, { resumeVariantId });
  if (q.isPending) {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p className={styles.alert} role="alert">
        {t('error')}
      </p>
    );
  }
  return <KeywordCheck rows={q.data.rows} />;
}
