'use client';

// useMockInterviews — React Query bindings for the Mock Interview surface.
//
// Read paths combine the static fixture catalog with the user's localStorage-
// backed custom mocks. Write paths go to localStorage (mockStore) and bust
// the relevant cache keys.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { FIXTURE_MOCKS } from '../lib/mockInterview/fixtures';
import { mockStore } from '../lib/mockInterview/store';
import type {
  MockCategory,
  MockInterview,
  MockReport,
  MockSession,
} from '../lib/mockInterview/types';

export const mockKeys = {
  all: ['mockInterviews'] as const,
  list: (kind: 'builtin' | 'custom', category?: MockCategory) =>
    ['mockInterviews', 'list', kind, category ?? 'all'] as const,
  detail: (id: string) => ['mockInterviews', 'detail', id] as const,
  session: (id: string) => ['mockInterviews', 'session', id] as const,
  report: (id: string) => ['mockInterviews', 'report', id] as const,
};

export function useMockList(params: {
  kind: 'builtin' | 'custom';
  category?: MockCategory;
}): UseQueryResult<MockInterview[], Error> {
  return useQuery({
    queryKey: mockKeys.list(params.kind, params.category),
    queryFn: async (): Promise<MockInterview[]> => {
      const source =
        params.kind === 'builtin' ? FIXTURE_MOCKS : mockStore.listCustomMocks();
      if (!params.category || params.category === 'all') return source;
      return source.filter((m) => m.category === params.category);
    },
  });
}

export function useMock(id: string | null | undefined): UseQueryResult<
  MockInterview | null,
  Error
> {
  return useQuery({
    queryKey: id ? mockKeys.detail(id) : ['mockInterviews', 'detail', 'null'],
    enabled: !!id,
    queryFn: async (): Promise<MockInterview | null> => {
      if (!id) return null;
      const builtin = FIXTURE_MOCKS.find((m) => m.id === id);
      if (builtin) return builtin;
      return mockStore.getCustomMock(id);
    },
  });
}

export function useCreateCustomMockMutation(): UseMutationResult<
  MockInterview,
  Error,
  MockInterview
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mock: MockInterview): Promise<MockInterview> => {
      mockStore.saveCustomMock(mock);
      return mock;
    },
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: mockKeys.all });
      qc.setQueryData(mockKeys.detail(m.id), m);
    },
  });
}

export function useDeleteCustomMockMutation(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      mockStore.deleteCustomMock(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mockKeys.all });
    },
  });
}

export function useMockSession(id: string | null | undefined): UseQueryResult<
  MockSession | null,
  Error
> {
  return useQuery({
    queryKey: id ? mockKeys.session(id) : ['mockInterviews', 'session', 'null'],
    enabled: !!id,
    queryFn: async (): Promise<MockSession | null> => {
      if (!id) return null;
      return mockStore.getSession(id);
    },
  });
}

export function useSaveSessionMutation(): UseMutationResult<
  MockSession,
  Error,
  MockSession
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (session: MockSession): Promise<MockSession> => {
      mockStore.saveSession(session);
      return session;
    },
    onSuccess: (s) => {
      qc.setQueryData(mockKeys.session(s.id), s);
    },
  });
}

export function useMockReport(id: string | null | undefined): UseQueryResult<
  MockReport | null,
  Error
> {
  return useQuery({
    queryKey: id ? mockKeys.report(id) : ['mockInterviews', 'report', 'null'],
    enabled: !!id,
    queryFn: async (): Promise<MockReport | null> => {
      if (!id) return null;
      return mockStore.getReport(id);
    },
  });
}

export function useSaveReportMutation(): UseMutationResult<
  MockReport,
  Error,
  MockReport
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (report: MockReport): Promise<MockReport> => {
      mockStore.saveReport(report);
      return report;
    },
    onSuccess: (r) => {
      qc.setQueryData(mockKeys.report(r.id), r);
    },
  });
}
