// WP-20: quick bar, active chips, fit view, title/company typeahead,
// saved-search switcher and FilterDiff.
// Agent-driven redesign §6: the bar is one summary line with "Change search"
// until its controls are opened (FilterBar, SearchSummary).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { __toastStore } from '../../v3/primitives/Toast';
import { ActiveFilterChips, activeChips } from './ActiveFilterChips';
import { FilterBar } from './FilterBar';
import { FilterDiff } from './FilterDiff';
import { FitTierFilter } from './FitTierFilter';
import { QuickFilterBar } from './QuickFilterBar';
import { SavedSearchSwitcher, profileLabel } from './SavedSearchSwitcher';
import { SUMMARY_MAX_VALUES, summaryParts } from './SearchSummary';
import { SearchTypeahead } from './SearchTypeahead';
import { TAXONOMY_TREE, fail, installFetch, list, ok, profile, renderWith, type RecordedCall } from './filters.testkit';
import styles from './filters.module.css';

const P = '/api/v1/roboapply/search-profiles';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function routes(extra: Record<string, (c: RecordedCall) => Response> = {}) {
  return installFetch({
    'GET /api/v1/roboapply/taxonomy': (c) =>
      ok(
        c.search.includes('q=')
          ? { ...TAXONOMY_TREE, nodes: [], suggestions: [{ id: 'backend_engineer', level: 3, label: 'Backend engineer', context: 'Backend and platform · Software engineering' }] }
          : TAXONOMY_TREE,
      ),
    'GET /api/v1/roboapply/companies': () => ok({ items: [{ id: 'c1', name: 'Acme', slug: 'acme', logoUrl: null, domain: 'acme.test' }] }),
    [`PATCH ${P}/sp_main`]: (c) => ok(profile({ version: 4, filters: (c.body as { filtersPatch?: object }).filtersPatch ?? {} })),
    [`POST ${P}/count`]: () => ok({ count: null, capped: false }),
    ...extra,
  });
}

describe('FIX-3: the search box fills its row; the drawer typeaheads keep their height', () => {
  // `.combo` is shared: the search box is a row item, the drawer's typeaheads
  // sit in a column (`.field`), where a flex-basis is a HEIGHT (a 320px input).
  const css = readFileSync(join(process.cwd(), 'components/features/filters/filters.module.css'), 'utf8');
  const rule = (selector: string) => new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('the width rule lives on the search box only, never on the shared .combo', () => {
    expect(rule('.combo')).toMatch(/position:\s*relative/);
    expect(rule('.combo')).not.toMatch(/(?:^|\s)flex:|flex-basis|max-width|(?:^|\s)height/);
    expect(rule('.searchCombo')).toMatch(/flex:\s*1 1 320px/);
    expect(rule('.searchCombo')).toMatch(/max-width:\s*560px/);
    expect(rule('.field')).toMatch(/flex-direction:\s*column/);
  });

  it('only the search box carries it', () => {
    routes();
    renderWith(<SearchTypeahead profile={profile()} />);
    const box = screen.getByRole('search');
    expect(styles.searchCombo).toBeTruthy();
    expect(styles.searchCombo).not.toBe(styles.combo);
    expect(box.classList.contains(styles.combo!)).toBe(true);
    expect(box.classList.contains(styles.searchCombo!)).toBe(true);
  });
});

