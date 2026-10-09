'use client';

// hooks/tracker/useApplicationsBadge.ts — the Applications nav badge: how many
// applications have had no reply in 10+ days (PRODUCT_PLAN.md §3.3, row 3;
// ruling C11). Owner: WP-38.
//
// Not a stub. The rail already showed this number before the clone (the
// existing `countAwaitingReply` over the tracker), so FND-6a moved the logic
// here unchanged instead of blanking a working badge. WP-38 may switch it to
// its own tracker query; the contract is only "a real count or null".
//
// There is no reply event in the data model — nothing writes "they emailed
// back". What the tracker does record is the stage the user last moved a row
// to, so an entry still sitting in `applied` N days after `dateApplied` is one
// nobody has heard from. Any real reply (a call, a rejection, an offer) moves
// the row out of `applied` and out of this count.

import { useMemo } from 'react';

import { usePipelineBoard } from '../usePipelineBoard';
import type { RATrackerEntryView } from '../../lib/api/v2';
import type { NavBadgeValue } from '../shared/navBadges';

/** Ruling C11: the one number worth interrupting someone for. */
export const NO_REPLY_DAYS = 10;

/** How many applications have had no reply in 10+ days. */
export function countAwaitingReply(entries: readonly RATrackerEntryView[], now: number = Date.now()): number {
  const cutoff = now - NO_REPLY_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter(
    (e) => e.status === 'applied' && e.dateApplied !== null && Date.parse(e.dateApplied) <= cutoff,
  ).length;
}

export function useApplicationsBadge(): NavBadgeValue | null {
  // Shares the TanStack cache entry with /applications and the board, so on
  // the Applications screen the badge costs nothing.
  const { data: board } = usePipelineBoard();
  return useMemo(() => {
    if (!board) return null;
    const count = countAwaitingReply(board.entries ?? []);
    return count > 0 ? { kind: 'count', count } : null;
  }, [board]);
}
