// server/src/features/resume/layout/fitToPage.ts
//
// Fit to one page (WP-65; PRODUCT_PLAN.md F-RES-14): tighten spacing first,
// then margins, then type sizes, never below readable floors — and never touch
// the text. The function only ever sees and returns layout values; the page
// counter it is given renders the same markdown every time.
//
// The search: one compression amount t ∈ [0, 1] moves every value from where
// it is now toward its floor, in phases (spacing 0–0.45, margins 0.3–0.7,
// sizes 0.55–1). If even t = 1 does not fit, nothing changes (`too_long`).
// Otherwise a short bisection finds the least compression that fits.

import type { FitSizes, FitSpacing, FitToPageResponse } from '../contract.js';

/** Readable floors (points). Values already below a floor are never raised. */
export const FIT_FLOORS: { sizes: FitSizes; spacing: FitSpacing } = {
  sizes: { name: 16, section: 10, sub: 9, body: 8.5 },
  spacing: { section: 3, entry: 1, line: 0, marginX: 32, marginY: 30 },
};

/** Bisection steps after the end-point checks (≤ 2 + FIT_STEPS renders). */
export const FIT_STEPS = 6;

export interface FitInput {
  /** The values in effect now (template defaults filled in). */
  current: { sizes: FitSizes; spacing: FitSpacing };
  /** 1 page (default), or 2 for GoApply resumes. */
  target: 1 | 2;
  /** PDF pages with these values applied over the stored layout. */
  countPages(values: { sizes: FitSizes; spacing: FitSpacing }): Promise<number>;
}

export type FitResult = Omit<FitToPageResponse, 'restore'>;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const phase = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const round1 = (n: number) => Math.round(n * 10) / 10;

function toward(value: number, floor: number, amount: number): number {
  const f = Math.min(value, floor);
  return round1(value - (value - f) * amount);
}

/** The values at compression t (pure; exported for tests). */
export function compressAt(current: { sizes: FitSizes; spacing: FitSpacing }, t: number): { sizes: FitSizes; spacing: FitSpacing } {
  const sp = phase(t, 0, 0.45);
  const mg = phase(t, 0.3, 0.7);
  const sz = phase(t, 0.55, 1);
  const F = FIT_FLOORS;
  return {
    spacing: {
      section: toward(current.spacing.section, F.spacing.section, sp),
      entry: toward(current.spacing.entry, F.spacing.entry, sp),
      line: toward(current.spacing.line, F.spacing.line, sp),
      marginX: toward(current.spacing.marginX, F.spacing.marginX, mg),
      marginY: toward(current.spacing.marginY, F.spacing.marginY, mg),
    },
    sizes: {
      name: toward(current.sizes.name, F.sizes.name, sz),
      section: toward(current.sizes.section, F.sizes.section, sz),
      sub: toward(current.sizes.sub, F.sizes.sub, sz),
      body: toward(current.sizes.body, F.sizes.body, sz),
    },
  };
}

export async function fitToPage(input: FitInput): Promise<FitResult> {
  const previous = { sizes: { ...input.current.sizes }, spacing: { ...input.current.spacing } };
  const target = input.target;
  const before = await input.countPages(previous);
  if (before <= target) {
    return { status: 'already_fits', pages: { before, after: before, target }, applied: null, previous };
  }
  const tightest = compressAt(previous, 1);
  const atMax = await input.countPages(tightest);
  if (atMax > target) {
    return { status: 'too_long', pages: { before, after: before, target }, applied: null, previous };
  }
  let lo = 0;
  let hi = 1;
  let best = tightest;
  let bestPages = atMax;
  for (let i = 0; i < FIT_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    const candidate = compressAt(previous, mid);
    const pages = await input.countPages(candidate);
    if (pages <= target) {
      hi = mid;
      best = candidate;
      bestPages = pages;
    } else {
      lo = mid;
    }
  }
  return { status: 'fitted', pages: { before, after: bestPages, target }, applied: best, previous };
}
