// components/features/practice/__tests__/practicePage.test.tsx
//
// WP-43 — /practice from a job: prefill from `?job=`, the interview planned
// for that job (prep/plan with its id), the server-side create (jobId, resume,
// recording, and the plan with the interviewer and focus chosen from it),
// 402 → the shared out-of-credits sheet plus the free-first-practice notice, a
// market-mismatch 404, the recording consent row and the choice it sends, the
// balance refetch after the setup grants the free first practice, GoApply's
// written practice when voice is unavailable (job and plan forwarded, metered,
// 402 back to the setup), and the prep brief on both brands (the AI label on
// GoApply only).
//
// FIX-6 — what the first plan on screen promises: a length the balance covers
// ("1 credit left", Start on), no "verify to get your first practice free"
// notice while the balance covers a practice, no "Get credits" link where
// nothing is on sale, and no video or voice format where the practice runs in
// writing.

import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import PracticePage from '../../../../app/(auth)/practice/page';
import { RoboApiError } from '../../../../lib/api/client';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { mockAuthState } from '../../../../__tests__/utils/mockAuth';
import {
  DANA,
  PREP_INDUSTRIES,
  SYSTEM_FOCUS,
  companyStyle,
  prepPlan,
  prepSearchResult,
} from '../../../../__tests__/utils/prepFixtures';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const m = vi.hoisted(() => ({
  setup: vi.fn(),
  create: vi.fn(),
  textStart: vi.fn(),
  industries: vi.fn(),
  roles: vi.fn(),
  search: vi.fn(),
  plan: vi.fn(),
  push: vi.fn(),
  report: vi.fn(),
  flags: { interviewBank: true } as Record<string, boolean>,
  credits: vi.fn(),
  getConsents: vi.fn(),
  recordConsent: vi.fn(),
  upgradable: true,
  plans: undefined as unknown,
  plansEnabled: [] as boolean[],
}));

const CREDITS = { balance: 5, periodAllotment: 1, tier: 'free', creditMinutes: 20 };

/** The plan prep/plan writes for the job (Acme's own interview style included). */
const PLAN = prepPlan({ role: 'Backend Engineer', company: 'Acme', jobId: 'j1', companyStyle: companyStyle() });

vi.mock('../../../../lib/api/interviewEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api/interviewEngine')>()),
  interviewEngineApi: { recent: vi.fn(async () => ({ sessions: [] })), remove: vi.fn(), preview: vi.fn() },
  practiceApi: { setup: m.setup, create: m.create, info: vi.fn(), practicedJobs: vi.fn() },
  prepApi: { industries: m.industries, roles: m.roles, search: m.search, plan: m.plan },
  textPracticeApi: {
    start: m.textStart,
    nextTurn: vi.fn(),
    score: vi.fn(),
  },
}));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('../../../../hooks/useAccount', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  const accountKeys = { credits: () => ['account', 'credits'] as const };
  return {
    accountKeys,
    useCredits: () => useQuery({ queryKey: accountKeys.credits(), queryFn: () => m.credits() }),
  };
});
vi.mock('../../../../lib/api/compliance', () => ({ getConsents: m.getConsents, recordConsent: m.recordConsent }));
vi.mock('../../../../hooks/shared/useCredits', () => ({
  useCredits: () => ({ data: { summary: { upgradable: m.upgradable } } }),
}));
vi.mock('../../../../hooks/credits/usePlans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../hooks/credits/usePlans')>()),
  usePlans: (options: { enabled?: boolean } = {}) => {
    m.plansEnabled.push(options.enabled !== false);
    return { data: options.enabled === false ? undefined : m.plans };
  },
}));
vi.mock('../../../../hooks/shared/useCreditGate', () => ({ reportCreditsExhausted: m.report }));
vi.mock('../../../../lib/flags', () => ({ useFlag: (key: string) => m.flags[key] === true }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: m.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/practice',
}));

