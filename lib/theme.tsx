'use client';

// lib/theme.tsx
//
// Appearance state. Light (default) or dark — that is the whole surface.
//
// Replaces lib/dcTheme.tsx, which carried five user-tunable knobs:
//
//   accent          lime | violet | cyan | pink   → DELETED. A brand the user
//                   can repaint is a brand that never had a position, and two
//                   of the four shipped illegible buttons in the default theme
//                   (white on pink = 2.68:1, white on violet = 4.17:1).
//   theme           light | dark | warm           → 'warm' DELETED.
//   density         compact | regular | comfy     → DELETED. It was read by
//                   exactly one declaration in 8,103 lines of CSS.
//   aggressiveness  chill | balanced | intense    → DELETED. It was a
//                   localStorage value that controlled nothing, rendered on an
//                   always-visible card as "Agent · full auto" while the
//                   server-side preference could say something else entirely.
//   tone            formal | casual | witty       → DELETED. It forked every
//                   page headline into three copy variants across nine
//                   locales, for no user-visible benefit.
//
// See docs/roboapply/OVERHAUL_RULINGS.md R3.
//
// Persisted under 'roboapply:theme:v4'. The key bump drops any persisted
// 'warm'/accent/density payload so stale state snaps to the light default.
// Keep the key and the 'theme' field in sync with the no-flash bootstrap
// script in app/layout.tsx.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeKey = 'light' | 'dark';

export interface ThemeState {
  theme: ThemeKey;
}

interface ThemeContextValue extends ThemeState {
  setTheme: (theme: ThemeKey) => void;
  toggle: () => void;
  /**
   * False during SSR and the client's FIRST render, true after mount. The
   * provider seeds from localStorage in the useState initializer (no flash),
   * so `theme` already holds the persisted value while hydrating — which
   * differs from the server's DEFAULT_THEME. Any consumer rendering
   * theme-CONDITIONAL markup (an icon, an aria-label) must gate on this and
   * use DEFAULT_THEME until true, or React reports a hydration mismatch.
   * CSS-only consumers (data-theme) are unaffected.
   */
  hydrated: boolean;
}

export const DEFAULT_THEME: ThemeState = { theme: 'light' };

const STORAGE_KEY = 'roboapply:theme:v4';

const VALID_THEMES: ReadonlySet<string> = new Set<ThemeKey>(['light', 'dark']);

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): ThemeState {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    if (!parsed.theme || !VALID_THEMES.has(parsed.theme)) return DEFAULT_THEME;
    return { theme: parsed.theme };
  } catch {
    return DEFAULT_THEME;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>(readInitialTheme);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* best-effort */
    }
  }, [state]);

  // Keep <html data-theme> + color-scheme in sync on runtime toggles. The
  // no-flash script sets the initial value pre-paint; this reconciles once
  // React owns the state. Written to <html>, not a wrapper, so the token
  // scopes in globals.css apply app-wide including public routes.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    el.setAttribute('data-theme', state.theme);
    el.style.colorScheme = state.theme;
  }, [state.theme]);

  const setTheme = useCallback((theme: ThemeKey) => setState({ theme }), []);
  const toggle = useCallback(
    () => setState((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ ...state, setTheme, toggle, hydrated }),
    [state, setTheme, toggle, hydrated],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe defaults if a consumer mounts outside the provider.
    return {
      ...DEFAULT_THEME,
      setTheme: () => undefined,
      toggle: () => undefined,
      hydrated: false,
    };
  }
  return ctx;
}
