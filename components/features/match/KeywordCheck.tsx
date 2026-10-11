'use client';

// KeywordCheck — requirement rows (PRODUCT F-RES-08; SM-6): job title, years,
// education, skills, keywords, each Met / Partly met / Not met, or "Not stated
// in the post" / "Not shown on your resume" (never counted as a miss).
// Deterministic and free; the 0–100 fit score stays the only number.
//
// Every skill and keyword has one of three states, each in its own words:
//
//   ✓ TypeScript      Your resume shows it
//                     “Rewrote the billing service in TypeScript.”   ← the sentence, when the text has it
//   ≈ Relational …    Related: your resume shows PostgreSQL          ← you decide whether to add the exact term
//   – Kubernetes      Not in your resume
//
// A state is a statement about the resume, never a verdict on the person. A
// skill nothing may be said about (nobody has reviewed it yet, or the resume's
// only trace of it is a word with another reading) is not listed at all: the
// row says how many were left out, and a row that lists nothing for that
// reason reads "Not checked yet", never "Not stated in the post". Nothing here
// edits a resume: the one action opens the person's own resume for this job.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useKeywordCheck } from '../../../hooks/match';
import { tailorHref } from '../../../hooks/shared/useLaunchTailor';
import type { KeywordItem, KeywordRow, KeywordRowStatus, KeywordState } from '../../../lib/api/contracts/match';
import { useFlag } from '../../../lib/flags';
import { plainQuote, useDegreeLabel } from './labels';
import styles from './match.module.css';

const STATUS_CLASS: Partial<Record<KeywordRowStatus, string>> = {
  met: styles.statusMet,
  partly: styles.statusPartly,
  not_met: styles.statusNotMet,
};

const STATE_CLASS: Record<KeywordState, string> = {
  shown: styles.termShown,
  related: styles.termRelated,
  not_shown: styles.termMissing,
};

const STATE_MARK: Record<KeywordState, string> = { shown: '✓', related: '≈', not_shown: '–' };

/**
 * The state of an item. An answer written before the three states existed
 * carries `found` (and `via`) only: it reads the same way.
 */
export function keywordState(item: Pick<KeywordItem, 'found'> & Partial<Pick<KeywordItem, 'state' | 'via'>>): KeywordState {
  if (item.state === 'shown' || item.state === 'related' || item.state === 'not_shown') return item.state;
  return item.found ? (item.via ? 'related' : 'shown') : 'not_shown';
}

/** How many items of a row are shown, related and listed. */
export function keywordCounts(items: readonly KeywordItem[]): { shown: number; related: number; total: number } {
  let shown = 0;
  let related = 0;
  for (const it of items) {
    const state = keywordState(it);
    if (state === 'shown') shown += 1;
    else if (state === 'related') related += 1;
  }
  return { shown, related, total: items.length };
}

/** Does any row hold a term the person may want to add (related or not in the resume)? */
export function hasTermsToAdd(rows: readonly KeywordRow[]): boolean {
  return rows.some((r) => r.items.some((it) => keywordState(it) !== 'shown'));
}

export interface KeywordCheckProps {
  rows: KeywordRow[];
  /** Render the section heading (default true). A caller that prints its own "Keyword check" title passes false. */
  withHeading?: boolean;
  /**
   * Where the person adds a term themselves: their resume for this job. Shown
   * only when a row holds a related or missing term. Never an automatic edit.
   */
  addToResume?: { href: string; label: string } | null;
}

export function KeywordCheck({ rows, withHeading = true, addToResume = null }: KeywordCheckProps) {
  const t = useTranslations('fit.keywordCheck');
  const degree = useDegreeLabel();
  return (
    <section
      className={styles.section}
      aria-labelledby={withHeading ? 'fit-keywords-heading' : undefined}
      aria-label={withHeading ? undefined : t('title')}
      data-testid="fit-keyword-check"
    >
      {withHeading ? (
        <h3 id="fit-keywords-heading" className={styles.heading}>
          {t('title')}
        </h3>
      ) : null}
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
      {addToResume && hasTermsToAdd(rows) ? (
        <div className={styles.actions} data-testid="fit-keyword-add">
          <p className={styles.muted}>{t('add.note')}</p>
          <Link className={styles.link} href={addToResume.href}>
            {addToResume.label}
          </Link>
        </div>
      ) : null}
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
  } else if (row.items.length) {
    lines.push(t('countStates', keywordCounts(row.items)));
  }
  // Skills of the post nobody has reviewed yet: left out of the list, and said so.
  const unchecked = typeof row.unchecked === 'number' && row.unchecked > 0 ? row.unchecked : 0;
  if (!lines.length && !row.items.length && !unchecked) return null;
  return (
    <div className={styles.rowDetail}>
      {/* Keys by position: "what the post asks" and "what you have" can be the same words (本科 / 本科). */}
      {lines.map((l, i) => (
        <span key={`${i}:${l}`}>{l}</span>
      ))}
      {row.items.length ? (
        <ul className={styles.terms}>
          {row.items.map((it, i) => (
            <TermItem key={`${i}:${it.term}`} item={it} />
          ))}
        </ul>
      ) : null}
      {unchecked ? (
        <span className={styles.muted} data-testid="fit-keyword-unchecked">
          {row.items.length ? t('unchecked', { count: unchecked }) : t('uncheckedAll', { count: unchecked })}
        </span>
      ) : null}
    </div>
  );
}

function TermItem({ item }: { item: KeywordItem }) {
  const t = useTranslations('fit.keywordCheck');
  const state = keywordState(item);
  const quote = state === 'shown' && typeof item.quote === 'string' ? plainQuote(item.quote) : '';
  return (
    <li className={`${styles.term} ${STATE_CLASS[state]}`} data-state={state}>
      <div className={styles.termHead}>
        <span className={styles.chipMark} aria-hidden="true">
          {STATE_MARK[state]}
        </span>
        <span className={styles.termName}>{item.term}</span>
        {item.required ? <span className={styles.source}>{t('required')}</span> : null}
      </div>
      {/* Related: what the resume does show, by name; the person decides whether to add the exact term. */}
      <p className={styles.termState}>{state === 'related' ? (item.via ? t('state.related', { term: item.via }) : t('state.relatedPlain')) : t(`state.${state}`)}</p>
      {quote ? <p className={styles.termQuote}>{t('quote', { text: quote })}</p> : null}
    </li>
  );
}

/** The keyword check for a job, loaded through hooks/match. */
export function JobKeywordCheck({ jobId, resumeVariantId, withHeading = true }: { jobId: string; resumeVariantId?: string | null; withHeading?: boolean }) {
  const t = useTranslations('fit.keywordCheck');
  const q = useKeywordCheck(jobId, { resumeVariantId });
  // The existing way to change a resume for a job is tailoring, which needs the brand's AI text. Without it the
  // link opens the person's resumes, where they edit by hand. Either way the person makes the change.
  const canTailor = useFlag('ai.text');
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
  const addToResume = canTailor
    ? { href: tailorHref({ jobId, resumeId: resumeVariantId ?? q.data.resumeVariantId, from: 'keyword_check' }), label: t('add.action') }
    : { href: '/resume', label: t('add.resume') };
  return <KeywordCheck rows={q.data.rows} withHeading={withHeading} addToResume={addToResume} />;
}
