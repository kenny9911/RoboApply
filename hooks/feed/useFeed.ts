'use client';

// hooks/feed/useFeed.ts — the /jobs list: POST /feed/query, 20 per page,
// cursor pagination over the server's feed session (ARCHITECTURE.md §4.8;
// WP-32 serves it, WP-33 renders it).
//
// Rules this hook keeps:
//   • the server ranks, filters and scores; the client never filters a
//     partial list (TASK_PLAN.md WP-33 acceptance). The only items removed
//     locally are jobs the user just hid, which the server has already hidden;
//   • fit scores come in the batch (`FeedItem.fit`); there is no per-card
//     score request;
//   • pages append; a job that appears twice across pages is shown once;
//   • a refresh with no cursor is rate-limited by the server (429
//     `rate_limited`, `details.reason: feed_refresh_limited`): the list is not
//     refetched on focus or by job actions (see keys.ts);
//   • a next page whose server session expired (409 `conflict`,
//     `details.reason: feed_session_expired`) restarts the list from page 1.

import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { queryFeed } from '../../lib/api/feed';
import { apiErrorReason } from '../../lib/api/contracts/wire';
import type { FeedItem, FeedQueryResponse, FeedSort } from '../../lib/api/contracts/feed';
import { feedKeys, type FeedFitView } from './keys';

export interface UseFeedParams {
  searchProfileId: string | null;
  /** The saved search's version: a filter change makes a new list. */
  version: number | null;
  sort: FeedSort;
  fitTier: FeedFitView;
  /** Query-only filters (Explore category). Never saved. */
  overrides?: Record<string, unknown> | null;
  enabled?: boolean;
}

export interface FeedListState {
  items: FeedItem[];
  /** "Hiding {n} weaker fits" from the first page; null until it loads. */
  hiddenByTier: number | null;
  /** The newest page's session id (impressions, rating). */
  sessionId: string | null;
  endOfFeed: boolean;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  /** The server refused a new session (20 per 10 minutes). */
  refreshLimited: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
}

/** Flatten pages in order, keeping the first copy of a job. Pure, for tests. */
export function flattenFeedPages(pages: readonly FeedQueryResponse[] | undefined): FeedItem[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const page of pages) {
    for (const item of page.items ?? []) {
      if (seen.has(item.jobId)) continue;
      seen.add(item.jobId);
      out.push(item);
    }
  }
  return out;
}

function stableKey(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export function useFeed(params: UseFeedParams): FeedListState {
  const { searchProfileId, version, sort, fitTier, overrides } = params;
  const overridesKey = stableKey(overrides);
  const queryClient = useQueryClient();
  const queryKey = feedKeys.list({ searchProfileId, version, sort, fitTier, overridesKey });
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      queryFeed(
        {
          ...(searchProfileId ? { searchProfileId } : {}),
          sort,
          fitTier,
          ...(overridesKey ? { overrides: overrides ?? undefined } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: FeedQueryResponse) => (last.endOfFeed || !last.cursor ? undefined : last.cursor),
    enabled: params.enabled ?? true,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const reason = apiErrorReason(query.error);
  const sessionExpired = query.isFetchNextPageError && reason === 'feed_session_expired';
  const queryKeyHash = JSON.stringify(queryKey);
  useEffect(() => {
    // The server session behind the cursor is gone (30 min): start again from page 1.
    if (sessionExpired) void queryClient.resetQueries({ queryKey: JSON.parse(queryKeyHash) as readonly unknown[], exact: true });
  }, [sessionExpired, queryClient, queryKeyHash]);

  const pages = query.data?.pages;
  const items = useMemo(() => flattenFeedPages(pages), [pages]);
  const first = pages?.[0];
  const last = pages?.[pages.length - 1];

  return {
    items,
    hiddenByTier: first ? (Number.isFinite(first.hiddenByTier) ? first.hiddenByTier : null) : null,
    sessionId: last?.sessionId ?? null,
    endOfFeed: !!last && (last.endOfFeed || !last.cursor),
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refreshLimited: reason === 'feed_refresh_limited',
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => {
      void query.refetch();
    },
  };
}
