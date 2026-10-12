'use client';

// hooks/profile/useProfileBadge.ts — the Profile nav badge: an "Incomplete"
// dot while a field application forms ask for (the extension fills them) is
// still missing (PRODUCT_PLAN.md §3.3, row 6; WP-19).
//
// Reads the shared profile query (hooks/profile/useProfile.ts), so the badge
// clears the moment the profile page saves the last missing field. Unknown,
// loading, errors and an area that is not live yet (501) all mean no badge.

import type { NavBadgeValue } from '../shared/navBadges';
import { useProfile } from './useProfile';

export function useProfileBadge(): NavBadgeValue | null {
  const { data } = useProfile();
  if (!data || !Array.isArray(data.missing)) return null;
  return data.missing.length > 0 ? { kind: 'dot' } : null;
}
