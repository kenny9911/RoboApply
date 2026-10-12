'use client';

// hooks/search/useApplyFilters.ts — the one write path of the filters UI (WP-20).
//
// The drawer, the quick bar, the chips, "Not interested" and the Assistant's
// diff card all change filters through this hook, so every change is ONE
// PATCH /search-profiles/:id carrying `baseVersion` (the version the UI read)
// and either the whole set (`replace`) or a FilterSetPatch (`patch`).
//
// Sponsorship (TW-09): when a change turns "I need visa sponsorship in
// {country}" on or off, the profile's work-authorization answer for that
// country is updated too (`RAProfile.workAuth`, WP-19's profile API), so the
// filter and the profile say the same thing. That second write is
// best-effort: the filter is saved either way, and a failure is reported in
// `sponsorshipSynced: false` for the UI to mention.
//
// Consecutive changes (FIX-3). A second change made while the first PATCH is
// still on its way used to carry the same `baseVersion` and was refused (409
// version_conflict) and dropped. Now, per saved search:
//   • writes run one after another; a queued write is sent on the version the
//     write before it produced, so none is lost;
//   • a field-level `patch` that still meets a 409 (the search was changed on
//     another device) is sent once more on the server's version: the user's
//     one change is applied to the newest filters, nothing else is replaced.
//     A whole-set `replace` is never retried: the caller shows the conflict;
//   • while a write is pending, `useOptimisticFilters` gives the filters as
//     they will be, and `saving: true`, so chips and the fit view change at
//     once and the bar can say "Saving…". The feed keeps reading the saved
//     profile (its list key carries the saved version), so a pending change
//     never starts an extra feed session.

import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { getProfile, patchProfile } from '../../lib/api/profile';
import { conflictProfile, useUpdateSearchProfile, type SearchProfile } from './useSearchProfiles';
import { mergePatch, normalizeFilters, sponsorshipCountry, workAuthWithSponsorship, type FilterSet, type FilterSetPatch } from './filterModel';

export type ApplyFiltersResult =
  | { ok: true; profile: SearchProfile; sponsorshipSynced: boolean | null }
  | { ok: false; conflict: SearchProfile | null; error: unknown };

export interface ApplyFiltersInput {
  profile: Pick<SearchProfile, 'id' | 'version' | 'filters'>;
  /** Replace the whole set (the drawer's "Show jobs"). */
  replace?: FilterSet;
  /** Change some fields (chips, quick bar, Assistant, Not interested). */
  patch?: FilterSetPatch;
  /** Country the sponsorship question is about when it is not in the filters. */
  defaultCountry: string;
}

export async function syncSponsorshipAnswer(country: string, needs: boolean): Promise<boolean> {
  try {
    const current = await getProfile();
    await patchProfile({ workAuth: workAuthWithSponsorship(current.workAuth ?? [], country, needs) });
    return true;
  } catch {
    return false;
  }
}

// ── Pending writes, per saved search ─────────────────────────────────────

interface WriteQueue {
  /** Resolves when the last queued write settles: the profile it saved, or null when it failed. */
  tail: Promise<SearchProfile | null>;
  /** The filters as they will be once every queued write is saved. */
  optimistic: FilterSet;
  pending: number;
}

const queues = new WeakMap<QueryClient, Map<string, WriteQueue>>();
const listeners = new Set<() => void>();

function queuesOf(qc: QueryClient): Map<string, WriteQueue> {
  let m = queues.get(qc);
  if (!m) {
    m = new Map();
    queues.set(qc, m);
  }
  return m;
}

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface OptimisticFilters<P> {
  /** The profile with the filters as they will be once pending changes are saved. */
  profile: P;
  /** A filter change for this saved search is on its way to the server. */
  saving: boolean;
}

/**
 * The saved search as the user just left it: pending changes are already in
 * `filters` (the version stays the saved one). Use it for what the filter
 * controls show; the feed keeps the saved profile.
 */
export function useOptimisticFilters<P extends Pick<SearchProfile, 'id' | 'filters'> | null>(profile: P): OptimisticFilters<P> {
  const qc = useQueryClient();
  const id = profile?.id ?? '';
  const read = () => {
    const q = id ? queuesOf(qc).get(id) : undefined;
    return q && q.pending > 0 ? q.optimistic : null;
  };
  const optimistic = useSyncExternalStore(subscribe, read, () => null);
  if (!profile || !optimistic) return { profile, saving: false };
  return { profile: { ...profile, filters: optimistic }, saving: true };
}

export function useApplyFilters() {
  const update = useUpdateSearchProfile();
  const qc = useQueryClient();
  const { mutateAsync } = update;

  const apply = useCallback(
    async (input: ApplyFiltersInput): Promise<ApplyFiltersResult> => {
      const id = input.profile.id;
      const all = queuesOf(qc);
      const prev = all.get(id);
      const waiting = prev && prev.pending > 0 ? prev : null;
      // What the controls show at once: this change on top of the ones still being saved.
      const shownBefore = waiting ? waiting.optimistic : input.profile.filters;
      const optimistic = input.replace ? normalizeFilters(input.replace) : mergePatch(shownBefore, input.patch ?? {});

      const send = (baseVersion: number) =>
        mutateAsync({
          id,
          body: input.replace ? { baseVersion, filters: optimistic } : { baseVersion, filtersPatch: input.patch ?? {} },
        });

      const run = async (): Promise<ApplyFiltersResult> => {
        // The write before this one (if any) decides the version this one is based on.
        const last = waiting ? await waiting.tail : null;
        const before = last?.filters ?? input.profile.filters;
        const baseVersion = last && last.version > input.profile.version ? last.version : input.profile.version;
        try {
          let profile: SearchProfile;
          try {
            profile = await send(baseVersion);
          } catch (error) {
            const current = conflictProfile(error);
            // One field-level change on a search that moved on: apply it to the newest version.
            if (!current || input.replace) throw error;
            profile = await send(current.version);
          }
          let sponsorshipSynced: boolean | null = null;
          const was = before.needsSponsorship === true;
          const now = profile.filters.needsSponsorship === true;
          if (was !== now) {
            sponsorshipSynced = await syncSponsorshipAnswer(sponsorshipCountry(profile.filters, input.defaultCountry), now);
            if (sponsorshipSynced) void qc.invalidateQueries({ queryKey: ['profile'] });
          }
          // The feed re-reads the active profile.
          void qc.invalidateQueries({ queryKey: ['feed'] });
          return { ok: true, profile, sponsorshipSynced };
        } catch (error) {
          return { ok: false, conflict: conflictProfile(error), error };
        }
      };

      const result = run();
      const entry: WriteQueue = {
        tail: result.then((r) => (r.ok ? r.profile : null)),
        optimistic,
        pending: (waiting?.pending ?? 0) + 1,
      };
      all.set(id, entry);
      notify();

      const settled = await result;
      const live = all.get(id);
      if (live) {
        live.pending -= 1;
        // Nothing left to save: the controls go back to the saved profile (a change that failed is no longer shown).
        if (live.pending <= 0) all.delete(id);
        notify();
      }
      return settled;
    },
    [mutateAsync, qc],
  );

  return { apply, isPending: update.isPending };
}
