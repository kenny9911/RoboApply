// INT-08 web: the GoApply half of the onboarding page — the resume gate
// (manual mode without the AI consent), the real count on the confirm screen,
// the first-value screen after confirm, the state re-read after a cn step,
// and the tour fallback in the app shell. Page requests go through the real
// lib/api wrappers against a fetch double; the cn steps' own requests are
// injected (CnOnboardingApiProvider). No network. 375 px. Fictional data only.

import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), pathname: '/onboarding/confirm' }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return {
    ...real,
    usePathname: () => nav.pathname,
    useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock('../../../lib/analytics', async (orig) => ({ ...(await orig<typeof import('../../../lib/analytics')>()), track: vi.fn() }));
const resumes = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: [] } }),
  useUploadResumeMutation: () => ({ isPending: false, mutateAsync: resumes.upload }),
}));
const auth = vi.hoisted(() => ({ value: { status: 'authenticated', refresh: vi.fn(async () => null), me: null as unknown } }));
vi.mock('../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => auth.value,
}));
const gate = vi.hoisted(() => ({ granted: true }));
vi.mock('../../../lib/ui/popupGate', async (orig) => ({
  ...(await orig<typeof import('../../../lib/ui/popupGate')>()),
  usePopupGate: () => ({ granted: gate.granted }),
}));
vi.mock('../growth', () => ({ GettingStartedChecklist: () => <p>Checklist card</p> }));

import { IntlWrapper } from '../../../__tests__/utils/mockTranslations';
import { capsFor } from '../../../__tests__/shell/helpers';
import { BrandProvider, clientBrandFor, type BrandId } from '../../../lib/brand';
import type { ResolvedFlags } from '../../../server/src/platform/flags';
import { fail, installFetch, ok } from '../filters/filters.testkit';
import { CnOnboardingApiProvider, type CnOnboardingApi } from '../onboarding-cn';
import OnboardingIndexPage from '../../../app/(onboarding)/onboarding/page';
import { onboardingIndexTarget } from './flow';
import { OnboardingStepPage, matchSummaryOf } from './OnboardingStepPage';
import { TourOverlay } from './TourOverlay';

const P = '/api/v1/roboapply/onboarding';
const ANSWERS = {
  identity: { cnIdentity: 'yingjie', graduationClass: 2027 },
  intent: { targetRoles: [{ taxonomyId: 'product_manager', label: '产品经理' }], cities: ['上海'], workType: 'full_time' },
};

function state(over: Record<string, unknown> = {}) {
  return {
    brand: 'goapply',
    stage: 'confirm',
    nextRoute: '/onboarding/confirm',
    branch: null,
    answers: ANSWERS,
    entry: null,
    completed: false,
    progress: { total: 8, stepsLeft: 1, leftEarly: null },
    defaults: { country: null },
    firstValueRoute: '/campus',
    ...over,
  };
}

const consent = (type: string, granted: boolean | null) => ({
  type, required: false, stage: 'signup' as const, control: 'toggle' as const, withdrawable: true, onWithdraw: 'none' as const, defaultGranted: false as const,
  prose: `prose:${type}`, proseVersion: 'v1', proseHash: 'h', proseLocale: 'en', granted, answeredAt: null,
});

function cnApi(over: Partial<CnOnboardingApi> = {}): Partial<CnOnboardingApi> {
  return {
    getState: vi.fn(async () => ({ stage: 'confirm' as const, nextRoute: '/onboarding/confirm', branch: null, answers: ANSWERS, entry: null })),
    saveStep: vi.fn(async (step: string) => ({ stage: 'tour' as const, nextStage: 'tour' as const, nextRoute: step === 'confirm' ? '/campus' : '/onboarding/identity' })),
    getConsents: vi.fn(async () => []),
    getMyConsents: vi.fn(async () => [consent('ai_resume_parsing', true), consent('personalized_recommendation', true)]),
    recordConsent: vi.fn(async (i: { type: string; granted: boolean }) => ({ type: i.type, granted: i.granted, proseVersion: 'v1', proseHash: 'h', at: '', accountClosing: false })),
    suggestRoles: vi.fn(async () => []),
    marketSnapshot: vi.fn(async () => ({ jobs: { value: 128, asOf: '2026-10-10T00:00:00Z', scope: { complete: true, role: '产品经理', city: null } }, campusOpen: null, pay: null })),
    campusPrograms: vi.fn(async () => ({ items: [] as never[], more: false, asOf: '2026-10-10T00:00:00Z' })),
    subscribeProgram: vi.fn(async () => undefined),
    ...over,
  } as Partial<CnOnboardingApi>;
}

