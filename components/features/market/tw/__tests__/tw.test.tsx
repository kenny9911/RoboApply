// WP-42 web: Taiwan job meta (面議 kept verbatim, Art. 5 note that never
// claims an amount, permit tags only with quotes) and the admin company job
// boards panel. API calls are mocked (lib/api/careerSources); no network.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../../__tests__/utils/mockAuth';
import { RoboApiError } from '../../../../../lib/api/client';

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
}));
vi.mock('../../../../../lib/api/careerSources', () => api);

import { MarketJobMeta } from '../..';
import { boardReadUrl, CareerSourcesPanel, JobMetaTw, NegotiablePayNote, readTwMeta, TW_PAY_LAW_URL } from '..';
import { problemKey } from '../CareerSourcesPanel';

const META = {
  ats_public: {
    country: 'TW',
    // What the server's cardMeta sends for a typical 104-style posting.
    pay: { text: '待遇面議', posted: '待遇面議（經常性薪資達4萬元或以上）', disclosed: false, negotiable: true },
    permitTags: [
      { tag: 'tw_work_permit_support', quote: '本公司可協助申請工作許可。' },
      { tag: 'tw_gold_card', quote: '' },
      { tag: 'made_up_tag', quote: 'x' },
    ],
    source: { name: 'Formosa Robotics · Greenhouse', url: 'https://boards.greenhouse.io/formosarobotics/jobs/1', board: 'greenhouse' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
});

describe('readTwMeta', () => {
  it('keeps only quoted, known permit tags and safe links', () => {
    const tw = readTwMeta(META)!;
    expect(tw.permitTags).toEqual([{ tag: 'tw_work_permit_support', quote: '本公司可協助申請工作許可。' }]);
    expect(tw.source.url).toBe('https://boards.greenhouse.io/formosarobotics/jobs/1');
    expect(readTwMeta({ ats_public: { ...META.ats_public, source: { url: 'javascript:alert(1)' } } })!.source.url).toBeNull();
    expect(readTwMeta({ ats_public: { ...META.ats_public, pay: { text: '面議', disclosed: true, negotiable: true } } })!.pay.negotiable).toBe(false);
  });

  it('is null for non-Taiwan or missing meta', () => {
    expect(readTwMeta(null)).toBeNull();
    expect(readTwMeta({ ats_public: { country: 'US' } })).toBeNull();
    expect(readTwMeta({ cn: { classYears: [2027] } })).toBeNull();
  });
});

describe('JobMetaTw', () => {
  it('card: pay as posted (面議 kept) and the permit tag; the Art. 5 floor never appears', () => {
    const { container } = renderWithBrand(<JobMetaTw jobId="j1" meta={META} variant="card" />);
    expect(screen.getByText('Pay as posted: 待遇面議')).toBeInTheDocument();
    expect(screen.getByText('Helps with the work permit')).toBeInTheDocument();
    expect(screen.queryByText('Mentions the Employment Gold Card')).toBeNull();
    expect(container.textContent).not.toMatch(/4\s*[萬万]|四\s*[萬万]|40,?000|NT\$/);
  });

  it('detail: the quote, the source link and the Art. 5 note that is explicitly not this job’s pay', () => {
    renderWithBrand(<JobMetaTw jobId="j1" meta={META} variant="detail" />);
    const region = screen.getByRole('region', { name: 'Pay and work permits' });
    expect(within(region).getByText('本公司可協助申請工作許可。').tagName).toBe('BLOCKQUOTE');
    expect(within(region).getByText('Source: Formosa Robotics · Greenhouse')).toBeInTheDocument();
    // The full wording only here, labelled as the posting's own words, next to the note.
    expect(within(region).getByText('Pay as posted: 待遇面議')).toBeInTheDocument();
    expect(within(region).getByText("The posting's own words: 待遇面議（經常性薪資達4萬元或以上）")).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Open the original posting' })).toHaveAttribute('href', 'https://boards.greenhouse.io/formosarobotics/jobs/1');
    fireEvent.click(within(region).getByText('Why is pay not listed?'));
    expect(within(region).getByText(/Article 5, lets an employer leave pay unlisted only when the regular monthly wage is NT\$40,000 or more/)).toBeInTheDocument();
    expect(within(region).getByText(/It is not this job's pay/)).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Read Article 5 in the national law database' })).toHaveAttribute('href', TW_PAY_LAW_URL);
  });

  it('renders nothing for a Taiwan job with listed pay and no permit tags, or with no meta', () => {
    const plain = {
      ats_public: { ...META.ats_public, pay: { text: 'NT$55,000 - NT$75,000', posted: 'NT$55,000 - NT$75,000', disclosed: true, negotiable: false }, permitTags: [] },
    };
    const a = renderWithBrand(<JobMetaTw jobId="j2" meta={plain} variant="detail" />);
    expect(a.container).toBeEmptyDOMElement();
    const b = renderWithBrand(<JobMetaTw jobId="j3" meta={null} variant="card" />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it('reaches RoboApply cards through MarketJobMeta', () => {
    renderWithBrand(<MarketJobMeta jobId="j1" meta={META} variant="card" />, { brand: 'roboapply' });
    expect(screen.getByText('Pay as posted: 待遇面議')).toBeInTheDocument();
  });

  it('the filter note adds the toggle hint', () => {
    renderWithBrand(<NegotiablePayNote context="filter" />);
    expect(screen.getByText(/Turn on “Only jobs that list pay” to hide them/)).toBeInTheDocument();
  });
});

// ── Admin panel ──────────────────────────────────────────────────────────

const ROW = {
  id: 'cs1',
  market: 'intl',
  ats: 'greenhouse',
  boardToken: 'formosarobotics',
  companyName: 'Formosa Robotics',
  companyId: null,
  countryCode: 'TW',
  enabled: true,
  lastSyncedAt: null,
  lastJobCount: null,
  lastError: 'board_not_found',
};

describe('CareerSourcesPanel', () => {
  it('is admin-only', () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'seeker' }) });
    renderWithBrand(<CareerSourcesPanel />);
    expect(screen.getByText('Only admins can see this page.')).toBeInTheDocument();
    expect(api.adminListCareerSources).not.toHaveBeenCalled();
  });

  it('lists boards with their state and last problem', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [ROW], cursor: null });
    renderWithBrand(<CareerSourcesPanel />);
    const row = await screen.findByRole('row', { name: /Formosa Robotics/ });
    expect(api.adminListCareerSources).toHaveBeenCalledWith({ market: 'intl' });
    expect(within(row).getByText('Greenhouse')).toBeInTheDocument();
    expect(within(row).getByText('Not checked yet')).toBeInTheDocument();
    expect(within(row).getByText('The board was not found. Check the board id.')).toBeInTheDocument();
    expect(within(row).getByText('On')).toBeInTheDocument();
  });

  it('adds a board and shows the URL it will read', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    api.adminCreateCareerSource.mockResolvedValue({ ...ROW, id: 'cs2', ats: 'lever', boardToken: 'pinecloud' });
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Job board system'), { target: { value: 'lever' } });
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'pinecloud' } });
    expect(screen.getByText(/Reads https:\/\/api\.lever\.co\/v0\/postings\/pinecloud\?mode=json/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Pine Cloud' } });
    fireEvent.change(screen.getByLabelText('Main hiring country (optional)'), { target: { value: 'tw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    await waitFor(() =>
      expect(api.adminCreateCareerSource).toHaveBeenCalledWith({ ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud', countryCode: 'TW' }),
    );
  });

  it('shows a plain message for a duplicate board', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    api.adminCreateCareerSource.mockRejectedValue(new RoboApiError('x', { status: 409, code: 'conflict', payload: { success: false, code: 'conflict', error: 'x' } }));
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'formosarobotics' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Formosa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This board is already in the list.');
  });

  // PAR gate (PAR-7 request): the 14 boards seeded for the mainland site cannot be added here,
  // and they are not in this list, so the duplicate sentence would be untrue.
  it('says so when the other site already reads the board (409 with reason board_on_other_site)', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    api.adminCreateCareerSource.mockRejectedValue(
      new RoboApiError('x', { status: 409, code: 'conflict', payload: { success: false, code: 'conflict', error: 'x', details: { field: 'boardToken', reason: 'board_on_other_site' } } }),
    );
    renderWithBrand(<CareerSourcesPanel />);
    await screen.findByText('No company job boards yet.');
    fireEvent.change(screen.getByLabelText('Board id'), { target: { value: 'BoschGroup' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Bosch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This board is already read for the other site, so it cannot be added here.');
    expect(alert).not.toHaveTextContent('already in the list');
  });

  it('check now reports what the board lists; turn off and remove (after confirming)', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [ROW], cursor: null });
    api.adminRunCareerSource.mockResolvedValue({ sourceId: 'cs1', status: 'scheduled', listed: 2, queued: true, error: null });
    api.adminUpdateCareerSource.mockResolvedValue({ ...ROW, enabled: false });
    api.adminDeleteCareerSource.mockResolvedValue({ archivedJobs: 2 });
    renderWithBrand(<CareerSourcesPanel />);
    const row = await screen.findByRole('row', { name: /Formosa Robotics/ });

    fireEvent.click(within(row).getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Formosa Robotics: the board lists 2 jobs. They are being added to the job list now.')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.adminUpdateCareerSource).toHaveBeenCalledWith('cs1', { enabled: false }));

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(api.adminDeleteCareerSource).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Remove for good' }));
    await waitFor(() => expect(api.adminDeleteCareerSource).toHaveBeenCalledWith('cs1'));
  });

  it('a board that cannot be read is reported, not hidden', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [ROW], cursor: null });
    api.adminRunCareerSource.mockResolvedValue({ sourceId: 'cs1', status: 'error', listed: 0, queued: false, error: 'board_not_found' });
    renderWithBrand(<CareerSourcesPanel />);
    const row = await screen.findByRole('row', { name: /Formosa Robotics/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Formosa Robotics: the board could not be read. The board was not found. Check the board id.')).toBeInTheDocument();
    expect(screen.queryByText(/board_not_found/)).toBeNull();
  });

  it('the last problem is shown in plain words, never as an error code', async () => {
    api.adminListCareerSources.mockResolvedValue({ items: [{ ...ROW, lastError: 'http_503' }, { ...ROW, id: 'cs2', companyName: 'Pine Cloud', lastError: 'network:ECONNRESET' }], cursor: null });
    renderWithBrand(<CareerSourcesPanel />);
    const row = await screen.findByRole('row', { name: /Formosa Robotics/ });
    expect(within(row).getByText('The job board system had a problem. It will be tried again later.')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Pine Cloud/ })).getByText('The board could not be reached.')).toBeInTheDocument();
    expect(screen.queryByText(/http_503|ECONNRESET/)).toBeNull();
  });

  it('problemKey maps every server error code to a plain key', () => {
    expect(['board_not_found', 'timeout', 'not_json', 'unexpected_shape', 'unsupported_job_board', 'redirect', 'response_too_large'].map(problemKey)).toEqual([
      'board_not_found',
      'timeout',
      'not_json',
      'unexpected_shape',
      'unsupported_job_board',
      'redirect',
      'response_too_large',
    ]);
    expect(['http_429', 'http_500', 'http_403', 'network', 'network:x', 'unexpected:boom', 'host_not_allowed:x'].map(problemKey)).toEqual([
      'rate_limited',
      'server_error',
      'refused',
      'network',
      'network',
      'other',
      'other',
    ]);
  });

  it('boardReadUrl mirrors the server connectors', () => {
    expect(boardReadUrl('greenhouse', 'acme')).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    expect(boardReadUrl('ashby', 'acme')).toBe('https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true');
    expect(boardReadUrl('smartrecruiters', 'Acme')).toBe('https://api.smartrecruiters.com/v1/companies/Acme/postings');
  });
});
