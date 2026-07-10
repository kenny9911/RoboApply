'use client';

// TweaksPanel — slide-over reachable from the LeftRail. The smallest piece
// of the dark-canvas system that still gives the user real agency:
//
//   • Accent color  (Lime / Violet / Cyan / Pink) — global tint
//   • Density       (Compact / Comfortable)       — row + stack spacing
//   • Aggressiveness (Chill / Balanced / Intense) — interviewer probe rate
//   • Tone          (Formal / Casual / Witty)     — AI copy register
//   • Replay onboarding (navigates back to the /onboarding flow)
//
// All changes write through useDcTheme() which persists in localStorage.

import { XMarkIcon } from '@heroicons/react/24/outline';
import {
  type AccentKey,
  type AggressivenessKey,
  type DensityKey,
  type ThemeKey,
  type ToneKey,
  useDcTheme,
} from '../../lib/dcTheme';
import { AiOrb } from './AiOrb';
import { cn } from '../../lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
}

const THEMES: { id: ThemeKey; label: string; description: string }[] = [
  { id: 'dark',  label: 'Dark',  description: 'The original near-black canvas. Built for focus.' },
  { id: 'light', label: 'Light', description: 'Cool paper canvas, brand teal-blue accents.' },
  { id: 'warm',  label: 'Warm',  description: 'Anthropic clay on cream. Soft and editorial.' },
];

// Swatch hexes MUST match the canonical dark accent tokens in app/globals.css
// (:root --lime/--violet/--cyan/--pink) — literals are required here because
// they're string-concatenated with an alpha suffix (`${primary}1a`) below.
const ACCENTS: { id: AccentKey; label: string; primary: string; secondary: string }[] = [
  { id: 'lime',   label: 'Electric Lime',   primary: '#C9FF3B', secondary: '#8B5BFF' },
  { id: 'violet', label: 'Plasma Violet',   primary: '#8B5BFF', secondary: '#4ED8FF' },
  { id: 'cyan',   label: 'Liquid Cyan',     primary: '#4ED8FF', secondary: '#C9FF3B' },
  { id: 'pink',   label: 'Hot Pink',        primary: '#FF6B9D', secondary: '#8B5BFF' },
];

const DENSITIES: { id: DensityKey; label: string; description: string }[] = [
  { id: 'compact', label: 'Compact', description: 'Tight rows. Maximum information density.' },
  { id: 'regular', label: 'Regular', description: 'The default. Balanced spacing.' },
  { id: 'comfy',   label: 'Comfy',   description: 'Generous spacing. Easiest to scan.' },
];

const AGGRESSIVENESS: { id: AggressivenessKey; label: string; description: string }[] = [
  { id: 'chill',    label: 'Chill',    description: 'AI rarely probes. Friendly and supportive.' },
  { id: 'balanced', label: 'Balanced', description: 'Probes thin answers. The default.' },
  { id: 'intense',  label: 'Intense',  description: 'AI hunts for specifics. No softballs.' },
];

const TONES: { id: ToneKey; label: string; example: string }[] = [
  { id: 'formal', label: 'Formal', example: '"Walk me through the project."' },
  { id: 'casual', label: 'Casual', example: '"Tell me how this one went."' },
  { id: 'witty',  label: 'Witty',  example: '"Okay — paint me the chaos."' },
];

