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

import { CareerSourcesPanel, countriesToAlsoFeed, importBody, parseCountries, stateKey } from '../CareerSourcesPanel';

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
