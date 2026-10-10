// WP-30 web: onboarding screens O1–O7 at 375 px, through the real lib/api
// wrappers against a fetch double (no network). Fictional data only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return {
    ...real,
    usePathname: () => '/onboarding/situation',
    useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
const tracked = vi.hoisted(() => [] as Array<[string, Record<string, unknown> | undefined]>);
vi.mock('../../../lib/analytics', async (orig) => {
  const real = await orig<typeof import('../../../lib/analytics')>();
  return { ...real, track: (name: string, props?: Record<string, unknown>) => tracked.push([name, props]) };
});
const resumes = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string }>, upload: vi.fn() }));
vi.mock('../../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: resumes.list } }),
  useUploadResumeMutation: () => ({ isPending: false, mutateAsync: resumes.upload }),
}));
vi.mock('../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({ status: 'authenticated', refresh: async () => null, me: null }),
}));

import { fail, installFetch, ok, renderWith, type RecordedCall } from '../filters/filters.testkit';
import { OnboardingStepPage } from './OnboardingStepPage';
import { confirmCountOf } from './steps/ConfirmStep';
import { resumeErrorKeyOf } from './steps/ResumeStep';

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
    ...over,
  };
}

function sse(events: Array<[string, unknown]>) {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
  tracked.length = 0;
  resumes.list = [];
  resumes.upload.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  window.dispatchEvent(new Event('resize'));
});
afterEach(() => vi.unstubAllGlobals());

describe('O1 situation', () => {
  it('enables Next only when both questions are answered, saves and goes to the server route', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state()),
      [`PUT ${P}/steps/situation`]: () => ok({ stage: 'basics', nextStage: 'basics', nextRoute: '/onboarding/basics' }),
    });
    renderWith(<OnboardingStepPage step="situation" />);
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull(); // no Skip on the situation step
    fireEvent.click(screen.getByRole('radio', { name: 'As soon as possible' }));
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Student' }));
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/basics'));
    expect(net.to('PUT', `${P}/steps/situation`)[0].body).toEqual({ timing: 'asap', seekerType: 'student' });
    expect(tracked.map(([n]) => n)).toEqual(['onboarding_step_viewed', 'onboarding_step_completed']);
    expect(tracked[1][1]).toMatchObject({ stage: 'situation', skipped: false });
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  it('sends a user who jumps ahead back to their current screen', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state()) });
    renderWith(<OnboardingStepPage step="confirm" />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/situation'));
  });

  it('sends a finished user to the jobs page', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ stage: 'done', completed: true, nextRoute: null })) });
    renderWith(<OnboardingStepPage step="basics" />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/jobs'));
  });

  it('"Finish later" leaves onboarding early and tracks it', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state()),
      [`POST ${P}/skip`]: () => ok({ stage: 'done', nextRoute: '/jobs' }),
    });
    renderWith(<OnboardingStepPage step="situation" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish later' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/jobs'));
    expect(net.to('POST', `${P}/skip`)).toHaveLength(1);
    expect(tracked.some(([n]) => n === 'onboarding_abandoned')).toBe(true);
  });
});

