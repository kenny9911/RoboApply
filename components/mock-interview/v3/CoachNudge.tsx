'use client';

// CoachNudge — the silent feedback the user's AI coach drops in mid-answer.
// THIS is the RoboApply differentiator: the interviewer challenges you, the
// coach helps you. Visually positioned mid-air between the interviewer orb
// and the candidate column, anchored just under the question card.
//
// We cycle through coach lines tied to the current question + the
// candidate's draft length so it feels reactive without an LLM round-trip.

import { useEffect, useMemo, useState } from 'react';
import { SparklesIcon } from '@heroicons/react/24/solid';
import { AiOrb } from '../../../components/dc/AiOrb';
import { cn } from '../../../lib/utils';

interface Props {
  /** Current question text — drives nudge selection. */
  question: string;
  /** Length of candidate's draft so far. Nudge swaps when crossing thresholds. */
  draftWordCount: number;
  /** Visible state — externally toggled when the answer is being given. */
  visible: boolean;
  className?: string;
}

const OPENING_NUDGES = [
  'nice framing — now commit to a call.',
  'good setup. who else was in the room?',
  'lead with the specific. you have a name for this.',
  'open with the situation, then YOU.',
];

const MIDPOINT_NUDGES = [
  "great — but they're going to ask 'by how much'.",
  'name the constraint you were under.',
  'this is the part to slow down on.',
  "you're starting to hedge. commit.",
];

const LANDING_NUDGES = [
  'land with a number. anything.',
  'finish with the delta — before vs after.',
  'last beat: what did you learn?',
  'land it, then stop talking.',
];

export function CoachNudge({ question, draftWordCount, visible, className }: Props) {
  const phase = useMemo<'opening' | 'mid' | 'landing'>(() => {
    if (draftWordCount < 25) return 'opening';
    if (draftWordCount < 90) return 'mid';
    return 'landing';
  }, [draftWordCount]);

  const pool = phase === 'opening' ? OPENING_NUDGES : phase === 'mid' ? MIDPOINT_NUDGES : LANDING_NUDGES;

  // Seeded pick — derived from the question so the same question shows a
  // consistent nudge per phase.
  const idx = useMemo(() => {
    let h = 0;
    for (let i = 0; i < question.length; i++) h = (h * 31 + question.charCodeAt(i)) & 0xffff;
    return h % pool.length;
  }, [question, pool]);

  // Soft mount-in animation
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
      className={cn(
        'relative flex items-start gap-3 rounded-2xl border px-4 py-3',
        'transition-all duration-300',
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        className,
      )}
      role="status"
      aria-live="polite"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--dc-accent) 12%, transparent), color-mix(in srgb, var(--dc-secondary) 12%, transparent))',
        borderColor: 'color-mix(in srgb, var(--dc-accent) 28%, transparent)',
        boxShadow: '0 0 24px -8px color-mix(in srgb, var(--dc-accent) 50%, transparent)',
      }}
    >
      <span className="relative shrink-0">
        <AiOrb size="sm" active />
      </span>
      <div className="flex-1 pt-0.5">
        <p
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--dc-accent, #c6ff3a)' }}
        >
          <SparklesIcon className="h-3 w-3" aria-hidden="true" />
          Your Coach · silent
        </p>
        <p className="dc-serif italic mt-0.5 text-[14px]" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          {pool[idx]}
        </p>
      </div>
    </div>
  );
}