function renderGo(ui: ReactElement, opts: { brand?: BrandId; flags?: Partial<ResolvedFlags>; api?: Partial<CnOnboardingApi> } = {}) {
  const brand = opts.brand ?? 'goapply';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const api = opts.api ?? cnApi();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, opts.flags ?? {})}>
            <CnOnboardingApiProvider api={api}>{children}</CnOnboardingApiProvider>
          </BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return { api, ...render(ui, { wrapper: Wrapper }) };
}

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.pathname = '/onboarding/confirm';
  resumes.upload.mockReset();
  gate.granted = true;
  auth.value = { status: 'authenticated', refresh: vi.fn(async () => null), me: null };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  window.dispatchEvent(new Event('resize'));
});
afterEach(() => vi.unstubAllGlobals());

describe('G6 resume on GoApply', () => {
  // FIX-8: "Fill in my profile by hand" opens the manual form (onboarding-cn `ManualProfileForm`);
  // the resume step is saved as skipped when that form is saved or left for later ("Fill in later").
  it('with AI consent off the step is manual: no upload, no parse or AI call; "fill in by hand" opens the manual form, and leaving it for later skips the step', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'resume', nextRoute: '/onboarding/resume' })),
      [`PUT ${P}/steps/resume`]: () => ok({ stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' }),
    });
    const api = cnApi({ getMyConsents: vi.fn(async () => [consent('ai_resume_parsing', false)]) });
    renderGo(<OnboardingStepPage step="resume" />, { api, flags: { 'ai.text': true } });
    expect(await screen.findByRole('heading', { name: 'Resume reading is off' })).toBeInTheDocument();
    // None of the upload doors exists.
    expect(screen.queryByTestId('resume-file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Find my jobs' })).toBeNull();
    // The optional-field reminder is always shown.
    expect(screen.getByText(/Photo, native place and political status are optional/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fill in my profile by hand' }));
    // The form opens; nothing is saved and nobody is sent on yet.
    expect(await screen.findByRole('heading', { name: 'Fill in your profile by hand' })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    expect(net.to('PUT', `${P}/steps/resume`)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Fill in later' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/matching'));
    expect(net.to('PUT', `${P}/steps/resume`)[0]!.body).toEqual({ skip: true });
    // Nothing was uploaded, seeded or recorded.
    expect(resumes.upload).not.toHaveBeenCalled();
    expect(net.to('POST', `${P}/resume`)).toEqual([]);
    expect(api.recordConsent).not.toHaveBeenCalled();
    expect(net.writes().map((c) => `${c.method} ${c.path}`)).toEqual([`PUT ${P}/steps/resume`]);
  });

  it('a failed "fill in by hand" shows the plain error inside the gate, and the user can try again', async () => {
    let failing = true;
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'resume', nextRoute: '/onboarding/resume' })),
      [`PUT ${P}/steps/resume`]: () => (failing ? fail(500, 'internal_error') : ok({ stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' })),
    });
    renderGo(<OnboardingStepPage step="resume" />, { api: cnApi({ getMyConsents: vi.fn(async () => [consent('ai_resume_parsing', false)]) }) });
    const gateBox = (await screen.findByRole('heading', { name: 'Resume reading is off' })).closest('section')!;
    expect(within(gateBox).queryByRole('alert')).toBeNull();
    fireEvent.click(within(gateBox).getByRole('button', { name: 'Fill in my profile by hand' }));
    const manualForm = await screen.findByTestId('cn-manual-profile');
    expect(within(manualForm).queryByRole('alert')).toBeNull();
    fireEvent.click(within(manualForm).getByRole('button', { name: 'Fill in later' }));
    // The message is in the manual form (the upload screen that normally shows it is not on the page).
    expect(await within(manualForm).findByRole('alert')).toHaveTextContent('Something went wrong. Your answers are still here; try again.');
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('resume-file')).toBeNull();
    // The buttons work again; a second try goes through.
    await waitFor(() => expect(within(manualForm).getByRole('button', { name: 'Fill in later' })).toBeEnabled());
    failing = false;
    fireEvent.click(within(manualForm).getByRole('button', { name: 'Fill in later' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/matching'));
    expect(net.to('PUT', `${P}/steps/resume`)).toHaveLength(2);
  });

  it('while "fill in by hand" is saving, neither button can be pressed again', async () => {
    let release: (r: Response) => void = () => undefined;
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'resume', nextRoute: '/onboarding/resume' })),
      [`PUT ${P}/steps/resume`]: () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    renderGo(<OnboardingStepPage step="resume" />, { api: cnApi({ getMyConsents: vi.fn(async () => [consent('ai_resume_parsing', false)]) }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in my profile by hand' }));
    const manual = await screen.findByRole('button', { name: 'Fill in later' });
    fireEvent.click(manual);
    await waitFor(() => expect(manual).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.click(manual);
    expect(net.to('PUT', `${P}/steps/resume`)).toHaveLength(1);
    release(ok({ stage: 'matching', nextStage: 'matching', nextRoute: '/onboarding/matching' }) as Response);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/matching'));
  });

  it('a consent that was never answered is also "off" (nothing starts granted)', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ stage: 'resume', nextRoute: '/onboarding/resume' })) });
    renderGo(<OnboardingStepPage step="resume" />, { api: cnApi({ getMyConsents: vi.fn(async () => [consent('ai_resume_parsing', null)]) }) });
    expect(await screen.findByRole('heading', { name: 'Resume reading is off' })).toBeInTheDocument();
    expect(screen.queryByTestId('resume-file')).toBeNull();
  });

  it('with AI consent on, the shared upload screen shows inside the gate', async () => {
    installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'resume', nextRoute: '/onboarding/resume' })),
      'GET /api/v1/roboapply/compliance/consents': () => ok({ items: [] }),
    });
    renderGo(<OnboardingStepPage step="resume" />);
    expect(await screen.findByTestId('resume-file')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Resume reading is off' })).toBeNull();
    expect(screen.getByText(/Photo, native place and political status are optional/)).toBeInTheDocument();
  });
});

