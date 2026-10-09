'use client';

// TourOverlay — the first-visit tour on /jobs (onboarding stage `tour`,
// PRODUCT_PLAN.md §4.3 O8), mounted once by the app shell (FND-6a slot).
//
// STUB (FND-6a). Owner: WP-30. Renders nothing. When filled: show only while
// `/auth/me.onboarding.step === 'tour'`, mark it seen with
// `markToursSeen(['jobs.firstVisit'])` (lib/api/uiState.ts), and never block
// the page (it is skippable at every step).

export type TourOverlayProps = Record<string, never>;

export function TourOverlay(_props: TourOverlayProps = {}): null {
  return null;
}

export default TourOverlay;