describe('O2 basics', () => {
  const basicsState = state({ stage: 'basics', branch: 'urgent', answers: { situation: { timing: 'asap', seekerType: 'experienced' } }, progress: { total: 5, stepsLeft: 4, leftEarly: null } });

  it('validates, asks per-country sponsorship, and sends the answers', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(basicsState),
      [`GET ${P}/title-suggest`]: () =>
        ok({ items: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer', level: 3, tooGeneral: false, context: 'Software engineering', children: [] }] }),
      [`GET ${P}/market-snapshot`]: () => ok({ jobCount: { value: 0, source: 'index', sampleSize: 0, asOf: '2026-10-10T00:00:00.000Z' }, windowDays: 30, pay: null, topSkills: [] }),
      [`PUT ${P}/steps/basics`]: () => ok({ stage: 'resume', nextStage: 'resume', nextRoute: '/onboarding/resume' }),
    });
    renderWith(<OnboardingStepPage step="basics" />);
    expect(await screen.findByRole('heading', { name: 'What job do you want next?' })).toBeInTheDocument();
    // Full-time is the default; US comes from the server's default country.
    expect(screen.getByRole('button', { name: 'Full-time' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'United States' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Add at least one job title.')).toBeInTheDocument();

    // Each message goes away when its field is fixed, without pressing Next again.
    fireEvent.click(screen.getByRole('button', { name: 'United States' }));
    expect(screen.getByText('Pick at least one place.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'United States' }));
    expect(screen.queryByText('Pick at least one place.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Full-time' }));
    expect(screen.getByText('Pick at least one job type.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Full-time' }));
    expect(screen.queryByText('Pick at least one job type.')).toBeNull();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'backend' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Backend engineer/ }));
    expect(screen.getByText('Backend engineer')).toBeInTheDocument();
    expect(screen.queryByText('Add at least one job title.')).toBeNull();
    expect(await screen.findByText('No open roles yet for this title here. Try a broader title or another city.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Not sure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/resume'));
    expect(net.to('PUT', `${P}/steps/basics`)[0].body).toEqual({
      jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }],
      jobTypes: ['full_time'],
      countries: ['US'],
      remoteOk: true,
      needsSponsorship: { US: 'not_sure' },
    });
  });

  it('Skip keeps what was entered and leaves out empty lists (no title found)', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(basicsState),
      [`GET ${P}/market-snapshot`]: () => ok({ jobCount: { value: 0, source: 'index', sampleSize: 0, asOf: '2026-10-10T00:00:00.000Z' }, windowDays: 30, pay: null, topSkills: [] }),
      [`PUT ${P}/steps/basics`]: () => ok({ stage: 'resume', nextStage: 'resume', nextRoute: '/onboarding/resume' }),
    });
    renderWith(<OnboardingStepPage step="basics" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(net.to('PUT', `${P}/steps/basics`)).toHaveLength(1));
    expect(net.to('PUT', `${P}/steps/basics`)[0].body).toEqual({ jobTypes: ['full_time'], countries: ['US'], remoteOk: true, skip: true });
  });

  it('flags a broad title and offers specific ones; caps titles at 3; Enter adds a custom title', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(basicsState),
      [`GET ${P}/title-suggest`]: (c: RecordedCall) =>
        ok({
          items: c.search.includes('software')
            ? [{ taxonomyId: 'software_engineering', label: 'Software engineering', level: 1, tooGeneral: true, context: null, children: [{ taxonomyId: 'swe_backend', label: 'Backend', level: 2 }] }]
            : [],
        }),
      [`GET ${P}/market-snapshot`]: () => ok({ jobCount: { value: 3, source: 'index', sampleSize: 3, asOf: '2026-10-10T00:00:00.000Z' }, windowDays: 30, pay: null, topSkills: [] }),
    });
    renderWith(<OnboardingStepPage step="basics" />);
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'software' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Software engineering/ }));
    expect(screen.getByText('This is broad. Pick a more specific title for better results.')).toBeInTheDocument();
    // The role group is named from the bundle by its id (the server's label is English or Simplified Chinese only).
    fireEvent.click(screen.getByRole('button', { name: 'Backend and platform' }));
    expect(screen.queryByText('This is broad. Pick a more specific title for better results.')).toBeNull();
    for (const title of ['Ops wrangler', 'Data tinkerer']) {
      fireEvent.change(input, { target: { value: title } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    fireEvent.change(input, { target: { value: 'One too many' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Pick up to 3 titles.')).toBeInTheDocument();
    // What was typed is what Enter added (never a leftover suggestion of the earlier search).
    expect(screen.queryByRole('button', { name: 'Remove Software engineering' })).toBeNull();
    // Removing a title makes room: the message goes away at once.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ops wrangler' }));
    expect(screen.queryByText('Pick up to 3 titles.')).toBeNull();
  });

  it('names categories and role groups from the bundle by id, and the line under a role too', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(basicsState),
      [`GET ${P}/title-suggest`]: () =>
        ok({
          items: [
            { taxonomyId: 'swe_backend', label: 'SERVER GROUP LABEL', level: 2, tooGeneral: false, context: 'SERVER CATEGORY', contextIds: ['software_engineering'], children: [] },
            { taxonomyId: 'backend_engineer', label: 'Backend engineer', level: 3, tooGeneral: false, context: 'SERVER GROUP · SERVER CATEGORY', contextIds: ['swe_backend', 'software_engineering'], children: [] },
          ],
        }),
      [`GET ${P}/market-snapshot`]: () => ok({ jobCount: { value: 0, source: 'index', sampleSize: 0, asOf: '2026-10-10T00:00:00.000Z' }, windowDays: 30, pay: null, topSkills: [] }),
    });
    renderWith(<OnboardingStepPage step="basics" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'backend' } });
    const group = await screen.findByRole('option', { name: /^Backend and platform/ });
    expect(group).toHaveTextContent('Software engineering');
    const role = screen.getByRole('option', { name: /Backend engineer/ });
    expect(role).toHaveTextContent('Backend and platform · Software engineering');
    expect(document.body.textContent).not.toMatch(/SERVER/);
  });

  it('shows pay only when the server published it, with N and the source footnote', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(state({ ...basicsState, answers: { ...basicsState.answers, basics: { jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }], jobTypes: ['full_time'], countries: ['US'] } } })),
      [`GET ${P}/market-snapshot`]: () =>
        ok({
          jobCount: { value: 42, source: 'index', sampleSize: 42, asOf: '2026-10-10T00:00:00.000Z' },
          windowDays: 30,
          pay: { listedCount: 25, sampleSize: 22, currency: 'USD', period: 'year', low: 120000, high: 160000, source: 'index', asOf: '2026-10-10T00:00:00.000Z' },
          topSkills: [{ value: 'go', count: 30, sampleSize: 42, source: 'index', asOf: '2026-10-10T00:00:00.000Z' }],
        }),
    });
    renderWith(<OnboardingStepPage step="basics" />);
    expect(await screen.findByTestId('snapshot-count')).toHaveTextContent('42 open roles for Backend engineer in United States in the last 30 days');
    expect(screen.getByTestId('snapshot-pay')).toHaveTextContent('Pay listed on 25 of 42 posts.');
    expect(screen.getByTestId('snapshot-skills')).toHaveTextContent('Most requested skills: go');
    expect(screen.getByText("From job posts in RoboApply's index. Updated daily.")).toBeInTheDocument();
  });
});

