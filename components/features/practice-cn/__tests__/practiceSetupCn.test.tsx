// INT-09 (WP-66 wiring; wave5 WP-93 #25) — /practice on GoApply:
//   - the picker lists the AI-interview practice format under GoApply's own
//     name and description (practiceCn.format.label / .sub), starts a job
//     practice on it, and offers only its 20–30 minute lengths;
//   - Start sends the format (voice and written practice), priced at the
//     length the server will run;
//   - Start is the WeChat "tell me when my report is ready" prompt point
//     (SubscribeOnTap, template `report_ready`);
//   - RoboApply's catalog has no such format and its screen is unchanged.
// The catalog, the practice API and the prompt wrapper are mocked; no network.

import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import PracticePage from '../../../../app/(auth)/practice/page';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { FIXTURE_MOCK_CATALOG } from '../../../../lib/fixtures/mockCatalog';
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
  catalog: { value: null as unknown },
  subscribeTemplates: [] as string[],
}));

/** The catalog GoApply's server returns: its AI-interview practice format first, then the shared list. */
const CN_TYPE = {
  id: 'cn_ai_interview',
  label: 'AI Interview Practice',
  sub: 'Timed one-way format: self-introduction, story questions, situational and structured-thinking questions',
  minutes: 25,
  suitedRoleCategories: ['All'],
};
const CN_CATALOG = { ...FIXTURE_MOCK_CATALOG, types: [CN_TYPE, ...FIXTURE_MOCK_CATALOG.types] };

vi.mock('../../../../hooks/useMockV3', () => ({
  useMockCatalog: () => ({ data: { catalog: m.catalog.value }, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../../lib/api/interviewEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api/interviewEngine')>()),
  interviewEngineApi: { recent: vi.fn(async () => ({ sessions: [] })), remove: vi.fn(), preview: vi.fn() },
  practiceApi: { setup: m.setup, create: m.create, info: vi.fn(), practicedJobs: vi.fn() },
  textPracticeApi: { start: m.textStart, nextTurn: vi.fn(), score: vi.fn() },
}));
// The prompt wrapper gates itself (GoApply, inside WeChat, `notify.wechat`,
// a linked account); its own tests cover that. Here: where it is mounted.
vi.mock('../../notify-cn', () => ({
  SubscribeOnTap: ({ template, children }: { template: string; children: ReactNode }) => {
    m.subscribeTemplates.push(template);
    return <span data-testid="subscribe-on-tap" data-template={template}>{children}</span>;
  },
}));
vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('../../../../hooks/useAccount', () => ({
  accountKeys: { credits: () => ['account', 'credits'] as const },
  useCredits: () => ({ data: { balance: 9, periodAllotment: 1, tier: 'free', creditMinutes: 20 } }),
}));
vi.mock('../../../../lib/api/compliance', () => ({ getConsents: vi.fn(async () => ({ items: [] })), recordConsent: vi.fn() }));
vi.mock('../../../../hooks/shared/useCredits', () => ({ useCredits: () => ({ data: { summary: { upgradable: true } } }) }));
// The setup reads the plans only when a credit shortfall is on screen; none is here.
vi.mock('../../../../hooks/credits/usePlans', () => ({ usePlans: () => ({ data: undefined }), visiblePlans: () => [] }));
vi.mock('../../../../hooks/shared/useCreditGate', () => ({ reportCreditsExhausted: vi.fn() }));
vi.mock('../../../../lib/flags', () => ({ useFlag: () => false }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: m.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/practice',
}));

function setupPayload(extra: Record<string, unknown> = {}) {
  return {
    market: 'cn',
    job: { id: 'j1', title: '后端工程师', companyName: '某公司', location: '上海', jdText: '负责后端服务。', closed: false },
    resume: null,
    firstPractice: { method: 'phone', verified: true, grant: 'already_granted' },
    voice: { available: true, reason: null },
    ai: { allowed: true, reason: null },
    recording: { available: false, consent: { audio: false, video: false } },
    ...extra,
  };
}

function page(brand: 'goapply' | 'roboapply') {
  return renderWithProviders(<BrandProvider brand={clientBrandFor(brand)}><PracticePage /></BrandProvider>);
}

const FORMAT_LABEL = 'AI interview practice';
const FORMAT_SUB = 'Timed, one question at a time: a self-introduction, story questions, a situational question and a structured-thinking question. 20–30 minutes.';

/** The chip of the launch dock that opens a tray (its accessible name holds the current value). */
const chip = (name: RegExp) => screen.findByRole('button', { name, expanded: false });

async function startButton(name = 'Start the interview') {
  const start = (await screen.findByRole('button', { name })) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  return start;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.subscribeTemplates.length = 0;
  m.catalog.value = CN_CATALOG;
  m.setup.mockResolvedValue(setupPayload());
  m.create.mockResolvedValue({ session: { id: 'sess1' }, practice: { jobId: 'j1', resumeId: null, recording: { audio: false, video: false } } });
  m.textStart.mockResolvedValue({ sessionId: 't1', questions: [{ q: '请做一个自我介绍。', hint: '', coachTip: null }], jobId: 'j1' });
  window.history.replaceState({}, '', '/practice?job=j1');
});

