// The two-screen start (/onboarding/start) at 375 px, through the real lib/api
// wrappers against a fetch double (no network): who sees it, what the resume
// fills in, the exact order and bodies of the saves, what a failure in the
// middle leaves, and the path without a resume. Fictional data only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return {
    ...real,
    usePathname: () => '/onboarding/start',
    useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
const tracked = vi.hoisted(() => [] as Array<[string, Record<string, unknown> | undefined]>);
vi.mock('../../../../lib/analytics', async (orig) => {
  const real = await orig<typeof import('../../../../lib/analytics')>();
  return { ...real, track: (name: string, props?: Record<string, unknown>) => tracked.push([name, props]) };
});
const resumes = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string }>, upload: vi.fn() }));
vi.mock('../../../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: resumes.list } }),
  useUploadResumeMutation: () => ({ isPending: false, mutateAsync: resumes.upload }),
}));
const auth = vi.hoisted(() => ({ refresh: vi.fn(async () => null) }));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({ status: 'authenticated', refresh: auth.refresh, me: null }),
}));

import OnboardingIndexPage from '../../../../app/(onboarding)/onboarding/page';
import { TAXONOMY_TREE, fail, installFetch, ok, renderWith, type Route } from '../../filters/filters.testkit';
import { ExpressOnboarding } from './ExpressOnboarding';

const P = '/api/v1/roboapply/onboarding';

function state(over: Record<string, unknown> = {}) {
  return {
    brand: 'roboapply',
    stage: 'situation',
    nextRoute: '/onboarding/situation',
    branch: null,
    answers: {},
    entry: null,
    completed: false,
    progress: { total: 5, stepsLeft: 5, leftEarly: null },
    defaults: { country: 'US' },
    firstValueRoute: '/jobs',
    ...over,
  };
}

