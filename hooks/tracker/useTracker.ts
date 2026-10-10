'use client';

// hooks/tracker/useTracker.ts — queries and mutations of /applications
// beyond the board read (WP-38): follow-up facts, timeline, files sent,
// drawer saves, manual adds and the weekly card. All requests go through
// lib/api/tracker.ts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addTrackerNote,
  createTrackerEntry,
  getTrackerEntry,
  getWeeklyInsight,
  listFollowUps,
  listTrackerArtifacts,
  listTrackerEvents,
  patchTrackerEntry,
  refreshWeeklyInsight,
} from '../../lib/api/tracker';
import { RoboApiError } from '../../lib/api/client';
import type { In } from '../../lib/api/contracts/wire';
import type * as TR from '../../lib/api/contracts/tracker';
import { pipelineKeys, upsertBoardEntry, type PipelineBoardData } from '../usePipelineBoard';
import { trackerKeys } from './keys';

/** Follow-up facts (no reply in 10 days, follow-up due, interview tomorrow, deadline soon). */
export function useFollowUps() {
  return useQuery({
    queryKey: trackerKeys.followUps(),
    queryFn: async () => (await listFollowUps()).items,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * One entry by id, for `?entry=<id>` links (reminders, the follow-up banner)
 * that point past the entries loaded on the page. Pass null to skip.
 */
export function useTrackerEntry(id: string | null) {
  return useQuery({
    queryKey: trackerKeys.entry(id ?? ''),
    queryFn: async () => (await getTrackerEntry(id!)).entry,
    enabled: Boolean(id),
    retry: false,
  });
}

/**
 * True only when the server answered "there is no such application of yours"
 * (404 / `not_found`). A timeout, being offline or a server error is not that:
 * the application may well exist.
 */
export function isTrackerEntryNotFound(err: unknown): boolean {
  return err instanceof RoboApiError && (err.status === 404 || err.code === 'not_found');
}

export function useTrackerEvents(id: string | null) {
  return useQuery({
    queryKey: trackerKeys.events(id ?? ''),
    queryFn: async () => (await listTrackerEvents(id!)).items,
    enabled: Boolean(id),
    retry: false,
  });
}

export function useTrackerArtifacts(id: string | null) {
  return useQuery({
    queryKey: trackerKeys.artifacts(id ?? ''),
    queryFn: async () => (await listTrackerArtifacts(id!)).items,
    enabled: Boolean(id),
    retry: false,
  });
}

function useSyncEntry() {
  const qc = useQueryClient();
  return (entry: TR.TrackerEntryView) => {
    qc.setQueryData<PipelineBoardData>(pipelineKeys.board(), (prev) => upsertBoardEntry(prev, entry));
    qc.setQueryData(trackerKeys.entry(entry.id), entry);
    qc.invalidateQueries({ queryKey: trackerKeys.events(entry.id) });
    qc.invalidateQueries({ queryKey: trackerKeys.followUps() });
    qc.invalidateQueries({ queryKey: ['tracker', 'weekly'] });
  };
}

/** Save drawer fields (stage, outcome, dates, salary, notes, interview round). */
export function usePatchTrackerEntry() {
  const sync = useSyncEntry();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: In<typeof TR.TrackerPatchBodySchema> }) => patchTrackerEntry(id, body),
    onSuccess: ({ entry }) => sync(entry),
  });
}

/** Add a job found elsewhere (or a job by id). */
export function useCreateTrackerEntry() {
  const sync = useSyncEntry();
  return useMutation({
    mutationFn: (body: In<typeof TR.TrackerCreateBodySchema>) => createTrackerEntry(body),
    onSuccess: ({ entry }) => sync(entry),
  });
}

/**
 * After a change made outside the drawer form (the WP-64 offer section writes
 * through its own API): re-read the entry and its timeline (Wave 5 gate,
 * REQ-64-02).
 */
export function useRefreshTrackerEntry(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: trackerKeys.entry(id) });
    void qc.invalidateQueries({ queryKey: trackerKeys.events(id) });
  };
}

/** After a file was recorded for the application (a resume download with its id): re-read the files list. */
export function useRefreshTrackerArtifacts(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: trackerKeys.artifacts(id) });
    void qc.invalidateQueries({ queryKey: trackerKeys.events(id) });
  };
}

export function useAddTrackerNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => addTrackerNote(id, { note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: trackerKeys.events(id) }),
  });
}

/** The weekly card: real counts, plus the AI summary when one was written. */
export function useWeeklyInsight(weekStartUtc?: string) {
  return useQuery({
    queryKey: trackerKeys.weekly(weekStartUtc),
    queryFn: () => getWeeklyInsight(weekStartUtc),
    retry: false,
  });
}

export function useRefreshWeeklyInsight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => refreshWeeklyInsight(),
    onSuccess: (data) => qc.setQueryData(trackerKeys.weekly(), data),
  });
}
