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

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

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

export function useApplyFilters() {
  const update = useUpdateSearchProfile();
  const qc = useQueryClient();

  const apply = useCallback(
    async (input: ApplyFiltersInput): Promise<ApplyFiltersResult> => {
      const before = input.profile.filters;
      const after = input.replace ? normalizeFilters(input.replace) : mergePatch(before, input.patch ?? {});
      const body = input.replace
        ? { baseVersion: input.profile.version, filters: after }
        : { baseVersion: input.profile.version, filtersPatch: input.patch ?? {} };
      try {
        const profile = await update.mutateAsync({ id: input.profile.id, body });
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
    },
    [update, qc],
  );

  return { apply, isPending: update.isPending };
}
