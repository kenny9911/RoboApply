'use client';

// CoachCard — the silent feedback the user's AI coach drops in mid-answer.
// Visual rebuild of CoachNudge for the new live page:
//   • Lime gradient border + outer glow
//   • Tiny orb on the left, "YOUR COACH · LIVE" eyebrow, italic message
//   • Dismiss X at the top-right
//
// Phase-aware copy stays the same as the old CoachNudge (opening / mid /
// landing based on draft word count) — we keep it because the coach feels
// reactive when the line swaps as the answer grows.

import { useEffect, useMemo, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { cn } from '../../../lib/utils';

const OPENING_NUDGES = [
  'nice framing — now commit to a call.',
  'good setup. who else was in the room?',
  'lead with the specific. you have a name for this.',
  'open with the situation, then YOU.',
];
const MID_NUDGES = [
  "great — but they're going to ask 'by how much'.",
  'name the constraint you were under.',
  'this is the part to slow down on.',
  "you're starting to hedge. commit.",
  'good specifics. now name the metric that proved you wrong.',
];
const LANDING_NUDGES = [
  'land with a number. anything.',
  'finish with the delta — before vs after.',
  'last beat: what did you learn?',
  'land it, then stop talking.',
];

interface Props {
  question: string;
  draftWordCount: number;
  visible: boolean;
  onDismiss?: () => void;
  className?: string;
}

export function CoachCard({
  question,
  draftWordCount,
  visible,
  onDismiss,
  className,
}: Props) {
  const phase = useMemo<'opening' | 'mid' | 'landing'>(() => {
    if (draftWordCount < 25) return 'opening';
    if (draftWordCount < 90) return 'mid';
    return 'landing';
  }, [draftWordCount]);

  const pool = phase === 'opening' ? OPENING_NUDGES : phase === 'mid' ? MID_NUDGES : LANDING_NUDGES;
  const idx = useMemo(() => {
    let h = 0;
    for (let i = 0; i < question.length; i++) h = (h * 31 + question.charCodeAt(i)) & 0xffff;
    return h % pool.length;
  }, [question, pool]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (visible) {
      const t = window.setTimeout(() => setMounted(true), 50);
      return () => window.clearTimeout(t);
    }
    setMounted(false);
  }, [visible, phase]);

  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'relative flex items-start gap-3 rounded-2xl border-2 px-4 py-3 transition-all duration-300',
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        className,
      )}
      style={{
        borderColor: 'var(--dc-accent, #c6ff3a)',
        background: 'rgba(11, 11, 18, 0.85)',
        boxShadow:
          '0 0 0 4px color-mix(in srgb, var(--dc-accent) 12%, transparent), 0 14px 36px -8px color-mix(in srgb, var(--dc-accent) 35%, transparent)',
      }}
    >
      {/* Mini orb — matches the persona-orb language but lime-only */}
      <span
        aria-hidden="true"
        className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{
          background:
            'radial-gradient(circle at 30% 30%, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 40%, #000) 75%)',
          boxShadow:
            '0 0 24px -4px var(--dc-accent), inset -3px -4px 8px rgba(0,0,0,0.5), inset 3px 3px 6px rgba(255,255,255,0.25)',
        }}
      >
        <span
          aria-hidden="true"
          className="absolute"
          style={{
            top: '20%',
            left: '22%',
            width: '36%',
            height: '28%',
            background:
              'radial-gradient(ellipse at center, rgba(255,255,255,0.7), transparent 70%)',
            borderRadius: '50%',
            filter: 'blur(1px)',
          }}
        />
      </span>

      {/* Body */}
      <div className="flex-1 pt-0.5">
        <p
          className="dc-mono text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--dc-accent, #c6ff3a)' }}
        >
          Your Coach · Live
        </p>
        <p
          className="dc-serif italic mt-1 text-[15px] leading-snug"
          style={{ color: 'var(--dc-ink, #f5f5fa)' }}
        >
          {pool[idx]}
        </p>
      </div>

      {/* Dismiss */}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/8"
          aria-label="Dismiss coach"
          style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
