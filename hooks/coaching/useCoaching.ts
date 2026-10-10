'use client';

// hooks/coaching/useCoaching.ts — query/mutation hooks for the coach list and
// the staff roster (WP-72). API calls go through lib/api/coaching only.
//
// The nav entry and every coaching upsell read the roster through
// `useCoachRosterAvailable` (hooks/shared/navBadges.ts, key
// COACH_ROSTER_QUERY_KEY); roster changes made here refresh that key too.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  adminCreateCoach,
  adminDeleteCoach,
  adminListCoaches,
  adminUpdateCoach,
  getCoach,
  listCoaches,
  requestCoach,
} from '../../lib/api/coaching';
import type { CoachBodySchema, CoachRequestBodySchema, PatchCoachBodySchema } from '../../lib/api/contracts/coaching';
import type { In } from '../../lib/api/contracts/wire';
import { COACH_ROSTER_QUERY_KEY } from '../shared/navBadges';

export type CoachBrandFilter = 'roboapply' | 'goapply';

export const coachingKeys = {
  all: ['coaching'] as const,
  list: (specialty: string | null, language: string | null) => ['coaching', 'list', specialty, language] as const,
  coach: (id: string) => ['coaching', 'coach', id] as const,
  admin: (brand: CoachBrandFilter | null) => ['coaching', 'admin', brand] as const,
};

/** The current site's listed coaches. Off (no request) when `enabled` is false. */
export function useCoaches(filters: { specialty?: string | null; language?: string | null } = {}, enabled = true) {
  const specialty = filters.specialty?.trim() || null;
  const language = filters.language?.trim() || null;
  return useQuery({
    queryKey: coachingKeys.list(specialty, language),
    queryFn: ({ signal }) =>
      listCoaches({ ...(specialty ? { specialty } : {}), ...(language ? { language } : {}) }, { signal }),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useCoach(id: string | null) {
  return useQuery({
    queryKey: coachingKeys.coach(id ?? ''),
    queryFn: ({ signal }) => getCoach(id!, { signal }),
    enabled: Boolean(id),
    retry: false,
  });
}

/** Send a booking request (emailed to the coach and staff; nothing is charged). */
export function useRequestCoach(id: string) {
  return useMutation({
    mutationFn: (body: In<typeof CoachRequestBodySchema>) => requestCoach(id, body),
  });
}

// ── Staff roster ─────────────────────────────────────────────────────────

export function useAdminCoaches(brand: CoachBrandFilter | null, enabled = true) {
  return useQuery({
    queryKey: coachingKeys.admin(brand),
    queryFn: ({ signal }) => adminListCoaches(brand ? { brand } : undefined, { signal }),
    enabled,
    retry: false,
  });
}

function useInvalidateRoster() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: coachingKeys.all }),
      qc.invalidateQueries({ queryKey: COACH_ROSTER_QUERY_KEY }),
    ]);
}

export function useCreateCoach() {
  const invalidate = useInvalidateRoster();
  return useMutation({
    mutationFn: (body: In<typeof CoachBodySchema>) => adminCreateCoach(body),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateCoach() {
  const invalidate = useInvalidateRoster();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: In<typeof PatchCoachBodySchema> }) => adminUpdateCoach(id, body),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteCoach() {
  const invalidate = useInvalidateRoster();
  return useMutation({
    mutationFn: (id: string) => adminDeleteCoach(id),
    onSuccess: () => invalidate(),
  });
}
