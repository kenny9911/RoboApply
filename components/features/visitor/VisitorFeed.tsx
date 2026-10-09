'use client';

// VisitorFeed — the signed-out job list on public pages: up to 20 public
// jobs, no fit scores, a signup gate after the list (TASK_PLAN.md WP-78;
// ruling C26).
//
// STUB (FND-6b). Owner: WP-78. Renders nothing. WP-56's browse pages
// (`/browse/*`) render it under their server-rendered list. Data comes only
// from GET /api/v1/public/feed (lib/api/visitor.ts `getPublicFeed`), which
// returns `publicDisplay` jobs only.

import type { PublicFeedItem } from '../../../lib/api/contracts/feed';

export interface VisitorFeedQuery {
  role?: string;
  city?: string;
  /** ISO-3166 alpha-2, uppercase. */
  country?: string;
}

export interface VisitorFeedProps {
  /** The page's own filter (role, city, country). */
  query?: VisitorFeedQuery;
  /** Signup attribution slug for the gate's CTA (`/signup?from=<from>`). */
  from: string;
  /** Items the server already rendered for this query, to skip the first fetch. */
  initialItems?: readonly PublicFeedItem[];
}

export function VisitorFeed(_props: VisitorFeedProps): null {
  return null;
}

export default VisitorFeed;
