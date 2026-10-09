'use client';

// hooks/feed/useJobsBadge.ts — the Jobs nav badge: new jobs that fit since the
// user's last visit to the feed (PRODUCT_PLAN.md §3.3, row 1).
//
// STUB (FND-6a). Owner: WP-33. Fill it from the feed's real count
// (`GET /api/v1/roboapply/feed/new-count`, lib/api/feed.ts) — never an
// estimate. Return null for unknown, loading or zero; the shell draws nothing
// for null (hooks/shared/navBadges.ts).

import type { NavBadgeValue } from '../shared/navBadges';

export function useJobsBadge(): NavBadgeValue | null {
  return null;
}
