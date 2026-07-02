'use client';

// StreamingText — renders a string with a blinking teal cursor at the end
// while still streaming. Used for the daily digest narration. The cursor
// drops the moment `done={true}`.
//
// The Teal-UI spec calls for a 2px teal-700 vertical bar blinking at 1Hz.
// That visual lives in .robo-cursor (styles/tokens.css).

import { cn } from '../../lib/utils';

interface Props {
  text: string;
  done: boolean;
  className?: string;
}

export function StreamingText({ text, done, className }: Props) {
  return (
    <span
      className={cn(
        'whitespace-pre-wrap text-ink-900',
        !done && 'robo-cursor',
        className,
      )}
    >
      {text}
    </span>
  );
}
