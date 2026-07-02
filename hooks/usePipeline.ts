'use client';

// hooks/usePipeline.ts
//
// Reads tracker entries and derives the 4-bucket PipelineFunnel view: counts
// for Bookmarked / Applied / Interviewing / Negotiating. The Home page
// also passes these counts to ApplicationsRing's "applied this week" math.
//
// We piggy-back on `tracker.list()` rather than building a dedicated funnel
// endpoint — the existing `statusCounts` field on the response gives every
// status key the funnel cares about.

import { useQuery } from '@tanstack/react-query';
import { raV2Api } from '../lib/api/v2';
import type {
  TrackerListResponse,
  RATrackerEntryView,
} from '../lib/api/v2';

const TRACKER_HOME_KEY = ['v2', 'home', 'tracker'] as const;

export interface PipelineBucket {
  status: 'bookmarked' | 'applied' | 'interviewing' | 'negotiating';
  count: number;
  goal: number;
}

export interface PipelineData {
  buckets: PipelineBucket[];
  entries: RATrackerEntryView[];
  total: number;
  appliedThisWeek: number;
  rangeStartIso: string;
  rangeEndIso: string;
}

/** Read the user's tracker (up to 50 entries) and surface both the raw rows
 *  and pre-aggregated pipeline buckets used by `PipelineFunnel` and
 *  `ApplicationsRing`. */
export function usePipeline() {
  const query = useQuery<TrackerListResponse>({
    queryKey: TRACKER_HOME_KEY,
    queryFn: () => raV2Api.tracker.list({ limit: 50 }),
  });

  let derived: PipelineData | null = null;
  if (query.data) {
    derived = deriveFromTracker(query.data);
  }

  return { ...query, derived };
}

function deriveFromTracker(data: TrackerListResponse): PipelineData {
  const counts = data.statusCounts;
  // The "goal" line on each bar is a rough yardstick the user can read
  // against — proportional to the largest bucket so a small tracker still
  // looks meaningful. We cap at 60 (the V2 PRD's reference value).
  const peak = Math.max(
    counts.bookmarked ?? 0,
    counts.applied ?? 0,
    counts.interviewing ?? 0,
    counts.negotiating ?? 0,
    8,
  );
  const goal = Math.max(peak, Math.min(60, peak * 1.5));

  const buckets: PipelineBucket[] = [
    { status: 'bookmarked', count: counts.bookmarked ?? 0, goal },
    { status: 'applied', count: counts.applied ?? 0, goal },
    { status: 'interviewing', count: counts.interviewing ?? 0, goal },
    { status: 'negotiating', count: counts.negotiating ?? 0, goal },
  ];

  // "Applied this week" = entries with `dateApplied` inside the rolling
  // 7-day window ending today. Cheap to compute against ≤50 rows so we do
  // it here instead of adding another endpoint.
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86_400_000;
  const appliedThisWeek = data.entries.filter((e) => {
    if (!e.dateApplied) return false;
    const t = Date.parse(e.dateApplied);
    return Number.isFinite(t) && t >= sevenDaysAgo && t <= now;
  }).length;

  const rangeStartIso = new Date(sevenDaysAgo).toISOString();
  const rangeEndIso = new Date(now).toISOString();

  return {
    buckets,
    entries: data.entries,
    total: data.total,
    appliedThisWeek,
    rangeStartIso,
    rangeEndIso,
  };
}