describe('G7 confirm on GoApply', () => {
  it('shows the real count from "Finding jobs" when the jobs were compared with the profile', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ answers: { ...ANSWERS, matching: { jobCount: 9, compared: 40, topJobIds: ['j1'], continuedInBackground: false, ranked: true } } })) });
    const { api } = renderGo(<OnboardingStepPage step="confirm" />, { flags: { 'jobs.feed': true } });
    expect(await screen.findByText('9 jobs at Good fit or better for your search')).toBeInTheDocument();
    // The index count is not asked for when the real one is there.
    expect(api.marketSnapshot).not.toHaveBeenCalled();
  });

  it('falls back to the index count when the run did not use the profile, or is still going', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ answers: { ...ANSWERS, matching: { jobCount: 40, compared: 40, topJobIds: [], continuedInBackground: false, ranked: false } } })) });
    const { api } = renderGo(<OnboardingStepPage step="confirm" />, { flags: { 'jobs.feed': true } });
    expect(await screen.findByText('128 open jobs in our index for your search')).toBeInTheDocument();
    expect(api.marketSnapshot).toHaveBeenCalled();
    expect(screen.queryByText(/Good fit or better/)).toBeNull();
  });

  it('matchSummaryOf: a number only for a finished, profile-based run', () => {
    expect(matchSummaryOf({ answers: {} })).toBeNull();
    expect(matchSummaryOf({ answers: { matching: { jobCount: 3, topJobIds: ['a', 7], continuedInBackground: false } } })).toEqual({ jobCount: 3, topJobIds: ['a'] });
    expect(matchSummaryOf({ answers: { matching: { jobCount: 0, continuedInBackground: false, ranked: true } } })).toEqual({ jobCount: 0 });
    expect(matchSummaryOf({ answers: { matching: { jobCount: 0, continuedInBackground: true } } })).toBeNull();
    expect(matchSummaryOf({ answers: { matching: { jobCount: 12, continuedInBackground: false, ranked: false } } })).toBeNull();
    expect(matchSummaryOf({ answers: { matching: { jobCount: '12' } } })).toBeNull();
    // No resume was compared: the screen's "Good fit or better" line would be untrue (D3).
    expect(matchSummaryOf({ answers: { matching: { jobCount: 12, continuedInBackground: false, ranked: true, resumeCompared: false } } })).toBeNull();
    expect(matchSummaryOf({ answers: { matching: { jobCount: 12, continuedInBackground: false, ranked: true, resumeCompared: true } } })).toEqual({ jobCount: 12 });
  });

  it('saving confirm opens the first-value screen in place; Start completes onboarding and goes to the first-value route', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state()),
      [`POST ${P}/complete`]: () => ok({ stage: 'done', nextRoute: '/campus' }),
    });
    const programs = [{ id: 'ev1', companyName: '示例科技', title: '2027届校园招聘', graduationClass: '2027届', applyClosesAt: '2026-11-01T00:00:00Z', verifiedAt: '2026-10-01T00:00:00Z', sourceName: null, officialUrl: 'https://example.com', subscribed: false }];
    const api = cnApi({ campusPrograms: vi.fn(async () => ({ items: programs as never[], more: false, asOf: '2026-10-10T00:00:00Z' })) });
    renderGo(<OnboardingStepPage step="confirm" />, { api, flags: { 'jobs.campusCalendar': true, 'ai.text': true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.saveStep).toHaveBeenCalledWith('confirm', {}));
    // The reminder prompt for the user's 届别 and cities, nothing pre-ticked.
    expect(await screen.findByRole('heading', { name: 'Get application deadline reminders' })).toBeInTheDocument();
    expect(api.campusPrograms).toHaveBeenLastCalledWith({ classYear: 2027, cities: ['上海'] });
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    // The tour lists what is on for this user: calendar + the two AI features.
    expect(await screen.findByRole('heading', { name: "Here's what you can do" })).toBeInTheDocument();
    for (const card of ['Campus calendar', 'Tailored resume', 'Interview practice']) expect(screen.getByRole('heading', { name: card })).toBeInTheDocument();
    expect(api.subscribeProgram).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/campus'));
    expect(net.to('POST', `${P}/complete`)).toHaveLength(1);
    expect(auth.value.refresh).toHaveBeenCalled();
  });

  it('the tour advertises nothing that is off: no calendar without the capability, no AI features without the consent', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ stage: 'tour', nextRoute: '/resume', firstValueRoute: '/resume' })) });
    const api = cnApi({ getMyConsents: vi.fn(async () => [consent('ai_resume_parsing', false)]) });
    renderGo(<OnboardingStepPage step="confirm" />, { api, flags: { 'ai.text': true } });
    // A user who comes back at stage `tour` gets the first-value screen, not the confirm form again.
    expect(await screen.findByRole('heading', { name: "Here's what you can do" })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fill in your profile' })).toBeInTheDocument();
    for (const card of ['Campus calendar', 'Tailored resume', 'Interview practice']) expect(screen.queryByRole('heading', { name: card })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Get application deadline reminders' })).toBeNull();
    expect(api.campusPrograms).not.toHaveBeenCalled();
  });

  it('AI features need the brand capability too: consent on but no model configured shows the manual card', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ stage: 'tour', nextRoute: '/resume' })) });
    renderGo(<OnboardingStepPage step="confirm" />, { flags: { 'ai.text': false } });
    expect(await screen.findByRole('heading', { name: 'Fill in your profile' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tailored resume' })).toBeNull();
  });

  it('a failed finish keeps the user on the tour with a plain message', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ stage: 'tour', nextRoute: '/resume' })), [`POST ${P}/complete`]: () => fail(500, 'internal_error') });
    renderGo(<OnboardingStepPage step="confirm" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Your answers are still here; try again.');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});

describe('moving between GoApply screens', () => {
  it('a cn step re-reads the state before it moves on (the next screen never starts from the old stage)', async () => {
    let stage = 'consent';
    const order: string[] = [];
    installFetch({
      [`GET ${P}/state`]: () => {
        order.push(`state:${stage}`);
        return ok(state({ stage, nextRoute: `/onboarding/${stage}`, answers: {} }));
      },
    });
    nav.push.mockImplementation((route: string) => order.push(`push:${route}`));
    const consents = ['pipl_basic_processing', 'age_16_plus'].map((t) => ({ ...consent(t, null), required: true, control: 'checkbox' as const }));
    const api = cnApi({
      getState: vi.fn(async () => ({ stage: 'consent' as const, nextRoute: '/onboarding/consent', branch: null, answers: {}, entry: null })),
      getConsents: vi.fn(async () => [...consents, { ...consent('personalized_recommendation', null), control: 'two_option' as const }]),
      getMyConsents: vi.fn(async () => []),
      saveStep: vi.fn(async () => {
        stage = 'identity';
        return { stage: 'identity' as const, nextStage: 'identity' as const, nextRoute: '/onboarding/identity' };
      }),
    });
    nav.pathname = '/onboarding/consent';
    renderGo(<OnboardingStepPage step="consent" />, { api });
    const boxes = await screen.findAllByRole('checkbox');
    // No consent box starts ticked.
    for (const box of boxes) expect(box).not.toBeChecked();
    for (const box of boxes) fireEvent.click(box);
    fireEvent.click(screen.getByRole('radio', { name: /Turn on|On/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/identity'));
    expect(order).toEqual(['state:consent', 'state:identity', 'push:/onboarding/identity']);
  });

  it('a finished user is sent to the first-value route the server names, not always /jobs', async () => {
    installFetch({ [`GET ${P}/state`]: () => ok(state({ stage: 'done', completed: true, nextRoute: null, firstValueRoute: '/resume' })) });
    renderGo(<OnboardingStepPage step="intent" />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/resume'));
  });

  it('"Finding jobs" names the G4 roles and cities, and reads the new stage before going to confirm', async () => {
    const order: string[] = [];
    let stage = 'matching';
    installFetch({
      [`GET ${P}/state`]: () => {
        order.push(`state:${stage}`);
        return ok(state({ stage, nextRoute: `/onboarding/${stage}` }));
      },
      [`POST ${P}/match`]: () => {
        stage = 'confirm';
        const events: Array<[string, unknown]> = [
          ['phase', { phase: 'reading', skipped: true }],
          ['phase', { phase: 'saving' }],
          ['phase', { phase: 'searching' }],
          ['phase', { phase: 'comparing', skipped: true }],
          ['phase', { phase: 'ranking', skipped: true }],
          ['done', { jobCount: 4, topJobIds: [], continuedInBackground: false }],
        ];
        return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    nav.push.mockImplementation((route: string) => order.push(`push:${route}`));
    nav.pathname = '/onboarding/matching';
    renderGo(<OnboardingStepPage step="matching" />);
    expect(await screen.findByText('Searching job sources for 产品经理 in 上海')).toBeInTheDocument();
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding/confirm'));
    // The last state read before the move already says `confirm`.
    expect(order.at(-1)).toBe('push:/onboarding/confirm');
    expect(order.at(-2)).toBe('state:confirm');
    // The lines that did not happen (no profile comparison) are not shown as done.
    expect(document.querySelector('[data-phase="comparing"]')).toHaveAttribute('data-state', 'skipped');
    expect(document.querySelector('[data-phase="searching"]')).toHaveAttribute('data-state', 'done');
  });
});

describe('/onboarding at stage tour (GoApply)', () => {
  it('a user who left during the first-value screen comes back to it, not to /campus where nothing finishes setup', async () => {
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(state({ stage: 'tour', nextRoute: '/campus', firstValueRoute: '/campus' })),
      [`POST ${P}/complete`]: () => ok({ stage: 'done', nextRoute: '/campus' }),
    });
    nav.pathname = '/onboarding';
    const first = renderGo(<OnboardingIndexPage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/onboarding/confirm'));
    expect(nav.replace).not.toHaveBeenCalledWith('/campus');
    first.unmount();

    // /onboarding/confirm at stage tour is the first-value screen; closing it completes onboarding.
    nav.replace.mockReset();
    nav.pathname = '/onboarding/confirm';
    renderGo(<OnboardingStepPage step="confirm" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/campus'));
    expect(net.to('POST', `${P}/complete`)).toHaveLength(1);
  });

  it('onboardingIndexTarget: finished → first-value page; GoApply tour → confirm; everything else → the server route', () => {
    const base = { brand: 'goapply' as const, stage: 'intent', completed: false, nextRoute: '/onboarding/intent', firstValueRoute: '/campus' };
    expect(onboardingIndexTarget(base)).toBe('/onboarding/intent');
    expect(onboardingIndexTarget({ ...base, stage: 'tour', nextRoute: '/campus' })).toBe('/onboarding/confirm');
    expect(onboardingIndexTarget({ ...base, stage: 'tour', nextRoute: '/jobs', firstValueRoute: '/jobs' })).toBe('/onboarding/confirm');
    expect(onboardingIndexTarget({ ...base, stage: 'done', completed: true, nextRoute: null })).toBe('/campus');
    expect(onboardingIndexTarget({ ...base, stage: 'done', completed: true, nextRoute: null, firstValueRoute: undefined })).toBe('/jobs');
    // No route from the server → the first-value page.
    expect(onboardingIndexTarget({ ...base, nextRoute: null })).toBe('/campus');
    // RoboApply at tour keeps the server route: its tour cards show on /jobs inside the app shell.
    expect(onboardingIndexTarget({ brand: 'roboapply', stage: 'tour', completed: false, nextRoute: '/jobs' })).toBe('/jobs');
  });
});

describe('tour fallback in the app shell (GoApply)', () => {
  const me = (step: string, completed = false) => ({ onboarding: { step, path: null, completed, nextRoute: completed ? null : '/resume' } });

  it('a user still at stage tour gets the GoApply first-value screen on /resume, never the RoboApply cards', async () => {
    auth.value.me = me('tour');
    nav.pathname = '/resume';
    const net = installFetch({
      [`POST ${P}/complete`]: () => ok({ stage: 'done', nextRoute: '/resume' }),
      'PATCH /api/v1/roboapply/ui-state': () => ok({ state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null }),
    });
    renderGo(<TourOverlay />, { flags: { 'ai.text': true } });
    expect(await screen.findByRole('heading', { name: "Here's what you can do" })).toBeInTheDocument();
    expect(screen.queryByText("Why you fit and what's missing")).toBeNull();
    expect(screen.queryByText('Ready-to-apply kits — you submit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(net.to('POST', `${P}/complete`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('heading', { name: "Here's what you can do" })).toBeNull());
  });

  it('shows nothing on other pages, before the tour, or while another prompt holds the page view', () => {
    auth.value.me = me('tour');
    nav.pathname = '/applications';
    const { unmount } = renderGo(<TourOverlay />);
    expect(document.body.textContent).toBe('');
    unmount();
    nav.pathname = '/jobs';
    auth.value.me = me('intent');
    const second = renderGo(<TourOverlay />);
    expect(document.body.textContent).toBe('');
    second.unmount();
    auth.value.me = me('tour');
    gate.granted = false;
    renderGo(<TourOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('RoboApply keeps its own tour on /jobs', async () => {
    auth.value.me = me('tour');
    nav.pathname = '/jobs';
    installFetch({});
    renderGo(<TourOverlay />, { brand: 'roboapply' });
    expect(await screen.findByText("Why you fit and what's missing")).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Here's what you can do" })).toBeNull();
  });
});
