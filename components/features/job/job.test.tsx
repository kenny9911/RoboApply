// WP-34 — job detail UI: every state (loading, open, closed, not found, no
// score, quick estimate, GoApply campus job with 网申 window and 届别), the
// apply flow (opens the employer page, Applied at once with inline Undo),
// the one-time apply intercept, People search links, the Company tab
// (sourced facts, "Not listed", our own open-job count), split mode and the
// CommandPalette deep link.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getJob: vi.fn(),
  getSimilarJobs: vi.fn(),
  getCompanyJobs: vi.fn(),
  getCompanyNews: vi.fn(),
  scoreJob: vi.fn(),
  applyClick: vi.fn(),
  undoApplied: vi.fn(),
  saveJob: vi.fn(),
  unsaveJob: vi.fn(),
  markApplied: vi.fn(),
  shareJob: vi.fn(),
  getKeywordCheck: vi.fn(),
  getFitAnalysis: vi.fn(),
  getCredits: vi.fn(),
  getUiState: vi.fn(),
  dismiss: vi.fn(),
  setUiValues: vi.fn(),
  addToQueue: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: api.push, replace: api.replace, prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../lib/api/jobs', () => ({
  getJob: api.getJob,
  getSimilarJobs: api.getSimilarJobs,
  getCompanyJobs: api.getCompanyJobs,
  getCompanyNews: api.getCompanyNews,
  scoreJob: api.scoreJob,
  applyClick: api.applyClick,
  undoApplied: api.undoApplied,
  saveJob: api.saveJob,
  unsaveJob: api.unsaveJob,
  markApplied: api.markApplied,
  shareJob: api.shareJob,
}));
vi.mock('../../../lib/api/match', () => ({ getKeywordCheck: api.getKeywordCheck, getFitAnalysis: api.getFitAnalysis }));
vi.mock('../../../lib/api/credits', () => ({ getCredits: api.getCredits }));
vi.mock('../../../lib/api/uiState', () => ({ getUiState: api.getUiState, dismiss: api.dismiss, setUiValues: api.setUiValues }));
vi.mock('../../../lib/api/agent', () => ({ addToQueue: api.addToQueue }));
// The share card renders nothing by design; a marker stands in so the tests can read what it is given.
vi.mock('../notify-cn', () => ({
  WechatShareCard: (p: { title: string; description?: string | null; path?: string | null }) => (
    <span data-testid="wechat-share" data-title={p.title} data-description={p.description ?? ''} data-path={p.path ?? ''} />
  ),
}));

import { RoboApiError } from '../../../lib/api/client';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import type { MatchFitView } from '../../../lib/api/contracts/match';
import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { jobHref } from '../../v3/shell/destinations';
import { JobDetailPanel } from './index';
import { payLine } from './format';
import { shouldAskBeforeApply } from '../../../hooks/job';

const NOW = '2026-10-10T12:00:00.000Z';
const EMPTY_UI = { state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null };

function detail(over: Partial<JobDetailResponse> = {}, job: Partial<JobDetailResponse['job']> = {}): JobDetailResponse {
  return {
    job: {
      id: 'j1',
      title: 'Backend Engineer',
      companyName: 'Acme',
      location: 'Austin, TX',
      workModel: 'onsite',
      employmentType: 'full_time',
      seniority: 'mid',
      pay: null,
      payText: null,
      summary: { text: 'A backend role on the payments team.', aiWritten: true },
      sections: [
        { kind: 'responsibilities', body: '- Own the payments API' },
        { kind: 'qualifications', body: '- 3+ years of Go' },
      ],
      skills: [{ skill: 'Go', kind: 'hard', required: true }],
      sponsorship: { status: 'offered', quote: 'We sponsor H-1B visas.' },
      requirements: [{ tag: 'clearance_required', quote: 'Active Secret clearance required.' }],
      applyUrl: 'https://boards.example.com/acme/1',
      postedAt: '2026-10-08T00:00:00.000Z',
      postedAtEstimated: false,
      lastSeenAt: NOW,
      closedAt: null,
      status: 'open',
      source: { name: 'Active Jobs DB', kind: 'provider', originalName: null },
      fromRecruiterBank: false,
      employerVerified: false,
      isAgency: false,
      visibility: 'public',
      badges: [{ kind: 'sponsorship', label: 'offered', quote: 'We sponsor H-1B visas.' }],
      campus: null,
      ...job,
    },
    company: {
      id: 'c1',
      name: 'Acme',
      slug: 'acme',
      logoUrl: null,
      domain: null,
      facts: { industry: { value: 'Software', source: 'provider:activejobs', asOf: '2026-10-01T00:00:00.000Z' } },
      openJobs: { value: 12, source: 'index', asOf: NOW, method: 'computed' },
    },
    fit: null,
    explanation: null,
    tracker: null,
    checklist: { saved: false, tailoredResumeId: null, coverLetterId: null, practiced: null, applied: false },
    similarIds: [],
    autofill: { supported: false, atsType: null },
    people: {
      mode: 'deeplinks_only',
      searchLinks: [
        { kind: 'role', url: 'https://www.linkedin.com/search/results/people/?keywords=%22Acme%22+Backend+Engineer', params: { company: 'Acme', title: 'Backend Engineer' } },
        { kind: 'past_companies', url: 'https://www.linkedin.com/search/results/people/?keywords=x', params: { company: 'Acme', companies: 'Globex' } },
        { kind: 'schools', url: null, params: { company: 'Acme', schools: '' } },
      ],
    },
    marketMeta: {},
    ...over,
  };
}

