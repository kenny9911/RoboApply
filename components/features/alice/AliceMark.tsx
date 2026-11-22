'use client';

// Alice's mark: a blue disc with her initial. A mark, never a face (she is an
// AI agent and is labelled one). While a turn really runs, a ring pulses
// around it (still under reduced motion).

import s from './alice.module.css';

export function AliceMark({ live = false, small = false }: { live?: boolean; small?: boolean }) {
  return (
    <span className={small ? `${s.mark} ${s.markSmall}` : s.mark} data-live={live ? 'true' : undefined} aria-hidden="true">
      a
    </span>
  );
}
