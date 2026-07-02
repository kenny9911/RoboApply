'use client';

// InterviewerWell — the "orb in a crater" centerpiece. Three nested layers:
//
//   1. Outer card        — dark surface with subtle border, persona name plate
//   2. Crater            — large nearly-black circle with strong inset shadow
//                          so the well reads as a deep depression
//   3. Orb               — persona-tinted sphere floating inside the crater
//                          with outer glow that bleeds out of the well
//
// While the interviewer is "speaking" (active=true) the orb gets expanding
// rings + a stronger glow pulse to signal voice activity.

import type { Persona } from '../../../lib/mockInterview/personas';
import { cn } from '../../../lib/utils';

interface Props {
  persona: Persona;
  /** "AI INTERVIEWER" eyebrow at the top — overridable. */
  eyebrow?: string;
  /** Status badge at the top-right ("LISTENING" / "SPEAKING"). */
  statusLabel: string;
  /** Drives the listening dot color (red while you speak, lime while AI speaks). */
  statusTint: 'red' | 'lime';
  /** Whether the AI is actively speaking — drives the orb glow pulse. */
  speaking?: boolean;
  className?: string;
}

export function InterviewerWell({
  persona,
  eyebrow = 'AI Interviewer',
  statusLabel,
  statusTint,
  speaking = false,
  className,
}: Props) {
  const tintColor = statusTint === 'red' ? '#ef4444' : '#c6ff3a';
  const orbGradient = `radial-gradient(circle at 32% 28%, ${persona.gradient.from}, ${persona.gradient.to} 55%, color-mix(in srgb, ${persona.gradient.to} 60%, #000) 100%)`;
  const orbGlowColor = persona.gradient.from;

  return (
    <section
      className={cn(
        'relative flex flex-col gap-6 overflow-hidden rounded-[28px] border p-6 md:p-7',
        className,
      )}
      style={{
        borderColor: 'var(--dc-edge, rgba(255,255,255,0.06))',
        background: 'var(--dc-surface, #181822)',
      }}
    >
      {/* Eyebrow + status badges */}
      <header className="flex items-center justify-between gap-3">
        <span
          className="dc-mono inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{
            color: 'var(--dc-accent)',
            borderColor: 'color-mix(in srgb, var(--dc-accent) 25%, transparent)',
            background: 'color-mix(in srgb, var(--dc-accent) 8%, transparent)',
          }}
        >
          <span aria-hidden="true">+</span>
          {eyebrow}
        </span>
        <span
          className="dc-mono inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{
            color: tintColor,
            borderColor: `color-mix(in srgb, ${tintColor} 25%, transparent)`,
            background: 'rgba(0,0,0,0.4)',
          }}
        >
          <span
            aria-hidden="true"
            className="relative inline-flex h-1.5 w-1.5 items-center justify-center rounded-full"
            style={{ background: tintColor }}
          >
            <span
              className="dc-tick absolute inset-0 rounded-full"
              style={{ background: tintColor }}
            />
          </span>
          {statusLabel}
        </span>
      </header>

      {/* The Well */}
      <div className="relative mx-auto my-2 flex h-[300px] w-[300px] items-center justify-center md:h-[340px] md:w-[340px]">
        {/* Outer rim — very subtle */}
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.02), transparent 70%)',
          }}
        />
        {/* Crater — nearly black with deep inset shadow */}
        <div
          aria-hidden="true"
          className="absolute inset-3 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 50% 35%, #0a0a10 0%, #050508 75%, #020204 100%)',
            boxShadow:
              'inset 0 18px 40px rgba(0,0,0,0.95), inset 0 -10px 28px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.04)',
          }}
        />
        {/* Outer glow bleed (when speaking, stronger) */}
        <div
          aria-hidden="true"
          className={cn('absolute rounded-full transition-opacity duration-500', speaking ? 'opacity-100 dc-breathe' : 'opacity-60')}
          style={{
            inset: '18%',
            background: `radial-gradient(circle at 50% 50%, ${orbGlowColor}, transparent 65%)`,
            filter: 'blur(20px)',
            opacity: speaking ? 0.85 : 0.45,
          }}
        />
        {/* Expanding rings when speaking */}
        {speaking ? (
          <>
            <span
              aria-hidden="true"
              className="dc-ring dc-ring-d1 absolute rounded-full"
              style={{
                inset: '18%',
                border: `1.5px solid ${orbGlowColor}`,
                opacity: 0.4,
              }}
            />
            <span
              aria-hidden="true"
              className="dc-ring dc-ring-d2 absolute rounded-full"
              style={{
                inset: '18%',
                border: `1.5px solid ${orbGlowColor}`,
                opacity: 0.25,
              }}
            />
          </>
        ) : null}
        {/* The Orb */}
        <div
          aria-label={persona.name}
          role="img"
          className={cn(
            'relative rounded-full transition-transform duration-700',
            speaking && 'dc-breathe',
          )}
          style={{
            width: '56%',
            height: '56%',
            background: orbGradient,
            boxShadow: `
              0 0 80px ${orbGlowColor}55,
              0 0 30px ${orbGlowColor}88,
              inset -10px -16px 30px rgba(0,0,0,0.55),
              inset 8px 8px 18px rgba(255,255,255,0.18)
            `,
          }}
        >
          {/* Highlight glint */}
          <span
            aria-hidden="true"
            className="absolute rounded-full"
            style={{
              top: '12%',
              left: '20%',
              width: '32%',
              height: '24%',
              background:
                'radial-gradient(ellipse at center, rgba(255,255,255,0.6), transparent 70%)',
              filter: 'blur(2px)',
            }}
          />
        </div>
      </div>

      {/* Persona name plate */}
      <div
        className="relative w-fit rounded-2xl border px-4 py-3"
        style={{
          background: 'var(--dc-card-nested, #0b0b12)',
          borderColor: 'var(--dc-edge, rgba(255,255,255,0.06))',
        }}
      >
        <p className="dc-display text-[22px] leading-none" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
          {persona.name}
        </p>
        <p className="dc-mono mt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}>
          {persona.archetype}
        </p>
      </div>
    </section>
  );
}
