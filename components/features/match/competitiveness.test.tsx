// WP-77 — "You and what employers ask" (/jobs/report): every comparative
// number shows its source with N; a suppressed number renders "—" and "Not
// enough…", never 0; a sample under 20 posts shows only the Broaden options;
// the page never compares the user with other applicants; creating a report
// goes through the credit gate with an idempotency key; Broaden removes one
// filter with one PATCH (baseVersion); the page is hidden with the flag off;
// `?job=` adds the job's own requirement rows; `?search=` picks the search.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createCompetitivenessReport: vi.fn(),
  getLatestCompetitivenessReport: vi.fn(),
  getKeywordCheck: vi.fn(),
  getFitAnalysis: vi.fn(),
  getCredits: vi.fn(),
  listSearchProfiles: vi.fn(),
  updateSearchProfile: vi.fn(),
  getTaxonomy: vi.fn(),
}));
const caps = vi.hoisted(() => ({ flags: { competitiveness: true } as Record<string, unknown> | null, status: 'ready' as string }));
const nav = vi.hoisted(() => ({ search: '', replace: [] as string[] }));

vi.mock('../../../lib/api/match', () => ({
  createCompetitivenessReport: api.createCompetitivenessReport,
  getLatestCompetitivenessReport: api.getLatestCompetitivenessReport,
  getKeywordCheck: api.getKeywordCheck,
  getFitAnalysis: api.getFitAnalysis,
}));
vi.mock('../../../lib/api/credits', () => ({ getCredits: api.getCredits }));
vi.mock('../../../lib/api/search', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/search')>()),
  listSearchProfiles: api.listSearchProfiles,
  updateSearchProfile: api.updateSearchProfile,
  getTaxonomy: api.getTaxonomy,
}));
vi.mock('../../../lib/flags', () => ({
  useCapabilities: () => ({ flags: caps.flags, brand: null, status: caps.status }),
  useFlag: (k: string) => caps.flags?.[k] === true,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs/report',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: (h: string) => nav.replace.push(h), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));

import { RoboApiError } from '../../../lib/api/client';
import type { CompetitivenessReport as Report } from '../../../lib/api/contracts/match';
import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import { CompetitivenessReport, CompetitivenessReportView } from './index';

const AS_OF = '2026-10-10T09:00:00.000Z';
const src = (value: number, sampleSize?: number, method: 'newest_posts_sample' | 'search_count' | 'filter_removal_count' = 'newest_posts_sample') => ({
  value,
  source: 'index' as const,
  ...(sampleSize !== undefined ? { sampleSize } : {}),
  asOf: AS_OF,
  method,
});

function report(over: Partial<Report> = {}): Report {
  return {
    id: 'rep_1',
    createdAt: AS_OF,
    schemaVersion: 1,
    searchProfileId: 'sp1',
    searchProfileName: 'Backend in Berlin',
    searchProfileVersion: 3,
    asOf: AS_OF,
    sample: { size: 25, maxSize: 50, method: 'newest_posts_sample' },
    total: src(240, undefined, 'search_count'),
    totalCapped: false,
    suppressed: null,
    meetsRequirements: { ...src(0.56, 25), met: 14, sampleSize: 25 },
    overall: { checked: 25, notStated: 0, unknown: 0 },
    requirements: [
      { key: 'degree', stated: 22, share: { ...src(0.91, 22), met: 20, sampleSize: 22 }, youKnown: true, yours: 'bachelor', typical: { ...src('bachelor' as never, 22), value: 'bachelor', count: 18 } },
      { key: 'years', stated: 21, share: { ...src(0.62, 21), met: 13, sampleSize: 21 }, youKnown: true, yours: 4, typical: { ...src(5, 21) } },
      { key: 'skills', stated: 12, share: null, youKnown: true, yours: 6, typical: null },
    ],
    topSkills: [
      { skill: 'TypeScript', askedIn: { ...src(20, 25), sampleSize: 25 }, youHave: true },
      { skill: 'Kubernetes', askedIn: { ...src(9, 25), sampleSize: 25 }, youHave: false },
    ],
    broaden: [
      {
        field: 'postedWithinDays',
        value: 7,
        patch: { postedWithinDays: null },
        extraJobs: src(57, undefined, 'filter_removal_count'),
        capped: false,
      },
    ],
    stale: false,
    full: false,
    hiddenSkills: 3,
    hiddenBroaden: 0,
    upgradable: true,
    charged: true,
    reused: false,
    ...over,
  };
}

function profile(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id === 'sp1' ? 'Backend in Berlin' : 'Data roles',
    isDefault: id === 'sp1',
    isActive: id === 'sp1',
    version: 3,
    schemaVersion: 1,
    filters: { postedWithinDays: 7 },
    alertInstantMax: 0,
    alertDigest: null,
    createdAt: AS_OF,
    updatedAt: AS_OF,
    ...over,
  };
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  caps.flags = { competitiveness: true };
  caps.status = 'ready';
  nav.search = '';
  nav.replace = [];
  api.getCredits.mockResolvedValue({
    summary: { buckets: { competitiveness: { window: 'week', cap: 1, used: 0, reserved: 0, remaining: 1, grantRemaining: 0, resetsAt: '2026-10-17T00:00:00Z' } }, upgradable: true },
    practice: null,
  });
  api.getTaxonomy.mockResolvedValue({ nodes: [] });
  api.listSearchProfiles.mockResolvedValue({ profiles: [profile('sp1')], maxProfiles: 1, maxInstantAlerts: 1, proMaxProfiles: 10, upgradable: true });
  api.getLatestCompetitivenessReport.mockResolvedValue(null);
});

describe('CompetitivenessReportView', () => {
  it('shows each number with its source and N; requirements, most requested skills and Broaden options', () => {
    renderWithProviders(<CompetitivenessReportView report={report()} onBroaden={vi.fn()} />);
    expect(screen.getByText('From the 25 newest posts in this search (240 in all).')).toBeInTheDocument();
    const headline = screen.getByTestId('meets-headline');
    expect(headline).toHaveTextContent('14 of 25 posts');
    expect(headline).toHaveTextContent('56% of posts');
    expect(document.querySelectorAll('[data-source-note="sourced"]').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/25 posts/).length).toBeGreaterThan(0);

    const degree = screen.getByTestId('requirement-degree');
    expect(degree).toHaveTextContent('You meet it in 20 of 22 posts that state it');
    expect(degree).toHaveTextContent(/Most often asked: .+ \(18 posts\)/);
    expect(screen.getByTestId('requirement-years')).toHaveTextContent('Typical minimum asked: 5 years');
    // Skills stated by 12 posts: under 20, so no number.
    expect(screen.getByTestId('requirement-skills')).toHaveTextContent('Not enough posts state this to give a number.');

    const skills = screen.getAllByTestId('top-skill');
    expect(skills[0]).toHaveTextContent('TypeScript');
    expect(skills[0]).toHaveTextContent('Asked for in 20 of 25 posts');
    expect(skills[0]).toHaveTextContent('On your profile or resume');
    expect(skills[1]).toHaveTextContent('Not on your profile or resume');
    expect(screen.getByText('3 more skills in the full report with Pro.')).toBeInTheDocument();

    const option = screen.getByTestId('broaden-option');
    expect(option).toHaveTextContent('+57 jobs');
    expect(within(option).getByRole('button', { name: 'Remove this filter' })).toBeEnabled();
  });

  it('a suppressed share renders "—" with "Not enough…", never 0', () => {
    renderWithProviders(<CompetitivenessReportView report={report({ meetsRequirements: null })} />);
    const none = screen.getByTestId('meets-not-enough');
    expect(none).toHaveTextContent('—');
    expect(none).toHaveTextContent('Not enough posts state these requirements to give a number.');
    expect(screen.queryByTestId('meets-headline')).not.toBeInTheDocument();
  });

  it('under 20 posts: only the Broaden options, no comparison', () => {
    renderWithProviders(
      <CompetitivenessReportView report={report({ suppressed: 'too_few_posts', sample: { size: 12, maxSize: 50, method: 'newest_posts_sample' }, meetsRequirements: null, requirements: [], topSkills: [], hiddenSkills: 0 })} />,
    );
    expect(screen.getByRole('heading', { name: 'Not enough posts to compare yet' })).toBeInTheDocument();
    expect(screen.getByText(/This search has 12 recent posts\. We need at least 20/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Requirements you meet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Most requested skills' })).not.toBeInTheDocument();
    expect(screen.getByTestId('broaden-option')).toBeInTheDocument();
  });

  it('a stale report says so and disables the filter buttons', () => {
    renderWithProviders(<CompetitivenessReportView report={report({ stale: true })} onBroaden={vi.fn()} />);
    expect(screen.getByText(/Your saved search changed after this report was made/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove this filter' })).toBeDisabled();
  });

  it('"with Pro" only when a Pro plan can be bought; otherwise neutral "not shown on your plan"', () => {
    renderWithProviders(<CompetitivenessReportView report={report({ upgradable: false, hiddenBroaden: 2 })} />);
    expect(screen.getByText("3 more skills aren't shown on your plan.")).toBeInTheDocument();
    expect(screen.getByText("2 more options aren't shown on your plan.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/with Pro/);
  });

  it('Broaden: a "+N or more" count when the figure is a lower bound; a capped search says it already has many posts', () => {
    const capped = report({
      broaden: [{ field: 'postedWithinDays', value: 7, patch: { postedWithinDays: null }, extraJobs: src(100, undefined, 'filter_removal_count'), capped: true }],
    });
    const { unmount } = renderWithProviders(<CompetitivenessReportView report={capped} />);
    expect(screen.getByTestId('broaden-option')).toHaveTextContent('+100 or more jobs');
    unmount();
    renderWithProviders(<CompetitivenessReportView report={report({ broaden: [], totalCapped: true, total: src(5000, undefined, 'search_count') })} />);
    expect(screen.getByTestId('broaden-many')).toHaveTextContent("Your search already has more than 5,000 posts, so removing a filter wouldn't change much.");
    expect(screen.queryByText('None of your filters is holding back many jobs right now.')).not.toBeInTheDocument();
  });

  it('never compares you with other people', () => {
    const { container } = renderWithProviders(<CompetitivenessReportView report={report()} />);
    expect(container.textContent).not.toMatch(/applicants?|outperform|percentile|top \d+%/i);
  });
});

describe('/jobs/report page', () => {
  it('flag off: the report is not offered', async () => {
    caps.flags = { competitiveness: false };
    renderWithProviders(<CompetitivenessReport />);
    expect(screen.getByText("This report isn't available")).toBeInTheDocument();
    expect(api.getLatestCompetitivenessReport).not.toHaveBeenCalled();
  });

  it('no report yet: the start card; creating one goes through the credit gate with an idempotency key', async () => {
    api.createCompetitivenessReport.mockResolvedValue(report());
    renderWithProviders(<CompetitivenessReport />);
    expect(screen.getByText(/It is not your chance of getting hired\./)).toBeInTheDocument();
    const start = await screen.findByTestId('competitiveness-start');
    expect(within(start).getByText('Counted from job posts. No AI is used.')).toBeInTheDocument();
    await waitFor(() => expect(api.getCredits).toHaveBeenCalled());
    fireEvent.click(within(start).getByRole('button', { name: 'Create the report' }));
    await screen.findByTestId('competitiveness-report');
    expect(api.getLatestCompetitivenessReport).toHaveBeenCalledWith({ searchProfileId: 'sp1' }, expect.anything());
    const [body, opts] = api.createCompetitivenessReport.mock.calls[0]!;
    expect(body).toEqual({ searchProfileId: 'sp1' });
    expect(typeof opts.idempotencyKey).toBe('string');
    expect(screen.getByText(/This report used 1 credit\./)).toBeInTheDocument();
    expect(screen.queryByTestId('report-reused')).not.toBeInTheDocument();
  });

  it('"same report as earlier today" only for a reused report; a new report under 20 posts says why it was free', async () => {
    api.createCompetitivenessReport.mockResolvedValueOnce(report({ charged: false, reused: true }));
    const first = renderWithProviders(<CompetitivenessReport />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create the report' }));
    expect(await screen.findByTestId('report-reused')).toHaveTextContent('Same search and profile as earlier today');
    first.unmount();

    api.createCompetitivenessReport.mockResolvedValueOnce(
      report({ charged: false, reused: false, suppressed: 'too_few_posts', sample: { size: 12, maxSize: 50, method: 'newest_posts_sample' }, meetsRequirements: null, requirements: [], topSkills: [], hiddenSkills: 0 }),
    );
    renderWithProviders(<CompetitivenessReport />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create the report' }));
    expect(await screen.findByTestId('report-not-charged')).toHaveTextContent("There weren't enough posts to compare, so no credit was used.");
    expect(screen.queryByTestId('report-reused')).not.toBeInTheDocument();
  });

  it('402 credits_exhausted: says so and shows no report', async () => {
    api.createCompetitivenessReport.mockRejectedValue(
      new RoboApiError('x', { status: 402, payload: { code: 'credits_exhausted', details: { bucket: 'competitiveness', upgradable: true } } }),
    );
    renderWithProviders(<CompetitivenessReport />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create the report' }));
    expect(await screen.findByText("You've used your reports for now.")).toBeInTheDocument();
    expect(screen.queryByTestId('competitiveness-report')).not.toBeInTheDocument();
  });

  it('Broaden: one PATCH with baseVersion and the field cleared, then asks to run the report again', async () => {
    api.getLatestCompetitivenessReport.mockResolvedValue(report({ charged: false }));
    api.updateSearchProfile.mockResolvedValue(profile('sp1', { version: 4, filters: {} }));
    renderWithProviders(<CompetitivenessReport />);
    const option = await screen.findByTestId('broaden-option');
    fireEvent.click(within(option).getByRole('button', { name: 'Remove this filter' }));
    expect(await within(option).findByText('Removed. Run the report again to see the new numbers.')).toBeInTheDocument();
    expect(api.updateSearchProfile).toHaveBeenCalledWith('sp1', { baseVersion: 3, filtersPatch: { postedWithinDays: null } });
  });

  it('?job= shows the job\'s own requirement rows and a link back', async () => {
    nav.search = 'job=job_42';
    api.getKeywordCheck.mockResolvedValue({ jobId: 'job_42', resumeVariantId: null, rows: [], asOf: AS_OF });
    renderWithProviders(<CompetitivenessReport />);
    expect(screen.getByRole('heading', { name: 'This job' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the job' })).toHaveAttribute('href', '/jobs/job_42');
    await waitFor(() => expect(api.getKeywordCheck).toHaveBeenCalledWith('job_42', {}, expect.anything()));
  });

  it('?search= picks that saved search; the picker replaces the URL', async () => {
    nav.search = 'search=sp2';
    api.listSearchProfiles.mockResolvedValue({ profiles: [profile('sp1'), profile('sp2')], maxProfiles: 10, maxInstantAlerts: 1, proMaxProfiles: null, upgradable: false });
    renderWithProviders(<CompetitivenessReport />);
    const select = await screen.findByRole('combobox', { name: 'Saved search' });
    expect(select).toHaveValue('sp2');
    await waitFor(() => expect(api.getLatestCompetitivenessReport).toHaveBeenCalledWith({ searchProfileId: 'sp2' }, expect.anything()));
    fireEvent.change(select, { target: { value: 'sp1' } });
    expect(nav.replace).toEqual(['/jobs/report?search=sp1']);
  });
});
