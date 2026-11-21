// WP-20: a saved-search write only refetches the legacy preferences query when
// the active profile's filters (what GET /v2/preferences projects) can change,
// so the Settings draft is not reseeded by a rename or an alert change.

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  changesPreferencesProjection,
  useActivateSearchProfile,
  useDeleteSearchProfile,
  useSetTargetCompany,
  useUpdateSearchProfile,
} from './useSearchProfiles';
import { LEGACY_PREFERENCES_KEY, searchKeys } from './keys';
import { agentKeys } from '../agent/keys';
import { installFetch, list, ok, profile } from '../../components/features/filters/filters.testkit';

const P = '/api/v1/roboapply/search-profiles';
afterEach(() => vi.unstubAllGlobals());

const main = profile();
const other = profile({ id: 'sp_b', name: 'Data', isDefault: false, isActive: false, version: 1 });

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(searchKeys.profiles(), list([main, other], { maxProfiles: 10 }));
  client.setQueryData(LEGACY_PREFERENCES_KEY, { preferences: {} });
  const spy = vi.spyOn(client, 'invalidateQueries');
  const legacyInvalidated = () => spy.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(LEGACY_PREFERENCES_KEY));
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, spy, legacyInvalidated, wrapper };
}

describe('changesPreferencesProjection', () => {
  it('is true only for writes that can change the active profile’s filters', () => {
    expect(changesPreferencesProjection({ kind: 'activate' })).toBe(true);
    expect(changesPreferencesProjection({ kind: 'create', profile: other })).toBe(false);
    expect(changesPreferencesProjection({ kind: 'create', profile: { ...other, isActive: true } })).toBe(true);
    expect(changesPreferencesProjection({ kind: 'delete', wasActive: false })).toBe(false);
    expect(changesPreferencesProjection({ kind: 'delete', wasActive: true })).toBe(true);
    expect(changesPreferencesProjection({ kind: 'update', profile: main, body: { baseVersion: 3, name: 'x' } })).toBe(false);
    expect(changesPreferencesProjection({ kind: 'update', profile: main, body: { baseVersion: 3, alertInstantMax: 1 } })).toBe(false);
    expect(changesPreferencesProjection({ kind: 'update', profile: main, body: { baseVersion: 3, makeDefault: true } })).toBe(false);
    expect(changesPreferencesProjection({ kind: 'update', profile: main, body: { baseVersion: 3, filtersPatch: { titles: ['A'] } } })).toBe(true);
    expect(changesPreferencesProjection({ kind: 'update', profile: main, body: { baseVersion: 3, filters: {} } })).toBe(true);
    expect(changesPreferencesProjection({ kind: 'update', profile: other, body: { baseVersion: 1, filters: {} } })).toBe(false);
    // "Companies you want to work at" are the projection's `targetCompanies`.
    expect(changesPreferencesProjection({ kind: 'targets', profile: main })).toBe(true);
    expect(changesPreferencesProjection({ kind: 'targets', profile: other })).toBe(false);
  });
});

// docs/agent-driven/REDESIGN.md §8 scenario 4: the job page's control.
describe('useSetTargetCompany', () => {
  it('sends one company and an answer, puts the search it answers into the list, and asks for the picks and the preferences afresh', async () => {
    const after = { ...main, version: 4, filters: { preferredCompanies: ['Stripe'] } };
    const net = installFetch({ [`POST ${P}/target-companies`]: () => ok({ profile: after, on: true }) });
    const h = harness();
    h.client.setQueryData(agentKeys.suggestions(3), { items: [] });
    const { result } = renderHook(() => useSetTargetCompany(), { wrapper: h.wrapper });
    const res = await act(() => result.current.mutateAsync({ company: 'Stripe', on: true }));
    expect(res).toEqual({ profile: after, on: true });
    expect(net.to('POST', `${P}/target-companies`).map((c) => c.body)).toEqual([{ company: 'Stripe', on: true }]);
    expect(h.client.getQueryData<{ profiles: Array<{ id: string; version: number }> }>(searchKeys.profiles())!.profiles.find((p) => p.id === 'sp_main')).toMatchObject({ version: 4, filters: { preferredCompanies: ['Stripe'] } });
    expect(h.legacyInvalidated()).toBe(true);
    expect(h.client.getQueryData(agentKeys.suggestions(3))).toBeUndefined();
  });
});

describe('saved-search writes and the legacy preferences query', () => {
  it('a rename or an alert change does not refetch the preferences (the Settings draft survives)', async () => {
    installFetch({ [`PATCH ${P}/sp_main`]: (c) => ok({ ...main, ...(c.body as object), version: 4 }) });
    const h = harness();
    const { result } = renderHook(() => useUpdateSearchProfile(), { wrapper: h.wrapper });
    await act(() => result.current.mutateAsync({ id: 'sp_main', body: { baseVersion: 3, alertInstantMax: 1 } }));
    await act(() => result.current.mutateAsync({ id: 'sp_main', body: { baseVersion: 4, name: 'Renamed' } }));
    expect(h.spy).toHaveBeenCalledWith({ queryKey: searchKeys.profiles() });
    expect(h.legacyInvalidated()).toBe(false);
  });

  it('a filter change on the active search does refetch them', async () => {
    installFetch({ [`PATCH ${P}/sp_main`]: (c) => ok({ ...main, version: 4, filters: (c.body as { filters: object }).filters }) });
    const h = harness();
    const { result } = renderHook(() => useUpdateSearchProfile(), { wrapper: h.wrapper });
    await act(() => result.current.mutateAsync({ id: 'sp_main', body: { baseVersion: 3, filters: { titles: ['QA'] } } }));
    expect(h.legacyInvalidated()).toBe(true);
  });

  it('deleting a search that is not in use leaves them alone; activating one refetches them', async () => {
    installFetch({
      [`DELETE ${P}/sp_b`]: () => ok(null),
      [`POST ${P}/sp_b/activate`]: () => ok({ ...other, isActive: true, version: 2 }),
    });
    const h = harness();
    const del = renderHook(() => useDeleteSearchProfile(), { wrapper: h.wrapper });
    await act(() => del.result.current.mutateAsync('sp_b'));
    expect(h.legacyInvalidated()).toBe(false);

    const h2 = harness();
    const act2 = renderHook(() => useActivateSearchProfile(), { wrapper: h2.wrapper });
    await act(() => act2.result.current.mutateAsync('sp_b'));
    await waitFor(() => expect(h2.legacyInvalidated()).toBe(true));
  });
});

describe('saved-search writes and the Job search agent’s picks', () => {
  it('a filter change made anywhere (the Jobs list too) asks for the picks afresh', async () => {
    installFetch({ [`PATCH ${P}/sp_main`]: (c) => ok({ ...main, version: 4, filters: (c.body as { filters: object }).filters }) });
    const h = harness();
    h.client.setQueryData(agentKeys.suggestions(3), { items: [] });
    const reset = vi.spyOn(h.client, 'resetQueries');
    const { result } = renderHook(() => useUpdateSearchProfile(), { wrapper: h.wrapper });
    await act(() => result.current.mutateAsync({ id: 'sp_main', body: { baseVersion: 3, filters: { titles: ['QA'] } } }));
    expect(reset).toHaveBeenCalledWith({ queryKey: agentKeys.suggestions() });
    // Reset, not refreshed in place: the cached picks are dropped, so the Dashboard takes the new list as a whole.
    expect(h.client.getQueryData(agentKeys.suggestions(3))).toBeUndefined();
  });
});