export function TweaksPanel({ open, onClose }: Props) {
  const theme = useDcTheme();

  if (!open) return null;

  function replayOnboarding() {
    if (typeof window === 'undefined') return;
    // Onboarding completion is tracked server-side (onboardingState.completedSteps
    // from /auth/me); the /onboarding route renders its flow unconditionally, so
    // replaying just means navigating there.
    onClose();
    window.location.href = '/onboarding';
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tweaks"
      className="fixed inset-0 z-40 flex"
    >
      <button
        type="button"
        aria-label="Close tweaks"
        onClick={onClose}
        className="flex-1 bg-black/60 backdrop-blur-sm"
      />
      <aside
        className="ml-auto flex h-full w-[400px] max-w-[92vw] flex-col overflow-y-auto"
        style={{ background: 'var(--dc-bg-2, #0d0d18)', borderLeft: '1px solid var(--dc-edge, rgba(255,255,255,0.08))' }}
      >
        {/* Header */}
        <header
          className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/5 px-5 py-4"
          style={{ background: 'var(--dc-bg-2, #0d0d18)' }}
        >
          <AiOrb size="sm" />
          <div className="flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--dc-ink-3,#8a8a9c)]">
              Tweaks
            </p>
            <h2 className="dc-display text-lg" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
              Make it <span className="dc-serif italic">yours</span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--dc-ink-2,#c9c9d4)] transition-colors hover:bg-white/5"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        {/* Sections */}
        <div className="flex flex-col gap-7 px-5 py-6">
          {/* Appearance (light / dark) */}
          <Section title="Appearance" eyebrow="Theme">
            <SegmentedPicker
              options={THEMES}
              value={theme.theme}
              onChange={(v) => theme.set('theme', v)}
            />
          </Section>

          {/* Accent */}
          <Section title="Accent" eyebrow="Color">
            <div className="grid grid-cols-2 gap-2.5">
              {ACCENTS.map((a) => {
                const active = a.id === theme.accent;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => theme.set('accent', a.id)}
                    className={cn(
                      'group relative flex items-center gap-3 overflow-hidden rounded-2xl border p-3 text-left transition-all',
                      active
                        ? 'border-white/30'
                        : 'border-white/10 hover:border-white/20',
                    )}
                    style={{
                      background: active
                        ? `linear-gradient(135deg, ${a.primary}1a, ${a.secondary}1a)`
                        : 'var(--dc-surface, #11111c)',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: `linear-gradient(135deg, ${a.primary}, ${a.secondary})`,
                        boxShadow: active ? `0 0 18px -2px ${a.primary}` : 'none',
                      }}
                    />
                    <span className="flex-1 text-[13px] font-semibold" style={{ color: 'var(--dc-ink,#f5f5fa)' }}>
                      {a.label}
                    </span>
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="inline-flex h-2 w-2 shrink-0 rounded-full"
                        style={{ background: a.primary, boxShadow: `0 0 8px ${a.primary}` }}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Density */}
          <Section title="Density" eyebrow="Layout">
            <SegmentedPicker
              options={DENSITIES}
              value={theme.density}
              onChange={(v) => theme.set('density', v)}
            />
          </Section>

          {/* Aggressiveness */}
          <Section title="Agent aggressiveness" eyebrow="Behavior">
            <SegmentedPicker
              options={AGGRESSIVENESS}
              value={theme.aggressiveness}
              onChange={(v) => theme.set('aggressiveness', v)}
            />
          </Section>

          {/* Tone */}
          <Section title="AI tone" eyebrow="Voice">
            <div className="grid grid-cols-1 gap-2">
              {TONES.map((t) => {
                const active = t.id === theme.tone;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => theme.set('tone', t.id)}
                    className={cn(
                      'flex items-baseline justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                      active
                        ? 'border-[color:var(--dc-accent)]'
                        : 'border-white/10 hover:border-white/20',
                    )}
                    style={{
                      background: active
                        ? 'color-mix(in srgb, var(--dc-accent) 8%, transparent)'
                        : 'var(--dc-surface, #11111c)',
                    }}
                  >
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
                      {t.label}
                    </span>
                    <span
                      className="dc-serif italic text-xs"
                      style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}
                    >
                      {t.example}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Replay onboarding */}
          <Section title="Onboarding" eyebrow="Replay">
            <button
              type="button"
              onClick={replayOnboarding}
              className="w-full rounded-xl border border-white/15 px-3.5 py-3 text-left transition-colors hover:border-white/30"
              style={{ background: 'var(--dc-surface, #11111c)' }}
            >
              <p className="text-[13px] font-semibold" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
                Replay onboarding →
              </p>
              <p className="dc-serif italic text-xs mt-1" style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}>
                I miss the first time we met.
              </p>
            </button>
          </Section>

          {/* Reset */}
          <button
            type="button"
            onClick={theme.reset}
            className="text-left text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}
          >
            Reset to defaults
          </button>
        </div>
      </aside>
    </div>
  );
}

function Section({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      {eyebrow ? (
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--dc-accent, #c6ff3a)' }}>
          {eyebrow}
        </p>
      ) : null}
      <h3 className="dc-display text-lg" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SegmentedPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; description: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cn(
              'rounded-xl border px-3.5 py-2.5 text-left transition-colors',
              active
                ? 'border-[color:var(--dc-accent)]'
                : 'border-white/10 hover:border-white/20',
            )}
            style={{
              background: active
                ? 'color-mix(in srgb, var(--dc-accent) 8%, transparent)'
                : 'var(--dc-surface, #11111c)',
            }}
          >
            <p className="text-[13px] font-semibold" style={{ color: 'var(--dc-ink, #f5f5fa)' }}>
              {o.label}
            </p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--dc-ink-3, #8a8a9c)' }}>
              {o.description}
            </p>
          </button>
        );
      })}
    </div>
  );
}
