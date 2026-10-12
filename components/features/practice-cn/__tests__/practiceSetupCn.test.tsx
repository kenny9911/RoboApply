// INT-09 (WP-66 wiring; wave5 WP-93 #25) — /practice on GoApply, with the
// interview planned by the prep agents:
//   - a planned focus in the AI-interview practice format runs on the format's
//     own lengths (20 or 30 minutes, 20 by default); a fallback plan names it
//     by GoApply's own name and description (practiceCn.format.label / .sub),
//     never the engine catalog's English;
//   - a planned focus in any other format keeps the practice lengths (15, 20,
//     30), with the format one tap away in the Focus tray;
//   - Start sends the format and its length (voice and written practice),
//     priced at the length the server will run;
//   - Start is the WeChat "tell me when my report is ready" prompt point
//     (SubscribeOnTap, template `report_ready`);
//   - RoboApply's plans have no such format and its lengths are unchanged.
// The practice and prep APIs and the prompt wrapper are mocked; no network.

import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import PracticePage from '../../../../app/(auth)/practice/page';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { mockAuthState } from '../../../../__tests__/utils/mockAuth';
import {
  DANA,
  LEO,
  PREP_INDUSTRIES,
  STORIES_FOCUS,
  fallbackPlan,
  prepFocus,
  prepPlan,
} from '../../../../__tests__/utils/prepFixtures';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const m = vi.hoisted(() => ({
  setup: vi.fn(),
  create: vi.fn(),
  textStart: vi.fn(),
  plan: vi.fn(),
  push: vi.fn(),
  subscribeTemplates: [] as string[],
}));

