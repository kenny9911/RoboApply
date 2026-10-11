// MKT-3D web (JI-3, JC-4): the admin company job boards panel after the market
// wave. One list for both sites; each row says where the board came from,
// which countries it is read for and its state; boards can be added many at a
// time from a CSV or JSON list. API calls are mocked (lib/api/careerSources);
// no network.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../../lib/api/client';
import type { CareerSourceView } from '../../../../../lib/api/careerSources';

vi.mock('../../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const api = vi.hoisted(() => ({
  adminListCareerSources: vi.fn(),
  adminCreateCareerSource: vi.fn(),
  adminUpdateCareerSource: vi.fn(),
  adminDeleteCareerSource: vi.fn(),
  adminRunCareerSource: vi.fn(),
  adminImportCareerSources: vi.fn(),
}));
vi.mock('../../../../../lib/api/careerSources', () => api);

import { CareerSourcesPanel, IMPORT_REASON_FALLBACK, PROBLEM_FALLBACK, boardReadUrl, countriesToAlsoFeed, importBody, offeredSystems, parseCountries, problemKey, stateKey } from '../CareerSourcesPanel';
import { BOARD_READ_URLS, BOARD_SYSTEMS, FLAG_GATED_SYSTEMS, PUBLIC_ATS_NAMES, boardSystemLabel } from '../meta';

function view(over: Partial<CareerSourceView> = {}): CareerSourceView {
  return {
    id: 'cs1',
    market: 'intl',
    ats: 'greenhouse',
    boardToken: 'formosarobotics',
    companyName: 'Formosa Robotics',
    companyId: null,
    countryCode: null,
    enabled: true,
    lastSyncedAt: '2026-10-10T00:00:00.000Z',
    lastJobCount: 12,
    lastError: null,
    origin: 'admin',
    discoveredFrom: null,
    countries: [],
    failCount: 0,
    lastChangeAt: null,
    nextSyncAt: null,
    disabledAt: null,
    state: 'enabled',
    ...over,
  };
}

