'use client';

// hooks/agent/useReadyBadge.ts — the "Ready to apply" nav badge: kits that are
// ready and not opened yet (PRODUCT_PLAN.md §3.3, row 2).
//
// STUB (FND-6a). Owner: WP-53. Fill it from the weekly list
// (lib/api/agent.ts). Return null for unknown, loading or zero; the shell draws
// nothing for null (hooks/shared/navBadges.ts).

import type { NavBadgeValue } from '../shared/navBadges';

export function useReadyBadge(): NavBadgeValue | null {
  return null;
}
