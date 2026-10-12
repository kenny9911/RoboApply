'use client';

// components/features/common/SourceNote.tsx — the one source line for every
// number that is not the user's own (D3; ARCHITECTURE.md §2.14; TASK_PLAN.md
// §2.2).
//
//   <SourcedValue value={job.payMedian} format={(v) => money(v)} />  →  "$142,000" or "—"
//   <SourceNote sourced={job.payMedian} />                          →  "Source: jobs in our index · 212 posts · as of 3 Oct 2026"
//
// Rules it enforces:
//   • unknown renders "—" (SourcedValue), never 0;
//   • `method: 'ai_estimate'` (or source 'ai_estimate' / 'ai') renders the word
//     "Estimate" and the method sentence;
//   • an aggregate (one with `sampleSize`) is suppressed below MIN_SAMPLE:
//     the value renders "—" and the note says there is not enough data yet;
//     at or above it the note shows N.
//
// MIN_SAMPLE is the client twin of server/src/platform/http.ts `MIN_SAMPLE`
// (a parity test keeps them equal).

import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

/** One sample rule: aggregates need at least this many rows in one currency and period. */
export const MIN_SAMPLE = 20;

/** Wire shape of a sourced value (server `Sourced<T>`). */
export interface SourcedLike<T = unknown> {
  value: T;
  source: string;
  sampleSize?: number;
  asOf: string;
  method?: string;
  url?: string;
}

/** Source tags whose labels name a real source (ICU param, never a bundle literal). */
const SOURCE_NAMES: Record<string, string> = {
  'bank:robohire': 'RoboHire',
  'bank:gohire': 'GoHire',
};

/** Key under `nav.source.label` for a source tag. */
export function sourceLabelKey(source: string): string {
  if (source in SOURCE_NAMES) return 'bank';
  if (source.startsWith('provider')) return 'provider';
  switch (source) {
    case 'posting':
    case 'employer':
    case 'public_record':
    case 'user':
    case 'company_website':
    case 'dol_lca':
    // Questions (or other facts) our own users shared and staff checked.
    case 'user_reports':
      return source;
    case 'index':
    case 'aggregate':
      return 'index';
    case 'ai':
    case 'ai_estimate':
      return 'ai';
    default:
      return 'other';
  }
}

export function isEstimate(s: Pick<SourcedLike, 'source' | 'method'>): boolean {
  return s.method === 'ai_estimate' || s.source === 'ai_estimate' || s.source === 'ai';
}

/** True when the value is an aggregate below the sample rule (must not be shown). */
export function isSuppressed(s: Pick<SourcedLike, 'sampleSize'>, min: number = MIN_SAMPLE): boolean {
  if (s.sampleSize === undefined || s.sampleSize === null) return false;
  return !(Number.isFinite(s.sampleSize) && s.sampleSize >= min);
}

/** True when the value may be shown: present and not suppressed. */
export function isPublishable<T>(s: SourcedLike<T> | null | undefined, min: number = MIN_SAMPLE): s is SourcedLike<T> {
  return s != null && s.value !== null && s.value !== undefined && !isSuppressed(s, min);
}

export interface SourceNoteProps {
  sourced: SourcedLike | null | undefined;
  /** Override the sample rule (never lower it below MIN_SAMPLE in product code). */
  minSample?: number;
  /** Noun for the sample count; default "posts". */
  sampleNoun?: 'posts' | 'filings' | 'companies';
  className?: string;
}

/** The source line. Renders nothing for a missing value (the value itself shows "—"). */
export function SourceNote({ sourced, minSample = MIN_SAMPLE, sampleNoun = 'posts', className }: SourceNoteProps) {
  const t = useTranslations('nav.source');
  const format = useFormatter();
  if (!sourced) return null;

  if (isSuppressed(sourced, minSample)) {
    return (
      <p className={className} data-source-note="suppressed">
        {t('not_enough', { min: minSample })}
      </p>
    );
  }

  const parts: ReactNode[] = [];
  const estimate = isEstimate(sourced);
  // A source whose label the loaded bundle does not carry (a bundle older than
  // the code during a deploy) reads "another source", never a raw key path.
  const wanted = sourceLabelKey(sourced.source);
  const labelKey = typeof t.has !== 'function' || t.has(`label.${wanted}`) ? wanted : 'other';
  parts.push(
    <span key="src">
      {t('source', { label: t(`label.${labelKey}`, { sourceName: SOURCE_NAMES[sourced.source] ?? '' }) })}
    </span>,
  );
  if (typeof sourced.sampleSize === 'number') {
    parts.push(<span key="n">{t(`sample.${sampleNoun}`, { count: sourced.sampleSize })}</span>);
  }
  const asOf = new Date(sourced.asOf);
  if (!Number.isNaN(asOf.getTime())) {
    parts.push(<span key="asof">{t('as_of', { date: format.dateTime(asOf, { dateStyle: 'medium' }) })}</span>);
  }

  return (
    <p className={className} data-source-note={estimate ? 'estimate' : 'sourced'}>
      {estimate ? (
        <>
          <strong>{t('estimate')}</strong> {t('estimate_method')}{' '}
        </>
      ) : null}
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ' · ' : null}
          {p}
        </span>
      ))}
      {sourced.url ? (
        <>
          {' · '}
          <a href={sourced.url} target="_blank" rel="noopener noreferrer">
            {t('view')}
          </a>
        </>
      ) : null}
    </p>
  );
}

export interface SourcedValueProps<T> {
  value: SourcedLike<T> | null | undefined;
  format?: (v: T) => ReactNode;
  minSample?: number;
}

/** The value itself: formatted when publishable, "—" otherwise (never 0). */
export function SourcedValue<T>({ value, format, minSample = MIN_SAMPLE }: SourcedValueProps<T>) {
  if (!isPublishable(value, minSample)) return <>—</>;
  return <>{format ? format(value.value) : String(value.value)}</>;
}
