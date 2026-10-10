'use client';

// components/features/tools/hooks.ts — queries and mutations of the free tools (WP-57).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { claimToolResult, getToolResult, getToolsConfig, runResumeCheck, runResumeJobMatch, toolForm } from '../../../lib/api/tools';
import type { ClaimToolResultResponse, ResumeCheckReport, ResumeJobMatchReport, ToolReport, ToolsConfigView } from '../../../lib/api/contracts/tools';

export const TOOLS_CONFIG_KEY = ['tools', 'config'] as const;
export const toolResultKey = (id: string) => ['tools', 'result', id] as const;

export function useToolsConfig() {
  return useQuery<ToolsConfigView>({
    queryKey: TOOLS_CONFIG_KEY,
    queryFn: ({ signal }) => getToolsConfig({ signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

/** A result this tab asked to keep (./pendingResult.ts); off without an id. */
export function useToolResult(id: string | null) {
  return useQuery<ToolReport>({
    queryKey: toolResultKey(id ?? ''),
    queryFn: ({ signal }) => getToolResult(id!, { signal }),
    enabled: !!id,
    retry: false,
  });
}

export interface ResumeCheckInput {
  resume: File;
  consent: string | null;
}

export interface ResumeJobMatchInput extends ResumeCheckInput {
  postingTitle: string;
  postingText: string;
}

export function useRunResumeCheck() {
  const qc = useQueryClient();
  return useMutation<ResumeCheckReport, unknown, ResumeCheckInput>({
    mutationFn: (input) => runResumeCheck(toolForm({ resume: input.resume, consent: input.consent })),
    onSettled: () => qc.invalidateQueries({ queryKey: TOOLS_CONFIG_KEY }),
  });
}

// A run is never remembered for a later claim: only the visitor's click on
// the signup / sign-in link under the report does that (NextStep, ./pendingResult.ts).

export function useRunResumeJobMatch() {
  const qc = useQueryClient();
  return useMutation<ResumeJobMatchReport, unknown, ResumeJobMatchInput>({
    mutationFn: (input) =>
      runResumeJobMatch(toolForm({ resume: input.resume, consent: input.consent, postingTitle: input.postingTitle, postingText: input.postingText })),
    onSettled: () => qc.invalidateQueries({ queryKey: TOOLS_CONFIG_KEY }),
  });
}

export function useClaimToolResult() {
  return useMutation<ClaimToolResultResponse, unknown, string>({
    mutationFn: (id) => claimToolResult(id),
  });
}
