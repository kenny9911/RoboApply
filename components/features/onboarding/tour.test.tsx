// WP-30 web: the O8 first visit on /jobs — the 4-card tour, the finish
// banner (demoted after two dismissals), and one tip at a time through the
// popup gate. 375 px. Fetch double only (no network).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const page = vi.hoisted(() => ({ pathname: '/jobs' }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, usePathname: () => page.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) };
});
const auth = vi.hoisted(() => ({ value: { status: 'authenticated', refresh: vi.fn(async () => null), me: null as unknown } }));
vi.mock('../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => auth.value,
}));
const gate = vi.hoisted(() => ({ granted: true, keys: [] as string[] }));
vi.mock('../../../lib/ui/popupGate', async (orig) => {
  const real = await orig<typeof import('../../../lib/ui/popupGate')>();
  return {
    ...real,
    usePopupGate: (key: string, _p: string, o: { enabled?: boolean } = {}) => {
      if (o.enabled !== false) gate.keys.push(key);
      return { granted: gate.granted && o.enabled !== false };
    },
  };
});
vi.mock('../growth', () => ({ GettingStartedChecklist: () => <p>Checklist card</p> }));

import { installFetch, ok, renderWith } from '../filters/filters.testkit';
import { TourOverlay } from './TourOverlay';
import { FinishSetupSettingsLine } from './FirstVisitPrompts';

const P = '/api/v1/roboapply/onboarding';
const me = (step: string, completed = false) => ({ onboarding: { step, path: null, completed, nextRoute: completed ? null : '/jobs' } });
const ui = (over: Record<string, unknown> = {}) => ({ state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {}, ...over }, lastFeedVisitAt: null, updatedAt: null });
const obState = (over: Record<string, unknown> = {}) => ({
  brand: 'roboapply',
  stage: 'done',
  nextRoute: null,
  branch: 'urgent',
  answers: {},
  entry: null,
  completed: true,
  progress: { total: 5, stepsLeft: 0, leftEarly: null },
  defaults: { country: null },
  ...over,
});

beforeEach(() => {
  page.pathname = '/jobs';
  gate.granted = true;
  gate.keys = [];
  auth.value = { status: 'authenticated', refresh: vi.fn(async () => null), me: null };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});
afterEach(() => vi.unstubAllGlobals());

