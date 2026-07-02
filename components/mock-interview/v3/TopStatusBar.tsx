'use client';

// TopStatusBar — sticky top strip for the Live page.
//
//   ←  Back to setup        ● LIVE  Senior PM · Behavioral · 📹 Video · 00:16        ─ ─ ─ ─ ─
//
// Left: back link. Center: live status group (red LIVE pill + meta crumbs +
// blinking timer). Right: per-question progress pips (lime when reached).

import Link from 'next/link';
import { ArrowLeftIcon, VideoCameraIcon } from '@heroicons/react/24/outline';
import { cn } from '../../../lib/utils';

interface Props {
  /** Track title (e.g. "Senior PM"). */
  trackTitle: string;
  /** Format label (e.g. "Behavioral"). */
  formatLabel: string;
  /** Recorded video / audio-only descriptor. */
  modeLabel?: string;
  /** Tick of the elapsed-time clock (seconds). */
  elapsedSec: number;
  /** 0-indexed current question. */
  currentIndex: number;
  /** Total questions. */
  total: number;
  /** Back-target href. */
  backHref?: string;
}

function formatClock(sec: number): string {
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return `${String(mm).padStart(2, '0')}:${ss}`;
}

export function TopStatusBar({
  trackTitle,
  formatLabel,
  modeLabel = 'Video',
  elapsedSec,
  currentIndex,
  total,
  backHref = '/mock-interview',
}: Props) {
  return (
    <header className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 py-4 md:px-8 md:py-5">
      {/* LEFT — Back */}
      <div className="flex items-center">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:text-white"
          style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          Back to setup
        </Link>
      </div>

      {/* CENTER — Live cluster */}
      <div className="flex items-center gap-3">
        {/* LIVE pill */}
        <span
          className="dc-mono inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em]"
          style={{
            color: '#ef4444',
            borderColor: 'rgba(239,68,68,0.55)',
            background: 'rgba(239,68,68,0.05)',
          }}
        >
          <span
            aria-hidden="true"
            className="relative inline-flex h-1.5 w-1.5 items-center justify-center rounded-full"
            style={{ background: '#ef4444' }}
          >
            <span className="dc-tick absolute inset-0 rounded-full" style={{ background: '#ef4444' }} />
          </span>
          Live
        </span>

        {/* Crumb: track */}
        <span className="text-[13.5px] font-semibold whitespace-nowrap" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          {trackTitle}
        </span>
        <Dot />
        {/* Format */}
        <span className="text-[13.5px] whitespace-nowrap" style={{ color: 'var(--dc-ink-2, #c9c9d4)' }}>
          {formatLabel}
        </span>
        <Dot />
        {/* Mode w/ icon */}
        <span
          className="inline-flex items-center gap-1.5 text-[13.5px] whitespace-nowrap"
          style={{ color: 'var(--dc-accent, #c6ff3a)' }}
        >
          <VideoCameraIcon className="h-4 w-4" aria-hidden="true" />
          {modeLabel}
        </span>
        <Dot />
        {/* Clock */}
        <span
          className="dc-mono text-[14px] font-bold whitespace-nowrap"
          style={{ color: 'var(--dc-accent, #c6ff3a)' }}
        >
          {formatClock(elapsedSec)}
        </span>
      </div>

      {/* RIGHT — Progress pips */}
      <div className="flex items-center justify-end gap-1.5" aria-label={`Question ${currentIndex + 1} of ${total}`}>
        {Array.from({ length: total }, (_, i) => {
          const reached = i <= currentIndex;
          return (
            <span
              key={i}
              className="block h-[3px] rounded-full transition-all"
              style={{
                width: i === currentIndex ? 36 : 28,
                background: reached
                  ? 'var(--dc-accent, #c6ff3a)'
                  : 'rgba(255,255,255,0.12)',
                boxShadow:
                  i === currentIndex
                    ? '0 0 8px var(--dc-accent, #c6ff3a)'
                    : undefined,
              }}
            />
          );
        })}
      </div>
    </header>
  );
}

function Dot() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1 w-1 rounded-full"
      style={{ background: 'var(--dc-ink-4, #5a5a6e)' }}
    />
  );
}
