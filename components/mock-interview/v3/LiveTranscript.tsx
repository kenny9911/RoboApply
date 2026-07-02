'use client';

// LiveTranscript — color-coded conversation log under the video tile.
//
//   LIVE TRANSCRIPT                                         AUTO-SAVED
//   ─────────────────────────────────────────────────────────────────
//   DR.       Walk me through a product decision you made
//   VOSS      that you'd reverse today. Why?
//
//   YOU       At Mavn we shipped a clinician inbox redesign…
//
// Speaker labels are mono uppercase, lime-tinted for the interviewer,
// violet-tinted for the candidate. A trailing "…" three-dot indicator
// signals that the AI is currently speaking / processing.

import { useEffect, useRef } from 'react';
import type { MockTurn } from '../../../lib/mockInterview/types';
import { cn } from '../../../lib/utils';

interface Props {
  turns: MockTurn[];
  /** Name to render in the interviewer column (e.g. "Dr. Voss"). */
  interviewerName: string;
  /** Whether the AI is currently speaking (renders the streaming dots). */
  interviewerSpeaking?: boolean;
  className?: string;
}

export function LiveTranscript({
  turns,
  interviewerName,
  interviewerSpeaking = false,
  className,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, interviewerSpeaking]);

  const interviewerSlug = interviewerName
    .replace(/^Dr\.?\s+/i, 'Dr. ')
    .toUpperCase();

  return (
    <section
      className={cn('overflow-hidden rounded-[24px] border', className)}
      style={{
        background: 'var(--dc-surface, #181822)',
        borderColor: 'var(--dc-edge, rgba(255,255,255,0.06))',
      }}
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--dc-edge, rgba(255,255,255,0.06))' }}>
        <p className="dc-mono text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--dc-ink-2, #c9c9d4)' }}>
          Live Transcript
        </p>
        <p
          className="dc-mono inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}
        >
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: 'var(--dc-accent, #c6ff3a)',
              boxShadow: '0 0 6px var(--dc-accent, #c6ff3a)',
            }}
          />
          Auto-saved
        </p>
      </header>

      {/* Body */}
      <div
        ref={scrollerRef}
        className="flex max-h-[420px] flex-col gap-5 overflow-y-auto px-5 py-5"
      >
        {turns.length === 0 ? (
          <p className="dc-serif italic text-sm" style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}>
            The interviewer will start in a moment…
          </p>
        ) : null}

        {turns.map((t) => (
          <Line key={t.id} turn={t} interviewerSlug={interviewerSlug} />
        ))}

        {interviewerSpeaking ? (
          <div className="flex items-start gap-4 pl-[88px]">
            <StreamingDots />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Line({ turn, interviewerSlug }: { turn: MockTurn; interviewerSlug: string }) {
  const isInterviewer = turn.role === 'interviewer';
  const label = isInterviewer ? interviewerSlug : 'You';
  const labelColor = isInterviewer ? 'var(--dc-accent, #c6ff3a)' : 'var(--dc-secondary, #b691ff)';

  // The label sits in its own narrow column (~72px). Multi-word labels
  // (e.g. "DR. VOSS") wrap onto two lines like in the screenshot.
  return (
    <div className="grid grid-cols-[72px_1fr] gap-4">
      <span
        className="dc-mono text-[11px] font-semibold uppercase tracking-[0.14em] leading-tight"
        style={{ color: labelColor }}
      >
        {label}
      </span>
      <p
        className="text-[14.5px] leading-relaxed"
        style={{ color: isInterviewer ? 'var(--dc-ink, #f5f5fa)' : 'var(--dc-ink-2, #c9c9d4)' }}
      >
        {turn.followUp ? (
          <span className="dc-serif italic mr-1 text-[12px] opacity-75">follow-up · </span>
        ) : null}
        {turn.text}
      </p>
    </div>
  );
}

function StreamingDots() {
  return (
    <span className="inline-flex gap-1" aria-label="Interviewer is composing a response">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block h-1.5 w-1.5 rounded-full"
          style={{
            background: 'var(--dc-ink-3, #8a8a9c)',
            animation: `dc-orb-breathe 1.2s ease-in-out infinite`,
            animationDelay: `${i * 150}ms`,
          }}
        />
      ))}
    </span>
  );
}