describe('the 4-card tour', () => {
  it('shows once on /jobs at stage tour; Start completes onboarding and marks the tour seen', async () => {
    auth.value.me = me('tour');
    const net = installFetch({
      [`POST ${P}/complete`]: () => ok({ stage: 'done', nextRoute: '/jobs' }),
      'PATCH /api/v1/roboapply/ui-state': () => ok(ui({ tours: { 'jobs.firstVisit': 'now' } })),
    });
    renderWith(<TourOverlay />);
    expect(await screen.findByText("Why you fit and what's missing")).toBeInTheDocument();
    for (const card of ['A tailored resume for each job', 'Ready-to-apply kits — you submit', 'Practice the interview']) {
      expect(screen.getByText(card)).toBeInTheDocument();
    }
    expect(gate.keys).toContain('onboarding:tour');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(net.to('POST', `${P}/complete`)).toHaveLength(1));
    expect(net.to('PATCH', '/api/v1/roboapply/ui-state')[0].body).toEqual({ toursSeen: ['jobs.firstVisit'] });
    await waitFor(() => expect(screen.queryByText("Why you fit and what's missing")).toBeNull());
    expect(auth.value.refresh).toHaveBeenCalled();
    // No countdown, no offer.
    expect(document.body.textContent).not.toMatch(/offer|left today|hours left/i);
  });

  it('renders nothing on other pages, while signed out, or before the tour', () => {
    auth.value.me = me('tour');
    page.pathname = '/resume';
    const a = renderWith(<TourOverlay />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    page.pathname = '/jobs';
    auth.value.me = me('confirm');
    const b = renderWith(<TourOverlay />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it('waits for the popup gate (never two prompts at once)', () => {
    auth.value.me = me('tour');
    gate.granted = false;
    installFetch({});
    renderWith(<TourOverlay />);
    expect(screen.queryByText("Why you fit and what's missing")).toBeNull();
  });
});

describe('leaving early: the finish banner', () => {
  const left = obState({ completed: false, stage: 'basics', nextRoute: '/onboarding/basics', progress: { total: 5, stepsLeft: 4, leftEarly: { at: 'x', stage: 'basics' } } });

  it('shows "Finish setting up — 4 steps left" with a resume link; Hide records a dismissal', async () => {
    auth.value.me = me('done', true);
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(left),
      'GET /api/v1/roboapply/ui-state': () => ok(ui()),
      'PATCH /api/v1/roboapply/ui-state': () => ok(ui({ dismissals: { 'onboarding.finishBanner': { count: 1, at: 'x' } } })),
    });
    renderWith(<TourOverlay />);
    expect(await screen.findByText('Finish setting up — 4 steps left')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/onboarding');
    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    await waitFor(() => expect(net.to('PATCH', '/api/v1/roboapply/ui-state')[0].body).toEqual({ dismiss: ['onboarding.finishBanner'] }));
    expect(screen.queryByTestId('finish-banner')).toBeNull();
  });

  it('after two dismissals the banner moves to Settings', async () => {
    auth.value.me = me('done', true);
    installFetch({
      [`GET ${P}/state`]: () => ok(left),
      'GET /api/v1/roboapply/ui-state': () => ok(ui({ dismissals: { 'onboarding.finishBanner': { count: 2, at: 'x' } } })),
    });
    renderWith(
      <>
        <TourOverlay />
        <FinishSetupSettingsLine />
      </>,
    );
    expect(await screen.findByText('You have 4 setup steps left.')).toBeInTheDocument();
    expect(screen.queryByTestId('finish-banner')).toBeNull();
  });
});

describe('tips after the tour, one at a time', () => {
  it('score tip first, with the honesty line; closing marks it seen', async () => {
    auth.value.me = me('done', true);
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(obState()),
      'GET /api/v1/roboapply/ui-state': () => ok(ui()),
      'PATCH /api/v1/roboapply/ui-state': () => ok(ui({ tours: { 'onboarding.scoreTip': 'x' } })),
      'GET /api/v1/roboapply/feed/skills-check': () => ok({ skills: [] }),
    });
    renderWith(<TourOverlay />);
    expect(await screen.findByText('This is not your chance of getting hired.')).toBeInTheDocument();
    expect(screen.queryByTestId('tip-resume')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(net.to('PATCH', '/api/v1/roboapply/ui-state')[0].body).toEqual({ toursSeen: ['onboarding.scoreTip'] }));
  });

  it('resume-check banner shows the finished check\'s real issue count and links to it', async () => {
    auth.value.me = me('done', true);
    installFetch({
      [`GET ${P}/state`]: () => ok(obState({ answers: { resume: { resumeVariantId: 'rv1' } } })),
      'GET /api/v1/roboapply/ui-state': () => ok(ui({ tours: { 'onboarding.scoreTip': 'x' } })),
      'GET /api/v1/roboapply/v2/resumes/rv1/grade/latest': () =>
        ok({ grade: { id: 'g1', resumeVariantId: 'rv1', status: 'done', issues: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, previous: null, stale: false, aiAvailable: true }),
      'GET /api/v1/roboapply/feed/skills-check': () => ok({ skills: [] }),
    });
    renderWith(<TourOverlay />);
    expect(await screen.findByText('Your resume check is ready: 3 things to fix.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the check' })).toHaveAttribute('href', '/resume/rv1/check');
  });

  it('skills check: "no" shows the filter change first; the checklist comes last', async () => {
    auth.value.me = me('done', true);
    const net = installFetch({
      [`GET ${P}/state`]: () => ok(obState()),
      'GET /api/v1/roboapply/ui-state': () => ok(ui({ tours: { 'onboarding.scoreTip': 'x' } })),
      'GET /api/v1/roboapply/feed/skills-check': () => ok({ skills: [{ skill: 'Terraform', askedIn: 7, outOf: 20 }] }),
      'GET /api/v1/roboapply/search-profiles': () =>
        ok({ profiles: [{ id: 'sp1', name: '', isDefault: true, isActive: true, version: 3, schemaVersion: 1, filters: {}, alertInstantMax: 0, alertDigest: null, createdAt: 'x', updatedAt: 'x' }], maxProfiles: 1, maxInstantAlerts: 1, proMaxProfiles: null, upgradable: false }),
      'PATCH /api/v1/roboapply/search-profiles/sp1': () => ok({}),
      'PATCH /api/v1/roboapply/ui-state': () => ok(ui({ tours: { 'onboarding.scoreTip': 'x', 'onboarding.skillsCheck': 'x' } })),
    });
    renderWith(<TourOverlay />);
    expect(await screen.findByText('Asked in 7 of 20 jobs in your list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByText('This adds a filter: hide jobs that require Terraform.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add the filter' }));
    await waitFor(() => expect(net.to('PATCH', '/api/v1/roboapply/search-profiles/sp1')[0].body).toEqual({ baseVersion: 3, filtersPatch: { excludedSkills: ['Terraform'] } }));
    expect(await screen.findByText('Checklist card')).toBeInTheDocument();
  });

  it('the checklist waits for the shared popup budget like every other prompt', async () => {
    auth.value.me = me('done', true);
    gate.granted = false;
    gate.keys.length = 0;
    try {
      installFetch({
        [`GET ${P}/state`]: () => ok(obState()),
        'GET /api/v1/roboapply/ui-state': () => ok(ui({ tours: { 'onboarding.scoreTip': 'x', 'onboarding.skillsCheck': 'x' } })),
        'GET /api/v1/roboapply/feed/skills-check': () => ok({ skills: [] }),
      });
      renderWith(<TourOverlay />);
      await waitFor(() => expect(gate.keys).toContain('onboarding:checklist'));
      expect(screen.queryByText('Checklist card')).toBeNull();
    } finally {
      gate.granted = true;
    }
  });
});
