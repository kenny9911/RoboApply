import type { Config } from 'tailwindcss';

// RoboApply design tokens for Tailwind.
//
// Authority: docs/roboapply/OVERHAUL_RULINGS.md, then app/globals.css. Every
// value below resolves to a CSS custom property so there is exactly one source
// of truth and both themes flip for free.
//
// The `fontSize` scale is the important part: this config previously had NO
// fontSize key at all, which is why 16 arbitrary `text-[Npx]` literals grew in
// the components and why the stylesheets reached 31 distinct sizes. The eight
// tokens below are the complete set — anything outside them fails
// `npm run check:design`.
//
// Legacy keys (`teal-*`, `indigo-*`, `zinc-*`, and the V2 component tokens)
// are kept pointing at the new tokens so ~80 existing class references keep
// compiling. They are deleted as each screen is migrated.
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
        // ── The system (ruling R3). Three colour roles, never confused. ──
        // INK — must pass 4.5:1 on every surface it is permitted on.
        text: {
          DEFAULT: 'var(--text)',
          2: 'var(--text-2)',
          muted: 'var(--text-muted)',
          disabled: 'var(--disabled)',
        },
        // SURFACE
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        rule: {
          DEFAULT: 'var(--rule)',
          strong: 'var(--rule-strong)',
        },
        // ACTION — buttons and links. Furniture; nobody notices it.
        action: {
          DEFAULT: 'var(--action)',
          hover: 'var(--action-hover)',
          ink: 'var(--action-ink)',
          subtle: 'var(--action-subtle)',
        },
        // IDENTITY — never carries text. Only ever painted on `brand-plane`,
        // which is why it is free to be electric lime and never needs a
        // contrast check.
        brand: {
          mark: 'var(--brand-mark)',
          plane: 'var(--brand-plane)',
        },
        ok: { DEFAULT: 'var(--ok)', subtle: 'var(--ok-subtle)' },

        // Page + surfaces (legacy `bg-*` keys, repointed)
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
      // Three elevation levels and one focus ring. No shadow may reference a
      // hue — the previous system had 48 distinct shadows, 46 of them accent
      // glows.
      boxShadow: {
        e1: 'var(--e1)',
        e2: 'var(--e2)',
        e3: 'var(--e3)',
        focus: 'var(--focus-ring)',
        // legacy aliases
        card: 'var(--e1)',
        lift: 'var(--e2)',
        cta: 'var(--e1)',
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        pill: 'var(--r-pill)',
        // legacy alias — the six 1px-apart radii collapsed to four
        xs: 'var(--r-sm)',
      },
      fontFamily: {
        // `display` = Instrument Sans, hero + page H1 only, whole headline.
        // `body`/`sans` = Inter, everything else. `mono` deliberately resolves
        // to the UI face: there is no downloaded monospace in the app.
        display: ['var(--font-display)'],
        sans: ['var(--font-ui)'],
        body: ['var(--font-ui)'],
        mono: ['var(--font-ui)'],
      },
      // The complete type scale. Eight sizes, 12px floor, no half-pixels.
      fontSize: {
        hero:     ['var(--fs-hero)',     { lineHeight: 'var(--lh-hero)',     letterSpacing: 'var(--ls-hero)',     fontWeight: '700' }],
        display:  ['var(--fs-display)',  { lineHeight: 'var(--lh-display)',  letterSpacing: 'var(--ls-display)',  fontWeight: '600' }],
        stat:     ['var(--fs-stat)',     { lineHeight: '1',                  letterSpacing: '-0.02em',            fontWeight: '600' }],
        title:    ['var(--fs-title)',    { lineHeight: 'var(--lh-title)',    letterSpacing: 'var(--ls-title)',    fontWeight: '600' }],
        subtitle: ['var(--fs-subtitle)', { lineHeight: 'var(--lh-subtitle)', letterSpacing: 'var(--ls-subtitle)', fontWeight: '500' }],
        body:     ['var(--fs-body)',     { lineHeight: 'var(--lh-body)',     letterSpacing: 'var(--ls-body)' }],
        meta:     ['var(--fs-meta)',     { lineHeight: 'var(--lh-meta)',     letterSpacing: 'var(--ls-meta)' }],
        label:    ['var(--fs-label)',    { lineHeight: '1.35',               letterSpacing: 'var(--ls-label)',    fontWeight: '500' }],
      },
      spacing: {
        1: 'var(--sp-1)', 2: 'var(--sp-2)', 3: 'var(--sp-3)', 4: 'var(--sp-4)',
        5: 'var(--sp-5)', 6: 'var(--sp-6)', 7: 'var(--sp-7)', 8: 'var(--sp-8)',
      },
      maxWidth: {
        page:  'var(--page-max)',
        prose: 'var(--prose-max)',
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
