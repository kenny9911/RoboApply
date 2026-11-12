// hooks/today — the reads behind /today (docs/agent-driven/REDESIGN.md §5).
// What these tests hold:
//   • Today composes the other areas' hooks and asks only what the
//     capabilities allow: no kit list without `agent`, no feed read "just in
//     case" before the flags are known, no skills check without a base resume;
//   • the picks are the suggestions with `agent`, else the top of the Jobs list;
//   • each read is off / loading / error / ready on its own; a failed one has
//     its own retry and an answer that cannot be read is an error, not a 0.
// Every hook Today composes is replaced by a double; the one request made
// here (GET /feed/new-count) is mocked at lib/api/feed.

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  caps: vi.fn(),
  queue: vi.fn(),
  suggestions: vi.fn(),
  feed: vi.fn(),
  skills: vi.fn(),
  onboarding: vi.fn(),
  profile: vi.fn(),
  search: vi.fn(),
  board: vi.fn(),
  resumes: vi.fn(),
  getNewCount: vi.fn(),
}));

vi.mock('../../lib/flags', () => ({ useCapabilities: () => h.caps() }));
vi.mock('../agent', () => ({ useReadyQueue: (o: unknown) => h.queue(o), useSuggestions: (o: unknown) => h.suggestions(o) }));
vi.mock('../feed/useFeed', () => ({ useFeed: (p: unknown) => h.feed(p) }));
vi.mock('../feed/useCalibration', () => ({ useSkillsCheckData: (enabled: boolean) => h.skills(enabled) }));
vi.mock('../onboarding/useOnboarding', () => ({ useOnboardingState: () => h.onboarding() }));
vi.mock('../profile/useProfile', () => ({ useProfile: () => h.profile() }));
vi.mock('../search/useSearchProfiles', () => ({ useActiveSearchProfile: () => h.search() }));
vi.mock('../usePipelineBoard', () => ({ usePipelineBoard: () => h.board() }));
vi.mock('../useResumes', () => ({ useResumeList: () => h.resumes() }));
vi.mock('../../lib/api/feed', () => ({ getNewCount: (...args: unknown[]) => h.getNewCount(...args) }));

import { RoboApiError } from '../../lib/api/client';
import { loadableOf, newJobsOf, useTodaySources, valueOf } from './index';

const apiError = (status: number, code: string) => new RoboApiError(code, { code, status, payload: { code } });

/** A query double: answered with `data`, or still loading, or failed. */
const answered = <T,>(data: T) => ({ data, isPending: false, isError: false, error: null, refetch: vi.fn() });
const pending = () => ({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });
const errored = (error: unknown = new Error('offline')) => ({ data: undefined, isPending: false, isError: true, error, refetch: vi.fn() });

const flags = (on: Record<string, boolean>) => ({ status: 'ready', brand: null, flags: { agent: false, copilot: false, 'jobs.feed': false, ...on } });
const feedState = (over: Record<string, unknown> = {}) => ({ items: [], isPending: true, isError: false, error: null, refetch: vi.fn(), ...over });
const feedItem = (jobId: string) => ({ jobId, title: jobId });
const PROFILE = { id: 'sp1', version: 4, filters: { fitTier: 'good' } };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const sources = () => renderHook(() => useTodaySources(), { wrapper });

beforeEach(() => {
  vi.clearAllMocks();
  h.caps.mockReturnValue(flags({ agent: true, copilot: true, 'jobs.feed': true }));
  h.queue.mockReturnValue(answered({ items: [] }));
  h.suggestions.mockReturnValue(answered({ items: [] }));
  h.feed.mockReturnValue(feedState());
  h.skills.mockReturnValue(answered({ skills: [] }));
  h.onboarding.mockReturnValue(answered({ progress: { total: 6, stepsLeft: 0, leftEarly: null } }));
  h.profile.mockReturnValue(answered({ missing: [] }));
  h.search.mockReturnValue({ ...answered({ profiles: [PROFILE] }), profile: PROFILE });
  h.board.mockReturnValue(answered({ entries: [], statusCounts: {}, total: 0 }));
  h.resumes.mockReturnValue(answered({ resumes: [{ id: 'rv', kind: 'base' }] }));
  h.getNewCount.mockResolvedValue({ count: 7, since: '2026-11-09T08:00:00.000Z' });
});

