'use client';

// AiOrb — the brand element of the new dark canvas: a slowly spinning,
// gradient-suffused sphere with optional expanding rings. Used in:
//   • LeftRail header (small, breathing, no rings)
//   • Setup persona cards (medium, no rings — just a tinted swatch per persona)
//   • Live interviewer panel (xl, with rings while speaking)
//   • Coach pop-in (sm, with a single ring)
//
// All accent-aware: the orb is built from CSS-var gradients so swapping the
// accent in the Tweaks panel re-tints every orb in the tree.

import { cn } from '../../lib/utils';

export type OrbSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const SIZE: Record<OrbSize, string> = {
  sm:  'h-8 w-8',
  md:  'h-12 w-12',
  lg:  'h-20 w-20',
  xl:  'h-32 w-32',
  '2xl':'h-44 w-44',
};

interface Props {
  size?: OrbSize;
  /** Show expanding rings around the orb. */
  active?: boolean;
  /** Override gradient — when set, this string replaces var(--dc-grad-orb). */
  gradient?: string;
  /** Secondary tint (the inner highlight). */
  highlight?: string;
  /** Optional ARIA label. */
  label?: string;
  className?: string;
}

export function AiOrb({
  size = 'md',
  active = false,
  gradient,
  highlight,
  label,
  className,
}: Props) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      className={cn('relative inline-flex items-center justify-center', SIZE[size], className)}
    >
      {/* Outer rings (only when active) */}
      {active ? (
        <>
          <span
            aria-hidden="true"
            className="dc-ring dc-ring-d1 absolute inset-0 rounded-full"
            style={{
              border: '1.5px solid var(--dc-accent)',
              opacity: 0.6,
            }}
          />
          <span
            aria-hidden="true"
            className="dc-ring dc-ring-d2 absolute inset-0 rounded-full"
            style={{
              border: '1.5px solid var(--dc-accent)',
              opacity: 0.4,
            }}
          />
          <span
            aria-hidden="true"
            className="dc-ring dc-ring-d3 absolute inset-0 rounded-full"
            style={{
              border: '1.5px solid var(--dc-secondary)',
              opacity: 0.3,
            }}
          />
        </>
      ) : null}

      {/* The orb itself — two stacked layers: a spinning gradient base + a
       *  breathing highlight overlay that adds depth. */}
      <span
        aria-hidden="true"
        className="dc-spin relative overflow-hidden rounded-full"
        style={{
          width: '88%',
          height: '88%',
          backgroundImage: gradient ?? 'var(--dc-grad-orb)',
          boxShadow:
            '0 0 0 1px rgba(255,255,255,0.08) inset, 0 14px 32px -8px color-mix(in srgb, var(--dc-secondary) 35%, transparent)',
        }}
      >
        <span
          aria-hidden="true"
          className="dc-breathe absolute inset-0"
          style={{
            background:
              highlight ??
              'radial-gradient(circle at 30% 25%, rgba(255,255,255,0.55), transparent 50%)',
            mixBlendMode: 'screen',
          }}
        />
      </span>

      {/* Static rim highlight — gives the orb depth even at rest. */}
      <span
        aria-hidden="true"
        className="absolute rounded-full"
        style={{
          width: '88%',
          height: '88%',
          boxShadow:
            'inset 2px 4px 8px rgba(255, 255, 255, 0.18), inset -3px -6px 14px rgba(0, 0, 0, 0.35)',
        }}
      />
    </span>
  );
}
