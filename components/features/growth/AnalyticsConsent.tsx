'use client';

// components/features/growth/AnalyticsConsent.tsx — STUB (FND-2b; WP-23 fills it).
//
// Analytics consent banner (TASK_PLAN.md WP-23, H28): EEA/UK/CH visitors on
// RoboApply see Accept and Reject with equal weight; before consent there is
// no `anonId` cookie and events stay session-only. GoApply lists the event
// collection in its personal-information list instead (WP-13 text).
//
// Mounted once by app/layout.tsx inside <Providers>; renders nothing until
// WP-23 replaces it. Brand comes from useBrand() (lib/brand).

export interface AnalyticsConsentProps {
  /** Visitor country from the edge headers (uppercase ISO-3166 alpha-2), or null. */
  country: string | null;
}

export function AnalyticsConsent(_props: AnalyticsConsentProps): null {
  return null;
}

export default AnalyticsConsent;
