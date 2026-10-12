// __tests__/pages/practice.test.tsx
//
// /practice — the one-screen interview brief, planned by the interview-prep
// agents (prep/search, prep/industries + prep/roles, prep/plan; mocked here).
//
// Three things are pinned here. First, the recent-practice lane: it renders
// SERVER data, and it used to leak three English strings into every locale
// (the catalog's raw English type label, a hardcoded 'Interviewer' fallback
// for a persona the catalog no longer carries, and a hand-rolled "2d ago"
// builder). A planned session names its own interviewer, focus and company.
//
// Second, the shape of the screen itself. The four-step wizard this replaced
// walked the candidate through three pre-filled steps before Start became
// reachable; the promise of the redesign is that choosing a job is the ONLY
// required act — typed and searched, browsed by industry, or pasted — and the
// plan written for it is already launchable. That is asserted directly.
//
// Third, what comes back: a report's "Run it again" link and the lane's
// "Practice this again" restore the role (and company) and re-plan, preferring
// the past interviewer and focus — without ever starting a paid interview.

import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AbstractIntlMessages } from 'next-intl';

import PracticePage from '../../app/(auth)/practice/page';
import {
  interviewEngineApi,
  practiceApi,
  type IESessionSummary,
  type PracticeCreateBody,
  type PrepPlanBody,
} from '../../lib/api/interviewEngine';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';
import {
  DANA,
  INDUSTRY_ROLES,
  LEO,
  POSTING_BOARD,
  PREP_INDUSTRIES,
  STORIES_FOCUS,
  SYSTEM_FOCUS,
  CODING_FOCUS,
  companyStyle,
  prepPlan,
  prepSearchResult,
} from '../utils/prepFixtures';
import enMessages from '../../i18n/messages/en.json';
import zhMessages from '../../i18n/messages/zh.json';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();
const creditState = vi.hoisted(() => ({
  data: {
    balance: 1,
    periodAllotment: 1,
    tier: 'free',
    creditMinutes: 20,
  },
}));

const prep = vi.hoisted(() => ({
  industries: vi.fn(),
  roles: vi.fn(),
  search: vi.fn(),
  plan: vi.fn(),
}));

// Two completed sessions: one on a persona the catalog knows (maya), one on a
// persona id it doesn't (the fallback path).
const RECENT = [
  {
    id: 'ie_1', status: 'completed', source: 'app', role: 'Backend Engineer',
    interviewType: 'behavioral', personaId: 'maya', mode: 'video', language: 'zh',
    durationMinutes: 40, overall: 82, externalRef: null,
    createdAt: daysAgo(2), startedAt: daysAgo(2), endedAt: daysAgo(2),
  },
  {
    id: 'ie_2', status: 'completed', source: 'app', role: 'Backend Engineer',
    interviewType: 'behavioral', personaId: 'retired_persona', mode: 'video', language: 'zh',
    durationMinutes: 40, overall: 71, externalRef: null,
    createdAt: daysAgo(3), startedAt: daysAgo(3), endedAt: daysAgo(3),
  },
];

/** A session planned by the prep agents: it names its own interviewer, focus and company. */
const PLANNED = {
  id: 'ie_0', status: 'completed', source: 'app', role: 'Backend Engineer',
  interviewType: 'behavioral', personaId: 'maya', mode: 'voice', language: 'en',
  durationMinutes: 20, overall: 77, externalRef: null,
  createdAt: daysAgo(1), startedAt: daysAgo(1), endedAt: daysAgo(1),
  interviewer: { name: 'Leo Martins', title: 'Engineering manager' },
  focusLabel: 'Ownership stories',
  company: 'Acme',
  jobId: null,
} as IESessionSummary;

vi.mock('../../lib/api/interviewEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/interviewEngine')>();
  return {
    ...actual,
    interviewEngineApi: {
      recent: vi.fn(async () => ({ sessions: RECENT })),
      remove: vi.fn(async () => ({ ok: true })),
      preview: vi.fn(),
    },
    // Sessions are created through the practice route only (the old browser
    // create is gone); spy on it so "nothing was created" can be asserted.
    practiceApi: { ...actual.practiceApi, create: vi.fn() },
    prepApi: prep,
  };
});

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));

