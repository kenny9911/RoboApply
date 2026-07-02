'use client';

// hooks/useMockV3.ts
//
// TanStack Query bindings for the V3 Mock Interview API ENVELOPE (`mock.*`,
// Routes 5–7). Query keys namespaced `['v3', 'mock', …]`.
//
// Naming note: a richer client-side mock-interview implementation already
// exists (`hooks/useMockInterviews.ts` + `lib/mockInterview/*`). These `*V3`
// hooks are the swap-path wrappers over the `raV2Api.mock.*` surface so the
// eventual server migration is a one-file change. The live V3 screens may keep
// reading the existing lib; these exist so the contract is fully wired.
//
// Surface:
//   - useMockCatalog()           GET  mock.catalog (roles/interviewers/types)
//   - useMockRecentSessions()    GET  mock.recentSessions
//   - useMockStart()             POST mock.start (new session + questions)
//   - useMockNextTurn()          POST mock.nextTurn (advance the live loop)
//   - useMockScore(sessionId)    GET  mock.score (the graded report)

import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  MockCatalogResponse,
  MockNextTurnBody,
  MockNextTurnResponse,
  MockRecentSessionsResponse,
  MockScoreResponse,
  MockStartBody,
  MockStartResponse,
} from '../lib/api/v2';

export const mockV3Keys = {
  all: ['v3', 'mock'] as const,
  catalog: () => ['v3', 'mock', 'catalog'] as const,
  recentSessions: () => ['v3', 'mock', 'recentSessions'] as const,
  score: (sessionId: string) => ['v3', 'mock', 'score', sessionId] as const,
};

export function useMockCatalog(): UseQueryResult<MockCatalogResponse, Error> {
  return useQuery({
    queryKey: mockV3Keys.catalog(),
    queryFn: () => raV2Api.mock.catalog(),
    // Catalog is effectively static for a session.
    staleTime: 5 * 60 * 1000,
  });
}

export function useMockRecentSessions(): UseQueryResult<
  MockRecentSessionsResponse,
  Error
> {
  return useQuery({
    queryKey: mockV3Keys.recentSessions(),
    queryFn: () => raV2Api.mock.recentSessions(),
  });
}

export function useMockStart(): UseMutationResult<
  MockStartResponse,
  Error,
  MockStartBody
> {
  return useMutation({
    mutationFn: (body: MockStartBody) => raV2Api.mock.start(body),
  });
}

export function useMockNextTurn(): UseMutationResult<
  MockNextTurnResponse,
  Error,
  MockNextTurnBody
> {
  return useMutation({
    mutationFn: (body: MockNextTurnBody) => raV2Api.mock.nextTurn(body),
  });
}

/** The graded report for a finished session. The report page reads it by id;
 *  `enabled` is gated on a non-empty `sessionId`. */
export function useMockScore(
  sessionId: string | null | undefined,
): UseQueryResult<MockScoreResponse, Error> {
  return useQuery({
    queryKey: sessionId
      ? mockV3Keys.score(sessionId)
      : ['v3', 'mock', 'score', 'null'],
    enabled: !!sessionId,
    queryFn: () => {
      if (!sessionId) throw new Error('sessionId is required');
      return raV2Api.mock.score(sessionId);
    },
  });
}
