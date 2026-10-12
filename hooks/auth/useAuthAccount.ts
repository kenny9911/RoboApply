'use client';

// hooks/auth/useAuthAccount.ts — React Query hooks for the auth area (WP-10).
// API calls live in lib/api/auth.ts; components get data + mutations here.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAuthMethods,
  getEmailStatus,
  getEntryJob,
  listIdentities,
  listSessions,
  revokeSession,
  sendVerificationEmail,
  unlinkIdentity,
} from '../../lib/api/auth';

export const authKeys = {
  methods: (locale: string) => ['auth', 'methods', locale] as const,
  identities: ['auth', 'identities'] as const,
  sessions: ['auth', 'sessions'] as const,
  emailStatus: ['auth', 'emailStatus'] as const,
  entryJob: (jobId: string) => ['auth', 'entryJob', jobId] as const,
};

/** The job in a signup/login link, looked up by id (null while loading, when unknown or not public). */
export function useEntryJob(jobId: string | null) {
  const query = useQuery({
    queryKey: authKeys.entryJob(jobId ?? ''),
    queryFn: () => getEntryJob(jobId!),
    enabled: !!jobId,
    staleTime: 10 * 60_000,
    retry: false,
  });
  return jobId ? (query.data ?? null) : null;
}

/** GET /auth/methods: configured methods, the visitor's country and whether the PDPA notice applies. */
export function useAuthMethodsInfo(locale: string) {
  return useQuery({
    queryKey: authKeys.methods(locale),
    queryFn: () => getAuthMethods(locale),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useIdentities() {
  return useQuery({ queryKey: authKeys.identities, queryFn: listIdentities, retry: 1 });
}

export function useUnlinkIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unlinkIdentity(id),
    onSuccess: (data) => qc.setQueryData(authKeys.identities, data),
  });
}

export function useSessions() {
  return useQuery({ queryKey: authKeys.sessions, queryFn: listSessions, retry: 1 });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.sessions }),
  });
}

export function useEmailStatus() {
  return useQuery({ queryKey: authKeys.emailStatus, queryFn: getEmailStatus, retry: 1 });
}

export function useSendVerificationEmail() {
  return useMutation({ mutationFn: () => sendVerificationEmail() });
}
