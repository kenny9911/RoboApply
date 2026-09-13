'use client';

// BrandLogo — the sidebar brand mark (.brand / .brand-mark): the identity
// plane (--brand-plane) carrying the sparkle glyph in --brand-mark, then the
// wordmark. This is one of the four places identity colour is allowed to
// appear (ruling R3), and it never carries text.
//
// It doubles as a "go home" affordance. Home is unconditionally /jobs: with
// auto-apply dead (R1) there is no second landing page to branch to, so the
// old useJobApplyingEnabled() fork — /home when the flag was on, the mock
// interview screen when it was off — is gone along with both routes.
//
// The mono sub-label ("YOUR AI JOB HUNTER") is gone too. The product has no
// persona to introduce (D4), and a tagline under the wordmark on every
// authenticated screen was the last place one was still speaking.

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BrandSymbol } from '../../chrome/BrandSymbol';

export function BrandLogo() {
  const t = useTranslations('nav');
  return (
    <Link href="/jobs" className="brand" aria-label={t('brand_home')}>
      <span className="brand-mark" aria-hidden="true">
        <BrandSymbol size={23} />
      </span>
      <span className="brand-name">RoboApply</span>
    </Link>
  );
}