function setupPayload(extra: Record<string, unknown> = {}) {
  return {
    market: 'intl',
    job: { id: 'j1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin', jdText: 'Build APIs.', closed: false },
    resume: { id: 'r1', name: 'Acme version', kind: 'tailored' },
    firstPractice: { method: 'email', verified: true, grant: 'already_granted' },
    voice: { available: true, reason: null },
    ai: { allowed: true, reason: null },
    recording: { available: true, consent: { audio: false, video: false } },
    ...extra,
  };
}

function consentItem(type: string, prose: string) {
  return {
    type, required: false, stage: 'in_context', control: 'toggle', withdrawable: true, onWithdraw: 'none',
    defaultGranted: false, prose, proseVersion: 'v1', proseHash: 'h', proseLocale: 'en', granted: null, answeredAt: null,
  };
}

function goApply(ui: ReactNode) {
  return <BrandProvider brand={clientBrandFor('goapply')}>{ui}</BrandProvider>;
}

async function startButton(name = 'Start the interview') {
  const start = (await screen.findByRole('button', { name })) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  return start;
}

/** A dock chip (its accessible name holds the current value); it shows once the plan is in. */
const chip = (name: RegExp) => screen.findByRole('button', { name, expanded: false }, { timeout: 3000 });

/** The prep brief section, once the plan is in. */
async function prepBrief() {
  const toggle = await screen.findByRole('button', { name: /Your prep brief/ }, { timeout: 3000 });
  return { toggle, brief: toggle.closest('section') as HTMLElement };
}

/** Without a job: type a title and pick the role (the search runs once typing pauses). */
async function pickFrontendRole() {
  fireEvent.change(await screen.findByRole('searchbox', { name: 'Job title' }), { target: { value: 'frontend' } });
  const roles = await screen.findByRole('group', { name: 'Roles that match' }, { timeout: 3000 });
  fireEvent.click(within(roles).getByRole('button', { name: /^Frontend Engineer/ }));
}

