'use client';

// PlanBadge — the plan line under the nav ("Free · Upgrade" or "Pro" with
// today's credits summary) (PRODUCT_PLAN.md §3.3; GoApply 会员 badge).
//
// STUB (FND-6a). Owner: WP-21b. Renders nothing. Mounted by the Sidebar
// (variant 'rail') and the mobile More sheet (variant 'sheet'). When filled:
// plan and credits come from /auth/me.entitlements via hooks/shared/useCredits
// (never computed on the client), caps print as "Up to N a day", never
// "unlimited"; nothing renders until the summary is known.

export interface PlanBadgeProps {
  variant?: 'rail' | 'sheet';
}

export function PlanBadge(_props: PlanBadgeProps = {}): null {
  return null;
}

export default PlanBadge;
