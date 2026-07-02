import type { Config } from 'tailwindcss';

// RoboApply design tokens. Mirrors styles/tokens.css so utilities and CSS
// custom properties stay in sync. CSS-var prefix is `--robo-*`. This is the
// Cool Graphite palette (CEO ruling 2026-05-26) — cool zinc-on-white with one
// electric blue accent. See docs/roboapply/04-modern-ui-redesign.md.
//
// The `teal-*` key is preserved (now pointing at accent shades) for backward
// compatibility with the 80+ existing class refs and the test suite. New code
// should prefer `accent-*`.
export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Page + surfaces
        bg: {
          page: 'var(--robo-bg-page)',
          card: 'var(--robo-bg-card)',
          muted: 'var(--robo-bg-muted)',
        },
        // Ink (text + borders)
        ink: {
          900: 'var(--robo-ink-900)',
          700: 'var(--robo-ink-700)',
          500: 'var(--robo-ink-500)',
          300: 'var(--robo-ink-300)',
          line: 'var(--robo-line)',
          'line-soft': 'var(--robo-line-soft)',
        },
        // Accent — electric blue, the canonical brand color
        accent: {
          50:  'var(--robo-accent-50)',
          100: 'var(--robo-accent-100)',
          200: 'var(--robo-accent-200)',
          500: 'var(--robo-accent-500)',
          600: 'var(--robo-accent-600)',
          700: 'var(--robo-accent-700)',
          900: 'var(--robo-accent-900)',
          // ON-accent ink (text/icon sitting on an accent FILL) + the deep
          // foreground sibling for accent-as-text on a light plane. Both are
          // theme-aware bare tokens (see globals.css light scope).
          ink:  'var(--accent-ink)',
          text: 'var(--accent-text)',
        },
        // Legacy `teal` key — kept for backward compat. The CSS vars these
        // resolve to now point at accent shades (see tokens.css).
        teal: {
          900: 'var(--robo-teal-900)',
          700: 'var(--robo-teal-700)',
          500: 'var(--robo-teal-500)',
          200: 'var(--robo-teal-200)',
          50:  'var(--robo-teal-50)',
        },
        // Legacy `indigo` key — kept for backward compat
        indigo: {
          700: 'var(--robo-indigo-700)',
        },
        // Cool zinc stops (used directly in a few places)
        zinc: {
          50:  'var(--robo-zinc-50)',
          100: 'var(--robo-zinc-100)',
          150: 'var(--robo-zinc-150)',
          200: 'var(--robo-zinc-200)',
          300: 'var(--robo-zinc-300)',
          400: 'var(--robo-zinc-400)',
          500: 'var(--robo-zinc-500)',
          600: 'var(--robo-zinc-600)',
          700: 'var(--robo-zinc-700)',
          800: 'var(--robo-zinc-800)',
          900: 'var(--robo-zinc-900)',
          950: 'var(--robo-zinc-950)',
        },
        // Semantic
        success: 'var(--robo-success)',
        warn: 'var(--robo-warn)',
        danger: 'var(--robo-danger)',

        // ── V2 component tokens (Wave-2 framework, visual spec §1.2) ──
        funnel: {
          'active-bg':     'var(--robo-funnel-active-bg)',
          'active-border': 'var(--robo-funnel-active-border)',
          'inactive-bg':   'var(--robo-funnel-inactive-bg)',
          'inactive-ink':  'var(--robo-funnel-inactive-ink)',
        },
        star: {
          filled: 'var(--robo-star-filled)',
          empty:  'var(--robo-star-empty)',
        },
        gauge: {
          track:        'var(--robo-gauge-track)',
          fill:         'var(--robo-gauge-fill)',
          'fill-strong':    'var(--robo-gauge-fill-strong)',
          'fill-good':      'var(--robo-gauge-fill-good)',
          'fill-stretch':   'var(--robo-gauge-fill-stretch)',
          'fill-long-shot': 'var(--robo-gauge-fill-long-shot)',
        },
        'premium-gate': {
          bg: 'var(--robo-premium-gate-bg)',
        },
        today: {
          bg:  'var(--robo-today-pill-bg)',
          ink: 'var(--robo-today-pill-ink)',
        },
        upgrade: {
          bg:        'var(--robo-upgrade-card-bg)',
          ink:       'var(--robo-upgrade-card-ink)',
          'ink-soft': 'var(--robo-upgrade-card-ink-soft)',
        },
      },
      backdropBlur: {
        'premium-gate': 'var(--robo-premium-gate-blur)',
      },
      boxShadow: {
        card: 'var(--robo-shadow-card)',
        lift: 'var(--robo-shadow-lift)',
        cta: 'var(--robo-shadow-cta)',
        focus: 'var(--robo-shadow-focus)',
      },
      borderRadius: {
        xs: 'var(--robo-radius-xs)',
        sm: 'var(--robo-radius-sm)',
        md: 'var(--robo-radius-md)',
        lg: 'var(--robo-radius-lg)',
        pill: 'var(--robo-radius-pill)',
      },
      fontFamily: {
        display: ['var(--robo-font-display)'],
        body: ['var(--robo-font-body)'],
        mono: ['var(--robo-font-mono)'],
      },
      transitionTimingFunction: {
        standard: 'var(--robo-ease-standard)',
        emphasized: 'var(--robo-ease-emphasized)',
      },
      transitionDuration: {
        fast: 'var(--robo-duration-fast)',
        base: 'var(--robo-duration-base)',
        slow: 'var(--robo-duration-slow)',
      },
    },
  },
  plugins: [],
} satisfies Config;