function apiError(status: number, payload: Record<string, unknown>) {
  return new RoboApiError(String(payload.error), { code: String(payload.error), status, payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.flags = { interviewBank: true };
  m.upgradable = true;
  m.plans = undefined;
  m.plansEnabled.length = 0;
  m.credits.mockReset().mockResolvedValue(CREDITS);
  m.getConsents.mockResolvedValue({
    items: [
      consentItem('interview_recording', 'Keep the audio and transcript of my practice interviews.'),
      consentItem('interview_video', 'Also keep the video of my practice interviews.'),
    ],
  });
  m.recordConsent.mockResolvedValue({});
  m.setup.mockReset().mockResolvedValue(setupPayload());
  m.create.mockReset().mockResolvedValue({ session: { id: 'sess1' }, practice: { jobId: 'j1', resumeId: 'r1', recording: { audio: false, video: false } } });
  m.textStart.mockReset();
  m.industries.mockReset().mockResolvedValue({ industries: PREP_INDUSTRIES });
  m.roles.mockReset().mockResolvedValue({ roles: [] });
  m.search.mockReset().mockResolvedValue(prepSearchResult({
    query: 'frontend',
    roles: [{ title: 'Frontend Engineer', titleEn: null, source: 'ai', context: 'Builds the web app', taxonomyId: null }],
    postings: [],
  }));
  m.plan.mockReset().mockResolvedValue({ plan: PLAN });
  window.history.replaceState({}, '', '/practice?job=j1');
});

describe('/practice?job=', () => {
  it('prefills the job and resume, plans the interview for the job, then creates the session server-side with the plan, the job and no recording', async () => {
    renderWithProviders(<PracticePage />);
    const banner = await screen.findByTestId('practice-job-banner');
    expect(banner).toHaveTextContent('Backend Engineer at Acme');
    expect(banner).toHaveTextContent('Using your resume tailored for this job: Acme version');
    expect(m.setup).toHaveBeenCalledWith({ job: 'j1', resume: null });
    expect(screen.getByTestId('practice-recording-row')).toHaveTextContent('Recording: Off');
    expect(screen.getByRole('link', { name: 'Practice questions' })).toHaveAttribute('href', '/practice/questions');

    // The job is planned by its id (the server reads the post), in its company's style.
    await waitFor(() => expect(m.plan).toHaveBeenCalledWith({ jobId: 'j1', company: 'Acme' }, expect.anything()));
    expect(m.plan).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Acme');
    expect(await chip(/^Interviewer\s*Dana Okafor/)).toBeTruthy();
    expect(screen.getByText('Backend Engineer · Acme')).toBeTruthy();

    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    const body = m.create.mock.calls[0][0];
    expect(body).toMatchObject({
      role: 'Backend Engineer',
      jobId: 'j1',
      resumeId: null,
      recording: { audio: false, video: false },
      // The interviewer's catalog persona and the focus's format, with the plan they came from.
      personaId: DANA.baseId,
      interviewType: SYSTEM_FOCUS.format,
      prep: { plan: PLAN, interviewerKey: DANA.key, focusKey: SYSTEM_FOCUS.key },
    });
    // The server loads the job's post and picks the resume; the browser sends neither.
    expect(body.jdText).toBeUndefined();
    expect(body).not.toHaveProperty('resumeContext');
    await waitFor(() => expect(m.push).toHaveBeenCalledWith('/practice/sess1'));
  });

  it('hides the Practice questions link when the question bank is off', async () => {
    m.flags = {};
    renderWithProviders(<PracticePage />);
    await screen.findByTestId('practice-job-banner');
    expect(screen.queryByRole('link', { name: 'Practice questions' })).toBeNull();
  });

  it('a 402 opens the practice out-of-credits sheet and says how to get the free first practice', async () => {
    m.create.mockRejectedValue(apiError(402, {
      error: 'insufficient_credits', balance: 0, required: 2, bucket: 'practice',
      firstPractice: { method: 'email', verified: false, grant: null },
    }));
    renderWithProviders(<PracticePage />);
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.report).toHaveBeenCalledWith({ bucket: 'practice', resetsAt: null, upgradable: true }));
    expect(await screen.findByText('Verify your email to get your first practice interview free.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Verify email' })).toHaveAttribute('href', '/settings#account');
  });

  it('a job from the other market shows a notice, plans nothing for it, and leaves the setup usable', async () => {
    m.setup.mockRejectedValue(apiError(404, { error: 'job_not_found' }));
    renderWithProviders(<PracticePage />);
    expect(await screen.findByText("That job isn't available here. Pick a role or paste a job post instead.")).toBeTruthy();
    expect(screen.queryByTestId('practice-job-banner')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Job title' })).toBeTruthy();
    expect(m.plan).not.toHaveBeenCalled();
  });

  it('"Practice without this job" drops the job from the session', async () => {
    renderWithProviders(<PracticePage />);
    await chip(/^Interviewer/);
    fireEvent.click(await screen.findByRole('button', { name: 'Practice without this job' }));
    expect(screen.queryByTestId('practice-job-banner')).toBeNull();
    // Back to choosing a job: the plan for the dropped one is gone, and so is Start.
    expect(screen.getByRole('searchbox', { name: 'Job title' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Interviewer/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the recording choice only after the consent sheet confirms it', async () => {
    renderWithProviders(<PracticePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep the audio and transcript of my practice interviews.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(m.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ type: 'interview_recording', granted: true }));
    expect(screen.getByTestId('practice-recording-row')).toHaveTextContent('Audio and transcript');

    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0].recording).toEqual({ audio: true, video: false });
  });

  it('drops video from the choice when the format is voice', async () => {
    renderWithProviders(<PracticePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep the audio and transcript of my practice interviews.' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Also keep the video/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('practice-recording-row')).toHaveTextContent('Audio, video and transcript');

    fireEvent.click(await chip(/Format\s*Video/));
    fireEvent.click(await screen.findByRole('radio', { name: /Voice only/ }));
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0].recording).toEqual({ audio: true, video: false });
    expect(m.create.mock.calls[0][0].mode).toBe('voice');
  });

  it('refetches the balance after the setup grants the free first practice, so Start turns on', async () => {
    m.credits.mockResolvedValueOnce({ ...CREDITS, balance: 0 }).mockResolvedValue({ ...CREDITS, balance: 3 });
    m.setup.mockResolvedValue(setupPayload({ firstPractice: { method: 'email', verified: true, grant: 'granted' } }));
    renderWithProviders(<PracticePage />);
    await startButton();
    expect(m.credits).toHaveBeenCalledTimes(2);
  });

  it('keeps Start off when the balance is short and nothing was granted', async () => {
    m.credits.mockResolvedValue({ ...CREDITS, balance: 0 });
    renderWithProviders(<PracticePage />);
    await screen.findByTestId('practice-job-banner');
    // The plan is on screen: Start is off for the balance alone.
    await chip(/^Interviewer/);
    await waitFor(() => expect(m.credits).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(m.credits).toHaveBeenCalledTimes(1);
  });

  it('shows the prep brief written for the job, without the AI label on RoboApply', async () => {
    renderWithProviders(<PracticePage />);
    const { toggle, brief } = await prepBrief();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(brief).getByRole('heading', { name: 'What this job tests' })).toBeTruthy();
    expect(brief).toHaveTextContent('Builds and runs the payment APIs.');
    expect(within(brief).getByRole('heading', { name: 'How Acme interviews' })).toBeTruthy();
    expect(within(brief).getByRole('link', { name: 'How Acme hires' })).toHaveAttribute('href', 'https://acme.example/hiring');
    expect(within(brief).getByRole('heading', { name: 'How this practice will run' })).toBeTruthy();
    expect(within(brief).getByRole('heading', { name: 'Prepare before you start' })).toBeTruthy();
    // RoboApply labels AI text in its own words; the GoApply badge is not shown.
    expect(toggle.querySelector('[data-ai-label]')).toBeNull();
    // The old market-requirements preview is gone.
    expect(screen.queryByRole('button', { name: 'Preview what you may be asked' })).toBeNull();
  });
});