describe('QuickFilterBar', () => {
  it('shows the six quick buttons + "All filters (N)" and saves only what changed in one PATCH', async () => {
    const net = routes();
    renderWith(<QuickFilterBar profile={profile({ filters: { titles: ['A'], workModels: ['remote'] } })} />);
    const bar = screen.getByRole('list', { name: 'Quick filters' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Location', 'Level', 'Job type', 'Work model', 'Date posted', 'Pay', 'All filters2All filters (2)']);
    expect(within(bar).getByRole('button', { name: 'Work model' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(bar).getByRole('button', { name: 'Level' }));
    const sheet = await screen.findByRole('dialog', { name: 'Level' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Entry level' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { seniority: ['entry'] } });
  });

  it('GoApply: the job-type quick sheet includes the hiring track', async () => {
    routes();
    renderWith(<QuickFilterBar profile={profile()} />, { brand: 'goapply' });
    fireEvent.click(screen.getByRole('button', { name: 'Job type' }));
    const sheet = await screen.findByRole('dialog', { name: 'Job type' });
    expect(within(sheet).getByRole('button', { name: 'Campus hiring' })).toBeInTheDocument();
  });
});

describe('ActiveFilterChips', () => {
  it('renders one chip per value with plain labels and removes one with a FilterSetPatch', async () => {
    const net = routes();
    renderWith(
      <ActiveFilterChips
        profile={profile({
          filters: {
            seniority: ['senior', 'mid'],
            excludedSkills: ['PHP'],
            salaryMin: { amount: 90000, currency: 'USD', period: 'year' },
            recruiterJobsOnly: true,
            includeUndisclosedPay: true,
            fitTier: 'great',
            classYear: 2027,
          },
        })}
      />,
    );
    const group = screen.getByRole('group', { name: 'Active filters' });
    const labels = within(group).getAllByRole('listitem').map((li) => li.textContent);
    expect(labels).toEqual(['Senior', 'Mid level', '$90,000 a year or more', 'Not PHP', 'Recruiter-posted only']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Senior' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { seniority: ['mid'] } });
  });

  it('renders nothing without filters', () => {
    routes();
    const { container } = renderWith(<ActiveFilterChips profile={profile({ filters: { fitTier: 'good' } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('FIX-3: a country with no city is ONE "Anywhere in United States" chip (never "US · Same city"); removing it clears both', async () => {
    const net = routes();
    // What onboarding stores for "Anywhere in United States".
    const filters = { country: 'US', locations: [{ label: 'US', country: 'US', radiusKm: 0 as const }], workModels: ['hybrid' as const] };
    renderWith(<ActiveFilterChips profile={profile({ filters })} />);
    const labels = within(screen.getByRole('group', { name: 'Active filters' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(labels).toEqual(['Hybrid', 'Anywhere in United States']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Anywhere in United States' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { locations: null, country: null } });
  });

  it('FIX-3: a city keeps its distance, and a whole country beside another country filter keeps both chips', () => {
    routes();
    const wrap = { excluded: (v: string) => v, only: (v: string) => v, quoted: (v: string) => v };
    const value = (_f: string, v: unknown) => (typeof v === 'string' ? v : (v as { label: string }).label);
    const chips = activeChips(
      { country: 'CA', locations: [{ label: 'US', country: 'US', radiusKm: 0 }, { label: 'Austin', city: 'Austin', country: 'US', radiusKm: 40 }] },
      [],
      { value },
      wrap,
    );
    expect(chips.map((c) => [c.field, c.label])).toEqual([['country', 'CA'], ['locations', 'US'], ['locations', 'Austin']]);
    expect(chips[1].remove).toEqual({ locations: [{ label: 'Austin', city: 'Austin', country: 'US', radiusKm: 40 }] });
  });

  it('FIX-3: a job-function chip waits for its name instead of showing the raw id, and takes the UI language', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    installFetch({
      'GET /api/v1/roboapply/taxonomy': async () => {
        await gate;
        return ok({ ...TAXONOMY_TREE, nodes: [...TAXONOMY_TREE.nodes, { id: 'swe_backend', level: 2, parent: 'software_engineering', label: 'Backend and platform' }] });
      },
    });
    renderWith(<ActiveFilterChips profile={profile({ filters: { taxonomyIds: ['swe_backend'], workModels: ['remote'] } })} />, {
      locale: 'ja',
      messages: { taxonomy: { groups: { swe_backend: 'バックエンド／プラットフォーム' } } },
    });
    const group = screen.getByRole('group', { name: 'Active filters' });
    expect(within(group).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Remote']);
    expect(screen.queryByText('swe_backend')).toBeNull();
    release();
    expect(await screen.findByText('バックエンド／プラットフォーム')).toBeInTheDocument();
    expect(screen.queryByText('Backend and platform')).toBeNull();
  });

  it('FIX-3: two chips removed in a row are both saved (the second waits for the first, on the new version)', async () => {
    let version = 3;
    let filters: Record<string, unknown> = { seniority: ['senior', 'mid'], workModels: ['remote'] };
    const net = installFetch({
      'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
      [`PATCH ${P}/sp_main`]: async (c) => {
        await new Promise((r) => setTimeout(r, 30));
        const body = c.body as { baseVersion: number; filtersPatch: Record<string, unknown> };
        if (body.baseVersion !== version) return fail(409, 'version_conflict', { profile: profile({ version, filters }) });
        version += 1;
        filters = { ...filters, ...body.filtersPatch };
        for (const k of Object.keys(filters)) if (filters[k] === null) delete filters[k];
        return ok(profile({ version, filters }));
      },
    });
    renderWith(<ActiveFilterChips profile={profile({ filters })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Senior' }));
    // The chip is gone at once and the next one can be removed straight away.
    expect(screen.queryByText('Senior')).toBeNull();
    const remote = screen.getByRole('button', { name: 'Remove filter: Remote' });
    expect(remote).toBeEnabled();
    fireEvent.click(remote);
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(2));
    expect(net.to('PATCH', `${P}/sp_main`).map((c) => c.body)).toEqual([
      { baseVersion: 3, filtersPatch: { seniority: ['mid'] } },
      { baseVersion: 4, filtersPatch: { workModels: null } },
    ]);
    await waitFor(() => expect(filters).toEqual({ seniority: ['mid'] }));
  });

  it('FIX-3: "Clear all" can be undone (it empties the saved search alerts use too)', async () => {
    __toastStore.set(() => []);
    const net = routes({ [`PATCH ${P}/sp_main`]: (c) => ok(profile({ version: 4 + net.to('PATCH', `${P}/sp_main`).length, filters: {} })) });
    const filters = { seniority: ['senior' as const], workModels: ['remote' as const], fitTier: 'good' as const };
    renderWith(<ActiveFilterChips profile={profile({ filters })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { workModels: null, seniority: null } });
    await waitFor(() => expect(__toastStore.get().map((x) => x.message)).toEqual(['Filters cleared.']));
    const undo = __toastStore.get()[0].action!;
    expect(undo.label).toBe('Undo');
    act(() => undo.onClick());
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(2));
    expect(net.to('PATCH', `${P}/sp_main`)[1].body).toEqual({ baseVersion: 5, filtersPatch: { workModels: ['remote'], seniority: ['senior'] } });
  });
});

describe('FitTierFilter', () => {
  it('offers the three views and says how many weaker fits are hidden, with "Show them."', async () => {
    const net = routes();
    renderWith(<FitTierFilter profile={profile({ filters: { fitTier: 'good' } })} hiddenCount={12} />);
    for (const name of ['Great fits only', 'Good fits and better', 'Everything']) expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Good fits and better' })).toBeChecked();
    expect(screen.getByText('Hiding 12 weaker fits.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show them.' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { fitTier: null } });
  });

  it('FIX-3: the chosen view shows at once and a second choice made before the first is saved is not lost', async () => {
    let version = 3;
    const net = installFetch({
      [`PATCH ${P}/sp_main`]: async (c) => {
        await new Promise((r) => setTimeout(r, 30));
        const body = c.body as { baseVersion: number; filtersPatch: { fitTier: 'great' | 'good' | null } };
        if (body.baseVersion !== version) return fail(409, 'version_conflict', { profile: profile({ version }) });
        version += 1;
        return ok(profile({ version, filters: body.filtersPatch.fitTier ? { fitTier: body.filtersPatch.fitTier } : {} }));
      },
    });
    renderWith(<FitTierFilter profile={profile()} hiddenCount={null} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Great fits only' }));
    expect(screen.getByRole('radio', { name: 'Great fits only' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Good fits and better' }));
    expect(screen.getByRole('radio', { name: 'Good fits and better' })).toBeChecked();
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(2));
    expect(net.to('PATCH', `${P}/sp_main`).map((c) => c.body)).toEqual([
      { baseVersion: 3, filtersPatch: { fitTier: 'great' } },
      { baseVersion: 4, filtersPatch: { fitTier: 'good' } },
    ]);
  });

  it('claims nothing when the hidden count is unknown', () => {
    routes();
    renderWith(<FitTierFilter profile={profile({ filters: { fitTier: 'great' } })} hiddenCount={null} />);
    expect(screen.queryByText(/Hiding/)).toBeNull();
  });
});

describe('SearchTypeahead', () => {
  it('waits for 2 characters and 300 ms, then suggests titles and companies; picking a title adds the role', async () => {
    const net = routes();
    renderWith(<SearchTypeahead profile={profile()} />);
    const input = screen.getByRole('combobox', { name: 'Search job titles or companies' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'b' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(net.calls.filter((c) => c.search.includes('q='))).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'ba' } });
    expect(await screen.findByRole('option', { name: /Backend engineer/ })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Acme/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Search for “ba”' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('option', { name: /Backend engineer/ }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { taxonomyIds: ['backend_engineer'], q: null } });
  });

  it('Enter searches the typed words', async () => {
    const net = routes();
    renderWith(<SearchTypeahead profile={profile()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'payments' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${P}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { q: 'payments' } });
  });
});

describe('SavedSearchSwitcher', () => {
  it('at the cap disables "Save as a new search" and shows the plan note with the Pro cap', () => {
    routes();
    const main = profile();
    renderWith(<SavedSearchSwitcher list={list([main])} active={main} />);
    expect(screen.getByRole('button', { name: 'Save as a new search' })).toBeDisabled();
    expect(screen.getByText('Your plan keeps up to 1 saved search.')).toBeInTheDocument();
    expect(screen.getByText('Pro keeps up to 10.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See Pro' })).toHaveAttribute('href', '/pricing');
  });

  it('switches the active search and saves the current filters as a new one', async () => {
    const other = profile({ id: 'sp_b', name: 'Data', isDefault: false, isActive: false });
    const main = profile({ filters: { titles: ['A'] } });
    const net = routes({
      [`POST ${P}/sp_b/activate`]: () => ok({ ...other, isActive: true }),
      [`POST ${P}`]: () => fail(403, 'forbidden', { reason: 'saved_search_limit', max: 2, upgradable: true }),
    });
    renderWith(<SavedSearchSwitcher list={list([main, other], { maxProfiles: 3 })} active={main} />);
    fireEvent.change(screen.getByLabelText('Saved search'), { target: { value: 'sp_b' } });
    await waitFor(() => expect(net.to('POST', `${P}/sp_b/activate`)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new search' }));
    fireEvent.change(screen.getByLabelText('Name this search'), { target: { value: 'Remote data' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(net.to('POST', P)[0].body).toEqual({ name: 'Remote data', filters: { titles: ['A'] }, activate: true });
    expect(await screen.findByText("You have reached your plan's limit for saved searches.")).toBeInTheDocument();
  });
});

describe('profile labels', () => {
  it('calls only the unnamed MAIN search "Your main search"; other unnamed searches are numbered', () => {
    routes();
    const main = profile({ name: '' });
    const unnamed = profile({ id: 'sp_c', name: '  ', isDefault: false, isActive: false });
    renderWith(<SavedSearchSwitcher list={list([main, unnamed], { maxProfiles: 10 })} active={main} />);
    const options = (screen.getByLabelText('Saved search') as HTMLSelectElement).options;
    expect([...options].map((o) => o.textContent)).toEqual(['Your main search · Main', 'Saved search 2']);
  });

  it('profileLabel prefers the name, then main, then the position, then a neutral fallback', () => {
    const labels = { main: 'M', numbered: (n: number) => `S${n}`, other: 'O' };
    expect(profileLabel({ id: 'a', name: 'Named', isDefault: false }, labels)).toBe('Named');
    expect(profileLabel({ id: 'a', name: '', isDefault: true }, labels)).toBe('M');
    expect(profileLabel({ id: 'b', name: '', isDefault: false }, labels, [{ id: 'a' }, { id: 'b' }])).toBe('S2');
    expect(profileLabel({ id: 'z', name: '', isDefault: false }, labels, [{ id: 'a' }])).toBe('O');
  });
});

describe('FilterDiff', () => {
  it('lists exactly what will be added, removed and changed', () => {
    routes();
    renderWith(
      <FilterDiff
        before={{ excludedCompanies: ['Acme'], workModels: ['remote'], postedWithinDays: 7 }}
        after={{ excludedCompanies: ['Acme', 'Initech'], postedWithinDays: 30, needsSponsorship: true }}
      />,
    );
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([
      'RemoveWork model: Remote',
      'ChangeDate posted: Past week → Past month',
      'AddVisa sponsorship: Needs sponsorship',
      'AddCompanies to leave out: Initech',
    ]);
  });

  it('FIX-3: a "No" to sponsorship is never listed as "Needs sponsorship" (the Assistant\'s "Your search now" card diffs against {})', () => {
    routes();
    renderWith(<FilterDiff before={{}} after={{ workModels: ['remote'], needsSponsorship: false, excludeAgencies: false, includeUndisclosedPay: false }} />);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['AddWork model: Remote', 'AddOnly jobs that list pay: Lists pay']);
    expect(screen.queryByText(/Needs sponsorship/)).toBeNull();
  });

  it('FIX-3: turning sponsorship off reads as that filter being removed, and a precomputed change to false says "No sponsorship needed"', () => {
    routes();
    const { unmount } = renderWith(<FilterDiff before={{ needsSponsorship: true }} after={{ needsSponsorship: false }} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['RemoveVisa sponsorship: any']);
    unmount();
    renderWith(<FilterDiff changes={[{ field: 'needsSponsorship', kind: 'added', to: false }]} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['AddVisa sponsorship: No sponsorship needed']);
  });

  it('says nothing changes for equal sets', () => {
    routes();
    renderWith(<FilterDiff before={{ titles: ['A'] }} after={{ titles: ['A'] }} />);
    expect(screen.getByText('Nothing changes.')).toBeInTheDocument();
  });
});

// ── Agent-driven redesign §6: one summary line, the controls on demand ──────

describe('summaryParts', () => {
  const labels = (n: number) => Array.from({ length: n }, (_, i) => `v${i + 1}`);

  it('names every value of a short search and counts nothing', () => {
    expect(summaryParts(['Product designer', 'Remote'])).toEqual({ shown: ['Product designer', 'Remote'], more: 0 });
    expect(summaryParts([])).toEqual({ shown: [], more: 0 });
  });

  it('names the first values of a long search and says how many more there are; one over the limit is simply named', () => {
    expect(summaryParts(labels(SUMMARY_MAX_VALUES + 1))).toEqual({ shown: labels(SUMMARY_MAX_VALUES + 1), more: 0 });
    expect(summaryParts(labels(SUMMARY_MAX_VALUES + 4))).toEqual({ shown: labels(SUMMARY_MAX_VALUES), more: 4 });
  });

  it('a label that has not loaded yet (empty) is not counted or named', () => {
    expect(summaryParts(['Remote', '', '  '])).toEqual({ shown: ['Remote'], more: 0 });
  });
});

describe('FilterBar: the search is one line until "Change search"', () => {
  const SEARCH = { titles: ['Product designer'], workModels: ['remote' as const, 'hybrid' as const], seniority: ['senior' as const], postedWithinDays: 30 as const };
  const withProfile = (filters: object, extra: Record<string, (c: RecordedCall) => Response> = {}) =>
    routes({ [`GET ${P}`]: () => ok(list([profile({ filters: filters as never })])), ...extra });
  const toggle = () => screen.getByRole('button', { name: 'Change search' });
  const summary = () => screen.getByTestId('search-summary');

  it('closed by default: the search in words, a disclosure button, and none of the search controls', async () => {
    withProfile(SEARCH);
    renderWith(<FilterBar />);
    await waitFor(() => expect(summary()).toHaveTextContent('Product designer · Remote · Hybrid · Senior · Past month'));
    // The same values the chips show, said once, with a prefix only a screen reader hears.
    expect(summary()).toHaveTextContent(/^Your search: Product designer/);
    const btn = toggle();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById(btn.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('hidden');
    expect(panel).toBeEmptyDOMElement();
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Quick filters' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull();
    expect(screen.queryByText('Your main search')).toBeNull();
  });

  it('the fit view and the caller\'s sort stay visible while closed, with "Hiding {n} weaker fits"', async () => {
    withProfile({ ...SEARCH, fitTier: 'good' });
    renderWith(<FilterBar hiddenWeakerFits={37} trailing={<label>Sort<select aria-label="Sort order" /></label>} />);
    expect(await screen.findByRole('radio', { name: 'Good fits and better' })).toBeChecked();
    expect(screen.getByText('Hiding 37 weaker fits.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show them.' })).toBeInTheDocument();
    expect(screen.getByLabelText('Sort order')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // The fit view is its own control, so it is not one of the words on the line.
    expect(summary()).not.toHaveTextContent('Good fits');
  });

  it('"Change search" shows every control in place; "Done" hides them and gives focus back to the button', async () => {
    withProfile(SEARCH);
    renderWith(<FilterBar />);
    await waitFor(() => expect(summary()).toHaveTextContent('Product designer'));
    const btn = toggle();
    btn.focus();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    // Opening leaves focus on the button (a disclosure): the controls are next in the tab order.
    expect(btn).toHaveFocus();
    const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(panel).not.toHaveAttribute('hidden');
    expect(within(panel).getByRole('search')).toBeInTheDocument();
    expect(within(panel).getByText('Your main search')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save as a new search' })).toBeInTheDocument();
    const quick = within(panel).getByRole('list', { name: 'Quick filters' });
    expect(within(quick).getAllByRole('button').map((b) => b.textContent)).toEqual(['Location', 'Level', 'Job type', 'Work model', 'Date posted', 'Pay', 'All filters4All filters (4)']);
    const chips = within(panel).getByRole('group', { name: 'Active filters' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Product designer', 'Remote', 'Hybrid', 'Senior', 'Past month']);
    // The line still says the search while the controls are open.
    expect(summary()).toHaveTextContent('Product designer · Remote · Hybrid · Senior · Past month');

    const done = within(panel).getByRole('button', { name: 'Done' });
    done.focus();
    fireEvent.click(done);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('hidden');
    expect(screen.queryByRole('search')).toBeNull();
    expect(btn).toHaveFocus();
  });

  it('the button also closes the controls it opened, and focus stays on it', async () => {
    withProfile(SEARCH);
    renderWith(<FilterBar />);
    await waitFor(() => expect(summary()).toHaveTextContent('Product designer'));
    const btn = toggle();
    btn.focus();
    fireEvent.click(btn);
    expect(screen.getByRole('search')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('search')).toBeNull();
    expect(btn).toHaveFocus();
  });

  it('stays open while it is used: removing a chip saves it, the line follows, and the controls are still there', async () => {
    let filters: Record<string, unknown> = { ...SEARCH };
    const net = routes({
      [`GET ${P}`]: () => ok(list([profile({ filters: filters as never })])),
      [`PATCH ${P}/sp_main`]: (c) => {
        const patch = (c.body as { filtersPatch: Record<string, unknown> }).filtersPatch;
        filters = Object.fromEntries(Object.entries({ ...filters, ...patch }).filter(([, v]) => v !== null));
        return ok(profile({ version: 4, filters: filters as never }));
      },
    });
    renderWith(<FilterBar />);
    await waitFor(() => expect(summary()).toHaveTextContent('Product designer'));
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Senior' }));
    await waitFor(() => expect(net.to('PATCH', `${P}/sp_main`)).toHaveLength(1));
    await waitFor(() => expect(summary()).toHaveTextContent(/^Your search: Product designer · Remote · Hybrid · Past month$/));
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Active filters' })).getAllByRole('listitem')).toHaveLength(4);
  });

  it('no filters reads "All jobs"; while the saved search is still loading nothing is claimed about it', async () => {
    let answer: (r: Response) => void = () => {};
    installFetch({ [`GET ${P}`]: () => new Promise<Response>((resolve) => (answer = resolve)) });
    renderWith(<FilterBar />);
    expect(summary()).toHaveTextContent('Loading your search…');
    expect(summary()).not.toHaveTextContent('All jobs');
    await act(async () => {
      answer(ok(list([profile({ filters: { fitTier: 'good' } })])));
    });
    await waitFor(() => expect(summary()).toHaveTextContent(/^Your search: All jobs$/));
  });

  it('a long search names its first values and how many more; all of them are chips once open', async () => {
    withProfile({ ...SEARCH, jobTypes: ['full_time', 'contract'], excludedSkills: ['PHP'], recruiterJobsOnly: true, excludeAgencies: true });
    renderWith(<FilterBar />);
    await waitFor(() => expect(summary()).toHaveTextContent(/^Your search: Product designer · Full-time · Contract · Remote · Hybrid · Senior · 4 more$/));
    fireEvent.click(toggle());
    expect(within(screen.getByRole('group', { name: 'Active filters' })).getAllByRole('listitem')).toHaveLength(10);
  });

  it('the caller can hold the state: `open` shows the controls, and the button and "Done" report the change', async () => {
    withProfile(SEARCH);
    const onOpenChange = vi.fn();
    const view = renderWith(<FilterBar open onOpenChange={onOpenChange} />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('group', { name: 'Active filters' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    // Controlled: nothing closes until the caller says so.
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    view.rerender(<FilterBar open={false} onOpenChange={onOpenChange} />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });
});
