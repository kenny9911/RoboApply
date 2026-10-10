'use client';

// hooks/network/useReferralCodes.ts — the GoApply 内推码 hub (WP-54; flag `cn.referralCodes`).
//
//   const codes = useReferralCodes({ company });   approved codes ("Load more") + the viewer's own
//   const share = useShareReferralCode();          → pending until a moderator approves it
//   const report = useReportReferralCode();
//   const remove = useDeleteReferralCode();

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { createReferralCode, deleteReferralCode, listReferralCodes, reportReferralCode } from '../../lib/api/network';
import { apiErrorCode, apiErrorReason } from '../../lib/api/contracts/wire';
import type { ListReferralCodesResponse, ReferralCodeView, ReferralReportReason } from '../../lib/api/contracts/cn/referrals';

export const referralKeys = {
  all: ['cn-referrals'] as const,
  list: (company: string, classYear: number | null) => ['cn-referrals', 'list', company, classYear ?? 'all'] as const,
};

export function useReferralCodes(filter: { company?: string; classYear?: number | null } = {}, options: { enabled?: boolean } = {}) {
  const company = filter.company?.trim() ?? '';
  const classYear = filter.classYear ?? null;
  return useInfiniteQuery<ListReferralCodesResponse>({
    queryKey: referralKeys.list(company, classYear),
    queryFn: ({ pageParam, signal }) =>
      listReferralCodes(
        { company: company || undefined, classYear: classYear ?? undefined, cursor: (pageParam as string | undefined) ?? undefined },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    retry: false,
  });
}

export type ReferralErrorKind =
  | 'referral_code_duplicate'
  | 'referral_share_limit'
  | 'referral_contact_details'
  | 'referral_already_reported'
  | 'expiry_past'
  | 'storage_unavailable'
  | 'feature_disabled'
  | 'phone_binding_required'
  | 'failed';

const KNOWN: ReadonlySet<string> = new Set([
  'referral_code_duplicate',
  'referral_share_limit',
  'referral_contact_details',
  'referral_already_reported',
  'expiry_past',
]);

export function referralErrorKind(err: unknown): ReferralErrorKind {
  const code = apiErrorCode(err);
  const reason = apiErrorReason(err);
  if (reason && KNOWN.has(reason)) return reason as ReferralErrorKind;
  // Sharing and reporting need a verified mobile (WP-11 gate); the UI shows PhoneBindingNotice.
  if (code === 'phone_binding_required') return 'phone_binding_required';
  if (code === 'storage_unavailable') return 'storage_unavailable';
  if (code === 'feature_disabled') return 'feature_disabled';
  return 'failed';
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: referralKeys.all });
}

export function useShareReferralCode() {
  const invalidate = useInvalidate();
  return useMutation<ReferralCodeView, unknown, { company: string; code: string; programme?: string; expiresAt?: string; note?: string }>({
    mutationFn: (body) => createReferralCode(body),
    onSuccess: invalidate,
  });
}

export function useReportReferralCode() {
  const invalidate = useInvalidate();
  return useMutation<{ reported: true }, unknown, { id: string; reason: ReferralReportReason; note?: string }>({
    mutationFn: ({ id, ...body }) => reportReferralCode(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteReferralCode() {
  const invalidate = useInvalidate();
  return useMutation<{ deleted: true }, unknown, string>({
    mutationFn: (id) => deleteReferralCode(id),
    onSuccess: invalidate,
  });
}
