// components/features/practice/__tests__/practicePage.test.tsx
//
// WP-43 — /practice from a job: prefill from `?job=`, the server-side create
// (jobId, resume, recording), 402 → the shared out-of-credits sheet plus the
// free-first-practice notice, a market-mismatch 404, the recording consent
// row and the choice it sends, the balance refetch after the setup grants the
// free first practice, GoApply's written practice when voice is unavailable
// (job forwarded, metered, 402 back to the setup), and no market-requirements
// preview where AI is blocked or on GoApply.

import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import PracticePage from '../../../../app/(auth)/practice/page';
import { RoboApiError } from '../../../../lib/api/client';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { mockAuthState } from '../../../../__tests__/utils/mockAuth';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const m = vi.hoisted(() => ({
  setup: vi.fn(),
  create: vi.fn(),
  textStart: vi.fn(),
  push: vi.fn(),
  report: vi.fn(),
  flags: { interviewBank: true } as Record<string, boolean>,
  credits: vi.fn(),
  getConsents: vi.fn(),
  recordConsent: vi.fn(),
}));

const CREDITS = { balance: 5, periodAllotment: 1, tier: 'free', creditMinutes: 20 };

vi.mock('../../../../lib/api/interviewEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api/interviewEngine')>()),
  interviewEngineApi: { recent: vi.fn(async () => ({ sessions: [] })), remove: vi.fn(), create: vi.fn(), preview: vi.fn() },
  practiceApi: { setup: m.setup, create: m.create, info: vi.fn(), practicedJobs: vi.fn() },
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
  useCredits: () => ({ data: { summary: { upgradable: true } } }),
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

function apiError(status: number, payload: Record<string, unknown>) {
  return new RoboApiError(String(payload.error), { code: String(payload.error), status, payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.flags = { interviewBank: true };
  m.credits.mockResolvedValue(CREDITS);
  m.getConsents.mockResolvedValue({
    items: [
      consentItem('interview_recording', 'Keep the audio and transcript of my practice interviews.'),
      consentItem('interview_video', 'Also keep the video of my practice interviews.'),
    ],
  });
  m.recordConsent.mockResolvedValue({});
  m.setup.mockResolvedValue(setupPayload());
  m.create.mockResolvedValue({ session: { id: 'sess1' }, practice: { jobId: 'j1', resumeId: 'r1', recording: { audio: false, video: false } } });
  window.history.replaceState({}, '', '/practice?job=j1');
});

describe('/practice?job=', () => {
  it('prefills the job and resume, then creates the session server-side with the job and no recording', async () => {
    renderWithProviders(<PracticePage />);
    const banner = await screen.findByTestId('practice-job-banner');
    expect(banner).toHaveTextContent('Backend Engineer at Acme');
    expect(banner).toHaveTextContent('Using your resume tailored for this job: Acme version');
    expect(m.setup).toHaveBeenCalledWith({ job: 'j1', resume: null });
    expect(screen.getByTestId('practice-recording-row')).toHaveTextContent('Recording: Off');
    expect(screen.getByRole('link', { name: 'Practice questions' })).toHaveAttribute('href', '/practice/questions');

    const start = screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0]).toMatchObject({
      role: 'Backend Engineer',
      jdText: 'Build APIs.',
      jobId: 'j1',
      resumeId: null,
      recording: { audio: false, video: false },
    });
    expect(m.create.mock.calls[0][0]).not.toHaveProperty('resumeContext');
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
    const start = await screen.findByRole('button', { name: 'Start the interview' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(m.report).toHaveBeenCalledWith({ bucket: 'practice', resetsAt: null, upgradable: true }));
    expect(await screen.findByText('Verify your email to get your first practice interview free.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Verify email' })).toHaveAttribute('href', '/settings#account');
  });

  it('a job from the other market shows a notice and leaves the setup usable', async () => {
    m.setup.mockRejectedValue(apiError(404, { error: 'job_not_found' }));
    renderWithProviders(<PracticePage />);
    expect(await screen.findByText("That job isn't available here. Pick a role or paste a job post instead.")).toBeTruthy();
    expect(screen.queryByTestId('practice-job-banner')).toBeNull();
  });

  it('"Practice without this job" drops the job from the session', async () => {
    renderWithProviders(<PracticePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Practice without this job' }));
    expect(screen.queryByTestId('practice-job-banner')).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: /Format\s*Video/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Voice only/ }));
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0].recording).toEqual({ audio: true, video: false });
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
    await waitFor(() => expect(m.credits).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(m.credits).toHaveBeenCalledTimes(1);
  });

  it('offers the market-requirements preview on RoboApply', async () => {
    renderWithProviders(<PracticePage />);
    expect(await screen.findByRole('button', { name: 'Preview what you may be asked' })).toBeTruthy();
  });
});

describe('GoApply without voice', () => {
  it('offers the written practice with a one-line reason and runs it on the page', async () => {
    m.setup.mockResolvedValue(setupPayload({
      market: 'cn', job: null, resume: null,
      voice: { available: false, reason: 'voice_unavailable' },
    }));
    m.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: 'Tell me about yourself.', hint: '', coachTip: null }], jobId: null });
    window.history.replaceState({}, '', '/practice');
    renderWithProviders(goApply(<PracticePage />));
    expect(await screen.findByText("Voice practice isn't available here yet, so this practice is in writing.")).toBeTruthy();
    fireEvent.click(await screen.findByRole('radio', { name: 'Frontend Engineer' }));
    const start = await screen.findByRole('button', { name: 'Start the written practice' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByRole('heading', { name: 'Written practice' })).toBeTruthy();
    expect(await screen.findByText('Tell me about yourself.')).toBeTruthy();
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({ role: 'Frontend Engineer', jobId: null }));
    expect(m.create).not.toHaveBeenCalled();
  });

  it('practises for the job: the written practice gets the job id', async () => {
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    m.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: 'Why Acme?', hint: '', coachTip: null }], jobId: 'j1' });
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await startButton('Start the written practice'));
    expect(await screen.findByText('Why Acme?')).toBeTruthy();
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1', role: 'Backend Engineer' }));
  });

  it('the written practice is metered: Start stays off without credits', async () => {
    m.credits.mockResolvedValue({ ...CREDITS, balance: 0 });
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
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

  it('shows no market-requirements preview on GoApply', async () => {
    m.setup.mockResolvedValue(setupPayload({ market: 'cn', voice: { available: false, reason: 'voice_unavailable' } }));
    renderWithProviders(goApply(<PracticePage />));
    await screen.findByTestId('practice-job-banner');
    expect(screen.queryByRole('button', { name: 'Preview what you may be asked' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Preview/ })).toBeNull();
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
    fireEvent.click(await screen.findByRole('radio', { name: 'Frontend Engineer' }));
    const start = screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement;
    await new Promise((r) => setTimeout(r, 0));
    expect(start.disabled).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Add phone number' })).toHaveLength(1);
  });
});