describe('O3 goal and O4 preferences (explore)', () => {
  it('goal: Next with nothing chosen asks to pick one or skip; Skip saves a skip', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'goal', branch: 'explore', progress: { total: 7, stepsLeft: 5, leftEarly: null } })),
      [`PUT ${P}/steps/goal`]: () => ok({ stage: 'preferences', nextStage: 'preferences', nextRoute: '/onboarding/preferences' }),
    });
    renderWith(<OnboardingStepPage step="goal" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(screen.getByText('Pick one, or skip this step.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(net.to('PUT', `${P}/steps/goal`)).toHaveLength(1));
    expect(net.to('PUT', `${P}/steps/goal`)[0].body).toEqual({ skip: true });
    expect(tracked.find(([n]) => n === 'onboarding_step_completed')?.[1]).toMatchObject({ skipped: true });
    // Back goes to the previous screen of the explore branch.
  });

  it('preferences: pay currency follows the first country; sizes map; invalid pay is refused', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () =>
        ok(state({ stage: 'preferences', branch: 'explore', answers: { basics: { jobFunctions: [{ label: 'X' }], jobTypes: ['full_time'], countries: ['GB'] } } })),
      [`PUT ${P}/steps/preferences`]: () => ok({ stage: 'resume', nextStage: 'resume', nextRoute: '/onboarding/resume' }),
    });
    renderWith(<OnboardingStepPage step="preferences" />);
    expect(await screen.findByLabelText('Currency')).toHaveValue('GBP');
    expect(screen.getByText("Many posts don't say company size. Jobs without size information are still shown.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Enter an amount above 0, or leave it empty.')).toBeInTheDocument();
    // Still wrong: still said. Fixed (or emptied): gone at once, without pressing Next again.
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: 'abc' } });
    expect(screen.getByText('Enter an amount above 0, or leave it empty.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '' } });
    expect(screen.queryByText('Enter an amount above 0, or leave it empty.')).toBeNull();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '60,000' } });
    expect(screen.queryByText('Enter an amount above 0, or leave it empty.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fintech' }));
    fireEvent.click(screen.getByRole('button', { name: '51–200' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(net.to('PUT', `${P}/steps/preferences`)).toHaveLength(1));
    expect(net.to('PUT', `${P}/steps/preferences`)[0].body).toEqual({
      industries: ['Fintech'],
      companySizes: ['51-200'],
      workModels: ['remote', 'hybrid', 'onsite'],
      minPay: { amount: 60000, currency: 'GBP', period: 'year' },
    });
    // Back: previous explore screen.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(nav.push).toHaveBeenCalledWith('/onboarding/goal');
  });
});

