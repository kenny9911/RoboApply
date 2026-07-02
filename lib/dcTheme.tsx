'use client';

// lib/dcTheme.tsx
//
// Theme provider for the dark-canvas era. Holds the user's tweakable
// preferences and exposes them via `data-*` attributes on the wrapper so
// CSS can swap accent / density without re-rendering.
//
//   accent          lime | violet | cyan | pink
//   density         compact | regular | comfy   (V3 — 3 values; --density 0.7/1/1.2)
//   aggressiveness  chill | balanced | intense   (drives interviewer probe rate)
//   tone            formal | casual | witty     (drives AI copy register)
//
// Persisted in localStorage under `roboapply:dc-theme`. The slide-over
// Tweaks panel writes through `useDcTheme()`. The (auth) layout reads
// `density` and sets `--density` (0.7 / 1 / 1.2) on the wrapper.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type AccentKey = 'lime' | 'violet' | 'cyan' | 'pink';
// V3 widens density to the prototype's three values. `--density` resolves to
// 0.7 (compact) / 1 (regular) / 1.2 (comfy).
export type DensityKey = 'compact' | 'regular' | 'comfy';
export type AggressivenessKey = 'chill' | 'balanced' | 'intense';
export type ToneKey = 'formal' | 'casual' | 'witty';
// Appearance mode. Dark is the historical default; 'warm' is the Anthropic
// "clay on cream" scope. Written to data-theme on <html> (NOT the (auth)
// wrapper) so the bare-token light/warm scopes in globals.css flip on both the
// authed shell and public pages. The no-flash bootstrap in app/layout.tsx
// applies the persisted value pre-paint; the effect below keeps it live on
// runtime toggles. Keep this union in sync with the no-flash script's guard.
export type ThemeKey = 'light' | 'dark' | 'warm';

/** Map a density key to the unitless `--density` CSS multiplier. */
export function densityMultiplier(density: DensityKey): number {
  return density === 'compact' ? 0.7 : density === 'comfy' ? 1.2 : 1;
}

export interface DcThemeState {
  theme: ThemeKey;
  accent: AccentKey;
  density: DensityKey;
  aggressiveness: AggressivenessKey;
  tone: ToneKey;
}

interface DcThemeContextValue extends DcThemeState {
  set: <K extends keyof DcThemeState>(key: K, value: DcThemeState[K]) => void;
  reset: () => void;
}

export const DEFAULT_THEME: DcThemeState = {
  theme: 'dark',
  accent: 'lime',
  density: 'regular',
  aggressiveness: 'balanced',
  tone: 'casual',
};

// v3 — bumped 2026-05-28 with the V3 redesign. The density scale changed from
// 2 values (compact|comfortable) to 3 (compact|regular|comfy); bumping the key
// drops any persisted `comfortable` so it snaps to the new `regular` default
// rather than reading an invalid value.
const STORAGE_KEY = 'roboapply:dc-theme:v3';

const VALID_DENSITY: ReadonlySet<string> = new Set<DensityKey>([
  'compact',
  'regular',
  'comfy',
]);

const DcThemeContext = createContext<DcThemeContextValue | null>(null);

/** Read the persisted theme synchronously. Used as the useState lazy
 *  initializer so the provider starts ALREADY in the stored theme on the
 *  client — otherwise it mounts as DEFAULT_THEME (dark) and the data-theme
 *  writer effect would stamp 'dark' on <html> for one frame before a load
 *  effect could correct it, flashing dark at persisted-light users (the
 *  no-flash <head> script already set the right value pre-paint). Returns
 *  DEFAULT_THEME on the server (no localStorage) and renders nothing
 *  theme-conditional, so there is no hydration mismatch. */
function readInitialDcTheme(): DcThemeState {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<DcThemeState>;
    // Defensive: drop an out-of-range density (e.g. a stale 'comfortable').
    if (parsed.density && !VALID_DENSITY.has(parsed.density)) {
      delete parsed.density;
    }
    return { ...DEFAULT_THEME, ...parsed };
  } catch {
    return DEFAULT_THEME;
  }
}

export function DcThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DcThemeState>(readInitialDcTheme);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* best-effort */
    }
  }, [state]);

  // Keep <html data-theme> + color-scheme in sync on runtime toggles. The
  // no-flash script in app/layout.tsx sets the initial value pre-paint; this
  // effect reconciles it once React owns the state and on every change. We
  // write to <html> (documentElement), NOT the (auth) wrapper, so the
  // bare-token light scope in globals.css applies app-wide.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    el.setAttribute('data-theme', state.theme);
    // 'warm' is not a valid CSS color-scheme keyword — it renders as a light
    // scheme (cream paper), so map it to 'light' for native control rendering.
    el.style.colorScheme = state.theme === 'warm' ? 'light' : state.theme;
  }, [state.theme]);

  const set = useCallback(<K extends keyof DcThemeState>(key: K, value: DcThemeState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
  }, []);

  const reset = useCallback(() => setState(DEFAULT_THEME), []);

  const value = useMemo<DcThemeContextValue>(
    () => ({ ...state, set, reset }),
    [state, set, reset],
  );

  return <DcThemeContext.Provider value={value}>{children}</DcThemeContext.Provider>;
}

export function useDcTheme(): DcThemeContextValue {
  const ctx = useContext(DcThemeContext);
  if (!ctx) {
    // Fallback — safe defaults if a consumer mounts outside the provider.
    return {
      ...DEFAULT_THEME,
      set: () => undefined,
      reset: () => undefined,
    };
  }
  return ctx;
}

/** Helper — pluck a tone-aware copy string. */
export function toneFor<T extends string>(tone: ToneKey, variants: Record<ToneKey, T>): T {
  return variants[tone];
}
