'use client';

// TranscriptViewer — the "View transcript" surface on the report. Instead of a
// flat interviewer/candidate turn dump, it groups the transcript into
// EXCHANGES (one interviewer prompt + the answer it drew) so the record reads
// as the question-and-answer pairs the interview actually was. Collapsed by
// default behind an explicit toggle — the question-by-question review is the
// primary coaching surface; this is the verbatim backup a user opens on demand.
//
// All turn text renders through the sanitized Markdown primitive (the only
// approved path for transcript text — project-wide XSS rule).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import type { IETranscriptTurn } from '../../../lib/api/interviewEngine';
import { Markdown } from '../primitives/Markdown';

interface Exchange {
  interviewer: string[];
  candidate: string[];
}

/** Group turns into (interviewer prompt → the answer it drew) exchanges. A new
 *  interviewer turn AFTER a candidate has answered opens a fresh exchange, so a
 *  follow-up probe reads as its own Q&A block. Interim + system turns dropped. */
export function groupTranscript(turns: IETranscriptTurn[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;
  for (const turn of turns) {
    if (turn.interim || turn.role === 'system') continue;
    const text = (turn.text ?? '').trim();
    if (!text) continue;
    if (turn.role === 'interviewer') {
      if (!current || current.candidate.length > 0) {
        current = { interviewer: [], candidate: [] };
        exchanges.push(current);
      }
      current.interviewer.push(text);
    } else {
      if (!current) {
        current = { interviewer: [], candidate: [] };
        exchanges.push(current);
      }
      current.candidate.push(text);
    }
  }
  return exchanges;
}

interface Props {
  turns: IETranscriptTurn[];
  transcriptUrl?: string | null;
  /** Start expanded. Default false — the toggle is the "View transcript" CTA. */
  defaultOpen?: boolean;
}

const turnLabel = (text: string, color: string) => (
  <span style={{ fontSize: 12, fontWeight: 600, color }}>{text}</span>
);

export function TranscriptViewer({ turns, transcriptUrl, defaultOpen = false }: Props) {
  const t = useTranslations('ie');
  const [open, setOpen] = useState(defaultOpen);

  const exchanges = groupTranscript(turns);
  // No groupable Q&A (e.g. a degenerate/aborted session whose only turns are
  // system/interim). The old flat transcript still surfaced a Download link
  // whenever a transcript file existed — preserve that affordance rather than
  // hiding the file entirely.
  if (exchanges.length === 0) {
    if (!transcriptUrl) return null;
    return (
      <section style={{ marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{t('report.transcript')}</span>
        <a
          href={transcriptUrl}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: 'var(--accent-text)' }}
        >
          <ArrowDownTrayIcon style={{ width: 14, height: 14 }} />
          {t('report.download')}
        </a>
      </section>
    );
  }

  return (
    <section style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--text)',
            fontSize: 15,
            fontWeight: 700,
          }}
        >
          <ChevronDownIcon
            style={{ width: 16, height: 16, color: 'var(--text-2)', transition: 'transform 0.18s ease', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
          {open ? t('report.transcriptHide') : t('report.transcriptView')}
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500, color: 'var(--text-2)' }}>
            {t('report.transcriptCount', { count: exchanges.length })}
          </span>
        </button>
        {transcriptUrl ? (
          <a
            href={transcriptUrl}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: 'var(--accent-text)' }}
          >
            <ArrowDownTrayIcon style={{ width: 14, height: 14 }} />
            {t('report.download')}
          </a>
        ) : null}
      </div>

      {open ? (
        <div
          style={{
            marginTop: 12,
            border: '1px solid var(--rule)',
            borderRadius: 'var(--r-xl, 16px)',
            background: 'var(--surface)',
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          {exchanges.map((ex, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {i > 0 ? <div style={{ height: 1, background: 'var(--rule)', margin: '0 0 2px' }} /> : null}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', fontWeight: 600 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              {ex.interviewer.map((text, j) => (
                <div key={`i-${j}`}>
                  {turnLabel(t('live.interviewer'), 'var(--text-2)')}
                  <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text)', marginTop: 2 }}>
                    <Markdown block>{text}</Markdown>
                  </div>
                </div>
              ))}
              {ex.candidate.map((text, j) => (
                <div
                  key={`c-${j}`}
                  style={{
                    borderLeft: '3px solid var(--accent-text)',
                    paddingLeft: 12,
                  }}
                >
                  {turnLabel(t('live.you'), 'var(--accent-text)')}
                  <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text)', marginTop: 2 }}>
                    <Markdown block>{text}</Markdown>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
