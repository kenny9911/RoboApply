// FIX-3: consecutive filter changes. A second change made while the first
// PATCH is still on its way used to carry the same baseVersion, get a 409
// version_conflict and be dropped. Writes are now queued per saved search and
// a field-level change that still meets a 409 is applied to the newest version.

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useApplyFilters, useOptimisticFilters, type ApplyFiltersResult } from './useApplyFilters';
import { searchKeys } from './keys';
import { mergePatch, type FilterSet, type FilterSetPatch } from './filterModel';
import { fail, installFetch, list, ok, profile, type RecordedCall } from '../../components/features/filters/filters.testkit';

const P = '/api/v1/roboapply/search-profiles';
afterEach(() => vi.unstubAllGlobals());

type Body = { baseVersion: number; filtersPatch?: FilterSetPatch; filters?: FilterSet };

/** A server that keeps one saved search and refuses a stale baseVersion, answering after `delayMs`. */
function server(start = profile({ version: 9, filters: { seniority: ['senior', 'mid'], workModels: ['remote'] } }), delayMs = 20) {
  let current = start;
  const route = async (c: RecordedCall) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const body = c.body as Body;
    if (body.baseVersion !== current.version) return fail(409, 'version_conflict', { profile: current });
    current = { ...current, version: current.version + 1, filters: body.filters ?? mergePatch(current.filters, body.filtersPatch ?? {}) };
    return ok(current);
  };
  const net = installFetch({ [`PATCH ${P}/sp_main`]: route });
  return { net, start, now: () => current, bump: (filters: FilterSet) => (current = { ...current, version: current.version + 1, filters }) };
}

function harness(start = profile()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(searchKeys.profiles(), list([start]));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe('useApplyFilters: consecutive changes', () => {
  it('a second change made before the first PATCH returns is sent on the new version and saved (no 409, nothing lost)', async () => {
    const s = server();
    const h = harness(s.start);
    const { result } = renderHook(() => ({ apply: useApplyFilters().apply, shown: useOptimisticFilters(s.start) }), { wrapper: h.wrapper });

    let first!: Promise<ApplyFiltersResult>;
    let second!: Promise<ApplyFiltersResult>;
    act(() => {
      // Both clicks read the same profile (version 9): the UI has not heard back yet.
      first = result.current.apply({ profile: s.start, patch: { seniority: ['mid'] }, defaultCountry: 'US' });
      second = result.current.apply({ profile: s.start, patch: { fitTier: 'good' }, defaultCountry: 'US' });
    });
    // Both changes show at once, with a saving state.
    expect(result.current.shown.saving).toBe(true);
    expect(result.current.shown.profile.filters).toEqual({ seniority: ['mid'], workModels: ['remote'], fitTier: 'good' });

    const [a, b] = await act(() => Promise.all([first, second]));
    expect(a.ok && b.ok).toBe(true);
    const sent = s.net.to('PATCH', `${P}/sp_main`).map((c) => (c.body as Body).baseVersion);
    expect(sent).toEqual([9, 10]);
    expect(s.now()).toMatchObject({ version: 11, filters: { seniority: ['mid'], workModels: ['remote'], fitTier: 'good' } });
    await waitFor(() => expect(result.current.shown.saving).toBe(false));
  });

  it('a field-level change that meets a 409 from another device is applied to the newest version', async () => {
    const s = server();
    const h = harness(s.start);
    s.bump({ seniority: ['senior', 'mid'], workModels: ['remote'], jobTypes: ['full_time'] }); // another tab saved version 10
    const { result } = renderHook(() => useApplyFilters(), { wrapper: h.wrapper });
    const res = await act(() => result.current.apply({ profile: s.start, patch: { workModels: null }, defaultCountry: 'US' }));
    expect(res.ok).toBe(true);
    expect(s.net.to('PATCH', `${P}/sp_main`).map((c) => (c.body as Body).baseVersion)).toEqual([9, 10]);
    // The other tab's change is kept; only this one field changed.
    expect(s.now().filters).toEqual({ seniority: ['senior', 'mid'], jobTypes: ['full_time'] });
  });

  it('a whole-set replace is never retried over a newer version: the caller gets the conflict', async () => {
    const s = server();
    const h = harness(s.start);
    s.bump({ jobTypes: ['contract'] });
    const { result } = renderHook(() => useApplyFilters(), { wrapper: h.wrapper });
    const res = await act(() => result.current.apply({ profile: s.start, replace: { titles: ['A'] }, defaultCountry: 'US' }));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.conflict?.version).toBe(10);
    expect(s.net.to('PATCH', `${P}/sp_main`)).toHaveLength(1);
    expect(s.now().filters).toEqual({ jobTypes: ['contract'] });
  });

  it('a change that fails is no longer shown as if it were saved', async () => {
    installFetch({ [`PATCH ${P}/sp_main`]: () => fail(500, 'server_error') });
    const start = profile({ filters: { workModels: ['remote'] } });
    const h = harness(start);
    const { result } = renderHook(() => ({ apply: useApplyFilters().apply, shown: useOptimisticFilters(start) }), { wrapper: h.wrapper });
    const res = await act(() => result.current.apply({ profile: start, patch: { workModels: null }, defaultCountry: 'US' }));
    expect(res.ok).toBe(false);
    expect(result.current.shown).toEqual({ profile: start, saving: false });
  });
});