// The catalog only names the interviewers of older sessions in the recent lane (none here).
vi.mock('../../../../hooks/useMockV3', () => ({
  useMockCatalog: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../../lib/api/interviewEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api/interviewEngine')>()),
  interviewEngineApi: { recent: vi.fn(async () => ({ sessions: [] })), remove: vi.fn(), preview: vi.fn() },
  practiceApi: { setup: m.setup, create: m.create, info: vi.fn(), practicedJobs: vi.fn() },
  prepApi: {
    industries: vi.fn(async () => ({ industries: PREP_INDUSTRIES })),
    roles: vi.fn(async () => ({ roles: [] })),
    search: vi.fn(),
    plan: m.plan,
  },
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

/** A plan the model wrote for the job that recommends the AI-interview format (under its own label). */
const CN_WRITTEN = prepPlan({
  role: '后端工程师',
  company: '某公司',
  market: 'cn',
  jobId: 'j1',
  focuses: [
    prepFocus({ key: 'f1', label: 'AI 面试：限时作答', format: 'cn_ai_interview', description: '自我介绍、经历题、情景题和结构化思维题', topics: ['自我介绍', 'STAR'] }),
    STORIES_FOCUS,
  ],
  recommended: { interviewerKey: DANA.key, focusKey: 'f1' },
});

/**
 * GoApply's catalog fallback (the server's fallbackPanel for market cn): the
 * engine catalog's English labels, which the screen replaces with its own.
 * It recommends the first focus, so the format sits in the tray.
 */
const CN_FALLBACK = fallbackPlan({
  role: '后端工程师',
  company: '某公司',
  market: 'cn',
  jobId: 'j1',
  focuses: [
    prepFocus({ key: 'f1', label: 'Behavioral (STAR)', format: 'behavioral', description: 'Ownership, conflict, failure' }),
    prepFocus({ key: 'f2', label: 'Case Interview', format: 'case', description: 'An open business problem' }),
    prepFocus({
      key: 'f3',
      label: 'AI Interview Practice',
      format: 'cn_ai_interview',
      description: 'Timed one-way format: self-introduction, story questions, situational and structured-thinking questions',
    }),
    prepFocus({ key: 'f4', label: 'Culture & values', format: 'culture', description: 'How you work' }),
  ],
  recommended: { interviewerKey: 'i1', focusKey: 'f1' },
});

/** The chip of the launch dock that opens a tray (its accessible name holds the current value); the plan comes first. */
const chip = (name: RegExp) => screen.findByRole('button', { name, expanded: false }, { timeout: 3000 });

const lengthsIn = (tray: HTMLElement) => within(tray).getAllByRole('radio').map((r) => r.textContent?.match(/\d+ min/)?.[0]);

async function startButton(name = 'Start the interview') {
  const start = (await screen.findByRole('button', { name })) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  return start;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.subscribeTemplates.length = 0;
  m.setup.mockReset().mockResolvedValue(setupPayload());
  m.plan.mockReset().mockResolvedValue({ plan: CN_WRITTEN });
  m.create.mockReset().mockResolvedValue({ session: { id: 'sess1' }, practice: { jobId: 'j1', resumeId: null, recording: { audio: false, video: false } } });
  m.textStart.mockReset().mockResolvedValue({ sessionId: 't1', questions: [{ q: '请做一个自我介绍。', hint: '', coachTip: null }], jobId: 'j1' });
  window.history.replaceState({}, '', '/practice?job=j1');
});

describe('GoApply: the AI-interview practice format in a planned interview', () => {
  it('a plan that recommends the format starts on it, on the format’s own lengths (20 or 30 minutes, 20 first)', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    await waitFor(() => expect(m.plan).toHaveBeenCalledWith({ jobId: 'j1', company: '某公司' }, expect.anything()));
    // A written plan names its focus itself.
    expect(await chip(/^Focus\s*AI 面试：限时作答\s*Suggested/)).toBeInTheDocument();
    fireEvent.click(await chip(/^Length\s*20 min/));
    const tray = await screen.findByRole('group', { name: 'How long should it run?' });
    expect(lengthsIn(tray)).toEqual(['20 min', '30 min']);
    expect(within(tray).getByRole('radio', { name: /^20 min/ })).toHaveTextContent('Costs 1 credit');
    expect(within(tray).getByRole('radio', { name: /^30 min/ })).toHaveTextContent('Costs 1.5 credits');
    fireEvent.click(within(tray).getByRole('radio', { name: /^30 min/ }));
    expect(await chip(/^Length\s*30 min/)).toBeInTheDocument();
  });

  it('a fallback plan names the format by GoApply’s own name and description, never the catalog’s English', async () => {
    m.plan.mockResolvedValue({ plan: CN_FALLBACK });
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    // The fallback recommends a general format, labelled from the bundle.
    fireEvent.click(await chip(/^Focus\s*Past situations\s*Suggested/));
    const tray = await screen.findByRole('group', { name: 'What should this interview cover?' });
    const option = within(tray).getByRole('radio', { name: new RegExp(`^${FORMAT_LABEL}`) });
    expect(option).toHaveAttribute('aria-checked', 'false');
    expect(option).toHaveTextContent(FORMAT_SUB);
    expect(tray).not.toHaveTextContent('AI Interview Practice'); // the engine's catalog label
    expect(tray).not.toHaveTextContent('Timed one-way format');
    // The shared formats keep their own labels.
    expect(within(tray).getByRole('radio', { name: /^Past situations/ })).toBeInTheDocument();
    expect(within(tray).getByRole('radio', { name: /^Business case/ })).toBeInTheDocument();
    expect(within(tray).getByRole('radio', { name: /^Values and working style/ })).toBeInTheDocument();

    fireEvent.click(option);
    expect(await chip(new RegExp(`^Focus\\s*${FORMAT_LABEL}`))).toBeInTheDocument();
    fireEvent.click(await chip(/^Length/));
    expect(lengthsIn(await screen.findByRole('group', { name: 'How long should it run?' }))).toEqual(['20 min', '30 min']);
  });

  it('Start sends the format and its length to the one create route, for the job, with the plan', async () => {
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({
      interviewType: 'cn_ai_interview',
      durationMinutes: 20,
      jobId: 'j1',
      role: '后端工程师',
      personaId: DANA.baseId,
      prep: { plan: CN_WRITTEN, interviewerKey: DANA.key, focusKey: 'f1' },
    });
    await waitFor(() => expect(m.push).toHaveBeenCalledWith('/practice/sess1'));
  });

  it('a length chosen for another focus is brought into 20–30 minutes when the format is picked', async () => {
    m.plan.mockResolvedValue({ plan: CN_FALLBACK });
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    // Keep a 15-minute length on the recommended general format, then pick the AI-interview practice.
    fireEvent.click(await chip(/^Length\s*20 min/));
    fireEvent.click(within(await screen.findByRole('group', { name: 'How long should it run?' })).getByRole('radio', { name: /^15 min/ }));
    expect(await chip(/^Length\s*15 min/)).toBeInTheDocument();
    fireEvent.click(await chip(/^Focus\s*Past situations/));
    fireEvent.click(within(await screen.findByRole('group', { name: 'What should this interview cover?' })).getByRole('radio', { name: new RegExp(`^${FORMAT_LABEL}`) }));
    expect(await chip(/^Length\s*20 min/)).toBeInTheDocument();
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({ interviewType: 'cn_ai_interview', durationMinutes: 20, prep: { focusKey: 'f3' } });
  });

  it('without voice, the written practice starts in the format too', async () => {
    m.setup.mockResolvedValue(setupPayload({ voice: { available: false, reason: 'voice_unavailable' } }));
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await startButton('Start the written practice'));
    expect(await screen.findByRole('heading', { name: 'Written practice' })).toBeInTheDocument();
    expect(m.textStart).toHaveBeenCalledWith(expect.objectContaining({
      typeId: 'cn_ai_interview',
      durationMinutes: 20,
      jobId: 'j1',
      interviewerId: DANA.baseId,
      prep: { plan: CN_WRITTEN, interviewerKey: DANA.key, focusKey: 'f1' },
    }));
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a planned focus in another format keeps the usual lengths (15, 20, 30); the format stays one tap away', async () => {
    m.plan.mockResolvedValue({ plan: CN_FALLBACK });
    page('goapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await chip(/^Length\s*20 min/));
    expect(lengthsIn(await screen.findByRole('group', { name: 'How long should it run?' }))).toEqual(['15 min', '20 min', '30 min']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await chip(/^Focus/));
    const tray = await screen.findByRole('group', { name: 'What should this interview cover?' });
    expect(within(tray).getByRole('radio', { name: new RegExp(`^${FORMAT_LABEL}`) })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({ interviewType: 'behavioral', durationMinutes: 20, personaId: 'priya' });
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

describe('RoboApply has no such format', () => {
  beforeEach(() => {
    m.setup.mockResolvedValue(setupPayload({
      market: 'intl',
      job: { id: 'j1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin', jdText: 'Build APIs.', closed: false },
      firstPractice: { method: 'email', verified: true, grant: 'already_granted' },
    }));
    // A plan for the job that recommends a behavioural interview with Leo.
    m.plan.mockResolvedValue({ plan: prepPlan({ jobId: 'j1', company: 'Acme', recommended: { interviewerKey: LEO.key, focusKey: STORIES_FOCUS.key } }) });
  });

  it('no AI-interview practice format, the usual lengths, and a behavioural job practice', async () => {
    page('roboapply');
    await screen.findByTestId('practice-job-banner');
    fireEvent.click(await chip(/^Focus\s*Ownership stories/));
    const tray = await screen.findByRole('group', { name: 'What should this interview cover?' });
    expect(within(tray).queryByRole('radio', { name: new RegExp(FORMAT_LABEL, 'i') })).toBeNull();
    expect(document.body.textContent).not.toContain(FORMAT_SUB);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await chip(/^Length\s*20 min/));
    const lengths = await screen.findByRole('group', { name: 'How long should it run?' });
    expect(lengthsIn(lengths)).toEqual(['15 min', '20 min', '30 min']);
    fireEvent.click(await startButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({ interviewType: 'behavioral', durationMinutes: 20, jobId: 'j1', personaId: LEO.baseId });
  });
});