describe('GoApply without voice', () => {
  it('offers the written practice with a one-line reason and runs it on the page, with the plan', async () => {
    m.setup.mockResolvedValue(setupPayload({
      market: 'cn', job: null, resume: null,
      voice: { available: false, reason: 'voice_unavailable' },
    }));
    m.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: 'Tell me about yourself.', hint: '', coachTip: null }], jobId: null });
    m.plan.mockResolvedValue({ plan: prepPlan({ role: 'Frontend Engineer' }) });
    window.history.replaceState({}, '', '/practice');
    renderWithProviders(goApply(<PracticePage />));
    expect(await screen.findByText("Voice practice isn't available here yet, so this practice is in writing.")).toBeTruthy();
    await pickFrontendRole();
    await waitFor(() => expect(m.plan).toHaveBeenCalledWith({ role: 'Frontend Engineer' }, expect.anything()));
    const start = await startButton('Start the written practice');
    // FIX-6: the practice is written, so no video or voice format is offered.
    expect(screen.getByRole('button', { name: /^Length/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Format/ })).toBeNull();
    expect(screen.queryByText('Video call')).toBeNull();
    expect(screen.queryByText('Voice only')).toBeNull();
    fireEvent.click(start);
    expect(await screen.findByRole('heading', { name: 'Written practice' })).toBeTruthy();
    expect(await screen.findByText('Tell me about yourself.')).toBeTruthy();
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({
      role: 'Frontend Engineer',
      jobId: null,
      // The plan's interviewer (its catalog persona) and focus (its format), and the plan itself.
      interviewerId: DANA.baseId,
      typeId: SYSTEM_FOCUS.format,
      durationMinutes: 20,
      prep: { plan: expect.objectContaining({ role: 'Frontend Engineer' }), interviewerKey: DANA.key, focusKey: SYSTEM_FOCUS.key },
    }));
    expect(m.create).not.toHaveBeenCalled();
  });

  it('practises for the job: the written practice gets the job id and the plan', async () => {
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    m.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: 'Why Acme?', hint: '', coachTip: null }], jobId: 'j1' });
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await startButton('Start the written practice'));
    expect(await screen.findByText('Why Acme?')).toBeTruthy();
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'j1',
      role: 'Backend Engineer',
      prep: { plan: PLAN, interviewerKey: DANA.key, focusKey: SYSTEM_FOCUS.key },
    }));
  });

  it('the written practice is metered: Start stays off without credits', async () => {
    m.credits.mockResolvedValue({ ...CREDITS, balance: 0 });
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    await chip(/^Interviewer/);
    await waitFor(() => expect(m.credits).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByRole('button', { name: 'Start the written practice' }) as HTMLButtonElement).disabled).toBe(true);
    expect(m.textStart).not.toHaveBeenCalled();
  });

  it('a 402 from the written practice goes back to the setup with the out-of-credits sheet', async () => {
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    m.textStart.mockRejectedValue(apiError(402, {
      error: 'insufficient_credits', balance: 0, required: 1, bucket: 'practice',
      firstPractice: { method: 'phone', verified: true, grant: 'already_granted' },
    }));
    renderWithProviders(goApply(<PracticePage />));
    fireEvent.click(await startButton('Start the written practice'));
    await waitFor(() => expect(m.report).toHaveBeenCalledWith({ bucket: 'practice', resetsAt: null, upgradable: true }));
    expect(await screen.findByRole('button', { name: 'Start the written practice' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Written practice' })).toBeNull();
  });

  it('the prep brief is shown here too (it does not depend on voice), with the AI label', async () => {
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    const { toggle, brief } = await prepBrief();
    expect(within(brief).getByRole('heading', { name: 'What this job tests' })).toBeTruthy();
    expect(toggle.querySelector('[data-ai-label="text"]')).toHaveTextContent('AI-generated');
  });

  it('without a bound phone the AI practice cannot start and the notice links to binding', async () => {
    m.setup.mockResolvedValue(setupPayload({
      market: 'cn', job: null,
      ai: { allowed: false, reason: 'phone_binding_required' },
      voice: { available: false, reason: 'phone_binding_required' },
      firstPractice: { method: 'phone', verified: false, grant: null },
    }));
    window.history.replaceState({}, '', '/practice');
    renderWithProviders(goApply(<PracticePage />));
    expect(await screen.findByText('Add a phone number before using AI practice.')).toBeTruthy();
    // The prep calls reach a model: none is made while the gate is closed.
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Job title' }), { target: { value: 'frontend' } });
    await new Promise((r) => setTimeout(r, 900));
    expect(m.search).not.toHaveBeenCalled();
    expect(m.plan).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Interviewer/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Add phone number' })).toHaveLength(1);
  });
});

// ─── FIX-6: the first plan on screen is one the user can start ────────────

/** A balance of one credit (20 minutes), as a new account has. */
const ONE_CREDIT = { ...CREDITS, balance: 1 };
const UNVERIFIED = { firstPractice: { method: 'email', verified: false, grant: null } };
const PACK = { key: 'practice_pack', kind: 'pack', amountMinor: 900, unsellableReason: null, requiresFlag: null, phase: 'mvp', sellable: true };

describe('a new user with one credit', () => {
  it('starts on 20 minutes, which one credit covers: "1 credit left", Start on, no shortfall and no verify notice', async () => {
    m.credits.mockResolvedValue(ONE_CREDIT);
    m.setup.mockResolvedValue(setupPayload(UNVERIFIED));
    renderWithProviders(<PracticePage />);
    await screen.findByTestId('practice-job-banner');
    // A practice runs 20 minutes by default: one credit at the standard rate.
    expect(await chip(/^Length\s*20 min/)).toBeTruthy();
    expect(await screen.findByText('Costs 1 credit · 1 credit left')).toBeTruthy();
    expect(screen.queryByText(/1 credits/)).toBeNull();
    await startButton();
    expect(screen.queryByRole('alert')).toBeNull();
    // The balance covers a practice, so nothing asks to verify for a free one.
    expect(screen.queryByText('Verify your email to get your first practice interview free.')).toBeNull();
    expect(m.plansEnabled.every((enabled) => !enabled)).toBe(true);
  });

  it('a longer length picked by hand says what is missing and offers the shorter one, still without the verify notice', async () => {
    m.credits.mockResolvedValue(ONE_CREDIT);
    m.setup.mockResolvedValue(setupPayload(UNVERIFIED));
    renderWithProviders(<PracticePage />);
    fireEvent.click(await chip(/^Length\s*20 min/));
    const tray = await screen.findByRole('group', { name: 'How long should it run?' });
    expect(within(tray).getAllByRole('radio').map((r) => r.textContent?.match(/\d+ min/)?.[0])).toEqual(['15 min', '20 min', '30 min']);
    expect(within(tray).getByRole('radio', { name: /^30 min/ })).toHaveTextContent('1.5 credits — more than you have');
    expect(within(tray).getByRole('radio', { name: /^20 min/ })).toHaveTextContent('Costs 1 credit');
    expect(within(tray).getByRole('radio', { name: /^15 min/ })).toHaveTextContent('Costs 0.75 credits');
    fireEvent.click(within(tray).getByRole('radio', { name: /^30 min/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This interview needs 1.5 credits and you have 1. Add credits to continue.');
    // The plan picker itself, like the report's "get more" link.
    expect(within(alert).getByRole('link', { name: 'Get credits' })).toHaveAttribute('href', '/settings/billing#plans');
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Verify your email to get your first practice interview free.')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Use 20 min instead' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await chip(/^Length\s*20 min/)).toBeTruthy();
    await startButton();
  });

  it('with no credit for any length, the unverified user is told how to get the free first practice', async () => {
    m.credits.mockResolvedValue({ ...CREDITS, balance: 0 });
    m.setup.mockResolvedValue(setupPayload(UNVERIFIED));
    renderWithProviders(<PracticePage />);
    expect(await screen.findByText('Verify your email to get your first practice interview free.')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This interview needs 1 credit and you have 0.');
    expect(within(alert).queryByRole('button', { name: /min instead/ })).toBeNull();
  });
});

describe('a credit shortfall where nothing is on sale', () => {
  beforeEach(() => {
    m.upgradable = false;
    m.credits.mockResolvedValue({ ...CREDITS, balance: 0 });
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
  });

  it('states the numbers with no "Get credits" link and no "add credits" instruction', async () => {
    m.plans = { plans: [] };
    renderWithProviders(goApply(<PracticePage />));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This interview needs 1 credit and you have 0.');
    expect(alert.textContent).not.toMatch(/Add credits/);
    expect(within(alert).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Get credits' })).toBeNull();
    // The plans were read to find out (only once a shortfall was on screen).
    expect(m.plansEnabled.at(-1)).toBe(true);
  });

  it('shows the link again once a practice pack is on sale', async () => {
    m.plans = { plans: [PACK] };
    renderWithProviders(goApply(<PracticePage />));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Get credits' })).toBeTruthy();
    expect(alert).toHaveTextContent('Add credits to continue.');
  });
});

describe('GoApply with the same capabilities as RoboApply (D5)', () => {
  const CN = { market: 'cn', media: { cameraPublish: true, recordVideo: true } };

  it('voice is offered whenever the server says it is available: the live interview starts, not the written one', async () => {
    m.setup.mockResolvedValue(setupPayload(CN));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    expect(screen.queryByRole('button', { name: 'Start the written practice' })).toBeNull();
    // Video and voice are both offered, as on RoboApply.
    fireEvent.click(await chip(/^Format/));
    expect(await screen.findByRole('radio', { name: /Voice only/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Video call/ })).toBeTruthy();
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0]).toMatchObject({
      jobId: 'j1',
      role: 'Backend Engineer',
      personaId: DANA.baseId,
      prep: { interviewerKey: DANA.key, focusKey: SYSTEM_FOCUS.key },
    });
    expect(m.textStart).not.toHaveBeenCalled();
    await waitFor(() => expect(m.push).toHaveBeenCalledWith('/practice/sess1'));
  });

  it('plans the job the same way, and the prep brief carries the AI label', async () => {
    m.setup.mockResolvedValue(setupPayload(CN));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    await waitFor(() => expect(m.plan).toHaveBeenCalledWith({ jobId: 'j1', company: 'Acme' }, expect.anything()));
    const { toggle, brief } = await prepBrief();
    expect(toggle.querySelector('[data-ai-label="text"]')).toHaveTextContent('AI-generated');
    expect(within(brief).getByRole('heading', { name: 'How Acme interviews' })).toBeTruthy();
    expect(brief).toHaveTextContent('From public sources, summarized by AI. Processes change, so check the links.');
  });

  it('behind GoApply’s AI consent gate no plan is written and the AI practice cannot start', async () => {
    m.setup.mockResolvedValue(setupPayload({ ...CN, ai: { allowed: false, reason: 'ai_consent_required' }, voice: { available: false, reason: 'ai_consent_required' } }));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    expect(await screen.findByText('AI practice needs your consent to AI processing. You can turn it on in Settings.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings#consents');
    await new Promise((r) => setTimeout(r, 0));
    // No plan request (the server would refuse it), no "preparing" state, no plan chips.
    expect(m.plan).not.toHaveBeenCalled();
    expect(screen.queryByText('Preparing your interview')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Interviewer/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a video practice can keep video too when the consent catalog offers it', async () => {
    m.setup.mockResolvedValue(setupPayload(CN));
    m.getConsents.mockResolvedValue({
      brand: 'goapply',
      items: [
        consentItem('interview_recording', 'Keep the audio and transcript of my practice interviews.'),
        consentItem('interview_video', 'Also keep the video of my practice interviews.'),
      ],
    });
    renderWithProviders(goApply(<PracticePage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep the audio and transcript of my practice interviews.' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Also keep the video/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('practice-recording-row')).toHaveTextContent('Audio, video and transcript');
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0].recording).toEqual({ audio: true, video: true });
  });

  it('until the catalog offers the video consent, only audio can be kept', async () => {
    m.setup.mockResolvedValue(setupPayload(CN));
    m.getConsents.mockResolvedValue({
      brand: 'goapply',
      items: [consentItem('interview_recording', 'Keep the audio and transcript of my practice interviews.')],
    });
    renderWithProviders(goApply(<PracticePage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await screen.findByRole('checkbox', { name: 'Keep the audio and transcript of my practice interviews.' });
    expect(screen.queryByRole('checkbox', { name: /Also keep the video/ })).toBeNull();
    expect(screen.getByText('Only audio can be kept. Video is never recorded.')).toBeTruthy();
  });

  it('the operator opt-out (the server says video is not recorded): the camera opt-in is not offered, on either brand', async () => {
    const consents = {
      items: [
        consentItem('interview_recording', 'Keep the audio and transcript of my practice interviews.'),
        consentItem('interview_video', 'Also keep the video of my practice interviews.'),
      ],
    };
    m.getConsents.mockResolvedValue({ brand: 'goapply', ...consents });
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', media: { cameraPublish: false, recordVideo: false } }));
    const view = renderWithProviders(goApply(<PracticePage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await screen.findByRole('checkbox', { name: 'Keep the audio and transcript of my practice interviews.' });
    expect(screen.queryByRole('checkbox', { name: /Also keep the video/ })).toBeNull();
    expect(screen.getByText('Only audio can be kept. Video is never recorded.')).toBeTruthy();
    view.unmount();
    // An older API that sends no policy keeps the opt-in (read as allowed).
    m.setup.mockResolvedValue(setupPayload({ market: 'cn' }));
    renderWithProviders(goApply(<PracticePage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('checkbox', { name: /Also keep the video/ })).toBeTruthy();
  });
});

describe('the Format chip', () => {
  it('RoboApply with voice: video and voice are offered', async () => {
    renderWithProviders(<PracticePage />);
    fireEvent.click(await chip(/^Format\s*Video/));
    expect(await screen.findByRole('radio', { name: /Voice only/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Video call/ })).toBeTruthy();
  });

  it('GoApply while AI practice is gated (no voice either way): no plan, so no format or any other choice is offered', async () => {
    m.setup.mockResolvedValue(setupPayload({
      market: 'cn',
      ai: { allowed: false, reason: 'phone_binding_required' },
      voice: { available: false, reason: 'phone_binding_required' },
    }));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    await new Promise((r) => setTimeout(r, 0));
    expect(m.plan).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Format/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Length/ })).toBeNull();
  });
});
