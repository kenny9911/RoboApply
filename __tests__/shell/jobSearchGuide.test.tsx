// __tests__/shell/jobSearchGuide.test.tsx — the developer reference and
// the key workspace on both brands (parity wave, D5): the same sections, the
// brand's own name, mainland examples on GoApply, and the off state when the
// site's job listings are switched off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithBrand } from './helpers';

const api = vi.hoisted(() => ({ keys: vi.fn(), createKey: vi.fn(), revokeKey: vi.fn() }));
vi.mock('../../lib/api/job-search', async (orig) => {
  const real = await orig<typeof import('../../lib/api/job-search')>();
  return { ...real, jobSearchApi: { ...real.jobSearchApi, keys: api.keys, createKey: api.createKey, revokeKey: api.revokeKey } };
});

import { ApiKeyWorkspace } from '../../components/job-search/ApiKeyWorkspace';
import { JobSearchDeveloperGuide } from '../../components/job-search/JobSearchDeveloperGuide';

beforeEach(() => {
  api.keys.mockResolvedValue({ keys: [] });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('JobSearchDeveloperGuide', () => {
  it('GoApply: its own name and symbol, mainland examples, its source and the AI consent line', () => {
    renderWithBrand(<JobSearchDeveloperGuide />, { brand: 'goapply', flags: { 'jobs.feed': true } });
    const page = screen.getByRole('main');
    expect(page.querySelector('.job-search-brand')).toHaveTextContent('GoApply');
    expect(page.querySelector('[data-brand-glyph]')).toHaveAttribute('data-brand-glyph', 'goapply');
    const [search, agent] = [...page.querySelectorAll('pre code')].map((c) => c.textContent ?? '');
    expect(search).toContain('$GOAPPLY_ORIGIN/api/v1/job-search/search');
    expect(search).toContain('"country":"CN"');
    expect(search).toContain('数据分析师');
    expect(agent).toContain('$GOAPPLY_ORIGIN/api/v1/job-search/agent/search');
    expect(agent).not.toContain('linkedinOnly');
    expect(page).toHaveTextContent('Replace GOAPPLY_ORIGIN with the address of this site and GOAPPLY_JOB_SEARCH_KEY with your API key.');
    expect(page).toHaveTextContent('jobs located in mainland China, read from employers\' public careers pages and, when they are listed, from GoHire.');
    expect(page).toHaveTextContent('This is not the whole market.');
    // Key access to the postings is the operator's decision, and the page says so.
    expect(page).toHaveTextContent('The site operator decides whether keys can read these postings. Until that is turned on, a request made with a key returns an error.');
    expect(page).toHaveTextContent('must have AI features turned on');
    expect(page).toHaveTextContent('an account that signed in with WeChat needs a verified phone number');
    // Nothing of the other brand, and no source GoApply does not have.
    expect(page.textContent).not.toMatch(/ROBOAPPLY|LinkedIn|Taiwan/);
    expect(page).toHaveTextContent('This endpoint does not submit applications.');
  });

  it('RoboApply: the page is what it was', () => {
    renderWithBrand(<JobSearchDeveloperGuide />, { brand: 'roboapply', flags: { 'jobs.feed': true } });
    const page = screen.getByRole('main');
    expect(page.querySelector('.job-search-brand')).toHaveTextContent('RoboApply');
    expect(page.querySelector('[data-brand-glyph]')).toHaveAttribute('data-brand-glyph', 'roboapply');
    const [search, agent] = [...page.querySelectorAll('pre code')].map((c) => c.textContent ?? '');
    expect(search).toContain('$ROBOAPPLY_ORIGIN/api/v1/job-search/search');
    expect(search).toContain('"country":"US"');
    expect(agent).toContain('"linkedinOnly":true');
    expect(page).toHaveTextContent('Replace ROBOAPPLY_ORIGIN with your deployment URL and ROBOAPPLY_JOB_SEARCH_KEY with your API key.');
    expect(page).toHaveTextContent('including LinkedIn listings when available');
    expect(page).toHaveTextContent('Available sources depend on server configuration and provider entitlements.');
    expect(page.textContent).not.toMatch(/GOAPPLY|mainland China/);
  });

  it('with the job listings switched off the page says it is not available (the API answers 404 then)', () => {
    renderWithBrand(<JobSearchDeveloperGuide />, { brand: 'goapply', flags: { 'jobs.feed': false } });
    expect(screen.getByRole('main')).toHaveTextContent('This is not available yet.');
    expect(screen.getByRole('main').querySelector('pre')).toBeNull();
  });
});

describe('ApiKeyWorkspace', () => {
  it('GoApply: lists and issues keys, says what the results are and that a key works only on this site', async () => {
    api.createKey.mockResolvedValue({ key: { id: 'k1', name: 'Campus portal', prefix: 'rajs_abcdefgh', createdAt: '2026-10-11T00:00:00.000Z', lastUsedAt: null, expiresAt: '2027-01-09T00:00:00.000Z' }, token: 'rajs_once_only_fixture' });
    renderWithBrand(<ApiKeyWorkspace />, { brand: 'goapply', flags: { 'jobs.feed': true } });
    await waitFor(() => expect(api.keys).toHaveBeenCalled());
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(screen.getByText('A key works only on this site. It does not work on other sites.')).toBeInTheDocument();
    expect(screen.getByText(/jobs located in mainland China.*when they are listed, from GoHire\. .*The site operator decides whether keys can read these postings/)).toBeInTheDocument();
    // The server sent no `sources` (an older server): nothing is claimed about key access.
    expect(screen.queryByTestId('job-search-keys-no-source')).toBeNull();
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Campus portal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await waitFor(() => expect(api.createKey).toHaveBeenCalledWith('Campus portal'));
    expect(await screen.findByDisplayValue('rajs_once_only_fixture')).toBeInTheDocument();
  });

  it.each(['goapply', 'roboapply'] as const)('%s: when the server says a key can read no source, the page says so before a first call fails', async (brand) => {
    api.keys.mockResolvedValue({ keys: [], sources: [{ id: 'index', name: 'Job index', enabled: false, reason: 'not_licensed', homepage: '', sourceType: 'index' }] });
    renderWithBrand(<ApiKeyWorkspace />, { brand, flags: { 'jobs.feed': true } });
    expect(await screen.findByTestId('job-search-keys-no-source')).toHaveTextContent('No job source is open to API keys on this site right now, so a request made with a key returns an error and no jobs. The site operator decides which sources keys can read.');
  });

  it('when at least one source is open to keys there is no such notice', async () => {
    api.keys.mockResolvedValue({ keys: [], sources: [{ id: 'index', name: 'Job index', enabled: true, homepage: '', sourceType: 'index' }, { id: 'x', name: 'X', enabled: false, reason: 'disabled', homepage: '', sourceType: 'ats' }] });
    renderWithBrand(<ApiKeyWorkspace />, { brand: 'goapply', flags: { 'jobs.feed': true } });
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(screen.queryByTestId('job-search-keys-no-source')).toBeNull();
  });

  it('RoboApply: no GoApply lines', async () => {
    renderWithBrand(<ApiKeyWorkspace />, { brand: 'roboapply', flags: { 'jobs.feed': true } });
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(screen.queryByText(/works only on/)).toBeNull();
    expect(screen.getByText(/Available sources depend on server configuration/)).toBeInTheDocument();
  });

  it('with the job listings switched off: not available, and no key request is made', async () => {
    renderWithBrand(<ApiKeyWorkspace />, { brand: 'goapply', flags: { 'jobs.feed': false } });
    expect(screen.getByText('This is not available yet.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.keys).not.toHaveBeenCalled();
  });
});
