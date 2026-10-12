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
//
// Admin console additions (WP-74; /api/v1/roboapply/admin/*, `adminConsoleApi`):
//   - useSystemStatus(brand?)         GET /system (refreshes every minute)
//   - useWorkItems / useRetryWorkItem GET /system/queue · POST …/:id/retry
//   - useAdminCosts(query)            GET /costs
//   - useSafety(query)                GET /safety
//   - useReports / useResolveReport   GET /reports · POST /reports/:id/resolve
//   - useUserOverrides / useCreateOverride / useDeleteOverride
//   - useCopilotFeedback(query)       GET /copilot-feedback
//   - useReferralQueue / useModerateReferral   GoApply referral codes (WP-54)
//   - usePiRequests / useUpdatePiRequest       personal-data requests (WP-13)
//   - useRefundQuote(userId)          credits refund quote (WP-21a)
//   - useAdminAudit(query)            GET /system/audit (admin actions)
//   - useHeldReferrals / useReviewReferral     held invite rewards (WP-60 routes, lib/api/growth.ts)

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { adminApi, adminConsoleApi } from '../lib/api/admin';
import { adminListPiRequests, adminUpdatePiRequest } from '../lib/api/compliance';
import { listHeldReferrals, reviewReferral } from '../lib/api/growth';
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

// ── Admin console additions (WP-74) ──────────────────────────────────────

type ConsoleArg<F extends (...a: never[]) => unknown> = Parameters<F>[0];

export function useSystemStatus(brand?: 'roboapply' | 'goapply', enabled = true) {
  return useQuery({
    queryKey: ['admin', 'console', 'system', brand ?? 'all'],
    queryFn: () => adminConsoleApi.getSystemStatus(brand ? { brand } : undefined),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useWorkItems(query: ConsoleArg<typeof adminConsoleApi.listWorkItems>, enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'queue', query ?? {}], queryFn: () => adminConsoleApi.listWorkItems(query), enabled });
}

export function useRetryWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminConsoleApi.retryWorkItem(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'console', 'queue'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'console', 'system'] });
    },
  });
}

/** Admin actions, newest first (GET /admin/system/audit). */
export function useAdminAudit(query: ConsoleArg<typeof adminConsoleApi.listAdminAudit>, enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'audit', query ?? {}], queryFn: () => adminConsoleApi.listAdminAudit(query), enabled });
}

export function useAdminCosts(query: ConsoleArg<typeof adminConsoleApi.getCosts>, enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'costs', query ?? {}], queryFn: () => adminConsoleApi.getCosts(query), enabled });
}

export function useSafety(query: ConsoleArg<typeof adminConsoleApi.getSafety>, enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'safety', query ?? {}], queryFn: () => adminConsoleApi.getSafety(query), enabled });
}

export function useReports(query: ConsoleArg<typeof adminConsoleApi.listReports>, enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'reports', query ?? {}], queryFn: () => adminConsoleApi.listReports(query), enabled });
}

export function useResolveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'close' | 'restore'; note?: string }) => adminConsoleApi.resolveReport(v.id, { decision: v.decision, note: v.note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'console', 'reports'] }),
  });
}

export function useUserOverrides(userId: string | null) {
  return useQuery({
    queryKey: ['admin', 'console', 'overrides', userId],
    queryFn: () => adminConsoleApi.listOverrides({ userId: userId! }),
    enabled: !!userId,
  });
}

export function useCreateOverride(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<NonNullable<Parameters<typeof adminConsoleApi.createOverride>[0]>, 'userId'>) => adminConsoleApi.createOverride({ ...body, userId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'console', 'overrides', userId] }),
  });
}

export function useDeleteOverride(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminConsoleApi.deleteOverride(id, { userId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'console', 'overrides', userId] }),
  });
}

export function useCopilotFeedback(query: ConsoleArg<typeof adminConsoleApi.listCopilotFeedback>, enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'feedback', query ?? {}], queryFn: () => adminConsoleApi.listCopilotFeedback(query), enabled });
}

export function useReferralQueue(enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'referrals'], queryFn: () => adminConsoleApi.listReferralQueue(), enabled });
}

export function useModerateReferral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject'; reason?: Parameters<typeof adminConsoleApi.moderateReferralCode>[1]['reason'] }) =>
      adminConsoleApi.moderateReferralCode(v.id, { decision: v.decision, ...(v.reason ? { reason: v.reason } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'console', 'referrals'] }),
  });
}

export function usePiRequests(query: Parameters<typeof adminListPiRequests>[0], enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'piRequests', query ?? {}], queryFn: () => adminListPiRequests(query), enabled });
}

export function useUpdatePiRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof adminUpdatePiRequest>[1] }) => adminUpdatePiRequest(v.id, v.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'console', 'piRequests'] }),
  });
}

export function useRefundQuote(userId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'console', 'refundQuote', userId],
    queryFn: () => adminConsoleApi.getRefundQuote(userId!),
    enabled: enabled && !!userId,
    retry: false,
  });
}

// ── Held invite rewards (WP-60's admin routes; INT-08 console) ───────────

/** Invite rewards waiting for a person to review, oldest first (this brand). */
export function useHeldReferrals(enabled = true) {
  return useQuery({ queryKey: ['admin', 'console', 'heldReferrals'], queryFn: () => listHeldReferrals(), enabled });
}

/**
 * Approve or reject one held invite. The list is read again after every
 * answer, success or not: a 409 means the row changed (approved with the
 * credits still being added, or reviewed by someone else).
 */
export function useReviewReferral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) => reviewReferral(v.id, { decision: v.decision }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin', 'console', 'heldReferrals'] }),
  });
}
