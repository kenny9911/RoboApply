'use client';

// components/features/campus/useCampus.ts — query/mutation hooks of the campus
// calendar (WP-58). API calls go through lib/api/campus only.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

import {
  adminCreateCampusEvent,
  adminDeleteCampusEvent,
  adminExtractCampusEvent,
  adminListCampusEvents,
  adminPublishCampusEvent,
  adminUpdateCampusEvent,
  adminVerifyCampusEvent,
  getPublicCampusCompany,
  listCampusSubscriptions,
  listPublicCampusEvents,
  subscribeCampus,
  unsubscribeCampus,
  type CampusCompanyResponse,
  type CampusEventDraft,
  type CampusEventList,
} from '../../../lib/api/campus';
import type { PatchCampusEventBodySchema } from '../../../lib/api/contracts/cn/campus';
import type { In } from '../../../lib/api/contracts/wire';

export interface CampusFilter {
  class?: number;
  role?: string;
  city?: string;
  openNow?: boolean;
}

export const campusKeys = {
  all: ['campus'] as const,
  list: (f: CampusFilter) => ['campus', 'list', f.class ?? null, f.role ?? '', f.city ?? '', !!f.openNow] as const,
  company: (slug: string) => ['campus', 'company', slug] as const,
  subscriptions: () => ['campus', 'subscriptions'] as const,
  admin: (status: string) => ['campus', 'admin', status] as const,
};

function query(f: CampusFilter, cursor: string | null) {
  return {
    ...(f.class ? { class: f.class } : {}),
    ...(f.role ? { role: f.role } : {}),
    ...(f.city ? { city: f.city } : {}),
    ...(f.openNow ? { openNow: 'true' as const } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** The public list (CDN-cacheable); the user's reminders come from useCampusSubscriptions. */
export function useCampusList(filter: CampusFilter, initial?: CampusEventList | null) {
  return useInfiniteQuery({
    queryKey: campusKeys.list(filter),
    queryFn: ({ pageParam, signal }) => listPublicCampusEvents(query(filter, pageParam), { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...(initial ? { initialData: { pages: [initial], pageParams: [null] } as InfiniteData<CampusEventList, string | null> } : {}),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useCampusCompany(slug: string, initial?: CampusCompanyResponse | null) {
  return useQuery({
    queryKey: campusKeys.company(slug),
    queryFn: ({ signal }) => getPublicCampusCompany(slug, { signal }),
    ...(initial ? { initialData: initial } : {}),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useCampusSubscriptions(enabled: boolean) {
  return useQuery({ queryKey: campusKeys.subscriptions(), queryFn: ({ signal }) => listCampusSubscriptions({ signal }), enabled, retry: false });
}

/**
 * Save a deadline reminder. `channel` is 'wechat' when the person accepted
 * WeChat's subscribe prompt at the tap (then the last reminder also arrives
 * in WeChat); otherwise the reminder lives in the inbox.
 */
export function useSubscribeEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { eventId: string; channel: 'in_app' | 'wechat' }) => subscribeCampus({ kind: 'event', eventId: v.eventId, channel: v.channel }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campusKeys.subscriptions() }),
  });
}

export function useFollowCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { companyName: string; year: number }) =>
      subscribeCampus({ kind: 'company', companyName: v.companyName, graduationClass: `${v.year}届`, channel: 'in_app' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: campusKeys.subscriptions() }),
  });
}

export function useUnsubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unsubscribeCampus(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: campusKeys.subscriptions() }),
  });
}

// ── Admin ──

export function useAdminCampusEvents(status: 'draft' | 'published' | 'archived', enabled = true) {
  return useInfiniteQuery({
    queryKey: campusKeys.admin(status),
    queryFn: ({ pageParam, signal }) => adminListCampusEvents({ status, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled,
  });
}

function useAdminMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['campus'] }) });
}

export const useExtractCampusEvent = () => useMutation({ mutationFn: (officialUrl: string) => adminExtractCampusEvent({ officialUrl }) });
export const useCreateCampusEvent = () => useAdminMutation((body: CampusEventDraft) => adminCreateCampusEvent(body));
export const useUpdateCampusEvent = () =>
  useAdminMutation((v: { id: string; body: In<typeof PatchCampusEventBodySchema> }) => adminUpdateCampusEvent(v.id, v.body));
export const useVerifyCampusEvent = () => useAdminMutation((id: string) => adminVerifyCampusEvent(id));
export const usePublishCampusEvent = () => useAdminMutation((id: string) => adminPublishCampusEvent(id));
export const useDeleteCampusEvent = () => useAdminMutation((id: string) => adminDeleteCampusEvent(id));
