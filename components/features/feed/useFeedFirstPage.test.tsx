import type { ReactNode } from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { feedKeys, type FeedListKeyInput } from '../../../hooks/feed/keys';
import type { FeedQueryResponse } from '../../../lib/api/contracts/feed';
import { useFeedFirstPage } from './useFeedFirstPage';

const input: FeedListKeyInput = {
  searchProfileId: 'profile-1',
  version: 1,
  sort: 'recommended',
  fitTier: 'all',
};

function page(sessionId: string): FeedQueryResponse {
  return { sessionId, items: [], cursor: null, endOfFeed: true, hiddenByTier: 0 };
}

function data(...pages: FeedQueryResponse[]): InfiniteData<FeedQueryResponse> {
  return { pages, pageParams: pages.map(() => null) };
}

function provider(client: QueryClient) {
  return function Provider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useFeedFirstPage', () => {
  it('does not update the feed reader while a newly mounted child initializes its query', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // JobCard and the job-action sheets mount queries when the first feed page
    // arrives. Creating their observers emits cache events during their render.
    function ChildQuery() {
      useQuery({ queryKey: ['child-profile'], queryFn: async () => [], enabled: false });
      return <span>Child ready</span>;
    }

    function FeedReader() {
      const firstPage = useFeedFirstPage(input);
      return firstPage ? <ChildQuery /> : <span>Loading feed</span>;
    }

    try {
      const view = render(<FeedReader />, { wrapper: provider(client) });
      expect(screen.getByText('Loading feed')).toBeInTheDocument();

      act(() => {
        client.setQueryData(feedKeys.list(input), data(page('first')));
      });
      await screen.findByText('Child ready');

      const renderWarnings = error.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.includes('Cannot update a component'),
      );
      expect(renderWarnings).toEqual([]);
      view.unmount();
    } finally {
      error.mockRestore();
      client.clear();
    }
  });

  it('reads cached first pages, follows updates and key changes, and makes no requests', async () => {
    const fetchQuery = vi.fn(async () => data(page('unexpected-request')));
    const client = new QueryClient({
      defaultOptions: { queries: { queryFn: fetchQuery, retry: false, gcTime: Infinity } },
    });
    const initial = page('recommended');
    const newestInput = { ...input, sort: 'newest' as const };
    const newest = page('newest');
    client.setQueryData(feedKeys.list(input), data(initial, page('second-page')));
    client.setQueryData(feedKeys.list(newestInput), data(newest));

    const view = renderHook((key: FeedListKeyInput) => useFeedFirstPage(key), {
      initialProps: input,
      wrapper: provider(client),
    });
    expect(view.result.current).toBe(initial);

    const updated = page('updated');
    act(() => {
      client.setQueryData(feedKeys.list(input), data(updated));
    });
    await waitFor(() => expect(view.result.current?.sessionId).toBe('updated'));

    view.rerender(newestInput);
    expect(view.result.current).toBe(newest);

    act(() => {
      client.setQueryData(feedKeys.list(input), data(page('old-key-update')));
    });
    expect(view.result.current).toBe(newest);

    act(() => {
      client.removeQueries({ queryKey: feedKeys.list(newestInput), exact: true });
    });
    await waitFor(() => expect(view.result.current).toBeNull());
    expect(fetchQuery).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });
});
