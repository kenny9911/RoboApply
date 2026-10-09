'use client';

// BrandLogo — the sidebar brand mark (.brand / .brand-mark): the identity
// plane (--brand-plane) carrying the brand glyph in --brand-mark, then the
// wordmark. This is one of the four places identity colour is allowed to
// appear (ruling R3), and it never carries text.
//
// Per brand (TASK_PLAN.md WP-12): the glyph and the name come from the
// request's brand (useBrand()); the colours come from the brand tokens
// (styles/brands/goapply.css overrides them under html[data-brand]).
//
// It doubles as a "go home" affordance. Home is unconditionally /jobs: with
// auto-apply dead (R1) there is no second landing page to branch to.
// No tagline under the wordmark: the product has no persona to introduce.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import { BrandSymbol } from '../../chrome/BrandSymbol';

export function BrandLogo() {
  const t = useTranslations('nav');
  const brand = useBrand();
  return (
    <Link href="/jobs" className="brand" aria-label={t('brand_home')} data-brand={brand.id}>
      <span className="brand-mark" aria-hidden="true">
        <BrandSymbol size={23} brand={brand.id} />
      </span>
      <span className="brand-name">{brand.name}</span>
    </Link>
  );
}
