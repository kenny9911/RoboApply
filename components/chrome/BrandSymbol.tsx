'use client';

// BrandSymbol — the product brand's glyph (TASK_PLAN.md WP-12, ARCHITECTURE.md
// §1.6). RoboApply: the R with its next-step arrow. GoApply: the G with the
// same arrow, so the two marks read as one family. The surrounding surface
// owns colour (`currentColor` / the `.brand-mark svg` stroke rule), so the
// glyph follows the brand tokens in both themes.
//
// `brand` picks the glyph explicitly (snapshots, the other-brand nudge);
// without it the glyph follows the request's brand (useBrand()), so every
// existing caller renders the right mark on goapply.top with no edit.

import { useBrandId, type BrandId } from '../../lib/brand';

const GLYPHS: Record<BrandId, readonly { d: string; strokeWidth?: string }[]> = {
  roboapply: [{ d: 'M5 18V6h7a4 4 0 0 1 0 8H8m4 0 6 5' }, { d: 'm16 4 3-1-1 3', strokeWidth: '1.5' }],
  goapply: [{ d: 'M17.5 7.5A7 7 0 1 0 19 12.5h-6.5' }, { d: 'm16 4 3-1-1 3', strokeWidth: '1.5' }],
};

export interface BrandSymbolProps {
  size?: number;
  /** Which brand's glyph; defaults to the current brand. */
  brand?: BrandId;
}

export function BrandSymbol({ size = 24, brand }: BrandSymbolProps) {
  const current = useBrandId();
  const id = brand ?? current;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-brand-glyph={id}
    >
      {GLYPHS[id].map((p) => (
        <path key={p.d} d={p.d} strokeWidth={p.strokeWidth} />
      ))}
    </svg>
  );
}