describe('GoApply: the AI-interview practice format in the picker', () => {
  it('a job practice starts on the format, shown under GoApply’s own name and description', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    // The Focus chip shows the format by its GoApply label, never the catalog's English one.
    fireEvent.click(await chip(new RegExp(`Focus\\s*${FORMAT_LABEL}`)));
    const tray = await screen.findByRole('group', { name: 'What should this interview cover?' });
    const option = within(tray).getByRole('radio', { name: new RegExp(`^${FORMAT_LABEL}`) });
    expect(option).toHaveAttribute('aria-checked', 'true');
    expect(option).toHaveTextContent(FORMAT_SUB);
    expect(tray).not.toHaveTextContent('AI Interview Practice'); // the engine's catalog label
    expect(tray).not.toHaveTextContent('Timed one-way format');
    // The shared formats keep their own labels.
    expect(within(tray).getByRole('radio', { name: /^Past situations/ })).toBeInTheDocument();
  });

  it('offers only the format’s lengths (20, 25, 30 minutes) and prices the one chosen', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await chip(/25 min/));
    const tray = await screen.findByRole('group', { name: 'How long should it run?' });
    expect(within(tray).getAllByRole('radio').map((r) => r.textContent?.match(/\d+ min/)?.[0])).toEqual(['20 min', '25 min', '30 min']);
    fireEvent.click(within(tray).getByRole('radio', { name: /^30 min/ }));
    expect(await chip(/30 min/)).toBeInTheDocument();
  });

  it('Start sends the format and its length to the one create route, for the job', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({ interviewType: 'cn_ai_interview', durationMinutes: 25, jobId: 'j1', role: '后端工程师' });
    await waitFor(() => expect(m.push).toHaveBeenCalledWith('/practice/sess1'));
  });

  it('a length chosen for another format is brought into 20–30 minutes when the format is picked', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    // Pick a 55-minute format, keep its length, then come back to the AI-interview practice.
    fireEvent.click(await chip(new RegExp(`Focus\\s*${FORMAT_LABEL}`)));
    fireEvent.click(within(await screen.findByRole('group', { name: 'What should this interview cover?' })).getByRole('radio', { name: /^System design/ }));
    fireEvent.click(await chip(/55 min/));
    fireEvent.click(within(await screen.findByRole('group', { name: 'How long should it run?' })).getByRole('radio', { name: /^60 min/ }));
    fireEvent.click(await chip(/Focus\s*System/));
    fireEvent.click(within(await screen.findByRole('group', { name: 'What should this interview cover?' })).getByRole('radio', { name: new RegExp(`^${FORMAT_LABEL}`) }));
    expect(await chip(/30 min/)).toBeInTheDocument();
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({ interviewType: 'cn_ai_interview', durationMinutes: 30 });
  });

  it('without voice, the written practice starts in the format too', async () => {
    m.setup.mockResolvedValue(setupPayload({ voice: { available: false, reason: 'voice_unavailable' } }));
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await startButton('Start the written practice'));
    expect(await screen.findByRole('heading', { name: 'Written practice' })).toBeInTheDocument();
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'cn_ai_interview', durationMinutes: 25, jobId: 'j1' }));
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a role picked from the list keeps its own recommendation (the format stays one tap away)', async () => {
    m.setup.mockResolvedValue(setupPayload({ job: null }));
    window.history.replaceState({}, '', '/practice');
    page('goapply');
    fireEvent.click(await screen.findByRole('radio', { name: 'Frontend Engineer' }));
    await startButton();
    fireEvent.click(await chip(/Focus/));
    const tray = await screen.findByRole('group', { name: 'What should this interview cover?' });
    expect(within(tray).getByRole('radio', { name: new RegExp(`^${FORMAT_LABEL}`) })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('the WeChat "report ready" prompt point', () => {
  it('Start is wrapped in SubscribeOnTap with the report_ready template, and still starts the practice', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    const start = await startButton();
    const wrap = screen.getByTestId('subscribe-on-tap');
    expect(wrap).toHaveAttribute('data-template', 'report_ready');
    expect(wrap).toContainElement(start);
    expect(new Set(m.subscribeTemplates)).toEqual(new Set(['report_ready']));
    // It wraps the same button: one Start on the page, and it works.
    expect(screen.getAllByRole('button', { name: 'Start the interview' })).toHaveLength(1);
    fireEvent.click(start);
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
  });

  it('the written practice’s Start is the prompt point too', async () => {
    m.setup.mockResolvedValue(setupPayload({ voice: { available: false, reason: 'voice_unavailable' } }));
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    expect(screen.getByTestId('subscribe-on-tap')).toContainElement(await startButton('Start the written practice'));
  });
});

describe('RoboApply is unchanged', () => {
  beforeEach(() => {
    m.catalog.value = FIXTURE_MOCK_CATALOG;
    m.setup.mockResolvedValue(setupPayload({
      market: 'intl',
      job: { id: 'j1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin', jdText: 'Build APIs.', closed: false },
      firstPractice: { method: 'email', verified: true, grant: 'already_granted' },
    }));
  });

  it('no AI-interview practice format, the usual lengths, and a behavioural job practice', async () => {
    page('roboapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await chip(/Focus\s*Past situations/));
    const tray = await screen.findByRole('group', { name: 'What should this interview cover?' });
    expect(within(tray).queryByRole('radio', { name: new RegExp(FORMAT_LABEL, 'i') })).toBeNull();
    expect(document.body.textContent).not.toContain(FORMAT_SUB);
    fireEvent.click(await chip(/40 min/));
    const lengths = await screen.findByRole('group', { name: 'How long should it run?' });
    expect(within(lengths).getAllByRole('radio').map((r) => r.textContent?.match(/\d+ min/)?.[0])).toEqual(['15 min', '30 min', '40 min', '45 min', '60 min']);
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({ interviewType: 'behavioral', durationMinutes: 40, jobId: 'j1' });
  });
});
