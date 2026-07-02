'use client';

// hooks/useInterviewPreview.ts
//
// Pre-launch "Market Job Requirements" preview for the mock-interview setup
// page. A MUTATION (not a query) on purpose: the preview runs a Tavily search +
// an LLM blueprint call, so it must fire ONLY on an explicit user action — never
// automatically on mount or per keystroke (React 18 StrictMode would otherwise
// double-charge the call). The result is independent of launch and never gates
// it. Lives outside lib/api/v2 because interviewEngineApi is in lib/api/.

import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import {
  interviewEngineApi,
  type IEPreviewBody,
  type IEPreviewResponse,
} from '../lib/api/interviewEngine';

export function useInterviewPreview(): UseMutationResult<
  IEPreviewResponse,
  Error,
  IEPreviewBody
> {
  return useMutation({
    mutationFn: (body: IEPreviewBody) => interviewEngineApi.preview(body),
  });
}
