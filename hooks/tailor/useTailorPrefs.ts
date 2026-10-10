'use client';

// hooks/tailor/useTailorPrefs.ts — the last tailor settings, for "Fast tailor"
// (PRODUCT_PLAN.md F-RES-09: repeat users skip the setup). Per-viewer
// convenience in localStorage; every read and write is guarded, and the flow
// works the same without it (Fast tailor simply does not show).

import { useCallback, useEffect, useState } from 'react';

import type { TailorSection } from '../../lib/api/contracts/resume';

/** The sections a tailor may change, in display order (server TAILOR_SECTIONS). */
export const TAILOR_SECTION_KEYS: readonly TailorSection[] = ['summary', 'experience', 'skills', 'projects', 'education'];
export type TailorSectionKey = TailorSection;
/** Default for a first tailor: the parts a posting usually changes. */
export const DEFAULT_TAILOR_SECTIONS: readonly TailorSection[] = ['summary', 'experience', 'skills'];

const KEY = 'ra_tailor_prefs_v1';

export interface TailorPrefs {
  sections: TailorSectionKey[];
  experienceDepth: 'quick' | 'full';
  /** Number of finished tailors on this device (Fast tailor shows from 1). */
  runs: number;
}

export function readTailorPrefs(): TailorPrefs | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TailorPrefs>;
    const sections = (Array.isArray(parsed.sections) ? parsed.sections : []).filter((s): s is TailorSectionKey =>
      (TAILOR_SECTION_KEYS as readonly string[]).includes(String(s)),
    );
    if (sections.length === 0) return null;
    return {
      sections,
      experienceDepth: parsed.experienceDepth === 'full' ? 'full' : 'quick',
      runs: typeof parsed.runs === 'number' && parsed.runs > 0 ? Math.floor(parsed.runs) : 0,
    };
  } catch {
    return null;
  }
}

export function writeTailorPrefs(prefs: TailorPrefs): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable (private window, blocked site data) — Fast tailor just stays hidden
  }
}

export function useTailorPrefs(): {
  prefs: TailorPrefs | null;
  remember: (sections: TailorSectionKey[], experienceDepth: 'quick' | 'full') => void;
} {
  const [prefs, setPrefs] = useState<TailorPrefs | null>(null);
  useEffect(() => {
    setPrefs(readTailorPrefs());
  }, []);
  const remember = useCallback((sections: TailorSectionKey[], experienceDepth: 'quick' | 'full') => {
    const next: TailorPrefs = { sections, experienceDepth, runs: (readTailorPrefs()?.runs ?? 0) + 1 };
    writeTailorPrefs(next);
    setPrefs(next);
  }, []);
  return { prefs, remember };
}
