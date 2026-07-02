'use client';

// AudioWaveform — 28-bar live audio waveform. Animates with random per-bar
// scale when `active` is true; freezes flat when inactive. CSS-only motion;
// no audio analysis (the AI session is heuristic for now, and we don't want
// to wedge users without mic permission).
//
// When real Whisper streaming lands in V2.1, swap this with an AnalyserNode-
// driven bar height array — same surface, same DOM count.

import { cn } from '../../../lib/utils';

const BAR_COUNT = 28;

interface Props {
  active: boolean;
  className?: string;
}

export function AudioWaveform({ active, className }: Props) {
  return (
    <div
      role="img"
      aria-label={active ? 'Microphone is open and listening' : 'Microphone is muted'}
      className={cn(
        'flex h-16 items-center justify-center gap-1',
        className,
      )}
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => {
        // Deterministic per-index heights so the wave reads as "alive" not
        // "noisy" — peaks in the middle, gentle at the edges.
        const baseScale =
          0.3 + 0.7 * Math.sin(((i + 1) / (BAR_COUNT + 1)) * Math.PI);
        return (
          <span
            key={i}
            className={active ? 'dc-wave-bar' : ''}
            style={{
              display: 'block',
              width: 3,
              height: 64,
              borderRadius: 9999,
              background:
                'linear-gradient(180deg, var(--dc-accent), var(--dc-secondary))',
              transform: active ? undefined : `scaleY(${baseScale * 0.18})`,
              opacity: 0.92,
              animationName: active ? 'dc-wave-bounce' : undefined,
              animationDuration: '0.9s',
              animationTimingFunction: 'ease-in-out',
              animationIterationCount: 'infinite',
              animationDelay: `${(i * 60) % 800}ms`,
              boxShadow: active
                ? '0 0 12px -2px var(--dc-accent)'
                : undefined,
              transformOrigin: 'center',
            }}
          />
        );
      })}
    </div>
  );
}