function fit(over: Partial<MatchFitView> = {}): MatchFitView {
  return {
    jobId: 'j1',
    score: 72,
    tier: 'good',
    kind: 'pre',
    dimensions: [],
    summary: null,
    strengths: [],
    gaps: [],
    keywordsMatched: [],
    keywordsMissing: [],
    skills: { aligned: [], missing: [], listed: 0 },
    topOverlap: null,
    topGap: null,
    scoredAt: NOW,
    resumeVariantId: null,
    estimateReason: 'no_resume',
    summaryLocaleStale: false,
    cached: true,
    ...over,
  };
}

let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getJob.mockResolvedValue(detail());
  api.getSimilarJobs.mockResolvedValue({ items: [] });
  api.getCompanyJobs.mockResolvedValue({ items: [], cursor: null });
  api.scoreJob.mockResolvedValue({ fit: fit() });
  api.getKeywordCheck.mockResolvedValue({ rows: [] });
  api.getCredits.mockResolvedValue({ summary: { buckets: {} }, practice: { balance: 2 } });
  api.getUiState.mockResolvedValue(EMPTY_UI);
  api.dismiss.mockResolvedValue(EMPTY_UI);
  api.setUiValues.mockResolvedValue(EMPTY_UI);
  api.applyClick.mockResolvedValue({ applyUrl: 'https://boards.example.com/acme/1', atsType: null, extensionSupported: false, trackerEntryId: 't1' });
  api.undoApplied.mockResolvedValue({ tracker: null });
  api.saveJob.mockResolvedValue({ tracker: { id: 't1', status: 'bookmarked', dateApplied: null } });
  api.shareJob.mockResolvedValue({ url: 'https://www.roboapply.io/jobs/j1', public: false });
  openSpy = vi.fn(() => null);
  vi.stubGlobal('open', openSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_FLAGS = { 'ai.text': true, 'jobs.recommendations': true } as const;
const render = (ui = <JobDetailPanel jobId="j1" mode="page" />, opts: Parameters<typeof renderWithBrand>[1] = { flags: { ...BASE_FLAGS, copilot: true, hiringContacts: 'deeplinks_only' } }) => renderWithBrand(ui, opts);

const similarItem = (over: Record<string, unknown> = {}) => ({
  jobId: 'j9',
  title: 'Platform Engineer',
  company: { id: 'c2', name: 'Globex', logoUrl: null },
  location: null,
  workModel: null,
  employmentType: null,
  seniority: null,
  pay: null,
  payText: null,
  postedAt: null,
  lastSeenAt: null,
  source: { name: 'x', kind: 'provider' },
  fromRecruiterBank: false,
  employerVerified: false,
  isAgency: false,
  badges: [],
  fit: null,
  tracker: null,
  ...over,
});

describe('states', () => {
  it('loading shows a skeleton, then the job', async () => {
    render();
    expect(screen.getByTestId('job-loading')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('heading', { level: 1, name: 'Backend Engineer' })).toBeInTheDocument();
  });

  it('open job: honest facts, AI-labelled summary, quoted work-authorization lines, verbatim sections', async () => {
    render();
    await screen.findByTestId('job-detail');
    expect(screen.getByTestId('job-pay')).toHaveTextContent('Pay not listed');
    expect(screen.getByTestId('job-source')).toHaveTextContent('From Active Jobs DB');
    expect(screen.getByText('On-site')).toBeInTheDocument();
    expect(within(screen.getByTestId('job-summary')).getByText('Summary written by AI from the job post')).toBeInTheDocument();
    const auth = screen.getByTestId('job-work-auth');
    expect(auth).toHaveTextContent('Visa sponsorship offered');
    expect(auth).toHaveTextContent('The post says: “We sponsor H-1B visas.”');
    expect(auth).toHaveTextContent('The post says: “Active Secret clearance required.”');
    expect(screen.getByRole('heading', { name: 'Responsibilities' })).toBeInTheDocument();
    expect(screen.getByText('Own the payments API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask about this job' })).toBeInTheDocument();
    // RoboApply: no AI badge (it labels AI text with its own line).
    expect(screen.getByTestId('job-summary').querySelector('[data-ai-label]')).toBeNull();
  });

  it('quick estimate: the fit block says so and carries the honesty line', async () => {
    render();
    expect(await screen.findByText('Quick estimate')).toBeInTheDocument();
    expect(screen.getAllByText('This is not your chance of getting hired.').length).toBeGreaterThan(0);
  });

  it('no score: no number is invented', async () => {
    api.scoreJob.mockResolvedValue({ fit: fit({ score: null, tier: null }) });
    render();
    await screen.findByTestId('job-fit');
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });

  it('pay states: range, exact, stated-only text', () => {
    expect(payLine({ min: 100000, max: 150000, currency: 'USD', period: 'year', text: null }, 'en')).toEqual({ kind: 'range', min: '$100,000', max: '$150,000', period: 'year' });
    expect(payLine({ min: 90000, max: 90000, currency: 'USD', period: 'year', text: null }, 'en')).toMatchObject({ kind: 'exact' });
    expect(payLine({ min: null, max: 25, currency: 'USD', period: 'hour', text: null }, 'en')).toMatchObject({ kind: 'upTo' });
    expect(payLine(null, 'en')).toBeNull();
  });

  it('closed job: "no longer listed (last seen …)", similar jobs, no apply button, tracker kept', async () => {
    api.getJob.mockResolvedValue(
      detail({ tracker: { id: 't1', status: 'applied', dateApplied: NOW }, checklist: { saved: true, tailoredResumeId: null, coverLetterId: null, practiced: null, applied: true } }, { status: 'closed', closedAt: NOW, lastSeenAt: '2026-10-05T00:00:00.000Z' }),
    );
    api.getSimilarJobs.mockResolvedValue({
      items: [
        similarItem(),
        similarItem({ jobId: 'j8', title: 'Site Reliability Engineer', pay: { min: 1200, max: 1500, currency: 'USD', period: 'week', text: null }, fit: { tier: 'good', score: 71, kind: 'pre', topGap: null, topOverlap: null } }),
        similarItem({ jobId: 'j7', title: 'Data Engineer', payText: 'Competitive' }),
      ],
    });
    render();
    const closed = await screen.findByTestId('job-closed');
    expect(closed).toHaveTextContent('This job is no longer listed');
    expect(closed).toHaveTextContent(/Last seen Oct 5, 2026/);
    expect(closed).toHaveTextContent('Anything you saved for it stays in Applications.');
    expect(screen.queryByTestId('apply-button')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Similar jobs you can still apply to' })).toBeInTheDocument();
    const card = await screen.findByText('Platform Engineer');
    expect(card.closest('a')).toHaveTextContent('Pay not listed');
    expect(card.closest('a')).toHaveTextContent('Fit: —');
    // Weekly pay and pay stated in words are shown as stated, never "not listed".
    expect(screen.getByText('Site Reliability Engineer').closest('a')).toHaveTextContent('$1,200 – $1,500 a week');
    expect(screen.getByText('Data Engineer').closest('a')).toHaveTextContent('Pay as stated: Competitive');
    // A fit score on a card carries the honesty line.
    const similar = screen.getByTestId('similar-jobs');
    expect(within(similar).getByText('Good fit · 71 / 100 · Quick estimate')).toBeInTheDocument();
    expect(within(similar).getByText('This is not your chance of getting hired.')).toBeInTheDocument();
    fireEvent.click(card);
    expect(api.push).toHaveBeenCalledWith('/jobs/j9');
  });

  it('jobs.recommendations off (GoApply, recruitment info off): no similar jobs section and no request', async () => {
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: { 'ai.text': true } });
    await screen.findByTestId('job-detail');
    expect(screen.queryByTestId('similar-jobs')).toBeNull();
    expect(api.getSimilarJobs).not.toHaveBeenCalled();
  });

  it('not found (market mismatch or someone else’s import)', async () => {
    api.getJob.mockRejectedValue(new RoboApiError('Job not found.', { code: 'not_found', status: 404, payload: { code: 'not_found' } }));
    render();
    expect(await screen.findByTestId('job-not-found')).toHaveTextContent("This job isn't available");
    expect(screen.getByRole('link', { name: 'Back to jobs' })).toHaveAttribute('href', '/jobs');
  });

  it('a failed load offers a retry', async () => {
    api.getJob.mockRejectedValueOnce(new RoboApiError('x', { code: 'internal_error', status: 500 })).mockRejectedValueOnce(new RoboApiError('x', { code: 'internal_error', status: 500 }));
    render();
    expect(await screen.findByTestId('job-error', {}, { timeout: 4000 })).toBeInTheDocument();
    api.getJob.mockResolvedValue(detail());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('job-detail')).toBeInTheDocument();
  });

  it('GoApply campus job: the employer’s 网申 window and 届别 with the official link; AI badge on the summary', async () => {
    api.getJob.mockResolvedValue(
      detail({}, {
        companyName: '示例科技',
        seniority: 'intern_newgrad',
        campus: {
          title: '2027届校园招聘',
          graduationClass: '2027届',
          classYears: [2027],
          applyOpensAt: '2026-09-01T00:00:00.000Z',
          applyClosesAt: '2026-11-30T00:00:00.000Z',
          officialUrl: 'https://campus.example.cn/2027',
          verifiedAt: NOW,
          needsCheck: false,
        },
      }),
    );
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    const campus = await screen.findByTestId('campus-window');
    expect(campus).toHaveTextContent('2027届 campus hiring at 示例科技');
    expect(campus).toHaveTextContent('Applications open Sep 1, 2026 – Nov 30, 2026');
    expect(campus).toHaveTextContent('For the class of 2027');
    expect(within(campus).getByRole('link')).toHaveAttribute('href', 'https://campus.example.cn/2027');
    expect(screen.getByTestId('job-summary').querySelector('[data-ai-label="text"]')).not.toBeNull();
    // No LinkedIn People tab on GoApply without the 内推 hub.
    expect(screen.queryByRole('tab', { name: 'People' })).toBeNull();
  });
});

