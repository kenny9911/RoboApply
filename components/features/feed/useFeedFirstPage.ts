'use client';

// components/features/feed/useFeedFirstPage.ts — the first page of the feed
// list as the server sent it, read from the query cache the list already
// fills (hooks/feed/useFeed.ts). It makes no request of its own.
//
// The list hook returns the cards; the response also says what the rows come
// from (`sources`), whether the result set is thin (`thin`) and whether the
// list is ordered by date (`order`). The page header needs those, so it reads
// the same cached response through the same key.

import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';

import { feedKeys, type FeedListKeyInput } from '../../../hooks/feed/keys';
import type { FeedQueryResponse } from '../../../lib/api/contracts/feed';

export function useFeedFirstPage(input: FeedListKeyInput): FeedQueryResponse | null {
  const client = useQueryClient();
  const key = JSON.stringify(feedKeys.list(input));
  const read = useCallback(
    () => client.getQueryData<InfiniteData<FeedQueryResponse>>(JSON.parse(key) as readonly unknown[])?.pages?.[0] ?? null,
    [client, key],
  );
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client]);
  return useSyncExternalStore(subscribe, read, () => null);
}
