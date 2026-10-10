'use client';

// hooks/tracker/useApplicationsBadge.ts — the Applications nav badge: how many
// applications have had no reply in 10+ days (PRODUCT_PLAN.md §3.3, row 3;
// ruling C11). Owner: WP-38.
//
// There is no reply event in the data model — nothing writes "they emailed
// back". What the tracker does record is the stage the user last moved a row
// to, so an entry still sitting at Applied 10+ days after `dateApplied` is one
// nobody has heard from. A follow-up date the user set in the future snoozes
// it until that date (the server's follow-up facts,
// server/src/features/tracker/facts.ts, split the same rows into "no reply"
// and "follow-up date has arrived").

import { useMemo } from 'react';

import { usePipelineBoard } from '../usePipelineBoard';
import type { NavBadgeValue } from '../shared/navBadges';

/** Ruling C11: the one number worth interrupting someone for. */
export const NO_REPLY_DAYS = 10;

export interface AwaitingReplyLike {
  status: string;
  dateApplied: string | null;
  followUpAt?: string | null;
}

/** Is this application still waiting for a reply after 10+ days? */
export function isAwaitingReply(e: AwaitingReplyLike, now: number = Date.now()): boolean {
  if (e.status !== 'applied' && e.status !== 'applying') return false;
  // A follow-up date still ahead means the user chose to wait until then.
  if (e.followUpAt && Date.parse(e.followUpAt) > now) return false;
  return e.dateApplied !== null && Date.parse(e.dateApplied) <= now - NO_REPLY_DAYS * 24 * 60 * 60 * 1000;
}

/** How many applications have had no reply in 10+ days. */
export function countAwaitingReply(entries: readonly AwaitingReplyLike[], now: number = Date.now()): number {
  return entries.filter((e) => isAwaitingReply(e, now)).length;
}

export function useApplicationsBadge(): NavBadgeValue | null {
  // Shares the TanStack cache entry with /applications, so on the
  // Applications screen the badge costs nothing.
  const { data: board } = usePipelineBoard();
  return useMemo(() => {
    if (!board) return null;
    const count = countAwaitingReply(board.entries ?? []);
    return count > 0 ? { kind: 'count', count } : null;
  }, [board]);
}