const ROWS: CareerSourceView[] = [
  view(),
  view({ id: 'seed', companyName: 'Bosch Group', ats: 'smartrecruiters', boardToken: 'BoschGroup', origin: 'seed', countries: ['CN', 'TW'] }),
  view({ id: 'waiting', companyName: 'Acme', boardToken: 'acme', origin: 'discovered', discoveredFrom: 'jsearch:abc', enabled: false, state: 'candidate', lastSyncedAt: null, lastJobCount: null }),
  view({ id: 'missed', companyName: 'Other Corp', boardToken: 'othercorp', origin: 'import', enabled: false, state: 'candidate', lastError: 'validation:name_mismatch' }),
  view({ id: 'failed', companyName: 'Gone Co', boardToken: 'gone', origin: 'seed', enabled: false, state: 'disabled', failCount: 3, disabledAt: '2026-10-09T00:00:00.000Z', lastError: 'board_not_found' }),
  view({ id: 'off', companyName: 'Paused Co', boardToken: 'paused', enabled: false, state: 'disabled', disabledAt: '2026-10-09T00:00:00.000Z' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
  api.adminListCareerSources.mockResolvedValue({ items: ROWS, cursor: null });
});

const row = (name: RegExp) => screen.findByRole('row', { name });

describe('the list: where a board came from, what it is read for and its state', () => {
  it('shows the new columns', async () => {
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    for (const header of ['Added by', 'Countries read', 'State', 'Last problem']) expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
  });

  it('origin, countries and state in plain words; a candidate\'s check result as a sentence, never as a code', async () => {
    renderWithBrand(<CareerSourcesPanel />);
    const own = await row(/Formosa Robotics/);
    expect(within(own).getByText('An admin')).toBeInTheDocument();
    expect(within(own).getByText('Every country')).toBeInTheDocument();
    expect(within(own).getByText('On')).toBeInTheDocument();

    const seed = await row(/Bosch Group/);
    expect(within(seed).getByText('Starting list')).toBeInTheDocument();
    expect(within(seed).getByText('CN, TW')).toBeInTheDocument();

    const waiting = await row(/Acme/);
    expect(within(waiting).getByText("Found in a posting's link")).toBeInTheDocument();
    expect(within(waiting).getByText('Waiting for its first check')).toBeInTheDocument();
    // A candidate cannot be checked by hand before it is on, but it can be turned on.
    expect(within(waiting).getByRole('button', { name: 'Check now' })).toBeDisabled();
    expect(within(waiting).getByRole('button', { name: 'Turn on' })).toBeEnabled();

    const missed = await row(/Other Corp/);
    expect(within(missed).getByText('Import')).toBeInTheDocument();
    expect(within(missed).getByText('Not confirmed')).toBeInTheDocument();
    expect(within(missed).getByText('The board belongs to a company with a different name.')).toBeInTheDocument();

    const failed = await row(/Gone Co/);
    expect(within(failed).getByText('Off after 3 failed reads')).toBeInTheDocument();
    expect(within(failed).getByText('The board was not found. Check the board id.')).toBeInTheDocument();

    expect(within(await row(/Paused Co/)).getByText('Off')).toBeInTheDocument();
    expect(screen.queryByText(/validation:|name_mismatch|board_not_found|jsearch:abc/)).toBeNull();
  });

  it('stateKey: on, waiting, not confirmed, off, off after failures; a row without the new fields still reads on or off', () => {
    expect(ROWS.map(stateKey)).toEqual(['on', 'on', 'waiting', 'notConfirmed', 'offAfterFailures', 'off']);
    expect(stateKey({ enabled: true } as never)).toBe('on');
    expect(stateKey({ enabled: false } as never)).toBe('off');
    // A candidate whose check failed because the board was busy is tried again: still waiting, not "not confirmed".
    expect(stateKey(view({ enabled: false, state: 'candidate', lastError: 'validation:http_503', lastSyncedAt: null, failCount: 1 }))).toBe('waiting');
    // Once the retries are used up the check has a time and a result.
    expect(stateKey(view({ enabled: false, state: 'candidate', lastError: 'validation:http_503', lastSyncedAt: '2026-10-10T03:00:00.000Z', failCount: 3 }))).toBe('notConfirmed');
  });

  it('turning a candidate on sends enabled true', async () => {
    api.adminUpdateCareerSource.mockResolvedValue(view({ id: 'waiting', state: 'enabled' }));
    renderWithBrand(<CareerSourcesPanel />);
    fireEvent.click(within(await row(/Acme/)).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.adminUpdateCareerSource).toHaveBeenCalledWith('waiting', { enabled: true }));
  });
});

describe('adding one board with the countries it is read for', () => {
  it('sends the countries as upper-case codes; none when the field is empty', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    api.adminCreateCareerSource.mockResolvedValue(view());
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Job board system'), { target: { value: 'smartrecruiters' } });
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'BoschGroup' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Bosch' } });
    fireEvent.change(screen.getByLabelText('Countries to read (optional)'), { target: { value: 'tw, cn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    await waitFor(() => expect(api.adminCreateCareerSource).toHaveBeenCalledWith({ ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch', countries: ['TW', 'CN'] }));
  });

  it('does not send a country that is not a two-letter code', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Countries to read (optional)'), { target: { value: 'Taiwan' } });
    expect(screen.getByRole('button', { name: 'Add board' })).toBeDisabled();
    expect(screen.getByLabelText('Countries to read (optional)')).toHaveAttribute('aria-invalid', 'true');
    expect(parseCountries('tw; CN | tw')).toEqual(['TW', 'CN']);
    expect(parseCountries('')).toEqual([]);
    expect(parseCountries('TWN')).toBeNull();
  });
});