describe('useTodaySources: what is asked, by capability', () => {
  it('with `agent`: the list and the suggestions are read, the picks are the top three suggestions, the feed is left alone', async () => {
    h.suggestions.mockReturnValue(answered({ items: ['a', 'b', 'c', 'd'].map(feedItem) }));
    const { result } = sources();
    expect(h.queue).toHaveBeenLastCalledWith({ enabled: true });
    expect(h.suggestions).toHaveBeenLastCalledWith({ enabled: true, limit: 3 });
    expect(h.feed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(result.current.flags).toEqual({ ready: true, agent: true, copilot: true, feed: true });
    expect(result.current.picksFrom).toBe('suggestions');
    expect(valueOf(result.current.picks)?.map((p) => p.jobId)).toEqual(['a', 'b', 'c']);
    expect(result.current.queue).toEqual({ status: 'ready', data: [] });
    await waitFor(() => expect(result.current.newJobs).toEqual({ status: 'ready', data: { count: 7, since: '2026-11-09T08:00:00.000Z', capped: false } }));
    // Reading the count is not a visit to Jobs.
    expect(h.getNewCount).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('without `agent`: no list, no suggestions; the picks are the top three of the Jobs list on its default sort', async () => {
    h.caps.mockReturnValue(flags({ 'jobs.feed': true }));
    h.feed.mockReturnValue(feedState({ items: ['a', 'b', 'c', 'd', 'e'].map(feedItem), isPending: false }));
    const { result } = sources();
    expect(h.queue).toHaveBeenLastCalledWith({ enabled: false });
    expect(h.suggestions).toHaveBeenLastCalledWith({ enabled: false, limit: 3 });
    await waitFor(() => expect(h.feed).toHaveBeenLastCalledWith({ searchProfileId: 'sp1', version: 4, sort: 'recommended', fitTier: 'good', enabled: true }));
    expect(result.current.queue).toEqual({ status: 'off' });
    expect(result.current.picksFrom).toBe('feed');
    expect(valueOf(result.current.picks)?.map((p) => p.jobId)).toEqual(['a', 'b', 'c']);
    expect(result.current.flags).toMatchObject({ agent: false, copilot: false });
  });

  it('reads the new-jobs count before it opens the Jobs list: opening the list is the visit the count starts from', async () => {
    h.caps.mockReturnValue(flags({ 'jobs.feed': true }));
    let answer: (value: { count: number; since: string | null }) => void = () => undefined;
    h.getNewCount.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = sources();
    await waitFor(() => expect(h.getNewCount).toHaveBeenCalledTimes(1));
    // The count is still on its way: the list is not asked for.
    expect(h.feed.mock.calls.every(([params]) => (params as { enabled: boolean }).enabled === false)).toBe(true);
    answer({ count: 5, since: '2026-11-09T08:00:00.000Z' });
    await waitFor(() => expect(h.feed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })));
    expect(result.current.newJobs).toEqual({ status: 'ready', data: { count: 5, since: '2026-11-09T08:00:00.000Z', capped: false } });
  });

  it('still opens the Jobs list when the count could not be read', async () => {
    h.caps.mockReturnValue(flags({ 'jobs.feed': true }));
    h.getNewCount.mockRejectedValue(new Error('offline'));
    sources();
    await waitFor(() => expect(h.feed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })));
  });

  it('waits for the saved search before it reads the Jobs list', () => {
    h.caps.mockReturnValue(flags({ 'jobs.feed': true }));
    h.search.mockReturnValue({ ...pending(), profile: null });
    const { result } = sources();
    expect(h.feed).toHaveBeenLastCalledWith(expect.objectContaining({ searchProfileId: null, enabled: false }));
    expect(result.current.picks).toEqual({ status: 'loading' });
    expect(result.current.search).toEqual({ status: 'loading' });
  });

  it('before the capabilities are known nothing that depends on them is asked, and nothing reads as off', () => {
    h.caps.mockReturnValue({ status: 'loading', brand: null, flags: null });
    const { result } = sources();
    expect(h.queue).toHaveBeenLastCalledWith({ enabled: false });
    expect(h.suggestions).toHaveBeenLastCalledWith({ enabled: false, limit: 3 });
    expect(h.feed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(h.skills).toHaveBeenLastCalledWith(false);
    expect(h.getNewCount).not.toHaveBeenCalled();
    expect(result.current.flags).toEqual({ ready: false, agent: false, copilot: false, feed: false });
    expect(result.current.queue).toEqual({ status: 'loading' });
    expect(result.current.picks).toEqual({ status: 'loading' });
    expect(result.current.newJobs).toEqual({ status: 'loading' });
    expect(result.current.picksFrom).toBeNull();
  });

  it('with no job list and no Ready to apply there is nothing to pick from and no count is asked', () => {
    h.caps.mockReturnValue(flags({}));
    const { result } = sources();
    expect(h.feed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(h.skills).toHaveBeenLastCalledWith(false);
    expect(h.getNewCount).not.toHaveBeenCalled();
    expect(result.current.picks).toEqual({ status: 'off' });
    expect(result.current.picksFrom).toBeNull();
    expect(result.current.newJobs).toEqual({ status: 'off' });
    expect(result.current.skills).toEqual({ status: 'off' });
  });

  it('capabilities that could not be read fail closed: everything flag-gated is off, not loading', () => {
    h.caps.mockReturnValue({ status: 'error', brand: null, flags: null });
    const { result } = sources();
    expect(result.current.flags).toEqual({ ready: true, agent: false, copilot: false, feed: false });
    expect(result.current.queue).toEqual({ status: 'off' });
    expect(result.current.picks).toEqual({ status: 'off' });
  });

  it('asks what jobs ask for only once there is a base resume to set it against', () => {
    h.resumes.mockReturnValue(answered({ resumes: [{ id: 't', kind: 'tailored_for_jd' }] }));
    const first = sources();
    expect(h.skills).toHaveBeenLastCalledWith(false);
    expect(first.result.current.skills).toEqual({ status: 'off' });
    first.unmount();

    h.resumes.mockReturnValue(answered({ resumes: [{ id: 'b', kind: 'from_template' }] }));
    h.skills.mockReturnValue(answered({ skills: [{ skill: 'SQL', askedIn: 3, outOf: 50 }] }));
    const second = sources();
    expect(h.skills).toHaveBeenLastCalledWith(true);
    expect(second.result.current.skills).toEqual({ status: 'ready', data: [{ skill: 'SQL', askedIn: 3, outOf: 50 }] });
  });
});

describe('useTodaySources: each read on its own', () => {
  it('loading reads are loading, not empty', () => {
    h.queue.mockReturnValue(pending());
    h.suggestions.mockReturnValue(pending());
    h.board.mockReturnValue(pending());
    h.profile.mockReturnValue(pending());
    h.resumes.mockReturnValue(pending());
    h.onboarding.mockReturnValue(pending());
    const { result } = sources();
    for (const key of ['queue', 'picks', 'board', 'profileMissing', 'resumes', 'setupStepsLeft'] as const) expect(result.current[key]).toEqual({ status: 'loading' });
  });

  it('a failed read is an error with its own retry, and the others are untouched', () => {
    const failedBoard = errored();
    h.board.mockReturnValue(failedBoard);
    const { result } = sources();
    const board = result.current.board;
    expect(board.status).toBe('error');
    if (board.status === 'error') board.retry();
    expect(failedBoard.refetch).toHaveBeenCalledTimes(1);
    expect(result.current.resumes.status).toBe('ready');
    expect(result.current.profileMissing).toEqual({ status: 'ready', data: 0 });
  });

  it('an area the server says is not there for this account is off, not an error', () => {
    h.queue.mockReturnValue(errored(apiError(403, 'feature_disabled')));
    h.suggestions.mockReturnValue(errored(apiError(501, 'not_implemented')));
    h.profile.mockReturnValue(errored(apiError(501, 'not_implemented')));
    const { result } = sources();
    expect(result.current.queue).toEqual({ status: 'off' });
    expect(result.current.picks).toEqual({ status: 'off' });
    expect(result.current.profileMissing).toEqual({ status: 'off' });
  });

  it('the Jobs list failing is an error for the picks, with the list’s own retry', () => {
    h.caps.mockReturnValue(flags({ 'jobs.feed': true }));
    const refetch = vi.fn();
    h.feed.mockReturnValue(feedState({ isPending: false, isError: true, error: new Error('offline'), refetch }));
    const { result } = sources();
    const picks = result.current.picks;
    expect(picks.status).toBe('error');
    if (picks.status === 'error') picks.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('an empty Jobs list is an answer: no picks, not loading', () => {
    h.caps.mockReturnValue(flags({ 'jobs.feed': true }));
    h.feed.mockReturnValue(feedState({ isPending: false }));
    expect(sources().result.current.picks).toEqual({ status: 'ready', data: [] });
  });

  it('counts the profile details forms ask for, and the setup screens left only when setup was left early', () => {
    h.profile.mockReturnValue(answered({ missing: [{ key: 'phone' }, { key: 'city' }] }));
    h.onboarding.mockReturnValue(answered({ progress: { total: 6, stepsLeft: 3, leftEarly: { at: '2026-11-01T00:00:00.000Z' } } }));
    const left = sources();
    expect(left.result.current.profileMissing).toEqual({ status: 'ready', data: 2 });
    expect(left.result.current.setupStepsLeft).toEqual({ status: 'ready', data: 3 });
    left.unmount();

    // Still in onboarding's own flow (not left early): nothing to finish from here.
    h.onboarding.mockReturnValue(answered({ progress: { total: 6, stepsLeft: 3, leftEarly: null } }));
    expect(sources().result.current.setupStepsLeft).toEqual({ status: 'ready', data: 0 });
  });

  it('an answer it cannot read is an error, never a made-up number', () => {
    h.profile.mockReturnValue(answered({ completeness: 80 }));
    h.onboarding.mockReturnValue(answered({ completed: true }));
    h.queue.mockReturnValue(answered({}));
    const { result } = sources();
    expect(result.current.profileMissing.status).toBe('error');
    expect(result.current.setupStepsLeft.status).toBe('error');
    expect(result.current.queue.status).toBe('error');
  });

  it('the new-jobs count failing is an error; the lane shows "—" for it', async () => {
    h.getNewCount.mockRejectedValue(new Error('offline'));
    const { result } = sources();
    await waitFor(() => expect(result.current.newJobs.status).toBe('error'));
  });

  it('the search Jobs uses is handed on as it is; an account with none reads null', () => {
    expect(valueOf(sources().result.current.search)).toBe(PROFILE);
    h.search.mockReturnValue({ ...answered({ profiles: [] }), profile: null });
    expect(sources().result.current.search).toEqual({ status: 'ready', data: null });
  });
});

describe('newJobsOf / loadableOf', () => {
  it('reads the server’s count, its date and whether it hit the ceiling', () => {
    expect(newJobsOf({ count: 12.9, since: '2026-11-09T08:00:00.000Z', capped: true })).toEqual({ count: 12, since: '2026-11-09T08:00:00.000Z', capped: true });
    expect(newJobsOf({ count: 0, since: null })).toEqual({ count: 0, since: null, capped: false });
    expect(newJobsOf({ count: 3, since: 'not a date' })).toEqual({ count: 3, since: null, capped: false });
  });

  it('an answer without a usable count is no answer', () => {
    for (const data of [{}, { count: '4' }, { count: Number.NaN }, { count: -1 }]) expect(newJobsOf(data)).toBeUndefined();
  });

  it('keeps the last real answer while a refresh fails', () => {
    const query = { data: { n: 2 }, isError: true, error: new Error('offline'), refetch: vi.fn() };
    expect(loadableOf(query, true, (d) => d.n)).toEqual({ status: 'ready', data: 2 });
  });

  it('is off when not asked, whatever the query holds', () => {
    expect(loadableOf({ data: { n: 2 }, isError: false, refetch: vi.fn() }, false, (d) => d.n)).toEqual({ status: 'off' });
  });
});