vi.mock('../../hooks/useAccount', () => ({
  useCredits: () => ({ data: creditState.data }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
    back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/practice',
}));

// The app deep-merges every bundle over en (lib/i18n.ts); mirror that here so a
// partially-translated bundle behaves in the test exactly as it does in prod.
const zh = {
  ...(enMessages as AbstractIntlMessages),
  ...(zhMessages as AbstractIntlMessages),
} as AbstractIntlMessages;

const create = vi.mocked(practiceApi.create);

function renderPage(locale: 'en' | 'zh' = 'en') {
  return renderWithProviders(<PracticePage />, {
    intlLocale: locale,
    intlMessages: (locale === 'zh' ? zh : enMessages) as AbstractIntlMessages,
  });
}

/** Type a job title; the search runs once typing pauses (650 ms), then lists the roles that match. */
async function search(query: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Job title' }), { target: { value: query } });
  return screen.findByRole('group', { name: 'Roles that match' }, { timeout: 3000 });
}

async function pickRole(name: RegExp, query = 'backend') {
  fireEvent.click(within(await search(query)).getByRole('button', { name }));
}

/** A dock chip (its accessible name holds the current value); the plan has to arrive first. */
const chip = (name: RegExp) => screen.findByRole('button', { name, expanded: false }, { timeout: 3000 });

async function startButton() {
  const start = (await screen.findByRole('button', { name: 'Start the interview' })) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  return start;
}

function createdBody(): PracticeCreateBody {
  return create.mock.calls[0]![0] as PracticeCreateBody;
}

describe('/practice setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/practice');
    creditState.data = {
      balance: 1,
      periodAllotment: 1,
      tier: 'free',
      creditMinutes: 20,
    };
    prep.industries.mockReset().mockResolvedValue({ industries: PREP_INDUSTRIES });
    prep.roles.mockReset().mockResolvedValue({ roles: INDUSTRY_ROLES });
    prep.search.mockReset().mockImplementation(async (body: { query: string }) => prepSearchResult({ query: body.query }));
    prep.plan.mockReset().mockImplementation(async (body: PrepPlanBody) => ({
      plan: prepPlan({ role: body.role ?? 'Backend Engineer', company: body.company ?? null }),
    }));
    create.mockReset().mockResolvedValue({
      session: { id: 'sess1' },
      practice: { jobId: null, resumeId: null, recording: { audio: false, video: false } },
    } as Awaited<ReturnType<typeof practiceApi.create>>);
  });

  it('localizes the type label, the missing-persona fallback and the timestamp', async () => {
    renderPage('zh');

    // Type label off practice.setup.types.behavioral.label, not the catalog's
    // English "Behavioral (STAR)".
    expect(await screen.findByText(/过往经历 · 面试官：Maya/)).toBeTruthy();
    expect(screen.queryByText(/Behavioral/i)).toBeNull();

    // An unknown persona falls back to the localized noun, not 'Interviewer'.
    expect(screen.getByText(/过往经历 · 面试官：未知/)).toBeTruthy();
    expect(screen.queryByText(/Interviewer/)).toBeNull();

    // Intl.RelativeTimeFormat('zh'), not "2d ago".
    expect(screen.getByText('前天')).toBeTruthy();
    expect(screen.getByText('3天前')).toBeTruthy();
    expect(screen.queryByText(/\d+[dhm] ago/)).toBeNull();
  });

  it('a planned session in the lane names its own interviewer, focus and company, and comes back with them', async () => {
    vi.mocked(interviewEngineApi.recent).mockResolvedValueOnce({ sessions: [PLANNED, ...(RECENT as IESessionSummary[])] });
    renderPage();

    expect(await screen.findByText('Backend Engineer · Acme')).toBeTruthy();
    expect(screen.getByText('Ownership stories · with Leo Martins')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Practice this again' })[0]!);
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ role: 'Backend Engineer', company: 'Acme' }, expect.anything()));
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Acme');
    // The new plan recommends Dana on system design; the past interviewer and focus win.
    expect(await chip(/^Interviewer\s*Leo Martins/)).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Focus\s*Ownership stories/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Format\s*Voice/ })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('is one search away from a launchable plan', async () => {
    creditState.data = { balance: 20, periodAllotment: 20, tier: 'pro', creditMinutes: 20 };
    renderPage();

    // Nothing to launch until a job is named — and nothing else is asked for.
    const start = (await screen.findByRole('button', { name: 'Start the interview' })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText('Pick a job above to begin.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    // The title is searched as typed; the roles that match and the open jobs come back.
    await pickRole(/^Backend Engineer/);
    expect(prep.search).toHaveBeenCalledWith({ query: 'backend' }, expect.anything());
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ role: 'Backend Engineer' }, expect.anything()));

    // The plan's recommendation is already on screen, and Start is already live.
    expect(await chip(/^Interviewer\s*Dana Okafor\s*Suggested/)).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Focus\s*Payments system design\s*Suggested/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Format\s*Video/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Length\s*20 min/ })).toBeTruthy();
    await waitFor(() => expect(start.disabled).toBe(false));
    // So is the prep brief written for the job.
    expect(screen.getByRole('button', { name: /Your prep brief/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Builds and runs the payment APIs.')).toBeTruthy();

    // Changing the job re-plans for it: a job board's posting is planned from the post itself.
    prep.plan.mockImplementation(async () => ({
      plan: prepPlan({ role: POSTING_BOARD.title, company: 'Monzo', recommended: { interviewerKey: 'i2', focusKey: 'f2' } }),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Practice for Backend Engineer, Payments at Monzo' }));
    await waitFor(() => expect(prep.plan).toHaveBeenLastCalledWith({
      role: 'Backend Engineer, Payments',
      posting: { title: 'Backend Engineer, Payments', company: 'Monzo', location: 'London', url: 'https://boards.example/jobs/9' },
      jdText: 'Build and run the ledger service that moves money between accounts.',
      company: 'Monzo',
    }, expect.anything()));
    expect(await chip(/^Interviewer\s*Leo Martins\s*Suggested/)).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Focus\s*Ownership stories/ })).toBeTruthy();
    // The posting named its company; it takes part in the plan at once.
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Monzo');
    expect(screen.getByText('Backend Engineer, Payments · Monzo')).toBeTruthy();
  });

  it('says it is searching from the first keystroke, before the typing pause has passed', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Start the interview' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Job title' }), { target: { value: 'backend' } });
    // No blank gap while the search waits for the pause: neither the industries nor nothing.
    expect(screen.getByText('Searching jobs…')).toBeTruthy();
    expect(screen.queryByText('Not sure yet? Browse by industry')).toBeNull();
    expect(prep.search).not.toHaveBeenCalled();
    expect(await screen.findByRole('group', { name: 'Roles that match' }, { timeout: 3000 })).toBeTruthy();
  });

  it('a posting from our own job list is practised as that job: planned and started by its id', async () => {
    const plan = prepPlan({ role: 'Senior Backend Engineer', company: 'Stripe', jobId: 'job_42' });
    prep.plan.mockResolvedValue({ plan });
    renderPage();

    await search('backend');
    fireEvent.click(screen.getByRole('button', { name: 'Practice for Senior Backend Engineer at Stripe' }));
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ jobId: 'job_42', company: 'Stripe' }, expect.anything()));
    expect(screen.getByText("You're practicing for")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View post' })).toHaveAttribute('href', 'https://www.roboapply.io/jobs/job_42');

    fireEvent.click(await startButton());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(createdBody()).toMatchObject({
      role: 'Senior Backend Engineer',
      jobId: 'job_42',
      personaId: DANA.baseId,
      interviewType: SYSTEM_FOCUS.format,
      durationMinutes: 20,
      prep: { interviewerKey: 'i1', focusKey: 'f1' },
    });
    expect(createdBody().prep?.plan).toEqual(plan);
    // The server loads our own job's post; the browser does not send it.
    expect(createdBody().jdText).toBeUndefined();
  });

  it('opens a plan chip into an inline tray and applies the choice on click; Start sends the choices', async () => {
    renderPage();
    await pickRole(/^Backend Engineer/);

    fireEvent.click(await chip(/^Interviewer\s*Dana Okafor/));
    expect(screen.getByRole('heading', { name: 'Pick your interviewer' })).toBeTruthy();
    // The plan's own interviewers, the recommended one badged.
    const tray = screen.getByRole('group', { name: 'Pick your interviewer' });
    expect(within(tray).getByRole('radio', { name: /^Dana Okafor/ })).toHaveTextContent('Suggested');
    fireEvent.click(within(tray).getByRole('radio', { name: /^Leo Martins/ }));

    // The tray closes and the chip reports the new value — no navigation.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pick your interviewer' })).toBeNull());
    expect(screen.getByRole('button', { expanded: false, name: /^Interviewer\s*Leo Martins/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { expanded: false, name: /^Focus/ }));
    const focuses = screen.getByRole('group', { name: 'What should this interview cover?' });
    expect(within(focuses).getAllByRole('radio').map((option) => option.querySelector('strong')?.textContent)).toEqual([
      SYSTEM_FOCUS.label,
      STORIES_FOCUS.label,
      CODING_FOCUS.label,
    ]);
    fireEvent.click(within(focuses).getByRole('radio', { name: /^Ownership stories/ }));
    expect(await chip(/^Focus\s*Ownership stories/)).toBeTruthy();

    // Start sends the plan and the choices: the interviewer's catalog persona and the focus's format.
    fireEvent.click(await startButton());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(createdBody()).toMatchObject({
      role: 'Backend Engineer',
      personaId: LEO.baseId,
      interviewType: STORIES_FOCUS.format,
      mode: 'video',
      language: 'en',
      durationMinutes: 20,
      jobId: null,
      prep: { interviewerKey: LEO.key, focusKey: STORIES_FOCUS.key },
    });
    expect(createdBody().prep?.plan.interviewers.map((item) => item.name)).toEqual([DANA.name, LEO.name]);
  });

  it('uses the server-authored minutes-per-credit rate for preflight and the affordable duration', async () => {
    creditState.data = {
      balance: 1.5,
      periodAllotment: 1.5,
      tier: 'free',
      creditMinutes: 10,
    };

    // The app's English (en.json with the staged strings merged over it).
    renderWithProviders(<PracticePage />, { intlLocale: 'en' });
    await pickRole(/^Backend Engineer/);

    // FIX-6: the plan starts on a length the balance covers. The default 20
    // minutes cost 2 credits at 10 minutes a credit; 1.5 credits cover 15
    // minutes, so that is where the plan starts, and Start is on.
    const startButtonEl = screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement;
    expect(await chip(/^Length\s*15 min/)).toBeTruthy();
    await waitFor(() => expect(startButtonEl.disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Costs 1.5 credits · 1.5 credits left')).toBeTruthy();

    // Picking a longer length by hand says what is missing and offers the repair.
    fireEvent.click(screen.getByRole('button', { expanded: false, name: /^Length\s*15 min/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /^30 min/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This interview needs 3 credits and you have 1.5.');
    expect(startButtonEl.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Use 15 min instead' }));
    await waitFor(() => expect(startButtonEl.disabled).toBe(false));
  });

  it('a target company joins the plan once the candidate pauses typing', async () => {
    renderPage();
    await pickRole(/^Backend Engineer/);
    await chip(/^Interviewer\s*Dana Okafor/);
    expect(prep.plan).toHaveBeenCalledTimes(1);

    prep.plan.mockImplementation(async (body: PrepPlanBody) => ({
      plan: prepPlan({ company: body.company ?? null, companyStyle: body.company ? companyStyle() : null }),
    }));
    fireEvent.change(screen.getByLabelText('Target company (optional)'), { target: { value: 'Acme' } });
    // Not on the keystroke: the plan is written again once typing pauses.
    expect(prep.plan).toHaveBeenCalledTimes(1);
    await waitFor(
      () => expect(prep.plan).toHaveBeenLastCalledWith({ role: 'Backend Engineer', company: 'Acme' }, expect.anything()),
      { timeout: 3000 },
    );
    expect(await screen.findByText('Backend Engineer · Acme')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'How Acme interviews' })).toBeTruthy();
  });

  it('browses an industry’s roles and plans for the one picked, in that industry', async () => {
    renderPage();
    const industries = await screen.findByRole('group', { name: 'Not sure yet? Browse by industry' });
    fireEvent.click(await within(industries).findByRole('button', { name: 'Software and internet' }));
    await waitFor(() => expect(prep.roles).toHaveBeenCalledWith('software'));

    const roles = await screen.findByRole('group', { name: 'Roles in Software and internet' });
    fireEvent.click(within(roles).getByRole('button', { name: /^Site Reliability Engineer/ }));
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith(
      { role: 'Site Reliability Engineer', industry: 'Software and internet' },
      expect.anything(),
    ));
    expect(await chip(/^Interviewer\s*Dana Okafor/)).toBeTruthy();
  });

  it('an industry in the candidate’s own words lists its roles and plans in it', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Other industry…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Type an industry, e.g. space technology' }), {
      target: { value: 'space technology' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show roles' }));
    await waitFor(() => expect(prep.roles).toHaveBeenCalledWith('space technology'));

    const roles = await screen.findByRole('group', { name: 'Roles in space technology' });
    fireEvent.click(within(roles).getByRole('button', { name: /^Data Engineer/ }));
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ role: 'Data Engineer', industry: 'space technology' }, expect.anything()));
  });

  it('a pasted job post is planned from its text once the candidate stops typing, and started with it', async () => {
    prep.plan.mockImplementation(async () => ({ plan: prepPlan({ role: 'Payments Backend Engineer' }) }));
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Paste a job post' }));
    const post = 'Payments Backend Engineer\nBuild and run the ledger service in Go and PostgreSQL.';
    fireEvent.change(screen.getByRole('textbox', { name: /^Paste the full job post/ }), { target: { value: post } });
    expect(prep.plan).not.toHaveBeenCalled();
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ jdText: post }, expect.anything()), { timeout: 3000 });

    fireEvent.click(await startButton());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // The plan names the role the post is for.
    expect(createdBody()).toMatchObject({ role: 'Payments Backend Engineer', jdText: post, jobId: null, personaId: DANA.baseId });
  });

  it('a plan that could not be written says so, keeps Start off, and tries again on request', async () => {
    prep.plan.mockRejectedValueOnce(new Error('prep_unavailable'));
    renderPage();
    await pickRole(/^Backend Engineer/);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't prepare this interview.");
    expect((screen.getByRole('button', { name: 'Start the interview' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await chip(/^Interviewer\s*Dana Okafor/)).toBeTruthy();
    expect(prep.plan).toHaveBeenCalledTimes(2);
    await startButton();
  });

  it('prefills the previous plan when a report asks to run it again', async () => {
    window.history.replaceState(
      {},
      '',
      '/practice?role=Backend+Engineer&company=Acme&interviewer=maya&type=behavioral&mode=voice&language=fr&duration=15',
    );
    renderPage();

    // The role and the company are back, and the plan is written for both at once.
    expect(await screen.findByText("You're practicing for")).toBeTruthy();
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Acme');
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ role: 'Backend Engineer', company: 'Acme' }, expect.anything()));

    // The new plan's interviewer on the same persona and its focus in the same
    // format are preselected over its own recommendation (Dana, system design).
    expect(await chip(/^Interviewer\s*Leo Martins/)).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Focus\s*Ownership stories/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Format\s*Voice/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Language\s*Français/ })).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Length\s*15 min/ })).toBeTruthy();
    expect(prep.plan).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('restores a past session onto the brief when asked to practise it again', async () => {
    renderPage();

    const again = await screen.findAllByRole('button', { name: 'Practice this again' });
    fireEvent.click(again[0]!);

    expect(await screen.findByText("You're practicing for")).toBeTruthy();
    await waitFor(() => expect(prep.plan).toHaveBeenCalledWith({ role: 'Backend Engineer' }, expect.anything()));
    // The past persona (maya) and format (behavioral) pick the new plan's interviewer and focus.
    expect(await chip(/^Interviewer\s*Leo Martins/)).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false, name: /^Focus\s*Ownership stories/ })).toBeTruthy();
    // Restoring a plan must never spend a credit on its own.
    expect(create).not.toHaveBeenCalled();
  });
});
