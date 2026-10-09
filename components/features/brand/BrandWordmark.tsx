'use client';

// BrandWordmark — the brand mark plus the brand name, for chrome outside the
// app sidebar (auth pages, onboarding header, public headers, the developer
// guide). TASK_PLAN.md WP-12 / ARCHITECTURE.md §1.6: the glyph and the name
// come from the request's brand, the colours from the brand tokens, so no
// caller ever writes a product name.
//
//   <BrandWordmark />                 links home ("/")
//   <BrandWordmark href={null} />     plain, not a link
//   <BrandWordmark size="md" />       34 px mark + title-size name
//
// The sidebar keeps its own BrandLogo (components/v3/shell/BrandLogo.tsx,
// .brand / .brand-mark classes); the root of both is BrandSymbol.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useBrand, type BrandId } from '../../../lib/brand';
import { BrandSymbol } from '../../chrome/BrandSymbol';
import styles from './brand.module.css';

export interface BrandWordmarkProps {
  /** Link target; `null` renders the wordmark without a link. Default "/". */
  href?: string | null;
  size?: 'sm' | 'md';
  /** Force a brand (previews, the other-brand nudge); defaults to the request's brand. */
  brand?: BrandId;
  className?: string;
}

const GLYPH_PX = { sm: 17, md: 22 } as const;

export function BrandWordmark({ href = '/', size = 'sm', brand: forced, className }: BrandWordmarkProps) {
  const current = useBrand();
  const t = useTranslations('brand.wordmark');
  const id = forced ?? current.id;
  const name = forced && forced !== current.id ? current.otherBrand.name : current.name;
  const cls = [styles.wordmark, styles[size], className].filter(Boolean).join(' ');
  const inner = (
    <>
      <span className={styles.wordmarkMark} aria-hidden="true">
        <BrandSymbol size={GLYPH_PX[size]} brand={id} />
      </span>
      <span className={styles.wordmarkName}>{name}</span>
    </>
  );
  if (href === null) {
    return (
      <span className={cls} data-brand={id}>
        {inner}
      </span>
    );
  }
  return (
    <Link href={href} className={cls} data-brand={id} aria-label={id === current.id ? t('home') : undefined}>
      {inner}
    </Link>
  );
}

export default BrandWordmark;
