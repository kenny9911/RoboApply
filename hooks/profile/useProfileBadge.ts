'use client';

// hooks/profile/useProfileBadge.ts — the Profile nav badge: an "Incomplete" dot
// until the fields the extension needs to fill a form are filled
// (PRODUCT_PLAN.md §3.3, row 6).
//
// STUB (FND-6a). Owner: WP-19. Return `{ kind: 'dot' }` from the profile's
// real completeness (lib/api/profile.ts), null otherwise; the shell draws
// nothing for null (hooks/shared/navBadges.ts).

import type { NavBadgeValue } from '../shared/navBadges';

export function useProfileBadge(): NavBadgeValue | null {
  return null;
}
