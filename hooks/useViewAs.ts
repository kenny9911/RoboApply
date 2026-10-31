'use client';

// hooks/useViewAs.ts — admin "view as" (the god's-eye view; server
// platform/viewAs). Kept apart from hooks/useAdmin.ts because the view banner
// is mounted on every page (app/providers.tsx) and must not pull the whole
// admin console client into each bundle.
//
//   - useStartViewAs()  POST /api/v1/roboapply/admin/view-as
//   - useStopViewAs()   POST /api/v1/roboapply/admin/view-as/stop
//
// Both are followed by a full page load (the caller's job): into `landing`
// after starting, back to the admin console after stopping. No cached data of
// one account is ever shown as the other's.

import { useMutation } from '@tanstack/react-query';
import { startViewAs, stopViewAs } from '../lib/api/admin';

/** Start a read-only view as one person. */
export function useStartViewAs() {
  return useMutation({ mutationFn: (userId: string) => startViewAs(userId) });
}

/** End the current view (works from inside it). */
export function useStopViewAs() {
  return useMutation({ mutationFn: () => stopViewAs() });
}
