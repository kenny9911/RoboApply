'use client';

// IngestRecap — "What your resume says".
//
// Moved here from components/v3/onboarding/ with the panel rewrite. This is
// NOT a spinner and it is not decoration: it is the evidence that earns the
// prefill on step 2. A user who watched their own job titles, employers and
// education appear one line at a time has already been told why the next
// screen knows things about them, so the prefilled chips read as a reading
// rather than a guess.
//
// The rows are built server-side from the parsed resume (`buildIngestRows`) —
// there is no fake-data state. While the bootstrap is in flight (`rows ===
// null`) it shows a skeleton; once rows arrive they reveal one at a time, and
// instantly when the reader prefers reduced motion.
//
// COPY: the two status strings moved with the component. This block used to
// call `reading_resume` and `upload_reading`; the rewritten `jobs.setup` block
// does not carry either key, and next-intl renders the literal dotted path
// rather than throwing, so leaving them would have shipped the string
// "jobs.setup.upload_reading" to production in all nine locales. Both call
// sites now read `reading_title`.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconCheck } from '../primitives/Iconset';
import type { IngestRow } from '../../../lib/api/v2/types';

interface Props {
  /** Real ingest rows from bootstrap/session — `null` while loading. */
  rows: IngestRow[] | null;
}

const REVEAL_BASE_MS = 350;
const REVEAL_STEP_MS = 380;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function IngestRecap({ rows }: Props) {
  const t = useTranslations('jobs.setup');
  const [visibleCount, setVisibleCount] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (!rows || rows.length === 0) {
      setVisibleCount(0);
      return;
    }
    if (prefersReducedMotion()) {
      setVisibleCount(rows.length);
      return;
    }
    setVisibleCount(0);
    rows.forEach((_row, i) => {
      const timer = setTimeout(
        () => setVisibleCount((cur) => Math.max(cur, i + 1)),
        REVEAL_BASE_MS + i * REVEAL_STEP_MS,
      );
      timers.current.push(timer);
    });
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [rows]);

  return (
    <div className="ingest" style={{ textAlign: 'left' }}>
      <div className="ingest-title">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M12 2 9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7Z" />
        </svg>
        {t('upload_ingest_title')}
      </div>

      {rows === null ? (
        // Skeleton while the bootstrap is in flight.
        <div aria-label={t('reading_title')}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="ingest-row pending">
              <div className="ic">
                <div className="spinner" />
              </div>
              <div
                style={{
                  height: 10,
                  width: `${52 - i * 10}%`,
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--surface-3)',
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <>
          {rows.slice(0, visibleCount).map((row) => (
            <div
              key={row.id}
              className="ingest-row"
              style={{ animation: 'expand 0.25s ease' }}
            >
              <div className="ic">
                <IconCheck size={12} strokeWidthValue={3.5} />
              </div>
              <div>{row.label}</div>
              <div className="extracted">{row.value}</div>
            </div>
          ))}
          {visibleCount < rows.length ? (
            <div className="ingest-row pending">
              <div className="ic">
                <div className="spinner" />
              </div>
              <div>{t('reading_title')}</div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
