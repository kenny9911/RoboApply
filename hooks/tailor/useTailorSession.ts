'use client';

// hooks/tailor/useTailorSession.ts — tailor session state (WP-36a).
//
//   const create = useCreateTailorSession();
//   const r = await create.run(body)        → spends one `tailor` credit through useCreditGate
//                                             (one Idempotency-Key per run; 402 opens the
//                                             out-of-credits sheet); r.ok / r.value
//   const s = useTailorSession(id)          → TailorSessionView (polls while generating)
//   const claim = useTailorClaim(id)        → claim.decide(claimId, { status, text? })
//   const fin = useFinalizeTailor(id)       → fin.mutateAsync(); refreshes the checklist
//                                             and the resume lists on success
//
// API calls go through lib/api/resumes.ts only.

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createTailorSession, finalizeTailorSession, getTailorSession, updateTailorClaim } from '../../lib/api/resumes';
import { apiErrorCode, apiErrorDetails, type In } from '../../lib/api/contracts/wire';
import type { CreateTailorSessionBodySchema, TailorSessionView } from '../../lib/api/contracts/resume';
import { useCreditGate, type CreditGateResult } from '../shared/useCreditGate';
import { refreshChecklist } from '../growth';
import { resumeKeys } from '../useResumes';

export type CreateTailorBody = In<typeof CreateTailorSessionBodySchema>;

export const tailorKeys = {
  all: ['tailor'] as const,
  session: (id: string) => ['tailor', 'session', id] as const,
};

/** Poll a session another tab or a reload left in `generating`. */
export const GENERATING_POLL_MS = 3_000;

export type TailorErrorKind =
  | 'credits_exhausted'
  | 'ai_unavailable'
  | 'ai_failed'
  | 'content_blocked'
  | 'safety_unavailable'
  | 'phone_binding_required'
  | 'unverified_claims'
  | 'in_progress'
  | 'not_reviewable'
  | 'conflict'
  | 'not_found'
  | 'failed';

/** Map a failed call to a small set of UI states. */
export function tailorErrorKind(err: unknown): TailorErrorKind {
  const code = apiErrorCode(err);
  const reason = apiErrorDetails<{ reason?: string }>(err)?.reason;
  switch (code) {
    case 'credits_exhausted':
      return 'credits_exhausted';
    case 'phone_binding_required':
      return 'phone_binding_required';
    case 'content_blocked':
      return 'content_blocked';
    case 'unverified_claims':
      return 'unverified_claims';
    case 'not_found':
      return 'not_found';
    case 'ai_unavailable':
      if (reason === 'ai_failed') return 'ai_failed';
      if (reason === 'content_safety_unavailable') return 'safety_unavailable';
      return 'ai_unavailable';
    case 'conflict':
      if (reason === 'request_in_progress') return 'in_progress';
      if (reason === 'tailor_session_not_reviewable') return 'not_reviewable';
      return 'conflict';
    default:
      return 'failed';
  }
}

export function sessionRefetchInterval(data: TailorSessionView | undefined): number | false {
  return data?.status === 'generating' ? GENERATING_POLL_MS : false;
}

export function useTailorSession(id: string | null | undefined) {
  return useQuery<TailorSessionView>({
    queryKey: id ? tailorKeys.session(id) : ['tailor', 'session', 'none'],
    queryFn: ({ signal }) => getTailorSession(id as string, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
    refetchInterval: (q) => sessionRefetchInterval(q.state.data),
  });
}

/** Create a session. The `tailor` credit is spent through the shared credit gate. */
export function useCreateTailorSession() {
  const gate = useCreditGate('tailor');
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(
    async (body: CreateTailorBody): Promise<CreditGateResult<TailorSessionView> | null> => {
      setPending(true);
      setError(null);
      try {
        const r = await gate.run((idempotencyKey) => createTailorSession(body, { idempotencyKey }));
        if (r.ok) client.setQueryData(tailorKeys.session(r.value.id), r.value);
        return r;
      } catch (err) {
        setError(err);
        return null;
      } finally {
        setPending(false);
      }
    },
    [client, gate],
  );

  return { run, pending, error, reset: () => setError(null), gate };
}

/** Verify details: kept · removed · edited. */
export function useTailorClaim(sessionId: string) {
  const client = useQueryClient();
  const m = useMutation({
    mutationFn: (args: { claimId: string; status: 'kept' | 'removed' | 'edited'; text?: string }) =>
      updateTailorClaim(sessionId, args.claimId, { status: args.status, ...(args.text ? { text: args.text } : {}) }),
    onSuccess: (view) => client.setQueryData(tailorKeys.session(sessionId), view),
  });
  const decide = useCallback(
    (claimId: string, decision: { status: 'kept' | 'removed' | 'edited'; text?: string }) => m.mutateAsync({ claimId, ...decision }),
    [m],
  );
  return { decide, pending: m.isPending, error: m.error, variables: m.variables, reset: m.reset };
}

/** Finalize: refreshes the getting-started checklist and the resume lists. */
export function useFinalizeTailor(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => finalizeTailorSession(sessionId),
    onSuccess: async (view) => {
      client.setQueryData(tailorKeys.session(sessionId), view);
      await Promise.all([
        refreshChecklist(client).catch(() => undefined),
        client.invalidateQueries({ queryKey: resumeKeys.all }),
      ]);
    },
  });
}
