// WP-20: Settings → Your search (saved searches, alerts), and the draft-backed notes the
// settings route renders under it (INT-12: SearchIntro / SearchNotes replace HuntSection).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { SettingsSection } from './SettingsSection';
import { SearchIntro, SearchNotes } from '../../v3/preferences/sections/HuntSection';
import { TAXONOMY_TREE, fail, installFetch, list, ok, profile, renderWith, type RecordedCall } from '../filters/filters.testkit';

const P = '/api/v1/roboapply/search-profiles';
afterEach(() => vi.unstubAllGlobals());

const main = profile({ name: 'Analyst roles', filters: { titles: ['Analyst'], workModels: ['remote'] } });
const other = profile({ id: 'sp_b', name: 'Data', isDefault: false, isActive: false, version: 1 });

function setup(over: { list?: ReturnType<typeof list>; routes?: Record<string, (c: RecordedCall) => Response> } = {}) {
  const net = installFetch({
    [`GET ${P}`]: () => ok(over.list ?? list([main, other], { maxProfiles: 10, maxInstantAlerts: 1, upgradable: true, proMaxProfiles: null })),
    'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
    [`PATCH ${P}/sp_b`]: (c) => ok({ ...other, ...(c.body as object), version: 2, isDefault: (c.body as { makeDefault?: boolean }).makeDefault === true }),
    [`PATCH ${P}/sp_main`]: (c) => ok({ ...main, ...(c.body as object), version: 4 }),
    [`DELETE ${P}/sp_b`]: () => ok(null),
    ...over.routes,
  });
  renderWith(<SettingsSection section="search" />);
  return net;
}

describe('SettingsSection (#search)', () => {
  it('lists saved searches with Main / In use and a filter summary; the main one has no delete', async () => {
    setup();
    const cards = await screen.findAllByRole('listitem');
    const mainCard = cards.find((c) => within(c).queryByRole('heading', { name: 'Analyst roles' }))!;
    expect(within(mainCard).getByText('Main')).toBeInTheDocument();
    expect(within(mainCard).getByText('In use')).toBeInTheDocument();
    expect(within(mainCard).getByText('2 filters')).toBeInTheDocument();
    expect(within(mainCard).queryByRole('button', { name: 'Delete' })).toBeNull();
    const otherCard = cards.find((c) => within(c).queryByRole('heading', { name: 'Data' }))!;
    expect(within(otherCard).getByText('No filters: all jobs')).toBeInTheDocument();
  });

  it('labels an unnamed non-main search "Saved search {n}", never "Your main search"', async () => {
    const unnamedMain = profile({ name: '' });
    const unnamedOther = profile({ id: 'sp_b', name: '', isDefault: false, isActive: false, version: 1 });
    setup({ list: list([unnamedMain, unnamedOther], { maxProfiles: 10 }) });
    expect(await screen.findByRole('heading', { name: 'Your main search' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved search 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Your main search' })).toHaveLength(1);
  });

  it('makes another search the main one with one PATCH (baseVersion + makeDefault)', async () => {
    const net = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Make this your main search' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_b`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_b`)[0].body).toEqual({ makeDefault: true, baseVersion: 1 });
  });

  it('deletes a non-main search after confirming, and explains a refused delete', async () => {
    const net = setup({ routes: { [`DELETE ${P}/sp_b`]: () => fail(409, 'conflict', { reason: 'cannot_delete_default_profile' }) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete search' }));
    await waitFor(() => expect(net.to('DELETE', `${P}/sp_b`)).toHaveLength(1));
    expect(await screen.findByText('Make another search your main one before you delete this one.')).toBeInTheDocument();
  });

  it('caps instant alerts at the plan (options above it are disabled) and never says "unlimited"', async () => {
    const net = setup();
    const selects = await screen.findAllByLabelText('Instant alerts');
    const options = within(selects[0]).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Off', false],
      ['Up to 1 a day', false],
      ['Up to 2 a day', true],
      ['Up to 5 a day', true],
      ['As they arrive', true],
    ]);
    expect(screen.getAllByText('Pro can get alerts as they arrive.').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/unlimited/i);
    fireEvent.change(screen.getAllByLabelText('Email summary')[0], { target: { value: 'weekly' } });
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ alertDigest: 'weekly', baseVersion: 3 });
  });

  it('opens the filters drawer for a saved search', async () => {
    setup();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit filters' }))[0]);
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByText('Changes apply to Analyst roles.')).toBeInTheDocument();
  });

  it('at the cap disables creating and shows the Pro note', async () => {
    setup({ list: list([main], { maxProfiles: 1, proMaxProfiles: 10, upgradable: true }) });
    expect(await screen.findByRole('button', { name: 'Save as a new search' })).toBeDisabled();
    expect(screen.getByText('Pro keeps up to 10.')).toBeInTheDocument();
  });

  it('says so when the list does not load', async () => {
    setup({ routes: { [`GET ${P}`]: () => fail(500, 'internal_error') } });
    expect(await screen.findByText('Your saved searches did not load.')).toBeInTheDocument();
  });
});

describe('SearchIntro + SearchNotes (the settings route’s pieces around the saved searches)', () => {
  it('the section = intro, saved searches, then only the free-text notes; no salary slider, stage grid or US-only work-authorization select', async () => {
    installFetch({
      [`GET ${P}`]: () => ok(list([main, other], { maxProfiles: 10, maxInstantAlerts: 1, upgradable: true, proMaxProfiles: null })),
      'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
    });
    const set = vi.fn();
    const prefs = { intentMarkdown: 'Fintech please', mustHaves: ['Remote'], dealbreakers: [] } as never;
    renderWith(
      <>
        <SearchIntro />
        <SettingsSection section="search" />
        <SearchNotes p={prefs} set={set} />
      </>,
    );
    expect((await screen.findAllByRole('heading', { name: 'Analyst roles' })).length).toBe(1);
    // One H1: the setup sentence. The saved searches carry the H2.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Saved searches' })).toBeInTheDocument();
    expect(screen.getByText(/now live in your saved searches below/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Fintech please')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByText(/H1-B|Series A/)).toBeNull();
    // The notes edit the preferences draft through `set`.
    fireEvent.change(screen.getByLabelText('What you want next'), { target: { value: 'Climate' } });
    expect(set).toHaveBeenCalledWith('intentMarkdown', 'Climate');
    // They are notes; the copy does not say they hide jobs.
    expect(document.body.textContent).not.toMatch(/are hidden|is hidden/);
  });
});
