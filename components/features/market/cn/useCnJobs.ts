'use client';

// components/features/market/cn/useCnJobs.ts — query/mutation hooks for the
// GoApply jobs UI (WP-41). API calls go through lib/api/cnJobs only.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  adminAddBlacklist,
  adminListBlacklist,
  adminListFraudQueue,
  adminRemoveBlacklist,
  adminResolveFraud,
  getExternalLinks,
} from '../../../../lib/api/cnJobs';
import type { FraudQueueStatus } from '../../../../lib/api/contracts/cn/jobs';

export const cnJobsKeys = {
  all: ['cnJobs'] as const,
  links: (q: string, city: string | null) => ['cnJobs', 'links', q, city] as const,
  fraud: (status: FraudQueueStatus) => ['cnJobs', 'admin', 'fraud', status] as const,
  blacklist: () => ['cnJobs', 'admin', 'blacklist'] as const,
};

export function useExternalLinks(query: string, city?: string | null) {
  const q = query.trim();
  return useQuery({
    queryKey: cnJobsKeys.links(q, city?.trim() || null),
    queryFn: ({ signal }) => getExternalLinks({ q, ...(city?.trim() ? { city: city.trim() } : {}) }, { signal }),
    enabled: q.length > 0,
    staleTime: Infinity,
  });
}

export function useFraudQueue(status: FraudQueueStatus, enabled = true) {
  return useInfiniteQuery({
    queryKey: cnJobsKeys.fraud(status),
    queryFn: ({ pageParam, signal }) => adminListFraudQueue({ status, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled,
  });
}

export function useResolveFraud() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { jobId: string; decision: 'clear' | 'confirm'; note?: string; blacklistEmployer?: boolean }) =>
      adminResolveFraud(v.jobId, { decision: v.decision, ...(v.note ? { note: v.note } : {}), ...(v.blacklistEmployer ? { blacklistEmployer: true } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cnJobs', 'admin'] }),
  });
}

export function useBlacklist(enabled = true) {
  return useQuery({ queryKey: cnJobsKeys.blacklist(), queryFn: ({ signal }) => adminListBlacklist({ signal }), enabled });
}

export function useAddBlacklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { employerName: string; reason: string }) => adminAddBlacklist(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cnJobs', 'admin'] }),
  });
}

export function useRemoveBlacklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminRemoveBlacklist(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cnJobs', 'admin'] }),
  });
}
