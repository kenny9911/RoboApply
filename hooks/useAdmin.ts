'use client';

// hooks/useAdmin.ts
//
// TanStack Query v5 bindings for the RoboApply admin analytics + profitability
// surface. All calls route through `adminApi` (lib/api/admin.ts). Query keys
// are namespaced `['admin', <section>, ...]`. Mirrors the hook style in
// hooks/useActivity.ts.
//
// Surface:
//   - useAdminOverview(range)         GET /overview
//   - useAdminUsers(params)           GET /users  (paginated/sorted/searchable)
//   - useAdminUser(userId, range)     GET /users/:userId
//   - useAdminSessions(params)        GET /sessions
//   - useAdminSession(id)             GET /sessions/:id
//   - useAdminRateCard()             GET /rate-card
//   - useSetPlan(userId)             POST /users/:userId/plan (mutation)

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { adminApi } from '../lib/api/admin';
import type {
  AdminOverviewResponse,
  AdminRange,
  AdminSetPlanBody,
  AdminSetPlanResponse,
  AdminSessionDetailResponse,
  AdminSessionsParams,
  AdminSessionsResponse,
  AdminUserDetailResponse,
  AdminUsersParams,
  AdminUsersResponse,
  AdminRateCardResponse,
} from '../lib/api/admin';

export const adminKeys = {
  all: ['admin'] as const,
  overview: (range?: AdminRange) =>
    ['admin', 'overview', range ?? {}] as const,
  users: (params?: AdminUsersParams) =>
    ['admin', 'users', params ?? {}] as const,
  user: (userId: string, range?: AdminRange) =>
    ['admin', 'user', userId, range ?? {}] as const,
  sessions: (params?: AdminSessionsParams) =>
    ['admin', 'sessions', params ?? {}] as const,
  session: (id: string) => ['admin', 'session', id] as const,
  rateCard: () => ['admin', 'rateCard'] as const,
};

export function useAdminOverview(
  range?: AdminRange,
  enabled = true,
): UseQueryResult<AdminOverviewResponse, Error> {
  return useQuery({
    queryKey: adminKeys.overview(range),
    queryFn: () => adminApi.overview(range),
    enabled,
  });
}

export function useAdminUsers(
  params?: AdminUsersParams,
  enabled = true,
): UseQueryResult<AdminUsersResponse, Error> {
  return useQuery({
    queryKey: adminKeys.users(params),
    queryFn: () => adminApi.users(params),
    enabled,
  });
}

export function useAdminUser(
  userId: string | null | undefined,
  range?: AdminRange,
): UseQueryResult<AdminUserDetailResponse, Error> {
  return useQuery({
    queryKey: userId
      ? adminKeys.user(userId, range)
      : (['admin', 'user', 'null', range ?? {}] as const),
    enabled: !!userId,
    queryFn: () => {
      if (!userId) throw new Error('userId is required');
      return adminApi.user(userId, range);
    },
  });
}

export function useAdminSessions(
  params?: AdminSessionsParams,
  enabled = true,
): UseQueryResult<AdminSessionsResponse, Error> {
  return useQuery({
    queryKey: adminKeys.sessions(params),
    queryFn: () => adminApi.sessions(params),
    enabled,
  });
}

export function useAdminSession(
  id: string | null | undefined,
): UseQueryResult<AdminSessionDetailResponse, Error> {
  return useQuery({
    queryKey: id ? adminKeys.session(id) : (['admin', 'session', 'null'] as const),
    enabled: !!id,
    queryFn: () => {
      if (!id) throw new Error('session id is required');
      return adminApi.session(id);
    },
  });
}

export function useAdminRateCard(
  enabled = true,
): UseQueryResult<AdminRateCardResponse, Error> {
  return useQuery({
    queryKey: adminKeys.rateCard(),
    queryFn: () => adminApi.rateCard(),
    enabled,
  });
}

export function useSetPlan(
  userId: string,
): UseMutationResult<AdminSetPlanResponse, Error, AdminSetPlanBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminSetPlanBody) => adminApi.setPlan(userId, body),
    onSuccess: () => {
      // Refetch this user's detail + the users list + the overview KPIs since
      // a plan change moves MRR / margin.
      qc.invalidateQueries({ queryKey: ['admin', 'user', userId] });
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}
