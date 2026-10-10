'use client';

// hooks/network/useNetwork.ts — People at {company}, outreach drafts and the
// LinkedIn connections import (WP-54).
//
//   const people = useConnectionsForJob(jobId);       people buckets, deep links, drafts for the job
//   const drafts = useOutreachDrafts({ trackerEntryId });
//   const create = useCreateOutreachDraft();          await create.run(body) → spends an `outreach` credit
//   const actions = useDraftActions();                save edits · copied · "I sent it"
//   const imp = useConnectionsImport();               status · upload Connections.csv · delete all
//
// We never send a message: the UI copies a draft or opens the user's own
// mail app. API calls go through lib/api/network.ts only.

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createOutreachDraft,
  deleteImportedConnections,
  getConnectionsForJob,
  getConnectionsImportStatus,
  importLinkedInConnections,
  listOutreachDrafts,
  markDraftCopied,
  markDraftSent,
  patchOutreachDraft,
} from '../../lib/api/network';
import { apiErrorCode, apiErrorReason } from '../../lib/api/contracts/wire';
import type {
  ConnectionsForJobResponse,
  ConnectionsImportResponse,
  ConnectionsImportStatus,
  ListOutreachDraftsResponse,
  OutreachChannel,
  OutreachDraftView,
} from '../../lib/api/contracts/network';
import { useCreditGate } from '../shared/useCreditGate';

export const networkKeys = {
  all: ['network'] as const,
  job: (jobId: string) => ['network', 'job', jobId] as const,
  drafts: (key: string) => ['network', 'drafts', key] as const,
  importStatus: ['network', 'import-status'] as const,
};

export function useConnectionsForJob(jobId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery<ConnectionsForJobResponse>({
    queryKey: jobId ? networkKeys.job(jobId) : ['network', 'job', 'none'],
    queryFn: ({ signal }) => getConnectionsForJob(jobId as string, { signal }),
    enabled: Boolean(jobId) && (options.enabled ?? true),
    staleTime: 30_000,
    retry: false,
  });
}

export function useOutreachDrafts(filter: { jobId?: string | null; trackerEntryId?: string | null }, options: { enabled?: boolean } = {}) {
  const query = { jobId: filter.jobId ?? undefined, trackerEntryId: filter.trackerEntryId ?? undefined };
  const key = `${query.jobId ?? ''}|${query.trackerEntryId ?? ''}`;
  return useQuery<ListOutreachDraftsResponse>({
    queryKey: networkKeys.drafts(key),
    queryFn: ({ signal }) => listOutreachDrafts(query, { signal }),
    enabled: Boolean(query.jobId || query.trackerEntryId) && (options.enabled ?? true),
    staleTime: 15_000,
  });
}

export type OutreachErrorKind =
  | 'credits_exhausted'
  | 'ai_unavailable'
  | 'safety_unavailable'
  | 'content_blocked'
  | 'phone_binding_required'
  | 'not_found'
  | 'too_long'
  | 'failed';

/** Map a failed call to the states the UI explains in plain words. */
export function outreachErrorKind(err: unknown): OutreachErrorKind {
  const code = apiErrorCode(err);
  const reason = apiErrorReason(err);
  switch (code) {
    case 'credits_exhausted':
      return 'credits_exhausted';
    case 'ai_unavailable':
      return reason === 'content_safety_unavailable' ? 'safety_unavailable' : 'ai_unavailable';
    case 'content_blocked':
      return 'content_blocked';
    case 'phone_binding_required':
      return 'phone_binding_required';
    case 'not_found':
      return 'not_found';
    case 'invalid_request':
      return reason === 'outreach_draft_too_long' ? 'too_long' : 'failed';
    default:
      return 'failed';
  }
}

export interface NewDraftInput {
  jobId: string;
  channel: OutreachChannel;
  contactId?: string;
  trackerEntryId?: string;
}

export type DraftResult = { ok: true; draft: OutreachDraftView } | { ok: false; error: OutreachErrorKind; cause?: unknown };

function useInvalidateDrafts() {
  const qc = useQueryClient();
  return useCallback(
    (jobId?: string | null) => {
      void qc.invalidateQueries({ queryKey: ['network', 'drafts'] });
      if (jobId) void qc.invalidateQueries({ queryKey: networkKeys.job(jobId) });
    },
    [qc],
  );
}

/** Write a draft (one `outreach` credit; the gate opens the out-of-credits sheet when none are left). */
export function useCreateOutreachDraft() {
  const gate = useCreditGate('outreach');
  const invalidate = useInvalidateDrafts();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (input: NewDraftInput): Promise<DraftResult> => {
      setPending(true);
      try {
        const r = await gate.run((idempotencyKey) => createOutreachDraft(input, { idempotencyKey }));
        if (!r.ok) return { ok: false, error: 'credits_exhausted' };
        invalidate(input.jobId);
        return { ok: true, draft: r.value };
      } catch (err) {
        return { ok: false, error: outreachErrorKind(err), cause: err };
      } finally {
        setPending(false);
      }
    },
    [gate, invalidate],
  );

  return { run, pending, summary: gate.summary, left: gate.left };
}

/** Save an edit, mark copied, mark "I sent it". Each returns the updated draft (or null on failure). */
export function useDraftActions() {
  const invalidate = useInvalidateDrafts();
  const wrap = useCallback(
    <A extends unknown[]>(fn: (...args: A) => Promise<OutreachDraftView>) =>
      async (...args: A): Promise<OutreachDraftView | null> => {
        try {
          const d = await fn(...args);
          invalidate(d.jobId);
          return d;
        } catch {
          return null;
        }
      },
    [invalidate],
  );
  return {
    save: wrap((id: string, body: { subject?: string | null; body?: string }) => patchOutreachDraft(id, body)),
    copied: wrap((id: string) => markDraftCopied(id)),
    sent: wrap((id: string) => markDraftSent(id)),
  };
}

export type ImportErrorKind =
  | 'connections_import_limit'
  | 'connections_csv_unreadable'
  | 'connections_file_too_large'
  | 'connections_file_missing'
  | 'feature_disabled'
  | 'failed';

export function importErrorKind(err: unknown): ImportErrorKind {
  const code = apiErrorCode(err);
  const reason = apiErrorReason(err);
  if (code === 'feature_disabled') return 'feature_disabled';
  if (
    reason === 'connections_import_limit' ||
    reason === 'connections_csv_unreadable' ||
    reason === 'connections_file_too_large' ||
    reason === 'connections_file_missing'
  ) {
    return reason;
  }
  return 'failed';
}

/** The connections import: status, upload (3 a day) and "Delete all imported connections". */
export function useConnectionsImport(options: { enabled?: boolean } = {}) {
  const qc = useQueryClient();
  const status = useQuery<ConnectionsImportStatus>({
    queryKey: networkKeys.importStatus,
    queryFn: ({ signal }) => getConnectionsImportStatus({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: networkKeys.importStatus });
    void qc.invalidateQueries({ queryKey: ['network', 'job'] });
  };
  const upload = useMutation<ConnectionsImportResponse, unknown, File>({
    mutationFn: (file) => {
      const form = new FormData();
      form.append('file', file, file.name || 'Connections.csv');
      return importLinkedInConnections(form);
    },
    onSettled: refresh,
  });
  const removeAll = useMutation<{ deleted: number }, unknown, void>({
    mutationFn: () => deleteImportedConnections(),
    onSettled: refresh,
  });
  return { status, upload, removeAll };
}
