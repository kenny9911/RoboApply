'use client';

// MicViz — the animated mic waveform (proto `MicViz` → `.iv-mic`). Bars animate
// only when `active`. `compact` is the overlay variant used inside the video
// tile's bottom strip.

interface Props {
  active: boolean;
  compact?: boolean;
}

export function MicViz({ active, compact = false }: Props) {
  const bars = compact ? 18 : 28;
  return (
    <div className={`iv-mic ${active ? 'on' : ''} ${compact ? 'compact' : ''}`} aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} style={{ animationDelay: `${(i * 73) % 1000}ms` }} />
      ))}
    </div>
  );
}