describe('O5 resume', () => {
  const resumeState = state({ stage: 'resume', branch: 'urgent', progress: { total: 5, stepsLeft: 3, leftEarly: null } });
  const consent = (granted: boolean | null) => ({
    items: [{ type: 'intl_cross_border_cn_parse', required: false, stage: 'in_context', control: 'checkbox', withdrawable: true, onWithdraw: 'none', defaultGranted: false, prose: 'Sample consent prose.', proseVersion: 'v1', proseHash: 'h', proseLocale: 'en', granted, answeredAt: null }],
  });

  it('shows the privacy line and the LinkedIn PDF how-to (no URL import); skip uses answers only', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(resumeState),
      'GET /api/v1/roboapply/compliance/consents': () => ok({ items: [] }),
      [`PUT ${P}/steps/resume`]: () => ok({ stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' }),
    });
    renderWith(<OnboardingStepPage step="resume" />);
    expect(await screen.findByText(/Your resume is used to rank jobs and draft materials for you\. It is not shared with employers unless you send it\./)).toBeInTheDocument();
    expect(screen.getByText(/Save to PDF/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/linkedin\.com\/in/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Find my jobs' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip — use my answers only' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/matching'));
    expect(net.to('PUT', `${P}/steps/resume`)[0].body).toEqual({ skip: true });
  });

  it('asks the cross-border parse consent before any upload; declining closes PDFs but keeps Word/text and paste', async () => {
    let granted: boolean | null = null;
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(resumeState),
      'GET /api/v1/roboapply/compliance/consents': () => ok(consent(granted)),
      'POST /api/v1/roboapply/compliance/consents': (c) => {
        granted = (c.body as { granted: boolean }).granted;
        return ok({ type: 'intl_cross_border_cn_parse', granted, proseVersion: 'v1', proseHash: 'h' });
      },
    });
    renderWith(<OnboardingStepPage step="resume" />);
    expect(await screen.findByText('Sample consent prose.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    await waitFor(() => expect(net.to('POST', '/api/v1/roboapply/compliance/consents')[0].body).toEqual({ type: 'intl_cross_border_cn_parse', granted: false, proseVersion: 'v1' }));
    expect(await screen.findByText(/won't be sent there/)).toBeInTheDocument();
    // Word and text files are read locally (the GoHire parser takes PDFs only), so that door reopens for them.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose a file' })).toBeEnabled());
    expect(screen.getByText('Word or text, up to 15 MB.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload the LinkedIn PDF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use this text' })).toBeEnabled();
    const input = screen.getByTestId('resume-file') as HTMLInputElement;
    expect(input.accept).toBe('.doc,.docx,.txt');
    fireEvent.change(input, { target: { files: [new File(['x'], 'cv.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText(/This PDF can't be read without the reading option you turned off/)).toBeInTheDocument();
    expect(resumes.upload).not.toHaveBeenCalled();
    resumes.upload.mockResolvedValue({ id: 'rv5', name: 'cv.docx' });
    fireEvent.change(input, { target: { files: [new File(['x'], 'cv.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })] } });
    expect(await screen.findByText(/Ready: cv\.docx/)).toBeInTheDocument();
    expect(resumes.upload).toHaveBeenCalledTimes(1);
  });

  it('privacy fails closed: while the consent is loading, no file door opens (paste stays open)', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(resumeState),
      'GET /api/v1/roboapply/compliance/consents': () => new Promise<Response>(() => undefined),
    });
    renderWith(<OnboardingStepPage step="resume" />);
    expect(await screen.findByText('Checking how we can read your file…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload the LinkedIn PDF' })).toBeDisabled();
    expect(screen.getByTestId('resume-file')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use this text' })).toBeEnabled();
  });

  // Verification finding: a PDF chosen before the consent request finished was
  // refused with "the reading option you turned off", though nothing was declined.
  it('a PDF that arrives before the consent answer waits for it, and never blames a setting the user did not change', async () => {
    let answer!: (r: Response) => void;
    installFetch({
      [`GET ${P}/state`]: () => ok(resumeState),
      'GET /api/v1/roboapply/compliance/consents': () => new Promise<Response>((r) => (answer = r)),
    });
    resumes.upload.mockResolvedValue({ id: 'rv9', name: 'resume.pdf' });
    renderWith(<OnboardingStepPage step="resume" />);
    await screen.findByText('Checking how we can read your file…');
    const pdf = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdf] } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/turned off/)).toBeNull();
    expect(resumes.upload).not.toHaveBeenCalled();
    // The answer arrives: the consent is not offered here, so the PDF is uploaded.
    answer(ok({ items: [] }) as Response);
    await waitFor(() => expect(resumes.upload).toHaveBeenCalledWith({ file: pdf }));
    expect(await screen.findByText(/resume\.pdf/)).toBeInTheDocument();
    expect(screen.queryByText(/turned off/)).toBeNull();
  });

  it('says which case it is: unanswered question, answer not loadable, or really declined', async () => {
    const consentItem = (granted: boolean | null) => ok({ items: [{ type: 'intl_cross_border_cn_parse', granted, proseVersion: 'v1', prose: 'How the file is read.' }] });
    const pdf = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });

    // Unanswered.
    installFetch({ [`GET ${P}/state`]: () => ok(resumeState), 'GET /api/v1/roboapply/compliance/consents': () => consentItem(null) });
    const a = renderWith(<OnboardingStepPage step="resume" />);
    await screen.findByText('How the file is read.');
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdf] } });
    expect(await screen.findByText('Answer the question above first. Then choose your PDF again.')).toBeInTheDocument();
    expect(screen.queryByText(/turned off/)).toBeNull();
    a.unmount();

    // Not loadable.
    installFetch({ [`GET ${P}/state`]: () => ok(resumeState), 'GET /api/v1/roboapply/compliance/consents': () => fail(503, 'service_unavailable') });
    const b = renderWith(<OnboardingStepPage step="resume" />);
    await screen.findByText(/uploads are paused/);
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdf] } });
    await waitFor(() => expect(screen.getAllByText(/uploads are paused/).length).toBe(2));
    expect(screen.queryByText(/turned off/)).toBeNull();
    b.unmount();

    // Declined: only now is the declined option named.
    installFetch({ [`GET ${P}/state`]: () => ok(resumeState), 'GET /api/v1/roboapply/compliance/consents': () => consentItem(false) });
    renderWith(<OnboardingStepPage step="resume" />);
    await screen.findByText(/Your file won't be sent there/);
    fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [pdf] } });
    expect(await screen.findByText(/the reading option you turned off/)).toBeInTheDocument();
    expect(resumes.upload).not.toHaveBeenCalled();
  });

  it('privacy fails closed: when the consent cannot be loaded, file doors stay closed with a retry', async () => {
    let up = false;
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(resumeState),
      'GET /api/v1/roboapply/compliance/consents': () => (up ? ok({ items: [] }) : fail(503, 'service_unavailable')),
    });
    renderWith(<OnboardingStepPage step="resume" />);
    expect(await screen.findByText(/uploads are paused/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload the LinkedIn PDF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use this text' })).toBeEnabled();
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(net.to('GET', '/api/v1/roboapply/compliance/consents')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose a file' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Upload the LinkedIn PDF' })).toBeEnabled();
  });

  it('pasting under 200 characters is refused; a reused resume is seeded then saved', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(resumeState),
      'GET /api/v1/roboapply/compliance/consents': () => ok({ items: [] }),
      [`POST ${P}/resume`]: () => ok({ suggestedSeniority: [], suggestedTaxonomyIds: [], suggestedSkills: [], profileDraft: {} }),
      [`PUT ${P}/steps/resume`]: () => ok({ stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' }),
    });
    resumes.list = [{ id: 'rv1', name: 'Sample resume' }];
    renderWith(<OnboardingStepPage step="resume" />);
    fireEvent.change(await screen.findByLabelText('Resume text'), { target: { value: 'too short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this text' }));
    expect(screen.getByText('Paste at least 200 characters.')).toBeInTheDocument();
    const select = await screen.findByLabelText('Your resumes', { selector: 'select' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(select, { target: { value: 'rv1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this resume' }));
    expect(screen.getByText(/Ready: Sample resume/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Find my jobs' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/matching'));
    expect(net.to('POST', `${P}/resume`)[0].body).toEqual({ resumeVariantId: 'rv1' });
    expect(net.to('PUT', `${P}/steps/resume`)[0].body).toEqual({ resumeVariantId: 'rv1' });
  });

  it('maps upload and seed failures to plain messages (daily limit persisted server-side)', () => {
    const err = (code: string, reason?: string) => ({ payload: { code, details: reason ? { reason } : undefined } });
    expect(resumeErrorKeyOf(err('rate_limited', 'onboarding_resume_daily_limit'))).toBe('dailyLimit');
    expect(resumeErrorKeyOf(err('file_too_large'))).toBe('tooLarge');
    expect(resumeErrorKeyOf(err('empty_text'))).toBe('unreadable');
    expect(resumeErrorKeyOf(err('invalid_request', 'onboarding_resume_unusable'))).toBe('unreadable');
    expect(resumeErrorKeyOf(new Error('x'))).toBe('failed');
  });
});