describe('a board that is in the list but read only for the other site\'s countries', () => {
  const conflict = (details: Record<string, unknown>) =>
    new RoboApiError('x', { status: 409, code: 'conflict', payload: { success: false, code: 'conflict', error: 'x', details: { field: 'boardToken', reason: 'board_read_for_other_countries', ...details } } });

  async function addBoard(token: string, company: string, countries = '') {
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: token } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: company } });
    if (countries) fireEvent.change(screen.getByLabelText('Countries to read (optional)'), { target: { value: countries } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
  }

  it('says why it does not show here and offers the one action that helps: read it for this site too', async () => {
    api.adminCreateCareerSource.mockRejectedValue(conflict({ id: 'cs-cn', countries: ['CN'], market: 'intl' }));
    api.adminUpdateCareerSource.mockResolvedValue(view({ id: 'cs-cn', companyName: 'Mainland Co', countries: ['CN', 'TW'] }));
    await addBoard('MainlandCo', 'Mainland Co', 'tw');
    expect(await screen.findByRole('alert')).toHaveTextContent('This board is already in the list, but it is read for other countries, so it does not show here.');
    // The sentence no longer sends the admin to a screen that does not exist.
    expect(screen.queryByText(/other site's boards/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read it for this site too' }));
    // Its countries are widened by the ones in the form; nothing else about the board is sent.
    await waitFor(() => expect(api.adminUpdateCareerSource).toHaveBeenCalledWith('cs-cn', { countries: ['CN', 'TW'] }));
    expect(await screen.findByText('Mainland Co is now read for this site too. Its jobs will be added within a few minutes.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read it for this site too' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Board id')).toHaveValue('');
  });

  it('on the mainland site the board is read for CN as well; with no countries in the form it is read for every country', async () => {
    api.adminCreateCareerSource.mockRejectedValue(conflict({ id: 'cs-us', countries: ['US'], market: 'cn' }));
    api.adminUpdateCareerSource.mockResolvedValue(view({ id: 'cs-us', companyName: 'US Only' }));
    await addBoard('usonly', 'US Only');
    fireEvent.click(await screen.findByRole('button', { name: 'Read it for this site too' }));
    await waitFor(() => expect(api.adminUpdateCareerSource).toHaveBeenCalledWith('cs-us', { countries: [] }));
  });

  it('the offer is about the board that was typed: it goes away when the board id changes, and a failed update says so', async () => {
    api.adminCreateCareerSource.mockRejectedValue(conflict({ id: 'cs-cn', countries: ['CN'], market: 'intl' }));
    await addBoard('MainlandCo', 'Mainland Co');
    await screen.findByRole('button', { name: 'Read it for this site too' });
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'AnotherCo' } });
    expect(screen.queryByRole('button', { name: 'Read it for this site too' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    api.adminUpdateCareerSource.mockRejectedValue(new RoboApiError('x', { status: 500, code: 'internal', payload: { success: false, code: 'internal', error: 'x' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read it for this site too' }));
    await waitFor(() => expect(api.adminUpdateCareerSource).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Read it for this site too' })).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('countriesToAlsoFeed: what the board is read for now plus what was asked for; an empty list is every country and wins; this site is never left out', () => {
    expect(countriesToAlsoFeed(['CN'], ['TW'], 'intl')).toEqual(['CN', 'TW']);
    expect(countriesToAlsoFeed(['CN'], [], 'intl')).toEqual([]);
    expect(countriesToAlsoFeed(['CN'], ['CN'], 'intl')).toEqual([]);
    expect(countriesToAlsoFeed(['US'], ['CN'], 'cn')).toEqual(['CN', 'US']);
    expect(countriesToAlsoFeed(['US'], [], 'cn')).toEqual([]);
    expect(countriesToAlsoFeed(['TW'], ['US'], 'cn')).toEqual(['CN', 'TW', 'US']);
    expect(countriesToAlsoFeed([], ['TW'], 'intl')).toEqual([]);
  });
});

describe('adding many boards', () => {
  const CSV = 'ats,boardToken,companyName,countries\ngreenhouse,acme,Acme,\nsmartrecruiters,BoschGroup,Bosch,TW|CN\ngreenhouse,bad token,Bad,';

  it('a pasted CSV is sent as it is; the summary says what was added, what was already there and which rows were not added, with the reason in plain words', async () => {
    api.adminImportCareerSources.mockResolvedValue({ total: 3, created: 1, merged: 1, invalid: [{ line: 4, reason: 'invalid_board_id' }], invalidCount: 1 });
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    fireEvent.change(screen.getByLabelText('List of boards'), { target: { value: CSV } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api.adminImportCareerSources).toHaveBeenCalledWith({ format: 'csv', csv: CSV, enable: false }));
    expect(await screen.findByText('3 rows read: 1 added, 1 already in the list, 1 not added.')).toBeInTheDocument();
    expect(screen.getByText('Row 4: the board id has characters a board id cannot have')).toBeInTheDocument();
    expect(screen.queryByText(/invalid_board_id/)).toBeNull();
    // The list is read again, and the box is cleared for the next list.
    await waitFor(() => expect(api.adminListCareerSources).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('List of boards')).toHaveValue('');
  });

  it('a pasted JSON list is sent as rows; "turn on right away" is sent as enable', async () => {
    api.adminImportCareerSources.mockResolvedValue({ total: 2, created: 2, merged: 0, invalid: [], invalidCount: 0 });
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    const rows = [{ ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud' }, { ats: 'ashby', boardToken: 'islandlabs', countries: ['TW'] }];
    fireEvent.change(screen.getByLabelText('List of boards'), { target: { value: JSON.stringify(rows) } });
    fireEvent.click(screen.getByLabelText('Turn the new boards on right away'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api.adminImportCareerSources).toHaveBeenCalledWith({ format: 'json', rows, enable: true }));
    expect(await screen.findByText('2 rows read: 2 added, 0 already in the list, 0 not added.')).toBeInTheDocument();
    expect(screen.queryByText('Rows that were not added')).toBeNull();
  });

  it('a chosen file fills the box', async () => {
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    const file = new File([CSV], 'boards.csv', { type: 'text/csv' });
    if (typeof file.text !== 'function') Object.defineProperty(file, 'text', { value: async () => CSV });
    fireEvent.change(screen.getByLabelText('Or choose a CSV or JSON file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('List of boards')).toHaveValue(CSV));
  });

  it('says how many more rows were not added when the answer lists only the first 100', async () => {
    api.adminImportCareerSources.mockResolvedValue({
      total: 200,
      created: 50,
      merged: 0,
      invalid: Array.from({ length: 100 }, (_, i) => ({ line: i + 2, reason: 'unknown_job_board' })),
      invalidCount: 150,
    });
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    fireEvent.change(screen.getByLabelText('List of boards'), { target: { value: 'ats,boardToken\nworkday,x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('200 rows read: 50 added, 0 already in the list, 150 not added.')).toBeInTheDocument();
    expect(screen.getByText('Row 2: this job board system is not supported')).toBeInTheDocument();
    expect(screen.getByText('And 50 more rows.')).toBeInTheDocument();
  });

  it('nothing is sent for an empty box or a JSON list that cannot be read; a refused list says so', async () => {
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste a list or choose a file first.');
    fireEvent.change(screen.getByLabelText('List of boards'), { target: { value: '[{"ats": "lever",' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The list could not be read as JSON.');
    expect(api.adminImportCareerSources).not.toHaveBeenCalled();

    api.adminImportCareerSources.mockRejectedValue(new RoboApiError('x', { status: 422, code: 'invalid_request', payload: { success: false, code: 'invalid_request', error: 'x' } }));
    fireEvent.change(screen.getByLabelText('List of boards'), { target: { value: 'company,id\nAcme,acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('The list could not be read. Check the first line and try again.')).toBeInTheDocument();
  });

  it('importBody: JSON when the text starts with a bracket, else CSV; too large is refused before it is sent', () => {
    expect(importBody('  ', false)).toBe('empty');
    expect(importBody('ats,boardToken\ngreenhouse,acme\n', true)).toEqual({ format: 'csv', csv: 'ats,boardToken\ngreenhouse,acme', enable: true });
    expect(importBody('[{"ats":"lever","boardToken":"x"}]', false)).toEqual({ format: 'json', rows: [{ ats: 'lever', boardToken: 'x' }], enable: false });
    expect(importBody('{"rows":[{"ats":"lever","boardToken":"x"}]}', false)).toEqual({ format: 'json', rows: [{ ats: 'lever', boardToken: 'x' }], enable: false });
    expect(importBody('{"boards": 3}', false)).toBe('json');
    expect(importBody('[1,', false)).toBe('json');
    expect(importBody(JSON.stringify(Array.from({ length: 5001 }, () => ({ ats: 'lever', boardToken: 'x' }))), false)).toBe('tooLarge');
    expect(importBody(`ats,boardToken\n${'x'.repeat(1_000_001)}`, false)).toBe('tooLarge');
  });
});

describe('the page at a glance', () => {
  it('says how often boards are read and that a posting lands on the site of its country', async () => {
    renderWithBrand(<CareerSourcesPanel />);
    await row(/Formosa Robotics/);
    expect(screen.getByText(/A board that changed lately is read every 2 hours/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add many boards' })).toBeInTheDocument();
    // The column names of the file are shown as they must be typed.
    expect(screen.getByText(/first line is ats,boardToken,companyName,countries \(countries separated by \|\)/)).toBeInTheDocument();
  });

  it('renders the same for the GoApply brand', async () => {
    renderWithBrand(<CareerSourcesPanel market="cn" />, { brand: 'goapply' });
    await row(/Formosa Robotics/);
    expect(api.adminListCareerSources).toHaveBeenCalledWith({ market: 'cn' });
    expect(screen.getByRole('heading', { name: 'Add many boards' })).toBeInTheDocument();
  });
});

// ── MKT-5B (JI-8, JC-8): more job-board systems ──────────────────────────

describe('MKT-5B: the systems offered when adding a board come from the contract mirror', () => {
  const options = () => within(screen.getByLabelText('Job board system')).getAllByRole('option').map((o) => [(o as HTMLOptionElement).value, o.textContent]);

  it('a server that does not say which systems it reads gets every system offered, the new ones included', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    expect(options()).toEqual([
      ['greenhouse', 'Greenhouse'],
      ['lever', 'Lever'],
      ['ashby', 'Ashby'],
      ['smartrecruiters', 'SmartRecruiters'],
      ['workable', 'Workable'],
      ['recruitee', 'Recruitee'],
      ['personio', 'Personio'],
      ['lever_eu', 'Lever (EU)'],
      ['beisen', '北森'],
    ]);
    // The list is the mirror's: nothing in the panel names a system.
    expect(options().map(([value]) => value)).toEqual(BOARD_SYSTEMS);
    expect(Object.keys(PUBLIC_ATS_NAMES)).toEqual(BOARD_SYSTEMS);
    expect(Object.keys(BOARD_READ_URLS)).toEqual(BOARD_SYSTEMS);
  });

  it('a server that names the systems it can read gets only those offered: 北森 is not offered while its connector is off', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null, systems: ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu'] });
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    await waitFor(() => expect(options().map(([value]) => value)).toEqual(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu']));
    // The sentence that says where boards can come from names the offered systems, each vendor once.
    expect(screen.getByText('Boards can come from: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio.')).toBeInTheDocument();
    expect(screen.queryByText(/北森/)).not.toBeInTheDocument();
    expect(offeredSystems({ systems: ['workable', 'greenhouse', 'unknown'] })).toEqual(['greenhouse', 'workable']);
    // An answer without the field (a server that does not say): every system.
    expect(offeredSystems({ items: [] })).toEqual(BOARD_SYSTEMS);
    // An answer that names none we know is treated as not saying.
    expect(offeredSystems({ systems: [] })).toEqual(BOARD_SYSTEMS);
  });

  it('before the list answer is there, and when the request failed, a system read only behind a flag is neither offered nor named (review finding)', async () => {
    const withoutFlagged = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu'];
    expect(FLAG_GATED_SYSTEMS).toEqual(['beisen']);
    expect(offeredSystems(undefined)).toEqual(withoutFlagged);
    expect(offeredSystems(null)).toEqual(withoutFlagged);
    // Still loading: the request never answers.
    api.adminListCareerSources.mockReturnValue(new Promise(() => undefined));
    const loading = renderWithBrand(<CareerSourcesPanel />);
    expect(await screen.findByLabelText('Job board system')).toBeInTheDocument();
    expect(options().map(([value]) => value)).toEqual(withoutFlagged);
    expect(screen.getByText('Boards can come from: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio.')).toBeInTheDocument();
    expect(screen.queryByText(/北森/)).not.toBeInTheDocument();
    loading.unmount();
    // The request failed.
    api.adminListCareerSources.mockRejectedValue(new Error('offline'));
    renderWithBrand(<CareerSourcesPanel />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(options().map(([value]) => value)).toEqual(withoutFlagged);
    expect(screen.queryByText(/北森/)).not.toBeInTheDocument();
  });

  it('once the server says it reads 北森 (its flag is on), the system is offered', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null, systems: [...BOARD_SYSTEMS] });
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    await waitFor(() => expect(options().map(([value]) => value)).toEqual(BOARD_SYSTEMS));
    expect(options().at(-1)).toEqual(['beisen', '北森']);
  });

  it('adds a board of a new system with the id it reads from, and shows the address before saving', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    api.adminCreateCareerSource.mockResolvedValue(view({ id: 'p1', ats: 'personio' as never, boardToken: 'alpenwerk', companyName: 'Alpenwerk' }));
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Job board system'), { target: { value: 'personio' } });
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'alpenwerk' } });
    expect(screen.getByText(/Reads https:\/\/alpenwerk\.jobs\.personio\.de\/xml\?language=en/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Alpenwerk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    await waitFor(() => expect(api.adminCreateCareerSource).toHaveBeenCalledWith({ ats: 'personio', boardToken: 'alpenwerk', companyName: 'Alpenwerk' }));
  });

  it('boardReadUrl mirrors the server connectors for every system', () => {
    expect(boardReadUrl('workable', 'tidewater')).toBe('https://apply.workable.com/api/v1/widget/accounts/tidewater?details=true');
    expect(boardReadUrl('recruitee', 'poldermobility')).toBe('https://poldermobility.recruitee.com/api/offers/');
    expect(boardReadUrl('personio', 'alpenwerk')).toBe('https://alpenwerk.jobs.personio.de/xml?language=en');
    expect(boardReadUrl('personio', 'alpenwerk.com')).toBe('https://alpenwerk.jobs.personio.com/xml?language=en');
    expect(boardReadUrl('lever_eu', 'nordwind')).toBe('https://api.eu.lever.co/v0/postings/nordwind?mode=json');
    expect(boardReadUrl('beisen', 'shili')).toBe('https://shili.zhiye.com/api/Jobad/GetJobAdPageList');
    // The four older systems are unchanged.
    expect(boardReadUrl('greenhouse', 'acme')).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    expect(boardReadUrl('lever', 'acme')).toBe('https://api.lever.co/v0/postings/acme?mode=json');
    expect(boardSystemLabel('lever_eu')).toBe('Lever (EU)');
    expect(boardSystemLabel('lever')).toBe('Lever');
  });

  it('a row of a new system shows its name; a row of a system this build does not know shows the id as stored', async () => {
    api.adminListCareerSources.mockResolvedValue({
      items: [
        view({ id: 'w', companyName: 'Tidewater', ats: 'workable' as never, boardToken: 'tidewater' }),
        view({ id: 'e', companyName: 'Nordwind', ats: 'lever_eu' as never, boardToken: 'nordwind' }),
        view({ id: 'x', companyName: 'Unknown Co', ats: 'futureats' as never, boardToken: 'x' }),
      ],
      cursor: null,
    });
    renderWithBrand(<CareerSourcesPanel />);
    expect(within(await row(/Tidewater/)).getByText('Workable')).toBeInTheDocument();
    expect(within(await row(/Nordwind/)).getByText('Lever (EU)')).toBeInTheDocument();
    expect(within(await row(/Unknown Co/)).getByText('futureats')).toBeInTheDocument();
  });
});

describe('MKT-5B: a system whose connector is switched off', () => {
  const switchedOff = () =>
    new RoboApiError('x', { status: 422, code: 'invalid_request', payload: { success: false, code: 'invalid_request', error: 'x', details: { field: 'ats', reason: 'connector_disabled' } } });

  it('adding a board of it says that this system cannot be read, not that the fields are wrong', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    api.adminCreateCareerSource.mockRejectedValue(switchedOff());
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Job board system'), { target: { value: 'workable' } });
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'tidewater' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Tidewater' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    // The sentence of its own (staged by MKT-5F in jobsTw.admin.problem); before it existed the panel fell back to "not supported".
    expect(await screen.findByRole('alert')).toHaveTextContent('This job board system is switched off here, so the board is not read.');
    expect(screen.queryByText('Check the fields and try again.')).not.toBeInTheDocument();
  });

  it('a board that is passed over reads as a sentence, never as a code; an import row of a switched-off system gives its reason', async () => {
    api.adminListCareerSources.mockResolvedValue({
      items: [view({ id: 'w', companyName: 'Tidewater', ats: 'workable' as never, boardToken: 'tidewater', lastError: 'connector_disabled' }), view({ id: 'p', companyName: 'Alpenwerk', ats: 'personio' as never, boardToken: 'alpenwerk', lastError: 'not_xml' })],
      cursor: null,
    });
    api.adminImportCareerSources.mockResolvedValue({ total: 2, created: 1, merged: 0, invalid: [{ line: 1, reason: 'connector_disabled' }], invalidCount: 1 });
    renderWithBrand(<CareerSourcesPanel />);
    expect(within(await row(/Tidewater/)).getByText('This job board system is switched off here, so the board is not read.')).toBeInTheDocument();
    expect(within(await row(/Alpenwerk/)).getByText('The board sent something other than job data.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('List of boards'), { target: { value: '[{"ats":"beisen","boardToken":"shili"},{"ats":"recruitee","boardToken":"polder"}]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Row 1: this job board system is switched off here')).toBeInTheDocument();
    expect(screen.queryByText(/connector_disabled|not_xml|import\.reason|problem\./)).toBeNull();
  });

  it('every new code has a key, and a key without a sentence of its own yet falls back to one that exists', () => {
    expect(problemKey('connector_disabled')).toBe('connector_disabled');
    expect(problemKey('tenant_denied')).toBe('tenant_denied');
    expect(problemKey('tenant_floor')).toBe('tenant_floor');
    expect(problemKey('not_xml')).toBe('not_json');
    expect(problemKey('invalid_board_id')).toBe('board_not_found');
    expect(problemKey('validation:connector_disabled')).toBe('connector_disabled');
    expect(PROBLEM_FALLBACK).toEqual({ connector_disabled: 'unsupported_job_board', tenant_denied: 'unsupported_job_board', tenant_floor: 'rate_limited' });
    expect(IMPORT_REASON_FALLBACK).toEqual({ connector_disabled: 'unknown_job_board' });
  });
});
