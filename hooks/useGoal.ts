'use client';

// hooks/useGoal.ts
//
// TanStack Query wrappers around `raV2Api.goal.{get,upsert}`. The Home page
// (and later /settings) both read from the same `['v2', 'goal']` key so a
// goal update from one place immediately invalidates the other.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { raV2Api } from '../lib/api/v2';
import type {
  GoalGetResponse,
  GoalUpsertBody,
  GoalUpsertResponse,
} from '../lib/api/v2';

const GOAL_KEY = ['v2', 'goal'] as const;

/** Read the user's current career goal. Returns `null` for `data.goal` when
 *  the user hasn't set one yet — the GoalCard renders its empty state then. */
export function useGoal() {
  return useQuery<GoalGetResponse>({
    queryKey: GOAL_KEY,
    queryFn: () => raV2Api.goal.get(),
  });
}

/** Upsert the goal. On success we invalidate `['v2', 'goal']` AND
 *  `['v2', 'home', 'jobs']` because the recent-jobs feed keys on the
 *  goal's targetTitle. */
export function useGoalMutation() {
  const qc = useQueryClient();
  return useMutation<GoalUpsertResponse, Error, GoalUpsertBody>({
    mutationFn: (patch) => raV2Api.goal.upsert(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: GOAL_KEY });
      void qc.invalidateQueries({ queryKey: ['v2', 'home', 'jobs'] });
    },
  });
}
