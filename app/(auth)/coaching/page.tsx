// /coaching — the coach list (WP-72; PRODUCT_PLAN.md §5.14 F-COACH-01).
// Renders inside the (auth) app shell. The nav entry shows only when the
// `coaching` capability is on and the site's list has a coach; the page
// itself says "not available here" when the capability is off.
//
// There is deliberately no /coaching/bookings route in V2 (no bookings data):
// that path 404s (asserted in components/features/coaching/__tests__).

import { CoachingPage } from '../../../components/features/coaching';

export default function CoachingRoute() {
  return <CoachingPage />;
}
