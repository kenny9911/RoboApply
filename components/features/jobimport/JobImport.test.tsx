// WP-35 — "Added by you" UI: add from a link (draft → check → save), the
// paste-the-text fallback for blocked boards, the typed-in form, warnings,
// limits and credit errors (the server decides whether a save is charged),
// the done card's entry points (job page, tracker, tailor, practice), the
// list and remove. Renders through the real en.json + staged
// English, so a missing key fails here instead of showing a dotted path.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import { __outOfCreditsStore } from '../../../hooks/shared/useCreditGate';
import type { AddedJobItem, AddedJobsResponse, ImportJobResponse } from '../../../lib/api/contracts/jobs/import';

const api = vi.hoisted(() => ({
  importJob: vi.fn(),
  getImportStatus: vi.fn(),
  listAddedJobs: vi.fn(),
  removeAddedJob: vi.fn(),
}));
vi.mock('../../../lib/api/jobImport', () => api);

const jobsApi = vi.hoisted(() => ({ saveJob: vi.fn(), unsaveJob: vi.fn(), applyClick: vi.fn(), markApplied: vi.fn(), shareJob: vi.fn(), undoApplied: vi.fn() }));
vi.mock('../../../lib/api/jobs', () => jobsApi);
vi.mock('../../../lib/api/feed', () => ({ hideJob: vi.fn(), reportJob: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/jobs/added',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../lib/api/contracts/wire', async (orig) => ({ ...(await orig<object>()), newIdempotencyKey: () => 'idem-key' }));

const credits = vi.hoisted(() => ({ remaining: 3, invalidations: 0 }));
vi.mock('../../../hooks/shared/useCredits', () => ({
  useCredits: () => ({ data: undefined, isSuccess: true }),
  useInvalidateCredits: () => async () => {
    credits.invalidations += 1;
  },
  creditsLeft: () => credits.remaining,
  bucketSummary: () => ({ window: 'day', remaining: credits.remaining, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00.000Z', cap: 10, used: 10 - credits.remaining, reserved: 0 }),
}));

import { JobsAddedPage } from './JobsAddedPage';
import { AddJobPanel } from './AddJobPanel';
import { AddedJobsList } from './AddedJobsList';
import { toManualJob, validateFields } from './ImportFieldsForm';

const LINK = 'https://careers.acme.example/jobs/42';
const LONG = 'You will build and run the data platform that powers our analytics, working with product every day.';

function draftResponse(over: Partial<ImportJobResponse> = {}): ImportJobResponse {
  return {
    importId: 'draft_abc.sig',
    status: 'needs_fields',
    jobId: null,
    missingFields: ['company'],
    warnings: [],
    reason: null,
    draft: { title: 'Senior Data Engineer', company: null, description: LONG, location: 'Austin, TX', applyUrl: LINK, sources: { title: 'page_title', description: 'job_data', location: 'job_data', applyUrl: 'link' } },
    matched: null,
    ...over,
  };
}

const done = (over: Partial<ImportJobResponse> = {}): ImportJobResponse => ({
  importId: 'job_j1',
  status: 'done',
  jobId: 'j1',
  missingFields: [],
  warnings: [],
  reason: null,
  draft: null,
  matched: null,
  ...over,
});

function item(over: Partial<AddedJobItem> = {}): AddedJobItem {
  return {
    jobId: 'j1',
    title: 'Senior Data Engineer',
    companyName: 'Acme',
    location: 'Austin, TX',
    workModel: null,
    applyUrl: LINK,
    sourceHost: 'careers.acme.example',
    addedAt: '2026-10-09T12:00:00.000Z',
    warnings: [],
    trackerStatus: null,
    ...over,
  };
}

const list = (items: AddedJobItem[], cursor: string | null = null): AddedJobsResponse => ({ items, cursor });

beforeEach(() => {
  vi.clearAllMocks();
  credits.remaining = 3;
  credits.invalidations = 0;
  __outOfCreditsStore.set(null);
  api.listAddedJobs.mockResolvedValue(list([]));
  jobsApi.saveJob.mockResolvedValue(undefined);
});

function typeLink(value: string) {
  fireEvent.change(screen.getByLabelText('Link to the job post'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Get job details' }));
}

describe('JobsAddedPage', () => {
  it('offers nothing when jobs.import is off (fail closed)', () => {
    renderWithBrand(<JobsAddedPage />, { flags: {} });
    expect(screen.getByRole('heading', { level: 1, name: 'Added by you' })).toBeInTheDocument();
    expect(screen.getByText("Adding jobs isn't available here")).toBeInTheDocument();
    expect(screen.queryByText('Add a job')).toBeNull();
    expect(api.listAddedJobs).not.toHaveBeenCalled();
  });

  it('shows the add panel and the empty list when on', async () => {
    renderWithBrand(<JobsAddedPage />, { flags: { 'jobs.import': true } });
    expect(screen.getByRole('heading', { name: 'Add a job' })).toBeInTheDocument();
    expect(await screen.findByText('No jobs added yet')).toBeInTheDocument();
    expect(api.listAddedJobs).toHaveBeenCalledWith({ limit: 20 }, expect.anything());
  });
});

describe('AddJobPanel — from a link', () => {
  it('checks the link locally before calling the server', () => {
    renderWithBrand(<AddJobPanel />);
    typeLink('acme jobs');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a full web address');
    expect(api.importJob).not.toHaveBeenCalled();
  });

  it('reads the page, shows what to check, and saves the confirmed fields with the draft id and a credit key', async () => {
    api.importJob.mockResolvedValueOnce(draftResponse()).mockResolvedValueOnce(done());
    renderWithBrand(<AddJobPanel />);
    typeLink(LINK);
    expect(api.importJob).toHaveBeenCalledWith({ url: LINK });

    expect(await screen.findByRole('heading', { name: 'Check the details' })).toBeInTheDocument();
    expect(screen.getByText(/haven't verified them/)).toBeInTheDocument();
    expect(screen.getByLabelText('Job title')).toHaveValue('Senior Data Engineer');
    expect(screen.getByText('From the page title. Check it.')).toBeInTheDocument();
    expect(screen.getByText('Not found on the page. Please fill this in.')).toBeInTheDocument();
    expect(screen.getByLabelText('Link to the job post (optional)')).toHaveValue(LINK);

    // Company is missing: the save is refused locally.
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    expect(screen.getByText('Add the company.')).toBeInTheDocument();
    expect(api.importJob).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(api.importJob).toHaveBeenCalledTimes(2));
    expect(api.importJob).toHaveBeenLastCalledWith(
      { manual: { title: 'Senior Data Engineer', company: 'Acme', description: LONG, location: 'Austin, TX', applyUrl: LINK }, importId: 'draft_abc.sig' },
      { idempotencyKey: 'idem-key' },
    );
    expect(credits.invalidations).toBe(1);

    const card = await screen.findByTestId('import-done');
    expect(within(card).getByRole('heading', { name: 'Job added' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Tailor resume' })).toHaveAttribute('href', '/resume?tailor=j1&from=job_import');
    expect(within(card).getByRole('link', { name: 'Practice interview' })).toHaveAttribute('href', '/practice?job=j1&from=job_import');
    expect(within(card).getByRole('link', { name: 'View job' })).toHaveAttribute('href', expect.stringMatching(/^\/jobs/));

    // Tracking entry point: the shared job action (a 'bookmarked' tracker entry; nothing is applied).
    fireEvent.click(within(card).getByRole('button', { name: 'Save to tracker' }));
    await waitFor(() => expect(jobsApi.saveJob).toHaveBeenCalledWith('j1'));
    expect(await within(card).findByText('Saved to your tracker.')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open tracker' })).toHaveAttribute('href', '/applications');

    fireEvent.click(within(card).getByRole('button', { name: 'Add another job' }));
    expect(screen.getByLabelText('Link to the job post')).toHaveValue('');
  });

  it('a board that forbids copying asks for the job text, with the link kept', async () => {
    api.importJob.mockResolvedValueOnce(
      draftResponse({
        status: 'needs_text',
        reason: 'blocked_site',
        missingFields: ['title', 'company', 'description'],
        draft: { title: null, company: null, description: null, location: null, applyUrl: 'https://www.linkedin.com/jobs/view/1', sources: { applyUrl: 'link' } },
      }),
    );
    renderWithBrand(<AddJobPanel />);
    typeLink('https://www.linkedin.com/jobs/view/1');
    expect(await screen.findByTestId('import-reason')).toHaveTextContent("doesn't allow us to copy its job posts");
    expect(screen.getByRole('heading', { name: 'Job details' })).toBeInTheDocument();
    expect(screen.getByLabelText('Link to the job post (optional)')).toHaveValue('https://www.linkedin.com/jobs/view/1');
    expect(screen.queryByText('Not found on the page. Please fill this in.')).toBeNull();
  });

  it('shows warnings quoted from the post before saving', async () => {
    api.importJob.mockResolvedValueOnce(draftResponse({ warnings: [{ rule: 'intl_pay_to_apply', evidence: 'Pay a $50 fee to apply.' }, { rule: 'cn_training_loan', evidence: '入职需办理培训贷' }] }));
    renderWithBrand(<AddJobPanel />);
    typeLink(LINK);
    const box = await screen.findByTestId('import-warnings');
    expect(within(box).getByText('Asks you to pay to apply')).toBeInTheDocument();
    expect(within(box).getByText('Pay a $50 fee to apply.')).toBeInTheDocument();
    expect(within(box).getByText('Flagged for a closer look')).toBeInTheDocument();
  });

  it('explains the lock and the hourly limit in plain words', async () => {
    api.importJob.mockRejectedValueOnce(
      new RoboApiError('x', { status: 429, payload: { code: 'rate_limited', details: { reason: 'import_locked', lockedUntil: '2026-10-10T13:00:00.000Z', retryAfterSec: 3600 } } }),
    );
    renderWithBrand(<AddJobPanel />);
    typeLink(LINK);
    expect(await screen.findByText(/Adding jobs is paused until/)).toBeInTheDocument();

    api.importJob.mockRejectedValueOnce(new RoboApiError('x', { status: 429, payload: { code: 'rate_limited', details: { reason: 'import_hourly_limit', retryAfterSec: 1500 } } }));
    typeLink(LINK);
    expect(await screen.findByText(/Try again in 25 minutes/)).toBeInTheDocument();
  });

  it('a job already in our listings says no credit was used', async () => {
    api.importJob.mockResolvedValueOnce(draftResponse({ missingFields: [], draft: { ...draftResponse().draft!, company: 'Acme' } })).mockResolvedValueOnce(done({ matched: 'public', jobId: 'pub_1' }));
    renderWithBrand(<AddJobPanel />);
    typeLink(LINK);
    fireEvent.click(await screen.findByRole('button', { name: 'Save job' }));
    expect(await screen.findByRole('heading', { name: 'This job is already in our listings' })).toBeInTheDocument();
    expect(screen.getByText(/No credit was used/)).toBeInTheDocument();
  });
});

describe('AddJobPanel — typed in', () => {
  it('validates before saving and sends only the filled fields', async () => {
    api.importJob.mockResolvedValueOnce(done());
    renderWithBrand(<AddJobPanel initialMode="manual" />);
    expect(screen.getByText(/Only you can see jobs you add/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Analyst' } });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Initech' } });
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'Too short' } });
    fireEvent.change(screen.getByLabelText('Link to the job post (optional)'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    expect(screen.getByText('Add at least 50 characters of the job post.')).toBeInTheDocument();
    expect(screen.getByText(/Use a full web address/)).toBeInTheDocument();
    expect(api.importJob).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: LONG } });
    fireEvent.change(screen.getByLabelText('Link to the job post (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(api.importJob).toHaveBeenCalledWith({ manual: { title: 'Analyst', company: 'Initech', description: LONG } }, { idempotencyKey: 'idem-key' }));
  });

  function fillManual() {
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Analyst' } });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Initech' } });
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: LONG } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
  }

  it('out of credits (402 from the server): the sheet takes over with the server details', async () => {
    api.importJob.mockRejectedValueOnce(
      new RoboApiError('x', { status: 402, payload: { code: 'credits_exhausted', details: { bucket: 'job_import', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true } } }),
    );
    renderWithBrand(<AddJobPanel initialMode="manual" />);
    fillManual();
    expect(await screen.findByText("You've used all your job adds for today.")).toBeInTheDocument();
    expect(__outOfCreditsStore.get()).toEqual({ bucket: 'job_import', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true });
  });

  it('with 0 left the save still reaches the server: re-adding your own job is free', async () => {
    credits.remaining = 0;
    api.importJob.mockResolvedValueOnce(done({ matched: 'yours' }));
    renderWithBrand(<AddJobPanel initialMode="manual" />);
    fillManual();
    expect(await screen.findByRole('heading', { name: "You've already added this job" })).toBeInTheDocument();
    expect(api.importJob).toHaveBeenCalledTimes(1);
    expect(__outOfCreditsStore.get()).toBeNull();
  });
});

describe('AddedJobsList', () => {
  it('renders real fields only, the source line, tracker status and warnings', async () => {
    api.listAddedJobs.mockResolvedValueOnce(
      list([
        item({ trackerStatus: 'applied' }),
        item({ jobId: 'j2', title: 'Typed role', location: null, applyUrl: null, sourceHost: null, warnings: [{ rule: 'intl_fee_required', evidence: 'A fee is required.' }] }),
      ]),
    );
    renderWithBrand(<AddedJobsList />);
    const rows = await screen.findAllByRole('listitem', { name: undefined });
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('From careers.acme.example')).toBeInTheDocument();
    expect(screen.getByText('Typed in by you')).toBeInTheDocument();
    expect(screen.getByText('Location not listed')).toBeInTheDocument();
    expect(screen.getByText('A fee is required.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Tailor resume' })[1]).toHaveAttribute('href', '/resume?tailor=j2&from=job_import');
    // A tracked job shows its status; an untracked one offers "Save to tracker".
    expect(screen.queryByRole('button', { name: 'Save Senior Data Engineer to your tracker' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Typed role to your tracker' }));
    await waitFor(() => expect(jobsApi.saveJob).toHaveBeenCalledWith('j2'));
  });

  it('says so when saving to the tracker fails', async () => {
    api.listAddedJobs.mockResolvedValueOnce(list([item()]));
    jobsApi.saveJob.mockRejectedValueOnce(new Error('down'));
    renderWithBrand(<AddedJobsList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save Senior Data Engineer to your tracker' }));
    expect(await screen.findByText("We couldn't save this job to your tracker. Try again.")).toBeInTheDocument();
  });

  it('removes a job after confirmation', async () => {
    api.listAddedJobs.mockResolvedValue(list([item()]));
    api.removeAddedJob.mockResolvedValueOnce(undefined);
    renderWithBrand(<AddedJobsList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Senior Data Engineer' }));
    expect(screen.getByText('Remove this job from your list?', { selector: 'span' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(api.removeAddedJob).toHaveBeenCalledWith('j1'));
  });

  it('pages with the cursor', async () => {
    api.listAddedJobs.mockResolvedValueOnce(list([item()], 'c1')).mockResolvedValueOnce(list([item({ jobId: 'j9', title: 'Older role' })]));
    renderWithBrand(<AddedJobsList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Older role')).toBeInTheDocument();
    expect(api.listAddedJobs).toHaveBeenLastCalledWith({ limit: 20, cursor: 'c1' }, expect.anything());
  });

  it('shows an error with retry', async () => {
    api.listAddedJobs.mockRejectedValueOnce(new Error('down'));
    renderWithBrand(<AddedJobsList />);
    expect(await screen.findByText("We couldn't load your jobs.")).toBeInTheDocument();
    api.listAddedJobs.mockResolvedValueOnce(list([]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No jobs added yet')).toBeInTheDocument();
  });
});

describe('form helpers', () => {
  it('validateFields and toManualJob', () => {
    const v = { title: ' A ', company: 'B', location: '', applyUrl: '', description: LONG };
    expect(validateFields(v)).toEqual({});
    expect(toManualJob(v)).toEqual({ title: 'A', company: 'B', description: LONG });
    expect(validateFields({ ...v, applyUrl: 'ftp://x.example' })).toEqual({ applyUrl: 'applyUrl' });
  });
});
