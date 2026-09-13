import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { JobSearchWorkspace } from '../../components/job-search/JobSearchWorkspace';
import { ApiKeyWorkspace } from '../../components/job-search/ApiKeyWorkspace';
import { JobSearchDeveloperGuide } from '../../components/job-search/JobSearchDeveloperGuide';
import { jobSearchApi } from '../../lib/api/job-search';
import { RoboApiError } from '../../lib/api/client';
import type { AgentSearchResult, JobSearchKey, ProviderInfo, SearchJob } from '../../lib/api/job-search-types';
import messages from '../../components/job-search/messages.en.json';

vi.mock('../../lib/api/job-search', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/api/job-search')>(),
  jobSearchApi: { providers: vi.fn(), search: vi.fn(), agentSearch: vi.fn(), keys: vi.fn(), createKey: vi.fn(), revokeKey: vi.fn() },
}));

const catalogue: ProviderInfo[] = [
  { id: 'jsearch', name: 'JSearch', enabled: true, homepage: 'https://example.com/jsearch', sourceType: 'aggregator' },
  { id: 'activejobs', name: 'Active Jobs DB', enabled: false, reason: 'missing_credentials', homepage: 'https://example.com/active', sourceType: 'aggregator' },
];
const job: SearchJob = {
  id: 'job-1', title: 'Platform Engineer', company: 'Example Employer', companyLogoUrl: null,
  location: 'Taipei', country: 'TW', description: 'Build infrastructure for teams.\nA real provider response in this test.',
  applyUrl: 'https://example.com/apply', sourceUrl: 'https://example.com/job', applyIsDirect: true, provider: 'jsearch',
  sources: [{ provider: 'jsearch', id: 'source-1', applyUrl: 'https://example.com/apply', publisher: 'Employer' }],
  postedAt: null, fetchedAt: '2026-09-12T01:00:00Z', remote: null, employmentType: 'full_time',
  salary: { min: 80000, max: 120000, currency: 'TWD', period: 'month' },
};
const result: AgentSearchResult = {
  jobs: [job],
  meta: { totalReturned: 1, deduplicated: 0, partial: false, providers: [{ id: 'jsearch', name: 'JSearch', status: 'ok', resultCount: 1 }], searchedAt: '2026-09-12T01:00:00Z', cache: 'miss', requestId: 'request-1' },
  agent: { queries: ['frontend engineer', 'React engineer'], mode: 'planned', criteria: { country: 'tw', location: 'Taipei', remote: true, datePosted: 'week', employmentTypes: ['full_time'] }, unverifiedPreferences: ['Product team preference', 'Visa sponsorship'], linkedinOnly: false },
  searches: [{ query: 'frontend engineer', providers: [{ id: 'jsearch', name: 'JSearch', status: 'ok', resultCount: 1 }] }, { query: 'React engineer', providers: [{ id: 'jsearch', name: 'JSearch', status: 'empty', resultCount: 0 }] }],
};
const key: JobSearchKey = { id: 'key-1', name: 'Careers portal', prefix: 'rjs_test', createdAt: '2026-09-12T01:00:00Z', lastUsedAt: null, expiresAt: '2026-12-11T01:00:00Z' };

function mount(node: React.ReactNode) { return render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>); }

const requestText = 'Find senior frontend roles in Taipei using React, preferably on product teams.';
async function submitSearch(request = requestText) {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Search Job' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: messages.jobSearch.request_label }), { target: { value: request } });
  fireEvent.click(screen.getByRole('button', { name: 'Search Job' }));
}
function openAdvanced() { fireEvent.click(screen.getByText(messages.jobSearch.advanced)); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(jobSearchApi.providers).mockResolvedValue({ providers: catalogue });
  vi.mocked(jobSearchApi.agentSearch).mockResolvedValue(result);
  vi.mocked(jobSearchApi.keys).mockResolvedValue({ keys: [] });
});

