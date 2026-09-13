import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { JobSearchWorkspace } from '../../components/job-search/JobSearchWorkspace';
import { ApiKeyWorkspace } from '../../components/job-search/ApiKeyWorkspace';
import { JobSearchDeveloperGuide } from '../../components/job-search/JobSearchDeveloperGuide';
import { jobSearchApi } from '../../lib/api/job-search';
import { RoboApiError } from '../../lib/api/client';
import type { JobSearchKey, ProviderInfo, SearchJob, SearchResult } from '../../lib/api/job-search-types';
import messages from '../../components/job-search/messages.en.json';

vi.mock('../../lib/api/job-search', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/api/job-search')>(),
  jobSearchApi: { providers: vi.fn(), search: vi.fn(), keys: vi.fn(), createKey: vi.fn(), revokeKey: vi.fn() },
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
const result: SearchResult = { jobs: [job], meta: { totalReturned: 1, deduplicated: 0, partial: false, providers: [{ id: 'jsearch', name: 'JSearch', status: 'ok', resultCount: 1 }], searchedAt: '2026-09-12T01:00:00Z', cache: 'miss', requestId: 'request-1' } };
const key: JobSearchKey = { id: 'key-1', name: 'Careers portal', prefix: 'rjs_test', createdAt: '2026-09-12T01:00:00Z', lastUsedAt: null, expiresAt: '2026-12-11T01:00:00Z' };

function mount(node: React.ReactNode) { return render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>); }

async function submitSearch() {
  await screen.findByRole('checkbox', { name: /JSearch/ });
  fireEvent.change(screen.getByRole('textbox', { name: 'Role or keywords' }), { target: { value: 'engineer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search jobs' }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(jobSearchApi.providers).mockResolvedValue({ providers: catalogue });
  vi.mocked(jobSearchApi.search).mockResolvedValue(result);
  vi.mocked(jobSearchApi.keys).mockResolvedValue({ keys: [] });
});

describe('job search workspace', () => {
  it('does not search until requested and disables unconnected sources', async () => {
    mount(<JobSearchWorkspace />);
    expect(await screen.findByText('Your next role starts with a search')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Active Jobs DB/ })).toBeDisabled();
    expect(jobSearchApi.search).not.toHaveBeenCalled();
    expect(screen.queryByText('0 results')).not.toBeInTheDocument();
  });

  it('submits supported filters and renders salary period, unknown posting date, and source links', async () => {
    mount(<JobSearchWorkspace />);
    await screen.findByRole('checkbox', { name: /JSearch/ });
    fireEvent.change(screen.getByRole('combobox', { name: messages.jobSearch.country }), { target: { value: 'TW' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Location' }), { target: { value: 'Taipei' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Date posted' }), { target: { value: 'week' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Employment type' }), { target: { value: 'full_time' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remote roles only' }));
    await submitSearch();
    expect(await screen.findByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
    expect(jobSearchApi.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'engineer', country: 'TW', location: 'Taipei', remote: true, datePosted: 'week', employmentTypes: ['full_time'], providers: ['jsearch'] }), expect.any(AbortSignal));
    expect(screen.getByText('TWD 80,000–120,000')).toBeInTheDocument();
    expect(screen.getByText('/ month')).toBeInTheDocument();
    expect(screen.getByText('Posting date not provided')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open application page/ })).toHaveAttribute('href', 'https://example.com/apply');
    fireEvent.click(screen.getByText('View role details'));
    expect(screen.getByText(/Build infrastructure for teams/)).toBeInTheDocument();
  });

  it('retains real results when another source times out and shows coverage', async () => {
    vi.mocked(jobSearchApi.search).mockResolvedValue({ ...result, meta: { ...result.meta, partial: true, providers: [...result.meta.providers, { id: 'activejobs', name: 'Active Jobs DB', status: 'timeout', resultCount: 0 }] } });
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByText(/Some sources couldn’t complete/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Source coverage'));
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
  });

  it('shows provider diagnostics for total failure without claiming no matching jobs', async () => {
    const failed = { jobs: [], meta: { ...result.meta, partial: true, providers: [{ id: 'jsearch', name: 'JSearch', status: 'timeout', resultCount: 0 }] } };
    vi.mocked(jobSearchApi.search).mockRejectedValue(new RoboApiError('unavailable', { status: 503, payload: { data: failed } }));
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent('No source could complete');
    expect(screen.queryByText('No roles found for this search')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Source coverage'));
    expect(screen.getByText('Timed out')).toBeInTheDocument();
  });

  it('explains an unconfigured service and offers existing matches', async () => {
    vi.mocked(jobSearchApi.providers).mockResolvedValue({ providers: catalogue.map((provider) => ({ ...provider, enabled: false })) });
    mount(<JobSearchWorkspace />);
    expect(await screen.findByText('Search sources aren’t connected yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search jobs' })).toBeDisabled();
    expect(screen.getAllByRole('link', { name: /Your job matches/ })[0]).toHaveAttribute('href', '/jobs');
  });

  it('requires a selected provider before spending a search request', async () => {
    mount(<JobSearchWorkspace />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /JSearch/ }));
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent('Select at least one available source');
    expect(jobSearchApi.search).not.toHaveBeenCalled();
  });

  it('distinguishes temporary provider capacity from missing configuration', async () => {
    vi.mocked(jobSearchApi.providers).mockResolvedValue({ providers: [{ ...catalogue[0], enabled: false, reason: 'budget_or_circuit' }] });
    mount(<JobSearchWorkspace />);
    expect(await screen.findByRole('heading', { name: 'Unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('Search sources aren’t connected yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('handles rate limits and successful empty searches distinctly', async () => {
    vi.mocked(jobSearchApi.search).mockRejectedValueOnce(new RoboApiError('limited', { status: 429 })).mockResolvedValueOnce({ ...result, jobs: [], meta: { ...result.meta, totalReturned: 0 } });
    mount(<JobSearchWorkspace />);
    await submitSearch();
    expect(await screen.findByRole('alert')).toHaveTextContent('You’ve reached the search limit');
    await submitSearch();
    expect(await screen.findByText('No roles found for this search')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
  expect(screen.getByText(/meta.providers/)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /Download OpenAPI/ })[0]).toHaveAttribute('href', '/api/v1/job-search/openapi.json');
});
