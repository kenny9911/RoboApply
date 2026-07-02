'use client';

// BrandLogo — the V3 sidebar brand mark (.brand / .brand-mark). A gradient
// rounded square (--grad-brand) with an inset --bg cutout and the sparkle SVG,
// then "RoboApply" + a mono sub-label. Ported from app.jsx BrandLogo. Doubles
// as a "go home" affordance — points at the ACTIVE home so it never targets a
// hidden route: /home when job-applying is on, /mock-interview when it's off
// (matching the JobApplyingGate landing).

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { JOB_APPLY_OFF_LANDING, useJobApplyingEnabled } from '../../../lib/jobApplying';

export function BrandLogo() {
  const t = useTranslations('nav_v3');
  const home = useJobApplyingEnabled() === true ? '/home' : JOB_APPLY_OFF_LANDING;
  return (
    <Link href={home} className="brand" aria-label="RoboApply — home">
      <span className="brand-mark" aria-hidden="true">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent-text)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        </svg>
      </span>
      <span className="brand-name">
        RoboApply
        <small>{t('brand_tagline')}</small>
      </span>
    </Link>
  );
}