describe('O6 matching', () => {
  it('checks each line only when its event arrives, then goes to confirm', async () => {
    let push!: (chunk: string) => void;
    let end!: () => void;
    installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'matching', branch: 'urgent', answers: { basics: { jobFunctions: [{ label: 'Backend engineer' }], countries: ['US'] } } })),
      [`POST ${P}/match`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              push = (chunk) => controller.enqueue(enc.encode(chunk));
              end = () => controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
    });
    renderWith(<OnboardingStepPage step="matching" />);
    expect(await screen.findByText('Searching job sources for Backend engineer in United States')).toBeInTheDocument();
    await waitFor(() => expect(push).toBeTypeOf('function'));
    const lineState = (phase: string) => document.querySelector(`[data-phase="${phase}"]`)?.getAttribute('data-state');
    expect(lineState('reading')).toBe('pending');
    await act(async () => push('event: phase\ndata: {"phase":"reading","skipped":true}\n\n'));
    await waitFor(() => expect(lineState('reading')).toBe('skipped'));
    expect(screen.getByText('No resume added')).toBeInTheDocument();
    await act(async () => push('event: phase\ndata: {"phase":"saving"}\n\n'));
    await waitFor(() => expect(lineState('saving')).toBe('done'));
    expect(lineState('searching')).toBe('pending');
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => {
      for (const p of ['searching', 'comparing', 'ranking']) push(`event: phase\ndata: {"phase":"${p}"}\n\n`);
      push('event: done\ndata: {"jobCount":3,"topJobIds":["j1"],"continuedInBackground":false}\n\n');
      end();
    });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/confirm'));
  });

  it('error: Try again · Continue anyway (to the feed)', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'matching', branch: 'urgent' })),
      [`POST ${P}/match`]: () => sse([['phase', { phase: 'reading', skipped: true }], ['error', { code: 'internal_error', message: 'x' }]]),
      [`POST ${P}/skip`]: () => ok({ stage: 'done', nextRoute: '/jobs' }),
    });
    renderWith(<OnboardingStepPage step="matching" />);
    expect(await screen.findByText('Something went wrong while searching.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(net.to('POST', `${P}/match`)).toHaveLength(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue anyway' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/jobs'));
  });

  it('when the run continues in the background, says so instead of a number', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'matching', branch: 'urgent' })),
      [`POST ${P}/match`]: () => sse([['done', { jobCount: 0, topJobIds: [], continuedInBackground: true }]]),
    });
    renderWith(<OnboardingStepPage step="matching" />);
    expect(await screen.findByText(/Still checking more jobs/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The page reads the new stage first, then moves on.
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/confirm'));
  });
});