// INT-06 (wave3 WP-93 #15 and #7, wave5 WP-93 #24).
describe('a job the user added', () => {
  const imported = (job: Partial<JobDetailResponse['job']> = {}) =>
    detail({}, { source: { name: '', kind: 'user_import', originalName: null }, visibility: 'private', applyUrl: '', ...job });

  it('the source line reads "Added by you" and says only the user can see it', async () => {
    api.getJob.mockResolvedValue(imported({ applyUrl: 'https://careers.acme.example/jobs/42' }));
    render();
    await screen.findByTestId('job-detail');
    expect(screen.getByTestId('job-source')).toHaveTextContent('Added by you');
    expect(screen.getByTestId('job-header')).toHaveTextContent('Only you can see this job');
    // With a link it applies like any other job.
    expect(screen.getByTestId('apply-button')).toHaveTextContent('Apply on company site');
    expect(screen.queryByTestId('i-applied-button')).toBeNull();
  });

  it('with no link: no "Apply on company site" anywhere; "I applied" records what the user says, with Undo', async () => {
    api.getJob.mockResolvedValue(imported());
    api.markApplied.mockResolvedValue({ tracker: { id: 't1', status: 'applied', dateApplied: NOW } });
    render();
    await screen.findByTestId('job-detail');
    expect(screen.queryByTestId('apply-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply on company site' })).toBeNull();
    expect(screen.getByTestId('no-apply-link')).toHaveTextContent('You added this job without a link.');
    fireEvent.click(screen.getByTestId('i-applied-button'));
    await waitFor(() => expect(api.markApplied).toHaveBeenCalledWith('j1', {}));
    expect(api.applyClick).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    // Once it is marked applied the button is gone, and so is the line that points at it.
    await waitFor(() => expect(screen.queryByTestId('i-applied-button')).toBeNull());
    expect(screen.queryByTestId('no-apply-link')).toBeNull();
    expect(screen.getByTestId('job-header')).not.toHaveTextContent('choose “I applied”');
  });

  it('FIX-3: after "Undo · I didn\'t apply" the header stops saying "In your applications" and takes the server\'s answer', async () => {
    const d = imported();
    const saved = { ...d, tracker: { id: 't1', status: 'bookmarked', dateApplied: null }, checklist: { ...d.checklist, saved: true, applied: false } };
    const applied = { ...d, tracker: { id: 't1', status: 'applied', dateApplied: NOW }, checklist: { ...d.checklist, saved: true, applied: true } };
    api.getJob.mockResolvedValueOnce(saved);
    api.markApplied.mockResolvedValue({ tracker: { id: 't1', status: 'applied', dateApplied: NOW } });
    render();
    await screen.findByTestId('job-detail');
    // "I applied": the page data now says applied.
    api.getJob.mockResolvedValue(applied);
    fireEvent.click(screen.getByTestId('i-applied-button'));
    expect(await screen.findByRole('button', { name: 'In your applications' })).toBeDisabled();
    // Undo: the server puts it back to Saved; the page data read after the undo is slow.
    let release!: (v: unknown) => void;
    api.undoApplied.mockResolvedValue({ tracker: { id: 't1', status: 'bookmarked', dateApplied: null } });
    api.getJob.mockReturnValue(new Promise((r) => (release = r)));
    fireEvent.click(within(await screen.findByTestId('undo-bar')).getByRole('button', { name: "Undo · I didn't apply" }));
    await waitFor(() => expect(api.undoApplied).toHaveBeenCalledWith('j1'));
    // Even before the fresh data arrives the stale "In your applications" is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'In your applications' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument();
    release(saved);
    await waitFor(() => expect(screen.getByTestId('i-applied-button')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'In your applications' })).toBeNull();
  });

  it('already applied when the page opens: no "I applied" button and no line pointing at it', async () => {
    const d = imported();
    api.getJob.mockResolvedValue({ ...d, checklist: { ...d.checklist, applied: true } });
    render();
    await screen.findByTestId('job-detail');
    expect(screen.queryByTestId('i-applied-button')).toBeNull();
    expect(screen.queryByTestId('no-apply-link')).toBeNull();
  });

  it('a listed job with no link keeps the plain "no application link" line', async () => {
    api.getJob.mockResolvedValue(detail({}, { applyUrl: '' }));
    render();
    await screen.findByTestId('job-detail');
    expect(screen.getByTestId('no-apply-link')).toHaveTextContent('This post has no application link.');
    expect(screen.getByTestId('i-applied-button')).toBeInTheDocument();
  });
});