const PHASES = ['reading', 'saving', 'searching', 'comparing', 'ranking'] as const;
function sse(events: Array<[string, unknown]>) {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const searchDone = (over: Record<string, unknown> = {}) =>
  sse([...PHASES.map((phase): [string, unknown] => ['phase', { phase }]), ['done', { jobCount: 4, topJobIds: ['j1'], continuedInBackground: false, ...over }]]);

/** What the resume suggests: one title the role list knows, senior level. */
const SUGGESTED = { suggestedSeniority: ['senior'], suggestedTaxonomyIds: ['backend_engineer'], suggestedSkills: ['go'], profileDraft: { targetRoles: ['Senior Backend Engineer'], years: 7, aiSuggested: false } };

/**
 * The onboarding API as the stage machine behaves: each save moves the stage,
 * and GET /state reports it (so a re-read in the middle of "Find my jobs"
 * shows a user who is no longer new). `over` replaces single routes.
 */
function server(over: Record<string, Route> = {}, opts: { state?: Record<string, unknown>; suggested?: unknown } = {}) {
  let stage = 'situation';
  const at = (next: string, body: unknown) => {
    stage = next;
    return ok(body);
  };
  return installFetch({
    [`GET ${P}/state`]: () => ok(state({ stage, nextRoute: stage === 'done' ? null : stage === 'tour' ? '/jobs' : `/onboarding/${stage}`, completed: stage === 'done', ...opts.state })),
    'GET /api/v1/roboapply/compliance/consents': () => ok({ items: [] }),
    'GET /api/v1/roboapply/taxonomy': () => ok(TAXONOMY_TREE),
    [`GET ${P}/title-suggest`]: () => ok({ items: [] }),
    [`POST ${P}/resume`]: () => ok(opts.suggested ?? SUGGESTED),
    [`PUT ${P}/steps/situation`]: () => at('basics', { stage: 'basics', nextStage: 'basics', nextRoute: '/onboarding/basics' }),
    [`PUT ${P}/steps/basics`]: () => at('resume', { stage: 'resume', nextStage: 'resume', nextRoute: '/onboarding/resume' }),
    [`PUT ${P}/steps/goal`]: () => at('preferences', { stage: 'preferences', nextStage: 'preferences', nextRoute: '/onboarding/preferences' }),
    [`PUT ${P}/steps/preferences`]: () => at('resume', { stage: 'resume', nextStage: 'resume', nextRoute: '/onboarding/resume' }),
    [`PUT ${P}/steps/resume`]: () => at('matching', { stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' }),
    [`POST ${P}/match`]: () => {
      stage = 'confirm';
      return searchDone();
    },
    [`POST ${P}/confirm`]: () => at('tour', { stage: 'tour', nextRoute: '/jobs' }),
    [`POST ${P}/complete`]: () => at('done', { stage: 'done', nextRoute: '/jobs' }),
    [`POST ${P}/skip`]: () => ok({ stage: 'done', nextRoute: '/jobs' }),
    ...over,
  });
}

/** The onboarding writes, in the order they were sent ("PUT /steps/basics", …). */
const writes = (net: ReturnType<typeof installFetch>) => net.writes().filter((c) => c.path.startsWith(P)).map((c) => `${c.method} ${c.path.slice(P.length)}`);
const bodyOf = (net: ReturnType<typeof installFetch>, method: string, path: string, nth = 0) => net.to(method, `${P}${path}`)[nth]?.body;

/** Screen 1 → screen 2 with the account's resume "Sample resume" (rv1). */
async function continueWithResume() {
  resumes.list = [{ id: 'rv1', name: 'Sample resume' }];
  const select = await screen.findByLabelText('Your resumes', { selector: 'select' });
  await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
  fireEvent.change(select, { target: { value: 'rv1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use this resume' }));
  expect(screen.getByText(/Ready: Sample resume/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return screen.findByRole('heading', { name: "Is this what you're looking for?" });
}

/** Screen 1 → screen 2 with no resume. */
async function continueWithoutResume() {
  fireEvent.click(await screen.findByRole('button', { name: "I don't have a resume yet" }));
  return screen.findByRole('heading', { name: "Is this what you're looking for?" });
}

/** "Internship" is both an experience level and a job type: each is found in its own group. */
const level = (name: string) => within(screen.getByRole('group', { name: 'Experience level' })).getByRole('button', { name });
const jobType = (name: string) => within(screen.getByRole('group', { name: 'Job type' })).getByRole('button', { name });

function addTitle(title: string) {
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
  auth.refresh.mockClear();
  tracked.length = 0;
  resumes.list = [];
  resumes.upload.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  window.dispatchEvent(new Event('resize'));
});
afterEach(() => vi.unstubAllGlobals());

describe('who sees /onboarding/start', () => {
  it('a new RoboApply user: the resume screen, with the way to the long screens and "Finish later"', async () => {
    const net = server();
    renderWith(<ExpressOnboarding />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Start with your resume' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    // The long flow's intake, whole: its doors, its privacy line, its LinkedIn how-to (never a URL import).
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this text' })).toBeInTheDocument();
    expect(screen.getByText(/Save to PDF/)).toBeInTheDocument();
    expect(screen.getByText(/Your resume is used to rank jobs and draft materials for you\. It is not shared with employers unless you send it\./)).toBeInTheDocument();
    // This screen's own words on its two buttons (the long screen's are not shown here).
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: "I don't have a resume yet" })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Find my jobs' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Answer a few more questions instead' })).toHaveAttribute('href', '/onboarding/situation?classic=1');
    expect(screen.getByRole('button', { name: 'Finish later' })).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(net.writes()).toEqual([]);
    expect(tracked).toEqual([['onboarding_step_viewed', { stage: 'start', branch: null }]]);
  });

  it('a finished user goes to Today', async () => {
    server({ [`GET ${P}/state`]: () => ok(state({ stage: 'done', completed: true, nextRoute: null })) });
    renderWith(<ExpressOnboarding />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByRole('heading', { name: 'Start with your resume' })).toBeNull();
  });

  it('a user who is mid-way through the long screens goes back to their screen', async () => {
    server({ [`GET ${P}/state`]: () => ok(state({ stage: 'basics', nextRoute: '/onboarding/basics', branch: 'urgent', answers: { situation: { timing: 'asap', seekerType: 'experienced' } } })) });
    renderWith(<ExpressOnboarding />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/basics'));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Start with your resume' })).toBeNull();
  });

  it('a GoApply user is handed to their own first screen', async () => {
    server({ [`GET ${P}/state`]: () => ok(state({ brand: 'goapply', stage: 'consent', nextRoute: '/onboarding/consent', firstValueRoute: '/campus' })) });
    renderWith(<ExpressOnboarding />, { brand: 'goapply' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/consent'));
    expect(screen.queryByRole('heading', { name: 'Start with your resume' })).toBeNull();
  });

  it('/onboarding sends a new RoboApply user here; a mid-way user and a GoApply user go where they went before', async () => {
    server();
    const fresh = renderWith(<OnboardingIndexPage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/start'));
    fresh.unmount();

    nav.replace.mockReset();
    server({ [`GET ${P}/state`]: () => ok(state({ stage: 'resume', nextRoute: '/onboarding/resume', branch: 'urgent' })) });
    const midWay = renderWith(<OnboardingIndexPage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/resume'));
    midWay.unmount();

    nav.replace.mockReset();
    server({ [`GET ${P}/state`]: () => ok(state({ brand: 'goapply', stage: 'consent', nextRoute: '/onboarding/consent', firstValueRoute: '/campus' })) });
    renderWith(<OnboardingIndexPage />, { brand: 'goapply' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/consent'));
    expect(nav.replace).not.toHaveBeenCalledWith('/onboarding/start');
  });

  it('the intake is the long flow\'s, rules included: the question before a PDF is read elsewhere, then an upload', async () => {
    let granted: boolean | null = null;
    const consent = () => ({
      items: [{ type: 'intl_cross_border_cn_parse', required: false, stage: 'in_context', control: 'checkbox', withdrawable: true, onWithdraw: 'none', defaultGranted: false, prose: 'Sample consent prose.', proseVersion: 'v1', proseHash: 'h', proseLocale: 'en', granted, answeredAt: null }],
    });
    const net = server({
      'GET /api/v1/roboapply/compliance/consents': () => ok(consent()),
      'POST /api/v1/roboapply/compliance/consents': (c) => {
        granted = (c.body as { granted: boolean }).granted;
        return ok({ type: 'intl_cross_border_cn_parse', granted, proseVersion: 'v1', proseHash: 'h' });
      },
    });
    resumes.upload.mockResolvedValue({ id: 'rv9', name: 'cv.pdf' });
    renderWith(<ExpressOnboarding />);
    // Fails closed: no file door before the answer.
    expect(await screen.findByText('Sample consent prose.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeDisabled();
    expect(screen.getByTestId('resume-file')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow and continue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose a file' })).toBeEnabled());
    const pdf = new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdf] } });
    expect(await screen.findByText(/Ready: cv\.pdf/)).toBeInTheDocument();
    expect(resumes.upload).toHaveBeenCalledWith({ file: pdf });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: "Is this what you're looking for?" });
    expect(bodyOf(net, 'POST', '/resume')).toEqual({ resumeVariantId: 'rv9' });
  });

  it('a resume the server cannot use keeps the user on the resume screen with the long flow\'s message', async () => {
    server({ [`POST ${P}/resume`]: () => fail(429, 'rate_limited', { reason: 'onboarding_resume_daily_limit' }) });
    resumes.list = [{ id: 'rv1', name: 'Sample resume' }];
    renderWith(<ExpressOnboarding />);
    const select = await screen.findByLabelText('Your resumes', { selector: 'select' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(select, { target: { value: 'rv1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this resume' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("You've added 10 resumes today. Try again tomorrow, or use one you already have.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start with your resume' })).toBeInTheDocument();
    // The other way on is still there.
    expect(screen.getByRole('button', { name: "I don't have a resume yet" })).toBeEnabled();
  });

  it('"Finish later" leaves setup early, as on the long screens', async () => {
    const net = server();
    renderWith(<ExpressOnboarding />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish later' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/jobs'));
    expect(writes(net)).toEqual(['POST /skip']);
    expect(tracked).toContainEqual(['onboarding_abandoned', { stage: 'start', branch: null }]);
  });

  it('a "Finish later" that fails says so and keeps the screen', async () => {
    server({ [`POST ${P}/skip`]: () => fail(500, 'internal_error') });
    renderWith(<ExpressOnboarding />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish later' }));
    expect(await screen.findByText('Something went wrong. Your answers are still here; try again.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start with your resume' })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('the second screen is filled in from the resume', () => {
  it('titles the role list knows, the level, and the defaults; nothing is saved as a step yet', async () => {
    const net = server();
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByText("This is what your resume suggests. Change anything that isn't right.")).toBeInTheDocument();
    // The matched title, by its name in the role list (not the resume's wording).
    const titles = screen.getByRole('list', { name: 'Job titles' });
    expect(within(titles).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Backend engineer']);
    expect(screen.getByRole('button', { name: 'Senior (5+ yrs)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Mid level (2–5 yrs)' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByText('Suggested from your resume')).toHaveLength(2);
    // Defaults: the visitor's country, remote included, full-time, as soon as possible.
    expect(screen.getByRole('button', { name: 'United States' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Include remote jobs' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Full-time' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('radio', { name: 'As soon as possible' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('About you: Experienced professional')).toBeInTheDocument();
    expect(screen.getByText('New jobs for this search are emailed to you once a day. You can change that in Settings.')).toBeInTheDocument();
    // One request for the suggestions (each spends a daily resume use); no step saved before "Find my jobs".
    expect(writes(net)).toEqual(['POST /resume']);
    expect(bodyOf(net, 'POST', '/resume')).toEqual({ resumeVariantId: 'rv1' });
    expect(tracked.map(([n, p]) => [n, p?.stage])).toEqual([
      ['onboarding_step_viewed', 'start'],
      ['onboarding_step_completed', 'start'],
      ['onboarding_step_viewed', 'start_check'],
    ]);
    expect(tracked[1][1]).toMatchObject({ skipped: false });
  });

  it('titles the role list does not know come as the resume words them, labelled when AI read them; an entry-level resume is a recent graduate', async () => {
    server({}, { suggested: { suggestedSeniority: ['entry'], suggestedTaxonomyIds: [], suggestedSkills: [], profileDraft: { targetRoles: ['Ops wrangler', 'Data tinkerer', 'ops wrangler', 'Sample title 3', 'Sample title 4'], years: 1, aiSuggested: true } } });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    const titles = screen.getByRole('list', { name: 'Job titles' });
    // At most 3, no repeats.
    expect(within(titles).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Ops wrangler', 'Data tinkerer', 'Sample title 3']);
    expect(screen.getByText('Suggested by AI from your resume. Check before you use it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entry level (0–2 yrs)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('About you: Recent graduate (graduated in the last 2 years)')).toBeInTheDocument();
  });

  it('a resume that suggests nothing says so and leaves the fields to the user', async () => {
    server({}, { suggested: { suggestedSeniority: [], suggestedTaxonomyIds: [], suggestedSkills: [], profileDraft: { targetRoles: [], years: null, aiSuggested: false } } });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    expect(screen.getByText('Nothing could be suggested from your resume. Fill these in to find jobs.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Job titles' })).toBeNull();
    expect(screen.queryByText('Suggested from your resume')).toBeNull();
  });

  it('every value can be changed, and "About you" follows the level until the user picks one', async () => {
    const net = server();
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    // Level: senior → internship only.
    fireEvent.click(level('Senior (5+ yrs)'));
    fireEvent.click(level('Internship'));
    expect(screen.getByText('About you: Student')).toBeInTheDocument();
    // …until it is picked by hand.
    fireEvent.click(screen.getByText('About you: Student'));
    fireEvent.click(screen.getByRole('radio', { name: 'Changing careers or returning to work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entry level (0–2 yrs)' }));
    expect(screen.getByText('About you: Changing careers or returning to work')).toBeInTheDocument();
    // Titles: remove the suggested one, add another.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Backend engineer' }));
    addTitle('Ops wrangler');
    // Where: the other places are folded until asked for; add Canada with a city and a work-permit answer; no remote.
    expect(screen.queryByRole('button', { name: 'Canada' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add another place' }));
    fireEvent.click(screen.getByRole('button', { name: 'Canada' }));
    fireEvent.change(screen.getByLabelText('Cities in Canada'), { target: { value: 'Toronto' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Canada' })).getByRole('button', { name: 'Add city' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Canada' })).getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include remote jobs' }));
    // Job type and timing.
    fireEvent.click(screen.getByRole('button', { name: 'Contract' }));
    fireEvent.click(screen.getByRole('radio', { name: 'As soon as possible' }));

    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(bodyOf(net, 'PUT', '/steps/situation')).toEqual({ timing: 'asap', seekerType: 'career_change' });
    expect(bodyOf(net, 'PUT', '/steps/basics')).toEqual({
      jobFunctions: [{ label: 'Ops wrangler' }],
      jobTypes: ['full_time', 'contract'],
      countries: ['US', 'CA'],
      locations: [{ country: 'CA', city: 'Toronto', label: 'Toronto, Canada' }],
      remoteOk: false,
      needsSponsorship: { CA: 'yes' },
    });
    // Levels go in the list's order, whatever order they were picked in.
    expect(bodyOf(net, 'POST', '/confirm')).toEqual({ experienceLevels: ['internship', 'entry'], alertFrequency: 'daily' });
  });
});

describe('"Find my jobs" saves in the server\'s order', () => {
  it('situation → basics → resume → the search (its real lines) → confirm → complete, then Today', async () => {
    let push!: (chunk: string) => void;
    let end!: () => void;
    let streaming = false;
    const net = server({
      [`POST ${P}/match`]: () => {
        streaming = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              push = (chunk) => controller.enqueue(enc.encode(chunk));
              end = () => controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));

    // The search has started: the three saves went first, in order, and nothing after it yet.
    await waitFor(() => expect(streaming).toBe(true));
    expect(writes(net)).toEqual(['POST /resume', 'PUT /steps/situation', 'PUT /steps/basics', 'PUT /steps/resume', 'POST /match']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Finding jobs' })).toBeInTheDocument();
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Searching for jobs. This can take a minute or two.'));
    expect(status).toHaveFocus();
    expect(screen.getByText('Searching job sources for Backend engineer in United States')).toBeInTheDocument();

    // A line is checked only when the server reports that step.
    const line = (phase: string) => document.querySelector(`[data-phase="${phase}"]`)?.getAttribute('data-state');
    expect(PHASES.map(line)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    await act(async () => push('event: phase\ndata: {"phase":"reading"}\n\n'));
    await waitFor(() => expect(line('reading')).toBe('done'));
    expect(PHASES.map(line)).toEqual(['done', 'pending', 'pending', 'pending', 'pending']);
    await act(async () => push('event: phase\ndata: {"phase":"saving"}\n\nevent: phase\ndata: {"phase":"searching"}\n\n'));
    await waitFor(() => expect(line('searching')).toBe('done'));
    expect(line('comparing')).toBe('pending');
    // Nothing is finished before the search is.
    expect(net.to('POST', `${P}/confirm`)).toEqual([]);
    expect(nav.replace).not.toHaveBeenCalled();

    await act(async () => {
      push('event: phase\ndata: {"phase":"comparing"}\n\nevent: phase\ndata: {"phase":"ranking"}\n\n');
      push('event: done\ndata: {"jobCount":4,"topJobIds":["j1"],"continuedInBackground":false}\n\n');
      end();
    });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));

    // The exact sequence and bodies.
    expect(writes(net)).toEqual(['POST /resume', 'PUT /steps/situation', 'PUT /steps/basics', 'PUT /steps/resume', 'POST /match', 'POST /confirm', 'POST /complete']);
    expect(bodyOf(net, 'PUT', '/steps/situation')).toEqual({ timing: 'asap', seekerType: 'experienced' });
    expect(bodyOf(net, 'PUT', '/steps/basics')).toEqual({
      jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }],
      jobTypes: ['full_time'],
      countries: ['US'],
      remoteOk: true,
    });
    expect(bodyOf(net, 'PUT', '/steps/resume')).toEqual({ resumeVariantId: 'rv1' });
    expect(bodyOf(net, 'POST', '/match')).toBeUndefined();
    expect(bodyOf(net, 'POST', '/confirm')).toEqual({ experienceLevels: ['senior'], alertFrequency: 'daily' });
    expect(bodyOf(net, 'POST', '/complete')).toBeUndefined();

    // The stage moved under the page (GET /state was read again after the search); the user was sent nowhere but Today.
    expect(net.to('GET', `${P}/state`).length).toBeGreaterThan(1);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
    // The session is read again, so the app knows setup is finished.
    expect(auth.refresh).toHaveBeenCalled();
    expect(tracked.at(-1)).toMatchObject(['onboarding_step_completed', { stage: 'start_check', skipped: false }]);
  });

  it('any timing but "as soon as possible" is the explore branch: its two steps are saved as skipped before the resume', async () => {
    const net = server();
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('radio', { name: 'In the next few months' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(writes(net)).toEqual([
      'POST /resume',
      'PUT /steps/situation',
      'PUT /steps/basics',
      'PUT /steps/goal',
      'PUT /steps/preferences',
      'PUT /steps/resume',
      'POST /match',
      'POST /confirm',
      'POST /complete',
    ]);
    expect(bodyOf(net, 'PUT', '/steps/situation')).toEqual({ timing: 'next_few_months', seekerType: 'experienced' });
    expect(bodyOf(net, 'PUT', '/steps/goal')).toEqual({ skip: true });
    expect(bodyOf(net, 'PUT', '/steps/preferences')).toEqual({ skip: true });
  });

  it('lands on the job the user signed up for when the server names it', async () => {
    server({ [`POST ${P}/complete`]: () => ok({ stage: 'done', nextRoute: '/jobs/cm_job_7' }) });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/jobs/cm_job_7'));
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });
});

describe('without a resume', () => {
  it('opens the second screen empty, asks for what is missing next to each field, and saves the resume step as skipped', async () => {
    const net = server();
    renderWith(<ExpressOnboarding />);
    await continueWithoutResume();
    expect(screen.getByText('No resume added, so jobs are found from these answers only. You can add one later to see how well each job fits.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Job titles' })).toBeNull();
    expect(screen.queryByText('Suggested from your resume')).toBeNull();
    for (const name of ['Internship', 'Entry level (0–2 yrs)', 'Mid level (2–5 yrs)', 'Senior (5+ yrs)', 'Lead / Staff', 'Director and above']) {
      expect(level(name)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(tracked[1]).toEqual(['onboarding_step_completed', expect.objectContaining({ stage: 'start', skipped: true })]);

    // Nothing is said before the first try.
    expect(screen.queryByText('Add at least one job title.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    expect(screen.getByText('Add at least one job title.')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one level.')).toBeInTheDocument();
    // The first missing field has the focus.
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(net.writes()).toEqual([]);

    // Each message goes away when its field is filled; the next missing field gets the focus on the next try.
    addTitle('Ops wrangler');
    expect(screen.queryByText('Add at least one job title.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'United States' }));
    fireEvent.click(screen.getByRole('button', { name: 'Full-time' }));
    expect(screen.getByText('Pick at least one place.')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one job type.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    expect(level('Internship')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Mid level (2–5 yrs)' }));
    expect(screen.queryByText('Pick at least one level.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    // With no place chosen every country is offered again, and the first one has the focus.
    expect(screen.getByRole('button', { name: 'United States' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remote anywhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    expect(jobType('Full-time')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Part-time' }));
    expect(net.writes()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    // No suggestions were ever asked for; the resume step says "skipped".
    expect(writes(net)).toEqual(['PUT /steps/situation', 'PUT /steps/basics', 'PUT /steps/resume', 'POST /match', 'POST /confirm', 'POST /complete']);
    expect(bodyOf(net, 'PUT', '/steps/resume')).toEqual({ skip: true });
    expect(bodyOf(net, 'PUT', '/steps/basics')).toEqual({ jobFunctions: [{ label: 'Ops wrangler' }], jobTypes: ['part_time'], countries: ['REMOTE'], remoteOk: true });
    expect(bodyOf(net, 'POST', '/confirm')).toEqual({ experienceLevels: ['mid'], alertFrequency: 'daily' });
  });

  it('Back to the resume screen keeps what was entered', async () => {
    server();
    renderWith(<ExpressOnboarding />);
    await continueWithoutResume();
    addTitle('Ops wrangler');
    fireEvent.click(screen.getByRole('button', { name: 'Senior (5+ yrs)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Start with your resume' })).toBeInTheDocument();
    // A resume chosen now fills in what it suggests; the rest of the answers stay.
    await continueWithResume();
    expect(within(screen.getByRole('list', { name: 'Job titles' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Backend engineer']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Backend engineer' }));
    addTitle('Data tinkerer');
    fireEvent.click(screen.getByRole('button', { name: 'Contract' }));
    // Back and forth with the same resume: the user's values, not the suggestions again.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText(/Ready: Sample resume/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: "Is this what you're looking for?" });
    expect(within(screen.getByRole('list', { name: 'Job titles' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Data tinkerer']);
    expect(screen.getByRole('button', { name: 'Contract' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('a failure in the middle', () => {
  it('a save that fails: the screen stays with everything entered, says what failed, and "Try again" goes on from that step', async () => {
    let down = true;
    const net = server({
      [`PUT ${P}/steps/basics`]: () => (down ? fail(500, 'internal_error') : ok({ stage: 'resume', nextStage: 'resume', nextRoute: '/onboarding/resume' })),
    });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Contract' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Your answers couldn't be saved, so the search didn't start. Everything you entered is still here. Try again.");
    expect(alert).toHaveFocus();
    expect(writes(net)).toEqual(['POST /resume', 'PUT /steps/situation', 'PUT /steps/basics']);
    // Still the second screen, with the answers as they were.
    expect(screen.getByRole('heading', { name: "Is this what you're looking for?" })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Job titles' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Backend engineer']);
    expect(screen.getByRole('button', { name: 'Senior (5+ yrs)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Contract' })).toHaveAttribute('aria-pressed', 'true');
    expect(nav.replace).not.toHaveBeenCalled();

    down = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    // The step that was saved is not sent again; the one that failed is.
    expect(writes(net)).toEqual(['POST /resume', 'PUT /steps/situation', 'PUT /steps/basics', 'PUT /steps/basics', 'PUT /steps/resume', 'POST /match', 'POST /confirm', 'POST /complete']);
    expect(bodyOf(net, 'PUT', '/steps/basics', 1)).toEqual(bodyOf(net, 'PUT', '/steps/basics', 0));
    expect(bodyOf(net, 'PUT', '/steps/basics', 1)).toMatchObject({ jobTypes: ['full_time', 'contract'] });
  });

  it('answers changed before the retry are saved from the first step again', async () => {
    let down = true;
    const net = server({ [`PUT ${P}/steps/resume`]: () => (down ? fail(429, 'rate_limited') : ok({ stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' })) });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your resume choice couldn't be saved, so the search didn't start. There were too many tries in a short time. Wait a minute, then try again.");

    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Mid level (2–5 yrs)' }));
    // The screen's own button is a retry too.
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(writes(net)).toEqual([
      'POST /resume',
      'PUT /steps/situation',
      'PUT /steps/basics',
      'PUT /steps/resume',
      'PUT /steps/situation',
      'PUT /steps/basics',
      'PUT /steps/resume',
      'POST /match',
      'POST /confirm',
      'POST /complete',
    ]);
    expect(bodyOf(net, 'POST', '/confirm')).toEqual({ experienceLevels: ['mid', 'senior'], alertFrequency: 'daily' });
  });

  it('setup that cannot be closed after the search: said as such, and the retry does not search again', async () => {
    let down = true;
    const net = server({ [`POST ${P}/confirm`]: () => (down ? fail(500, 'internal_error') : ok({ stage: 'tour', nextRoute: '/jobs' })) });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Your search is saved, but setup couldn't be finished. Everything you entered is still here. Try again.");
    down = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(net.to('POST', `${P}/match`)).toHaveLength(1);
    expect(writes(net).slice(-3)).toEqual(['POST /confirm', 'POST /confirm', 'POST /complete']);
  });

  it('going back to the resume screen drops the failure message (the next try may be for other answers)', async () => {
    server({ [`PUT ${P}/steps/situation`]: () => fail(500, 'internal_error') });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your answers couldn't be saved");
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByRole('button', { name: "I don't have a resume yet" }));
    await screen.findByRole('heading', { name: "Is this what you're looking for?" });
    expect(screen.queryByRole('alert')).toBeNull();
    // What was entered is still there.
    expect(within(screen.getByRole('list', { name: 'Job titles' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Backend engineer']);
  });

  it('a search that goes on in the background still finishes setup and lands on Today', async () => {
    const net = server({ [`POST ${P}/match`]: () => sse([['phase', { phase: 'reading' }], ['done', { jobCount: 0, topJobIds: [], continuedInBackground: true }]]) });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(writes(net).slice(-3)).toEqual(['POST /match', 'POST /confirm', 'POST /complete']);
  });

  it('a search that fails does not keep the user: the server refuses confirm at that stage, so setup is left for later and they land on Today', async () => {
    const net = server({
      [`POST ${P}/match`]: () => sse([['phase', { phase: 'reading' }], ['error', { code: 'internal_error', message: 'x' }]]),
      // The stage is still `matching`: POST /confirm is a step beyond it.
      [`POST ${P}/confirm`]: () => fail(409, 'conflict', { reason: 'onboarding_step_not_available' }),
    });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(writes(net).slice(-3)).toEqual(['POST /match', 'POST /confirm', 'POST /skip']);
    expect(net.to('POST', `${P}/complete`)).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a search that could not start (too many runs this hour) is the same: no dead end', async () => {
    const net = server({
      [`POST ${P}/match`]: () => fail(429, 'rate_limited'),
      [`POST ${P}/confirm`]: () => fail(409, 'conflict', { reason: 'onboarding_step_not_available' }),
    });
    renderWith(<ExpressOnboarding />);
    await continueWithoutResume();
    addTitle('Ops wrangler');
    fireEvent.click(screen.getByRole('button', { name: 'Mid level (2–5 yrs)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/dashboard'));
    expect(writes(net).slice(-3)).toEqual(['POST /match', 'POST /confirm', 'POST /skip']);
  });

  it('a refused confirm after a search that DID finish is a failure to show, not a reason to leave setup', async () => {
    const net = server({ [`POST ${P}/confirm`]: () => fail(409, 'conflict', { reason: 'onboarding_step_not_available' }) });
    renderWith(<ExpressOnboarding />);
    await continueWithResume();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your search is saved, but setup couldn't be finished. Setup has moved on somewhere else, maybe in another tab. Reload this page.");
    expect(net.to('POST', `${P}/skip`)).toEqual([]);
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
