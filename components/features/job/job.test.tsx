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
    expect(within(list).getByRole('link', { name: 'Practice questions for Acme' })).toHaveAttribute('href', '/practice/questions/acme');
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

  it('CommandPalette job hits land on /jobs/[id], which renders the panel in page mode', async () => {
    expect(jobHref('j1', true)).toBe('/jobs/j1');
    const { default: Page } = await import('../../../app/(auth)/jobs/[id]/page');
    render(await Page({ params: Promise.resolve({ id: 'j1' }) }));
    expect(await screen.findByTestId('job-detail')).toHaveAttribute('data-mode', 'page');
    expect(api.getJob).toHaveBeenCalledWith('j1', expect.anything());
  });
});