describe('GoApply: one pay line, one set of dates (the market block has them)', () => {
  const CN_META = {
    cn: {
      sourceLine: { kind: 'source', sourceName: 'GoHire', originalSourceName: null, licence: null },
      salary: { text: '15-25K·14薪', disclosed: true },
      updatedAt: '2026-10-08T00:00:00.000Z',
      lastCheckedAt: NOW,
      expiresAt: null,
      tags: [],
      classYears: [],
      warnings: [],
    },
  };
  const cnJob = { companyName: '示例科技', location: '上海', pay: { min: 15000, max: 25000, currency: 'CNY', period: 'month' as const, text: '15-25K·14薪' }, payText: '15-25K·14薪' };

  it('the header drops its pay, posted, last-checked and source lines; JobMetaCn shows each once', async () => {
    api.getJob.mockResolvedValue(detail({ marketMeta: CN_META }, cnJob));
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    await screen.findByTestId('job-detail');
    const header = screen.getByTestId('job-header');
    expect(within(header).queryByTestId('job-pay')).toBeNull();
    expect(within(header).queryByTestId('job-source')).toBeNull();
    expect(header).not.toHaveTextContent('Posted');
    expect(header).not.toHaveTextContent('Last checked');
    const block = screen.getByTestId('job-meta-cn');
    expect(within(block).getAllByText('15-25K·14薪')).toHaveLength(1);
    expect(screen.getAllByText('15-25K·14薪')).toHaveLength(1);
    expect(block.querySelectorAll('dd')[2]).toHaveTextContent(/^Updated /);
    expect(block).toHaveTextContent('Source: GoHire');
  });

  it('a GoApply job with no market block keeps the header lines (nothing is dropped without its replacement)', async () => {
    api.getJob.mockResolvedValue(detail({ marketMeta: {} }, cnJob));
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    await screen.findByTestId('job-detail');
    expect(screen.getByTestId('job-pay')).toBeInTheDocument();
    expect(screen.getByTestId('job-source')).toBeInTheDocument();
  });

  it('RoboApply is unchanged even when a job carries cn meta', async () => {
    api.getJob.mockResolvedValue(detail({ marketMeta: CN_META }));
    render();
    await screen.findByTestId('job-detail');
    expect(screen.getByTestId('job-pay')).toHaveTextContent('Pay not listed');
    expect(screen.getByTestId('job-source')).toBeInTheDocument();
    expect(screen.getByTestId('job-header')).toHaveTextContent('Posted');
  });

  it('a GoApply job the user added says "Added by you" once (never "Source not listed") and "Only you can see this job"', async () => {
    const own = { cn: { ...CN_META.cn, sourceLine: { kind: 'source', sourceName: null, originalSourceName: null, licence: null } } };
    api.getJob.mockResolvedValue(detail({ marketMeta: own }, { ...cnJob, source: { name: '', kind: 'user_import', originalName: null }, visibility: 'private' }));
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    const panel = await screen.findByTestId('job-detail');
    // One visible source line, in the market block (its screen-reader term repeats the same words).
    expect(within(panel).getAllByTestId('cn-source')).toHaveLength(1);
    expect(screen.getByTestId('cn-source')).toHaveTextContent('Added by you');
    expect(panel).not.toHaveTextContent('Source not listed');
    const header = screen.getByTestId('job-header');
    expect(header).not.toHaveTextContent('Added by you');
    expect(header).toHaveTextContent('Only you can see this job');
    expect(within(header).queryByTestId('job-source')).toBeNull();
    expect(within(header).queryByTestId('job-pay')).toBeNull();
  });

  it('the pay, dates and source stay on screen on the Company tab (the market block sits above the tabs)', async () => {
    api.getJob.mockResolvedValue(detail({ marketMeta: CN_META }, cnJob));
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    await screen.findByTestId('job-detail');
    // On Overview the block is there once, outside the tab's own content.
    expect(screen.getAllByTestId('job-meta-cn')).toHaveLength(1);
    expect(within(screen.getByTestId('job-overview')).queryByTestId('job-meta-cn')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Company' }));
    await screen.findByTestId('company-tab');
    expect(screen.queryByTestId('job-overview')).toBeNull();
    const block = screen.getByTestId('job-meta-cn');
    expect(block).toHaveTextContent('15-25K·14薪');
    expect(block).toHaveTextContent('Source: GoHire');
    expect(block).toHaveTextContent(/Updated /);
    expect(block).toHaveTextContent(/Last checked /);
    expect(screen.getAllByText('15-25K·14薪')).toHaveLength(1);
  });

  it('RoboApply keeps its market block inside the Overview tab', async () => {
    api.getJob.mockResolvedValue(detail({ marketMeta: CN_META }));
    render();
    await screen.findByTestId('job-detail');
    expect(screen.queryByTestId('job-meta-cn')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Company' }));
    await screen.findByTestId('company-tab');
    // The header still carries the facts there.
    expect(screen.getByTestId('job-pay')).toBeInTheDocument();
    expect(screen.getByTestId('job-source')).toBeInTheDocument();
  });
});

describe('WeChat share card (GoApply only)', () => {
  it('GoApply: "{title} · {company}", the place and the pay as listed, sharing /jobs/{id}', async () => {
    api.getJob.mockResolvedValue({ ...detail({}, { title: '数据分析师', location: '上海', payText: '15-25K·14薪' }), company: { ...detail().company, name: '示例科技' } });
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    const card = await screen.findByTestId('wechat-share');
    expect(card).toHaveAttribute('data-title', '数据分析师 · 示例科技');
    expect(card).toHaveAttribute('data-description', '上海 · 15-25K·14薪');
    expect(card).toHaveAttribute('data-path', '/jobs/j1');
  });

  it('no listed pay: the description is the place alone, never a 0 or a guess', async () => {
    api.getJob.mockResolvedValue(detail({}, { location: '上海', pay: { min: 0, max: 0, currency: 'CNY', period: 'month', text: null }, payText: null }));
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    const card = await screen.findByTestId('wechat-share');
    expect(card).toHaveAttribute('data-description', '上海');
    expect(card.getAttribute('data-description')).not.toMatch(/0/);
  });

  it('neither place nor pay: no description (the card falls back to its own default line)', async () => {
    api.getJob.mockResolvedValue(detail({}, { location: null, pay: null, payText: null }));
    render(<JobDetailPanel jobId="j1" mode="split" />, { brand: 'goapply', flags: {} });
    expect(await screen.findByTestId('wechat-share')).toHaveAttribute('data-description', '');
  });

  it('listed figures with no pay text are written out as listed', async () => {
    api.getJob.mockResolvedValue(detail({}, { location: 'Shanghai', pay: { min: 15000, max: 25000, currency: 'CNY', period: 'month', text: null }, payText: null }));
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: {} });
    const card = await screen.findByTestId('wechat-share');
    expect(card.getAttribute('data-description')).toMatch(/^Shanghai · .*15,000.*25,000.* a month$/);
  });

  it('RoboApply: no share card', async () => {
    render();
    await screen.findByTestId('job-detail');
    expect(screen.queryByTestId('wechat-share')).toBeNull();
  });
});

