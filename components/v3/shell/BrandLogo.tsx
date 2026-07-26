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

export function BrandLogo() {
  const t = useTranslations('nav');
  return (
    <Link href="/jobs" className="brand" aria-label={t('brand_home')}>
      <span className="brand-mark" aria-hidden="true">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--brand-mark)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        </svg>
      </span>
      <span className="brand-name">RoboApply</span>
    </Link>
  );
}
