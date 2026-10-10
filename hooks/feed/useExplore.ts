'use client';

// hooks/feed/useExplore.ts — Explore (PRODUCT F-FEED-13, F-FEED-17):
// the function categories with live counts (`GET /feed/explore`, cached 10
// minutes by the server) and the plain-language search that turns a sentence
// into a filter change the user confirms (`POST /feed/nl-query`).

import { useMutation, useQuery } from '@tanstack/react-query';

import { getExplore, nlQuery } from '../../lib/api/feed';
import { feedKeys } from './keys';

export function useExplore(enabled = true) {
  return useQuery({
    queryKey: feedKeys.explore(),
    queryFn: ({ signal }) => getExplore({ signal }),
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useNlQuery() {
  return useMutation({
    mutationFn: (vars: { text: string; searchProfileId?: string }) =>
      nlQuery(vars.searchProfileId ? { text: vars.text, searchProfileId: vars.searchProfileId } : { text: vars.text }),
  });
}
