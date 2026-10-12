'use client';

// hooks/resume/useResumeBuilder.ts — the guided builder's data (WP-65):
// config for this brand and locale, AI suggestions, and creating the resume.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createResumeFromBuilder,
  getBuilderConfig,
  suggestBuilderText,
  type BuilderConfig,
  type BuilderCreateResponse,
  type BuilderDraft,
  type BuilderSuggestBody,
  type BuilderSuggestResponse,
} from '../../lib/api/resumes';
import { newIdempotencyKey } from '../../lib/api/contracts/wire';

export const BUILDER_CONFIG_KEY = ['resume', 'builder', 'config'] as const;

export function useBuilderConfig() {
  return useQuery<BuilderConfig>({
    queryKey: BUILDER_CONFIG_KEY,
    queryFn: ({ signal }) => getBuilderConfig({ signal }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** One AI suggestion request (a `rewrite` credit; each call gets its own key). */
export function useBuilderSuggest() {
  return useMutation<BuilderSuggestResponse, unknown, BuilderSuggestBody>({
    mutationFn: (body) => suggestBuilderText(body, { idempotencyKey: newIdempotencyKey() }),
  });
}

export function useCreateFromBuilder() {
  const qc = useQueryClient();
  return useMutation<BuilderCreateResponse, unknown, BuilderDraft>({
    mutationFn: (draft) => createResumeFromBuilder(draft),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'resumes'] });
    },
  });
}
