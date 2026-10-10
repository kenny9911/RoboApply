'use client';

// components/features/feed/useProposalApply.ts — save a filter change that a
// feed screen proposed (Not interested, NL search, rating fixes, skills check,
// zero-results relax) through the filters area's one write path
// (useApplyFilters, WP-20): ONE PATCH with `baseVersion`.

import { useCallback } from 'react';

import { useEditorContext } from '../filters';
import { useActiveSearchProfile, useApplyFilters, type SearchProfile } from '../../../hooks/search';
import type { FilterSet, FilterSetPatch } from '../../../lib/api/contracts/search';

export type ProposalResult = 'saved' | 'conflict' | 'failed' | 'no_profile';

export function useProposalApply() {
  const { profile, data } = useActiveSearchProfile();
  const ctx = useEditorContext();
  const { apply, isPending } = useApplyFilters();

  /** The saved search a proposal names, else the active one. */
  const target = useCallback(
    (searchProfileId?: string | null): SearchProfile | null => {
      if (searchProfileId && data?.profiles) {
        const found = data.profiles.find((p) => p.id === searchProfileId);
        if (found) return found;
      }
      return profile;
    },
    [data, profile],
  );

  const save = useCallback(
    async (patch: FilterSetPatch, searchProfileId?: string | null): Promise<ProposalResult> => {
      const p = target(searchProfileId);
      if (!p) return 'no_profile';
      const res = await apply({ profile: p, patch, defaultCountry: ctx.defaultCountry });
      if (res.ok) return 'saved';
      return res.conflict ? 'conflict' : 'failed';
    },
    [apply, ctx.defaultCountry, target],
  );

  const replace = useCallback(
    async (filters: FilterSet, searchProfileId?: string | null): Promise<ProposalResult> => {
      const p = target(searchProfileId);
      if (!p) return 'no_profile';
      const res = await apply({ profile: p, replace: filters, defaultCountry: ctx.defaultCountry });
      if (res.ok) return 'saved';
      return res.conflict ? 'conflict' : 'failed';
    },
    [apply, ctx.defaultCountry, target],
  );

  return { profile, target, save, replace, isPending };
}
