// FIX-3: "Rewrite them in this language". The score call can answer 200
// without a rewrite (the day's limit is used up, the model failed). That
// answer must never replace the AI fit on screen: the mutation fails, so the
// reader is told, and the cached fit stays.

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ scoreJob: vi.fn() }));
vi.mock('../../lib/api/jobs', () => ({ scoreJob: api.scoreJob }));

import type { MatchFitView } from '../../lib/api/contracts/match';
import { FitRewriteNotDoneError, isRewrittenFit, jobFitKey, useRewriteFitText } from './useJobFit';

function fit(over: Partial<MatchFitView> = {}): MatchFitView {
  return {
    jobId: 'job1',
    score: 78,
    tier: 'good',
    kind: 'ai',
    dimensions: [],
    summary: 'Your payments work lines up well.',
    strengths: ['Your payments APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    keywordsMatched: [],
    keywordsMissing: [],
    skills: { aligned: [], missing: [], listed: 0 },
    topOverlap: null,
    topGap: null,
    scoredAt: '2026-10-10T08:00:00.000Z',
    resumeVariantId: 'rv1',
    estimateReason: null,
    summaryLocaleStale: false,
    cached: false,
    ...over,
  } as MatchFitView;
}

function harness(cached: MatchFitView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(jobFitKey('job1'), cached);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => api.scoreJob.mockReset());

describe('useRewriteFitText', () => {
  const onScreen = fit({ summaryLocaleStale: true });

  it('a rewritten AI fit replaces the one on screen', async () => {
    const rewritten = fit({ summary: '你的支付经验很对口。', strengths: ['你在 Go 里做过支付接口'], gaps: ['没有体现 Kubernetes 经验'] });
    api.scoreJob.mockResolvedValue({ fit: rewritten });
    const h = harness(onScreen);
    const { result } = renderHook(() => useRewriteFitText('job1'), { wrapper: h.wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.scoreJob).toHaveBeenCalledWith('job1', { regenerateExplanation: true });
    expect(h.client.getQueryData(jobFitKey('job1'))).toEqual(rewritten);
  });

  it.each([
    ['a quick estimate (the day’s limit is used up)', fit({ kind: 'pre', score: 61, summary: null, strengths: [], gaps: [], estimateReason: 'daily_cap' })],
    ['the stored fit, still in the other language', fit({ summaryLocaleStale: true, cached: true })],
  ])('%s does not replace the AI fit, and the rewrite reports a failure', async (_name, answer) => {
    api.scoreJob.mockResolvedValue({ fit: answer });
    const h = harness(onScreen);
    const { result } = renderHook(() => useRewriteFitText('job1'), { wrapper: h.wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(FitRewriteNotDoneError);
    expect(h.client.getQueryData(jobFitKey('job1'))).toEqual(onScreen);
  });

  it('isRewrittenFit: only an AI fit in the asked language', () => {
    expect(isRewrittenFit(fit())).toBe(true);
    expect(isRewrittenFit(fit({ summaryLocaleStale: true }))).toBe(false);
    expect(isRewrittenFit(fit({ kind: 'pre' }))).toBe(false);
    expect(isRewrittenFit(null)).toBe(false);
  });
});
