'use client';

// Data for the Account V2 components (WP-79). API calls stay in
// lib/api/accountV2.ts; these are the react-query bindings next to the UI.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { accountV2Api } from '../../../lib/api/accountV2';
import { apiErrorCode, apiErrorDetails, apiErrorReason } from '../../../lib/api/contracts/wire';
import { useFlag } from '../../../lib/flags';

export const TWO_FACTOR_KEY = ['account-v2', '2fa'] as const;
export const STUDENT_KEY = ['account-v2', 'student'] as const;

export function useTwoFactorStatus() {
  const on = useFlag('totp');
  return useQuery({ queryKey: TWO_FACTOR_KEY, queryFn: () => accountV2Api.getTwoFactorStatus(), enabled: on, staleTime: 30_000 });
}

/** Live student status; disabled (no request) when the `student` capability is off. */
export function useStudentStatus() {
  const on = useFlag('student');
  return useQuery({ queryKey: STUDENT_KEY, queryFn: () => accountV2Api.getStudentStatus(), enabled: on, staleTime: 60_000 });
}

export function useInvalidate(key: readonly string[]) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key });
}

export { useMutation };

/**
 * The message key (under `accountV2`) for a failed call: the area reason when
 * we have copy for it, then the platform code, else the generic line.
 */
export function errorKey(err: unknown, area: 'twoFactor' | 'student', known: readonly string[]): string {
  const reason = apiErrorReason(err);
  if (reason && known.includes(reason)) return `${area}.errors.${reason}`;
  const code = apiErrorCode(err);
  if (code === 'rate_limited') return 'common.rateLimited';
  if (code === 'conflict' && area === 'twoFactor') return 'twoFactor.errors.conflict';
  if (code === 'network_error' || code === 'server_error') return 'common.network';
  return 'common.generic';
}

export function attemptsLeft(err: unknown): number | null {
  const n = apiErrorDetails<{ attemptsLeft?: unknown }>(err)?.attemptsLeft;
  return typeof n === 'number' ? n : null;
}
