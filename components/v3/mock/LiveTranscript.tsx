'use client';

// LiveTranscript — the streaming transcript panel (proto `.iv-transcript`). One
// `.iv-line` per turn, colored by author (interviewer = accent, you = violet).
// Shows a typing indicator while the interviewer is "listening" after a
// candidate turn. Turn text is LLM/stub-authored → sanitized Markdown.

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Markdown } from '../primitives/Markdown';
import type { RAMockTurn } from '../../../lib/api/v2/types';

interface Props {
  turns: RAMockTurn[];
  interviewerName: string;
  /** Show the 3-dot typing indicator (interviewer composing). */
  typing: boolean;
}

export function LiveTranscript({ turns, interviewerName, typing }: Props) {
  const t = useTranslations('mock');
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest turn.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, typing]);

  return (
    <div className="iv-transcript">
      <div className="iv-transcript-head">
        <span>{t('live.transcript')}</span>
        <span style={{ color: 'var(--muted)' }}>{t('live.autoSaved')}</span>
      </div>
      <div className="iv-transcript-body" ref={bodyRef}>
        {turns.length === 0 ? (
          <div className="iv-transcript-empty">{t('live.transcriptEmpty')}</div>
        ) : null}
        {turns.map((line, i) => (
          <div key={i} className={`iv-line iv-line-${line.who}`}>
            <span className="iv-line-who">
              {line.who === 'them' ? interviewerName : t('live.you')}
            </span>
            <span className="iv-line-text">
              <Markdown>{line.text}</Markdown>
            </span>
          </div>
        ))}
        {typing ? (
          <div className="iv-typing">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
    </div>
  );
}
