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
import { IconSparkle } from '../../../components/v3/primitives/Iconset';
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
        'relative flex items-start gap-3 border px-4 py-3',
        'transition-all',
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        className,
      )}
      role="status"
      aria-live="polite"
      style={{
        borderRadius: 'var(--r-lg)',
        background: 'var(--surface-2)',
        borderColor: 'var(--rule)',
        boxShadow: 'var(--e1)',
        transitionDuration: 'var(--dur-enter)',
        transitionTimingFunction: 'var(--ease-out)',
      }}
    >
      {/* The nudge is picked locally from the question + draft length — there is
       *  no LLM round-trip here, so the card deliberately does NOT carry the
       *  `ra-working` indeterminate bar. That cue is reserved for a real
       *  in-flight request; running it here would fake work the coach isn't
       *  doing. */}
      <IconSparkle
        size={16}
        className="mt-0.5 shrink-0"
        style={{ color: 'var(--text-muted)' }}
      />
      <div className="flex-1 pt-0.5">
        <p
          className="inline-flex items-center gap-1 font-medium"
          style={{
            fontSize: 'var(--fs-label)',
            letterSpacing: 'var(--ls-label)',
            color: 'var(--text-muted)',
          }}
        >
          <SparklesIcon className="h-3 w-3" aria-hidden="true" />
          Your coach · silent
        </p>
        <p
          className="mt-0.5"
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--fs-body)',
            lineHeight: 'var(--lh-body)',
            color: 'var(--text)',
          }}
        >
          {pool[idx]}
        </p>
      </div>
    </div>
  );
}