describe('Search Job Agent workspace', () => {
  it('waits for an explicit Search Job action and exposes source availability', async () => {
    mount(<JobSearchWorkspace />);
    expect(await screen.findByText('Your next role starts with a search')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search Job' })).toBeEnabled();
    openAdvanced();
    expect(screen.getByRole('checkbox', { name: /Active Jobs DB/ })).toBeDisabled();
    expect(jobSearchApi.agentSearch).not.toHaveBeenCalled();
    expect(jobSearchApi.search).not.toHaveBeenCalled();
    expect(screen.queryByText('0 results')).not.toBeInTheDocument();
  });

  it('passes natural language without default filters overriding it and displays actual search criteria', async () => {
    vi.mocked(jobSearchApi.agentSearch).mockResolvedValue({ ...result, agent: { ...result.agent, linkedinOnly: true } });
    mount(<JobSearchWorkspace />);
    await submitSearch('Find frontend engineering roles in Taipei on LinkedIn only.');
    expect(await screen.findByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
    const [input] = vi.mocked(jobSearchApi.agentSearch).mock.calls[0];
    expect(input).toMatchObject({ request: 'Find frontend engineering roles in Taipei on LinkedIn only.', locale: 'en', providers: ['jsearch'] });
    expect(input.country).toBeUndefined();
    expect(input.location).toBeUndefined();
    expect(input.remote).toBeUndefined();
    expect(input.datePosted).toBeUndefined();
    expect(input.linkedinOnly).toBeUndefined();
    const plan = screen.getByRole('region', { name: messages.jobSearch.plan_title });
    expect(within(plan).getByText('frontend engineer')).toBeInTheDocument();
    expect(within(plan).getByText('React engineer')).toBeInTheDocument();
    expect(within(plan).getByText('Taiwan')).toBeInTheDocument();
    expect(within(plan).getByText('LinkedIn listings only')).toBeInTheDocument();
    expect(within(plan).getByText('Visa sponsorship')).toBeInTheDocument();
    expect(within(plan).getByText(messages.jobSearch.plan_unverified_hint)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'LinkedIn listings only' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'LinkedIn listings only' }));
    await submitSearch('Find frontend engineering roles in Taipei on LinkedIn only.');
    await waitFor(() => expect(jobSearchApi.agentSearch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(jobSearchApi.agentSearch).mock.calls[1][0].linkedinOnly).toBe(false);
  });

  it('applies explicitly selected overrides and preserves job salary, dates, and application links', async () => {
    mount(<JobSearchWorkspace />);
    await screen.findByText('Your next role starts with a search');
    openAdvanced();
    fireEvent.change(screen.getByRole('combobox', { name: messages.jobSearch.country }), { target: { value: 'TW' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Location' }), { target: { value: 'Taipei' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Date posted' }), { target: { value: 'week' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Employment type' }), { target: { value: 'full_time' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Work arrangement' }), { target: { value: 'remote' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'LinkedIn listings only' }));
    await submitSearch();
    expect(await screen.findByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
    expect(jobSearchApi.agentSearch).toHaveBeenCalledWith(expect.objectContaining({ request: requestText, country: 'TW', location: 'Taipei', remote: true, datePosted: 'week', employmentTypes: ['full_time'], providers: ['jsearch'], linkedinOnly: true }), expect.any(AbortSignal));
    expect(screen.getByText('TWD 80,000–120,000')).toBeInTheDocument();
    expect(screen.getByText('/ month')).toBeInTheDocument();
    expect(screen.getByText('Posting date not provided')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open application page/ })).toHaveAttribute('href', 'https://example.com/apply');
    fireEvent.click(screen.getByText('View role details'));
    expect(screen.getByText(/Build infrastructure for teams/)).toBeInTheDocument();
  });

  it('keeps completed results and per-query diagnostics when a later query reaches its limit', async () => {
    vi.mocked(jobSearchApi.agentSearch).mockResolvedValue({ ...result, meta: { ...result.meta, partial: true }, searches: [result.searches[0], { query: 'React engineer', providers: [], error: { code: 'rate_limited', message: 'Private upstream failure details' } }] });
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByText(/Some sources couldn’t complete/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(messages.jobSearch.query_coverage));
    expect(screen.getByText(messages.jobSearch.query_limited)).toBeInTheDocument();
    expect(screen.queryByText('Private upstream failure details')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
  });

  it('shows total-source failure diagnostics without claiming no matching jobs', async () => {
    const failed = { jobs: [], meta: { ...result.meta, partial: true, providers: [{ id: 'jsearch', name: 'JSearch', status: 'timeout', resultCount: 0 }] } };
    vi.mocked(jobSearchApi.agentSearch).mockRejectedValue(new RoboApiError('unavailable', { status: 503, payload: { data: failed } }));
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent('No source could complete');
    expect(screen.queryByText('No roles found for this search')).not.toBeInTheDocument();
    expect(screen.queryByText('0 results')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Source coverage'));
    expect(screen.getByText('Timed out')).toBeInTheDocument();
  });

  it('shows planner unavailability without fabricated queries or results', async () => {
    vi.mocked(jobSearchApi.agentSearch).mockRejectedValue(new RoboApiError('planner failed', { status: 503, payload: { code: 'agent_unavailable' } }));
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.jobSearch.agent_unavailable);
    expect(screen.queryByRole('region', { name: messages.jobSearch.plan_title })).not.toBeInTheDocument();
    expect(screen.queryByText('0 results')).not.toBeInTheDocument();
  });

  it('asks for a role when the planner rejects a request without one', async () => {
    vi.mocked(jobSearchApi.agentSearch).mockRejectedValue(new RoboApiError('No role found', { status: 400, payload: { code: 'invalid_request' } }));
    mount(<JobSearchWorkspace />);
    await submitSearch('I would like flexible hours and a friendly team.');
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.jobSearch.request_invalid);
    expect(screen.queryByRole('region', { name: messages.jobSearch.plan_title })).not.toBeInTheDocument();
  });

  it('stops an in-flight search and ignores its late response after another search completes', async () => {
    let resolveFirst!: (value: AgentSearchResult) => void;
    vi.mocked(jobSearchApi.agentSearch).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByRole('status')).toHaveTextContent(messages.jobSearch.agent_pending);
    const firstSignal = vi.mocked(jobSearchApi.agentSearch).mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: messages.jobSearch.cancel_search }));
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent(messages.jobSearch.search_stopped);
    await submitSearch('Find a product engineering role in Taiwan.');
    expect(await screen.findByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
    await act(async () => resolveFirst({ ...result, jobs: [{ ...job, id: 'stale', title: 'Stale response' }] }));
    expect(screen.queryByRole('heading', { name: 'Stale response' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
  });

  it('explains an unconfigured service and offers existing matches', async () => {
    vi.mocked(jobSearchApi.providers).mockResolvedValue({ providers: catalogue.map((provider) => ({ ...provider, enabled: false })) });
    mount(<JobSearchWorkspace />);
    expect(await screen.findByText('Search sources aren’t connected yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search Job' })).toBeDisabled();
    expect(screen.getAllByRole('link', { name: /Your job matches/ })[0]).toHaveAttribute('href', '/jobs');
  });

  it('requires a selected source before spending a request', async () => {
    mount(<JobSearchWorkspace />);
    await screen.findByText('Your next role starts with a search');
    openAdvanced();
    fireEvent.click(screen.getByRole('checkbox', { name: /JSearch/ }));
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent('Select at least one available source');
    expect(jobSearchApi.agentSearch).not.toHaveBeenCalled();
  });

  it('distinguishes temporary provider capacity from missing configuration', async () => {
    vi.mocked(jobSearchApi.providers).mockResolvedValue({ providers: [{ ...catalogue[0], enabled: false, reason: 'budget_or_circuit' }] });
    mount(<JobSearchWorkspace />);
    expect(await screen.findByRole('heading', { name: 'Unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('Search sources aren’t connected yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('distinguishes an account limit from an empty LinkedIn subset', async () => {
    vi.mocked(jobSearchApi.agentSearch).mockRejectedValueOnce(new RoboApiError('limited', { status: 429 })).mockResolvedValueOnce({ ...result, jobs: [], meta: { ...result.meta, totalReturned: 0 }, agent: { ...result.agent, linkedinOnly: true } });
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent('You’ve reached the search limit');
    await submitSearch();
    expect(await screen.findByText('No roles found for this search')).toBeInTheDocument();
    expect(screen.getByText(messages.jobSearch.linkedin_empty)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains LinkedIn posting provenance while the primary application link points to the employer', async () => {
    const linkedinJob = { ...job, sources: [{ provider: 'jsearch', id: 'source-linkedin', publisher: 'LinkedIn', applyUrl: job.applyUrl, sourceUrl: 'https://www.linkedin.com/jobs/view/12345' }] };
    vi.mocked(jobSearchApi.agentSearch).mockResolvedValue({ ...result, jobs: [linkedinJob] });
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByText('JSearch · LinkedIn')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open application page/ })).toHaveAttribute('href', job.applyUrl);
    fireEvent.click(screen.getByText('View role details'));
    expect(screen.getByRole('link', { name: /JSearch · LinkedIn/ })).toHaveAttribute('href', 'https://www.linkedin.com/jobs/view/12345');
  });
});

describe('job search API keys', () => {
  it('reveals a newly created key once and requires explicit revoke confirmation', async () => {
    vi.mocked(jobSearchApi.createKey).mockResolvedValue({ key, token: 'rjs_secret_only_once' });
    vi.mocked(jobSearchApi.revokeKey).mockResolvedValue(undefined);
    mount(<ApiKeyWorkspace />);
    await screen.findByText('No API keys yet');
    fireEvent.change(screen.getByRole('textbox', { name: 'Key name' }), { target: { value: 'Careers portal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    expect(await screen.findByRole('textbox', { name: 'New API key' })).toHaveValue('rjs_secret_only_once');
    expect(jobSearchApi.createKey).toHaveBeenCalledWith('Careers portal');
    expect(screen.getByRole('button', { name: 'Create API key' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'I’ve saved the key' }));
    expect(screen.queryByDisplayValue('rjs_secret_only_once')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(jobSearchApi.revokeKey).not.toHaveBeenCalled();
    expect(screen.getByText(/Integrations using it will stop working/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(jobSearchApi.revokeKey).toHaveBeenCalledWith('key-1');
  });

  it('preserves a key when revocation fails', async () => {
    vi.mocked(jobSearchApi.keys).mockResolvedValue({ keys: [key] });
    vi.mocked(jobSearchApi.revokeKey).mockRejectedValue(new Error('unavailable'));
    mount(<ApiKeyWorkspace />);
    await screen.findByRole('heading', { name: 'Careers portal' });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t revoke the key');
    expect(screen.getByRole('heading', { name: 'Careers portal' })).toBeInTheDocument();
  });

  it('provides a manual copy fallback when the clipboard is unavailable', async () => {
    vi.mocked(jobSearchApi.createKey).mockResolvedValue({ key, token: 'rjs_manual_copy' });
    mount(<ApiKeyWorkspace />);
    await screen.findByText('No API keys yet');
    fireEvent.change(screen.getByRole('textbox', { name: 'Key name' }), { target: { value: 'Careers portal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Select the key and copy it manually');
    expect(screen.getByRole('textbox', { name: 'New API key' })).toHaveValue('rjs_manual_copy');
  });
});

it('documents the real API contract without embedding a credential', () => {
  mount(<JobSearchDeveloperGuide />);
  const code = screen.getByRole('region', { name: 'Example request' });
  expect(within(code).getByText(/ROBOAPPLY_JOB_SEARCH_KEY/)).toBeInTheDocument();
  const agentCode = screen.getByLabelText(messages.jobSearch.eyebrow, { selector: 'pre' });
  expect(agentCode).toHaveTextContent('/api/v1/job-search/agent/search');
  expect(agentCode).toHaveTextContent('ROBOAPPLY_JOB_SEARCH_KEY');
  expect(screen.getByText(/meta.providers/)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /Download OpenAPI/ })[0]).toHaveAttribute('href', '/api/v1/job-search/openapi.json');
});