describe('apply flow (D1, R1/C11)', () => {
  it('a click that changed nothing (already applied elsewhere) offers no Undo', async () => {
    api.getUiState.mockResolvedValue({ ...EMPTY_UI, state: { ...EMPTY_UI.state, values: { 'applyIntercept.never': true } } });
    api.applyClick.mockResolvedValue({ applyUrl: 'https://boards.example.com/acme/1', atsType: null, extensionSupported: false, trackerEntryId: 't1', alreadyApplied: true });
    render();
    await screen.findByTestId('job-detail');
    await waitFor(() => expect(api.getUiState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-button'));
    await waitFor(() => expect(api.applyClick).toHaveBeenCalledWith('j1'));
    await act(async () => {});
    expect(screen.queryByTestId('undo-bar')).toBeNull();
  });

  it('GoApply without a text model: no tailor, cover letter or practice entry, and no "Tailor first" sheet', async () => {
    render(<JobDetailPanel jobId="j1" mode="page" />, { brand: 'goapply', flags: { 'jobs.recommendations': true } });
    const list = await screen.findByTestId('job-checklist');
    expect(within(list).queryByRole('button', { name: 'Tailor my resume' })).toBeNull();
    expect(within(list).queryByRole('link', { name: 'Write a cover letter' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Practice for this job' })).toBeNull();
    await waitFor(() => expect(api.getUiState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-button'));
    await waitFor(() => expect(api.applyClick).toHaveBeenCalledWith('j1'));
    expect(screen.queryByTestId('apply-intercept')).toBeNull();
  });

  it('first apply without a tailored resume asks once; "Apply with my current resume" opens the employer page and offers Undo', async () => {
    render();
    await screen.findByTestId('job-detail');
    await waitFor(() => expect(api.getUiState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-button'));
    const sheet = await screen.findByTestId('apply-intercept');
    expect(api.dismiss).toHaveBeenCalledWith(['applyIntercept:j1']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply with my current resume' }));
    await waitFor(() => expect(api.applyClick).toHaveBeenCalledWith('j1'));
    expect(openSpy).toHaveBeenCalledWith('https://boards.example.com/acme/1', '_blank', 'noopener,noreferrer');
    const undo = await screen.findByTestId('undo-bar');
    expect(undo).toHaveTextContent('Moved to Applications.');
    fireEvent.click(within(undo).getByRole('button', { name: "Undo · I didn't apply" }));
    await waitFor(() => expect(api.undoApplied).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(screen.queryByTestId('undo-bar')).toBeNull());
  });

  it('not asked again for the same job, after "Don\'t ask again", or with a tailored resume', () => {
    const state = EMPTY_UI.state;
    expect(shouldAskBeforeApply(state, 'j1', false)).toBe(true);
    expect(shouldAskBeforeApply({ ...state, dismissals: { 'applyIntercept:j1': { count: 1, at: NOW } } }, 'j1', false)).toBe(false);
    expect(shouldAskBeforeApply({ ...state, values: { 'applyIntercept.never': true } }, 'j1', false)).toBe(false);
    expect(shouldAskBeforeApply(state, 'j1', true)).toBe(false);
    expect(shouldAskBeforeApply(null, 'j1', false)).toBe(false);
  });

  it('an already-asked job applies directly', async () => {
    api.getUiState.mockResolvedValue({ ...EMPTY_UI, state: { ...EMPTY_UI.state, dismissals: { 'applyIntercept:j1': { count: 1, at: NOW } } } });
    render();
    await screen.findByTestId('job-detail');
    await waitFor(() => expect(api.getUiState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-button'));
    await waitFor(() => expect(api.applyClick).toHaveBeenCalled());
    expect(screen.queryByTestId('apply-intercept')).toBeNull();
  });

  it('"Don\'t ask again" remembers the choice and applies; "Tailor my resume first" opens tailoring', async () => {
    render();
    await screen.findByTestId('job-detail');
    await waitFor(() => expect(api.getUiState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-button'));
    fireEvent.click(within(await screen.findByTestId('apply-intercept')).getByRole('button', { name: "Don't ask again" }));
    await waitFor(() => expect(api.setUiValues).toHaveBeenCalledWith({ 'applyIntercept.never': true }));
    await waitFor(() => expect(api.applyClick).toHaveBeenCalled());
  });

  it('"Tailor my resume first" goes to tailoring for this job', async () => {
    render();
    await screen.findByTestId('job-detail');
    await waitFor(() => expect(api.getUiState).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByTestId('apply-button'));
    fireEvent.click(within(await screen.findByTestId('apply-intercept')).getByRole('button', { name: 'Tailor my resume first' }));
    expect(api.push).toHaveBeenCalledWith('/resume?tailor=j1&from=job_detail');
    expect(api.applyClick).not.toHaveBeenCalled();
  });

  it('save, then the checklist marks Saved; share copies the link', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render();
    await screen.findByTestId('job-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Save for later', pressed: false }));
    await waitFor(() => expect(api.saveJob).toHaveBeenCalledWith('j1'));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://www.roboapply.io/jobs/j1'));
  });
});

describe('checklist, People, Company', () => {
  it('Saved → Resume tailored → Practiced → Applied with actions and credit lines; Practiced says we cannot tell yet', async () => {
    render(<JobDetailPanel jobId="j1" mode="page" />, { flags: { ...BASE_FLAGS, interviewBank: true, hiringContacts: 'deeplinks_only' } });
    const list = await screen.findByTestId('job-checklist');
    expect(within(list).getByText('Get ready for this job')).toBeInTheDocument();
    for (const step of ['Saved', 'Resume tailored', 'Practiced', 'Applied']) expect(within(list).getByText(step)).toBeInTheDocument();
    expect(within(list).getByText("We can't tell yet")).toBeInTheDocument();
    expect(await within(list).findByText('2 practice credits left')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Practice questions for Acme' })).toHaveAttribute('href', '/practice/questions/acme?job=j1');
    fireEvent.click(within(list).getByRole('button', { name: 'Practice for this job' }));
    expect(api.push).toHaveBeenCalledWith('/practice?job=j1&from=job_detail');
  });

  it('practice questions link only with interviewBank; Ready to apply only with agent', async () => {
    render();
    const list = await screen.findByTestId('job-checklist');
    expect(within(list).queryByText(/Practice questions for/)).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Add to Ready to apply' })).toBeNull();
  });

  it('People tab: LinkedIn searches the user opens, and a hint when the profile lacks schools', async () => {
    render();
    await screen.findByTestId('job-detail');
    fireEvent.click(screen.getByRole('tab', { name: 'People' }));
    const people = await screen.findByTestId('job-people');
    const role = within(people).getByRole('link', { name: /People working as Backend Engineer at Acme/ });
    expect(role).toHaveAttribute('href', expect.stringMatching(/^https:\/\/www\.linkedin\.com\/search\/results\/people\//));
    expect(role).toHaveAttribute('target', '_blank');
    expect(people.querySelector('[data-people-missing="schools"]')).toHaveTextContent('Add your schools to your profile');
  });

  it('Company tab: sourced facts with their source, "Not listed" for the rest, our open-job count', async () => {
    render();
    await screen.findByTestId('job-detail');
    fireEvent.click(screen.getByRole('tab', { name: 'Company' }));
    const tab = await screen.findByTestId('company-tab');
    expect(tab.querySelector('[data-fact="industry"]')).toHaveTextContent('Software');
    expect(tab.querySelector('[data-fact="industry"] [data-source-note]')).not.toBeNull();
    expect(tab.querySelector('[data-fact="size"]')).toHaveTextContent('Not listed');
    expect(screen.getByTestId('company-open-jobs')).toHaveTextContent('12 open jobs at Acme in RoboApply');
    // No news block while the V2 flag is off.
    expect(screen.queryByTestId('company-news')).toBeNull();
    expect(api.getCompanyNews).not.toHaveBeenCalled();
  });
});

describe('split mode and deep links', () => {
  it('split mode renders an h2 title and a Close button', async () => {
    const onClose = vi.fn();
    render(<JobDetailPanel jobId="j1" mode="split" onClose={onClose} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Backend Engineer' })).toBeInTheDocument();
    expect(screen.getByTestId('job-detail')).toHaveAttribute('data-mode', 'split');
    expect(screen.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/jobs/j1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('?tab=people (the Assistant\'s People link) opens the People tab', async () => {
    window.history.replaceState(null, '', '/jobs/j1?tab=people');
    try {
      render();
      expect(await screen.findByTestId('job-people')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'People' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('?tab=people stays on Overview when this user has no People tab', async () => {
    window.history.replaceState(null, '', '/jobs/j1?tab=people');
    try {
      render(<JobDetailPanel jobId="j1" mode="page" />, { flags: { ...BASE_FLAGS, hiringContacts: 'off' } });
      await screen.findByTestId('job-detail');
      expect(screen.queryByRole('tab', { name: 'People' })).toBeNull();
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('CommandPalette job hits land on /jobs/[id], which renders the panel in page mode', async () => {
    expect(jobHref('j1', true)).toBe('/jobs/j1');
    const { default: Page } = await import('../../../app/(auth)/jobs/[id]/page');
    render(await Page({ params: Promise.resolve({ id: 'j1' }) }));
    expect(await screen.findByTestId('job-detail')).toHaveAttribute('data-mode', 'page');
    expect(api.getJob).toHaveBeenCalledWith('j1', expect.anything());
  });
});