describe('O7 confirm', () => {
  // The feed's live count must not be asked: `fitTier` does not filter it, so it
  // returned the size of the whole search (1,586 "jobs that fit you" with no resume).
  const noFeedCount = {
    'GET /api/v1/roboapply/search-profiles': () => fail(500, 'internal_error'),
    'POST /api/v1/roboapply/search-profiles/count': () => ok({ count: 1586, capped: false }),
  };
  const confirmState = (matching: Record<string, unknown> | undefined, answers: Record<string, unknown> = {}) =>
    ok(state({ stage: 'confirm', branch: 'urgent', answers: { ...(matching ? { matching } : {}), ...answers } }));

  it('shows the count "Finding jobs" stored (Good fit or better, of those compared) and defaults the email to Daily', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () =>
        confirmState(
          { jobCount: 9, compared: 62, ranked: true, resumeCompared: true, comparedCapped: false },
          { resume: { resumeVariantId: 'rv1' }, resumeSuggestions: { suggestedSeniority: ['mid'], suggestedTaxonomyIds: [], profileDraft: {} } },
        ),
      ...noFeedCount,
      [`POST ${P}/confirm`]: () => ok({ stage: 'tour', nextRoute: '/jobs' }),
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: 'We found 9 jobs that fit you. Check these details.' })).toBeInTheDocument();
    expect(screen.getByText('Counts jobs at Good fit or better, out of the 62 jobs we compared with your resume.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mid level (2–5 yrs)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Suggested from your resume')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByLabelText('LinkedIn profile (optional)'), { target: { value: 'https://example.com/me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show my jobs' }));
    expect(screen.getByText(/Use your LinkedIn profile link/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('LinkedIn profile (optional)'), { target: { value: '' } });
    // Fixed fields lose their message at once.
    expect(screen.queryByText(/Use your LinkedIn profile link/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/How did you hear about RoboApply/), { target: { value: 'friend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show my jobs' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/jobs'));
    expect(net.to('POST', `${P}/confirm`)[0].body).toEqual({ experienceLevels: ['mid'], alertFrequency: 'daily', heardFrom: 'friend' });
    // One stable number: the heading never asks the feed for another count.
    expect(net.to('POST', '/api/v1/roboapply/search-profiles/count')).toEqual([]);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('We found 9 jobs that fit you.');
  });

  it('with no resume compared it never says "fit": it shows the saved search\'s own size (D3)', async () => {
    const net = installFetch({
      // `compared` (the comparison's own query) is not the number: `searchCount` is.
      [`GET ${P}/state`]: () => confirmState({ jobCount: 31, compared: 54, ranked: true, resumeCompared: false, comparedCapped: false, searchCount: 37, searchCountCapped: false }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: 'We found 37 jobs for your search. Check these details.' })).toBeInTheDocument();
    expect(screen.getByText('These are open jobs that match your search. No resume was compared, so this is not a fit count.')).toBeInTheDocument();
    expect(screen.queryByText(/that fit you/)).toBeNull();
    expect(screen.queryByText(/Good fit or better/)).toBeNull();
    expect(screen.queryByText(/54/)).toBeNull();
    // Still one stored number: the screen asks the feed for nothing.
    await new Promise((r) => setTimeout(r, 600));
    expect(net.to('POST', '/api/v1/roboapply/search-profiles/count')).toEqual([]);
  });

  // Review finding: with every step skipped nothing can be compared (no
  // title), so `compared` is 0, while the saved search has no filter and /jobs
  // lists the whole index. The heading said "We didn't find jobs for your search".
  it('every step skipped: the unfiltered search has its real size, and it is never called a fit', async () => {
    installFetch({
      [`GET ${P}/state`]: () => confirmState({ jobCount: 0, compared: 0, ranked: true, resumeCompared: false, comparedCapped: false, searchCount: 1586, searchCountCapped: false }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: 'We found 1,586 jobs for your search. Check these details.' })).toBeInTheDocument();
    expect(screen.getByText('These are open jobs that match your search. No resume was compared, so this is not a fit count.')).toBeInTheDocument();
    expect(screen.queryByText(/that fit you/)).toBeNull();
    expect(screen.queryByText(/didn't find/)).toBeNull();
    // Not the zero-results help either.
    expect(screen.queryByRole('link', { name: "Change what you're looking for" })).toBeNull();
  });

  it('a saved search at the feed cap reads "N+"', async () => {
    installFetch({
      [`GET ${P}/state`]: () => confirmState({ jobCount: 0, compared: 200, ranked: true, resumeCompared: false, comparedCapped: true, searchCount: 5000, searchCountCapped: true }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: 'We found 5,000+ jobs for your search. Check these details.' })).toBeInTheDocument();
  });

  it('a saved search with no jobs opens the help, without the "these are open jobs" note', async () => {
    installFetch({
      [`GET ${P}/state`]: () => confirmState({ jobCount: 0, compared: 0, ranked: true, resumeCompared: false, comparedCapped: false, searchCount: 0, searchCountCapped: false }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: "We didn't find jobs for your search yet. Adjust your search below." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Change what you're looking for" })).toHaveAttribute('href', '/onboarding/basics');
    expect(screen.queryByText(/These are open jobs that match your search/)).toBeNull();
  });

  it('no resume and the search was not counted: no number at all (never the comparison\'s, never the whole index)', async () => {
    installFetch({
      [`GET ${P}/state`]: () => confirmState({ jobCount: 12, compared: 54, ranked: true, resumeCompared: false, comparedCapped: false }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: 'Your search is saved. Check these details.' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your search is saved. Check these details.');
    expect(document.body.textContent).not.toMatch(/54|12 jobs|1,586|that fit you|didn't find/);
    expect(screen.queryByRole('link', { name: "Change what you're looking for" })).toBeNull();
  });

  it('Back goes to the resume screen, never to "Finding jobs" (which would run again and come back)', async () => {
    installFetch({ [`GET ${P}/state`]: () => confirmState({ jobCount: 2 }), ...noFeedCount });
    renderWith(<OnboardingStepPage step="confirm" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(nav.push).toHaveBeenCalledWith('/onboarding/resume');
    expect(nav.push).not.toHaveBeenCalledWith('/onboarding/matching');
  });

  it.each([
    ['student', 'Internship'],
    ['recent_graduate', 'Entry level'],
  ])('a %s with no resume suggestion starts with %s selected', async (seekerType, label) => {
    installFetch({ [`GET ${P}/state`]: () => confirmState({ jobCount: 2 }, { situation: { timing: 'asap', seekerType } }), ...noFeedCount });
    renderWith(<OnboardingStepPage step="confirm" />);
    const chip = await screen.findByRole('button', { name: new RegExp(`^${label}`) });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Suggested from your resume')).toBeNull();
  });

  it('a run that stopped at its cap is shown as "N+", never as an exact number', async () => {
    installFetch({
      [`GET ${P}/state`]: () => confirmState({ jobCount: 120, compared: 200, ranked: true, resumeCompared: true, comparedCapped: true }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: 'We found 120+ jobs that fit you. Check these details.' })).toBeInTheDocument();
  });

  it('0 at Good fit or better opens the help', async () => {
    installFetch({
      [`GET ${P}/state`]: () => confirmState({ jobCount: 0, compared: 12, ranked: true, resumeCompared: true }, { resume: { resumeVariantId: 'rv1' } }),
      ...noFeedCount,
    });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: "We didn't find strong fits yet. Adjust your search below." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Change what you're looking for" })).toHaveAttribute('href', '/onboarding/basics');
    fireEvent.click(screen.getByRole('button', { name: 'Show my jobs' }));
    expect(screen.getByText('Pick at least one level.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Mid level/ }));
    expect(screen.queryByText('Pick at least one level.')).toBeNull();
  });

  it('never claims a number while O6 is still running in the background', async () => {
    installFetch({ [`GET ${P}/state`]: () => confirmState({ jobCount: 0, continuedInBackground: true }), ...noFeedCount });
    renderWith(<OnboardingStepPage step="confirm" />);
    expect(await screen.findByRole('heading', { name: "We're still checking jobs for you. Check these details." })).toBeInTheDocument();
  });

  it('confirmCountOf: results stored before `resumeCompared` existed follow the resume answer', () => {
    expect(confirmCountOf(undefined, true)).toEqual({ kind: 'pending' });
    expect(confirmCountOf({ jobCount: 30, compared: 62 }, true)).toEqual({ kind: 'fit', count: 30, capped: false, compared: 62 });
    // No resume and no stored search size: no number (the comparison's 62 is not the search's size).
    expect(confirmCountOf({ jobCount: 30, compared: 62 }, false)).toEqual({ kind: 'uncounted' });
    expect(confirmCountOf({ jobCount: 3 }, false)).toEqual({ kind: 'uncounted' });
    expect(confirmCountOf({ jobCount: 30, compared: 62, searchCount: 410 }, false)).toEqual({ kind: 'search', count: 410, capped: false });
    // 个性化推荐 off: the jobs were found, not compared.
    expect(confirmCountOf({ jobCount: 40, compared: 40, ranked: false, resumeCompared: false }, true)).toEqual({ kind: 'uncounted' });
    expect(confirmCountOf({ jobCount: 40, compared: 40, ranked: false, resumeCompared: false, searchCount: 44, searchCountCapped: true }, true)).toEqual({ kind: 'search', count: 44, capped: true });
    // With a resume the fit count stays, whatever else was stored.
    expect(confirmCountOf({ jobCount: 9, compared: 62, resumeCompared: true, searchCount: 1586 }, true)).toEqual({ kind: 'fit', count: 9, capped: false, compared: 62 });
    // Still running: no number yet.
    expect(confirmCountOf({ jobCount: 0, continuedInBackground: true, searchCount: 5 }, false)).toEqual({ kind: 'pending' });
  });
});

describe('errors and GoApply', () => {
  it('a refused save shows a plain message and keeps the answers', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(state()),
      [`PUT ${P}/steps/situation`]: () => fail(409, 'conflict', { reason: 'onboarding_step_not_available' }),
    });
    renderWith(<OnboardingStepPage step="situation" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'In the next few months' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Experienced professional' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Finish the earlier steps first.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'In the next few months' })).toHaveAttribute('aria-checked', 'true');
  });

  it('GoApply renders its own screens from onboarding-cn', async () => {
    // Wave 3 gate: WP-31 replaced the onboarding-cn stubs (which rendered
    // nothing) with real steps, so G1 now renders the CN consent screen.
    installFetch({ [`GET ${P}/state`]: () => ok(state({ brand: 'goapply', stage: 'consent', nextRoute: '/onboarding/consent', progress: { total: 8, stepsLeft: 8, leftEarly: null } })) });
    renderWith(<OnboardingStepPage step="consent" />, { brand: 'goapply' });
    await waitFor(() => expect(screen.queryByText('Loading your setup…')).toBeNull());
    expect(nav.replace).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Before you start' })).toBeInTheDocument();
  });
});

describe('O5 upload door', () => {
  it('rejects a wrong type and an oversized file before uploading; a good file is uploaded and shown as ready', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'resume', branch: 'urgent' })),
      'GET /api/v1/roboapply/compliance/consents': () => ok({ items: [] }),
    });
    resumes.upload.mockResolvedValue({ id: 'rv9', name: 'cv.pdf' });
    renderWith(<OnboardingStepPage step="resume" />);
    const input = (await screen.findByTestId('resume-file')) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'cv.rtf', { type: 'application/rtf' })] } });
    expect(await screen.findByText('Use a PDF, Word or text file.')).toBeInTheDocument();
    const big = new File(['x'], 'cv.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText('This file is larger than 15 MB.')).toBeInTheDocument();
    expect(resumes.upload).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(['x'], 'cv.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText(/Ready: cv\.pdf/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find my jobs' })).toBeEnabled();
  });
});
