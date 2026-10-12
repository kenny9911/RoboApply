// WP-53 acceptance (Ready to apply UI): every kit state, the intro, the
// setup wizard's five steps, the cost shown before "Prepare kits", the
// out-of-credits sheet, the mandatory Verify details block, "Open application"
// → Applied at once with "Undo · I didn't apply", the F-FILT-07 question and
// the mobile layout. Agent calls are mocked at lib/api/agent; every other
// read answers from a fetch double (no network, no database).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/ready',
}));

const api = vi.hoisted(() => ({
  getAgentSettings: vi.fn(),
  putAgentSettings: vi.fn(),
  getAgentSetup: vi.fn(),
  submitCalibration: vi.fn(),
  getSuggestions: vi.fn(),
  listQueue: vi.fn(),
  addToQueue: vi.fn(),
  prepareKit: vi.fn(),
  confirmKitPart: vi.fn(),
  openApplication: vi.fn(),
  undoQueueApplied: vi.fn(),
  markQueueApplied: vi.fn(),
  skipQueueItem: vi.fn(),
  removeQueueItem: vi.fn(),
  restoreQueueItem: vi.fn(),
  getReadyBadge: vi.fn(),
  getAnswerBank: vi.fn(),
  putAnswerBank: vi.fn(),
  completeSetupStep: vi.fn(),
  generateList: vi.fn(),
  getKitDetail: vi.fn(),
  getKitHistory: vi.fn(),
  getQuestionKeys: vi.fn(),
}));
vi.mock('../../../lib/api/agent', () => ({ ...api, agentApi: api }));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { installFetch, list as profileList, ok, profile as searchProfile } from '../filters/filters.testkit';
import { RoboApiError } from '../../../lib/api/client';
import { __outOfCreditsStore } from '../../../hooks/shared/useCreditGate';
import { __toastStore } from '../../v3/primitives/Toast';
import type { AgentSettings, AgentSetupResponse, AnswerBankItemView } from '../../../lib/api/contracts/agent';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import type { ReadyQueueItem } from '../../../hooks/agent';
import ReadyRoute from '../../../app/(auth)/ready/page';
import { KitReview } from './KitReview';
import { KitRow } from './KitRow';
import { ReadySearchCard } from './ReadySearchCard';
import { SetupWizard, initialStep, wizardSteps } from './SetupWizard';
import { ReadyIntro } from './ReadyIntro';
import { PageHeader, isPlainText } from '../../v3/primitives/PageHeader';
import { flagsWith } from '../../../__tests__/shell/helpers';
import { KitAllowance } from './KitAllowance';
import { eventLine, isEmployerApplyPage, safeHttpUrl } from './KitParts';
import { noTailorKey } from './PrepareSheet';
import { customQuestionKey, questionsFor, sha256Hex } from './questions';
import { previewFileName } from './fileName';
import type { QueueItemDetail } from '../../../lib/api/agent';
import { useReadyBadge } from '../../../hooks/agent/useReadyBadge';

// ── Fixtures (fictional) ────────────────────────────────────────────────────

const RESETS = '2026-10-12T00:00:00.000Z';
const bucket = (cap: number, remaining: number, window: 'day' | 'week') => ({ cap, window, used: cap - remaining, remaining, grantRemaining: 0, resetsAt: RESETS });
const CREDITS = {
  summary: {
    planKey: 'free',
    planProfile: 'free',
    legacyPlan: false,
    interval: null,
    periodEnd: null,
    timezone: 'UTC',
    upgradable: true,
    buckets: { ready_kits: bucket(3, 2, 'week'), tailor: bucket(2, 2, 'day'), cover_letter: bucket(2, 1, 'day') },
    entitlements: {},
  },
  practice: null,
};

function item(over: Partial<ReadyQueueItem> = {}): ReadyQueueItem {
  return {
    id: 'q1',
    jobId: 'job1',
    state: 'picked',
    weekKey: '2026-W41',
    trackerEntryId: null,
    resumeVariantId: null,
    coverLetterId: null,
    missingFields: [],
    addedVia: 'weekly',
    openedAt: null,
    userMarkedSubmitted: false,
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...over,
  };
}

function jobDetail(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    job: { id, title, companyName: 'Acme', applyUrl: `https://acme.example/apply/${id}`, status: 'open', ...over },
    company: {},
    fit: { jobId: id, score: 82, tier: 'great', kind: 'ai' },
    explanation: null,
    tracker: null,
  };
}

const SETTINGS: AgentSettings = { weeklyTarget: 10, minTier: 'good', tailorEach: true, coverLetterMode: 'when_required', baseVariantId: null, fileNameStyle: 'name_company_role' };
const setupAt = (step: AgentSetupResponse['step'], checks: Partial<AgentSetupResponse['checks']> = {}): AgentSetupResponse => ({
  step,
  checks: { profileMissing: [], calibrationDone: false, reportReady: false, extensionConnected: false, ...checks },
});

function feedItem(jobId: string, title: string): FeedItem {
  return {
    jobId,
    title,
    company: { id: null, name: 'Globex', logoUrl: null },
    location: 'Austin, TX',
    workModel: 'hybrid',
    employmentType: null,
    seniority: null,
    pay: null,
    postedAt: null,
    lastSeenAt: null,
    source: { name: 'Example Board', kind: 'provider' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: { tier: 'good', score: 70, kind: 'pre', topGap: null, topOverlap: null },
    tracker: null,
  };
}

function answer(over: Partial<AnswerBankItemView> = {}): AnswerBankItemView {
  return { id: 'a1', questionKey: 'notice_period', questionText: 'What is your notice period?', answer: 'Two weeks', locale: 'en', source: 'user', lastUsedAt: null, updatedAt: '2026-10-01T00:00:00.000Z', ...over };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'ts1',
    status: 'review',
    baseVariantId: 'v0',
    jobId: 'job1',
    scoreBefore: null,
    scoreAfter: null,
    changes: [],
    claims: [],
    resultVariantId: 'v1',
    mode: 'fast',
    sections: ['summary'],
    experienceDepth: null,
    target: { title: 'Data Analyst', company: 'Acme' },
    pendingClaims: 0,
    fit: { before: null, after: null },
    aiWritten: true,
    failure: null,
    createdAt: '2026-10-09T00:00:00.000Z',
    ...over,
  };
}

const apiError = (status: number, code: string, details?: unknown) => new RoboApiError(code, { code, status, payload: { code, details } });

/** GET /agent/queue/:id as WP-52 sends it. */
function detailOf(it: ReadyQueueItem, over: { resume?: Partial<QueueItemDetail['kit']['resume']>; aiAvailable?: boolean; history?: QueueItemDetail['history'] } = {}): QueueItemDetail {
  return {
    item: it,
    kit: {
      resume: { variantId: it.resumeVariantId, tailorSessionId: it.tailorSessionId ?? null, pendingClaims: 0, tailored: Boolean(it.tailorSessionId), used: false, ...over.resume },
      letter: { coverLetterId: it.coverLetterId, needed: false, used: false },
      answers: [],
      fileName: null,
      aiAvailable: over.aiAvailable ?? true,
    },
    history: over.history ?? [],
  };
}

/** A tab double for "Open application" (opened blank inside the click, pointed after the server answers). */
function fakeTab() {
  return { location: { href: '' }, close: vi.fn(), opener: {} as unknown };
}

let net: ReturnType<typeof installFetch>;
let extraRoutes: Record<string, () => Response> = {};

function installNet() {
  net = installFetch({
    'GET /api/v1/roboapply/credits': () => ok(CREDITS),
    'GET /api/v1/roboapply/jobs/job1': () => ok(jobDetail('job1', 'Data Analyst')),
    'GET /api/v1/roboapply/jobs/job2': () => ok(jobDetail('job2', 'BI Developer')),
    'GET /api/v1/roboapply/jobs/job3': () => ok(jobDetail('job3', 'Analytics Engineer')),
    'GET /api/v1/roboapply/profile': () => ok({ firstName: 'Jane', lastName: 'Doe', missing: [], completeness: 100, availability: { market: 'intl' } }),
    'GET /api/v1/roboapply/search-profiles': () => ok(profileList([searchProfile()])),
    'GET /api/v1/roboapply/taxonomy': () => ok({ version: 1, asOf: '2026-10-01', locale: 'en', nodes: [], suggestions: [], sources: [] }),
    ...Object.fromEntries(Object.entries(extraRoutes).map(([k, f]) => [k, () => f()])),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = new URLSearchParams();
  extraRoutes = {};
  __outOfCreditsStore.set(null);
  api.getAgentSettings.mockResolvedValue(SETTINGS);
  api.getAgentSetup.mockResolvedValue(setupAt('done', { calibrationDone: true }));
  api.listQueue.mockResolvedValue({ items: [] });
  api.getSuggestions.mockResolvedValue({ items: [] });
  api.getAnswerBank.mockResolvedValue({ items: [] });
  // WP-52 reads not served yet unless a test says so: the UI falls back.
  api.getKitDetail.mockRejectedValue(apiError(501, 'not_implemented'));
  api.getKitHistory.mockRejectedValue(apiError(501, 'not_implemented'));
  api.getQuestionKeys.mockRejectedValue(apiError(501, 'not_implemented'));
  api.completeSetupStep.mockImplementation(async (b: { step: string }) => setupAt(b.step === 'extension' || b.step === 'weekly' ? 'done' : 'calibrate'));
  api.generateList.mockResolvedValue({ weekKey: '2026-W41', added: 0, items: [], filtersDiffer: false, reason: 'no_matches' });
  installNet();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A published extension for RoboApply (the store id is build-time configuration). */
const publishExtension = () => vi.stubEnv('NEXT_PUBLIC_EXT_ID', 'abcdefghijklmnopabcdefghijklmnop');

const ON = { agent: true };

/** No control may imply the product applies or submits (D1). */
function expectNoSubmitWording() {
  for (const el of [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]) {
    expect(el.textContent ?? '').not.toMatch(/submit|apply for me|auto[- ]?apply/i);
  }
}

// ── /ready ──────────────────────────────────────────────────────────────────

describe('/ready', () => {
  it('has no page when the `agent` flag is off, and calls nothing', async () => {
    renderWithBrand(<ReadyRoute />, { flags: {} });
    expect(await screen.findByText("Ready to apply isn't available here yet")).toBeInTheDocument();
    expect(api.listQueue).not.toHaveBeenCalled();
  });

  it('says it is unavailable while the API is not live (501)', async () => {
    api.listQueue.mockRejectedValue(apiError(501, 'not_implemented'));
    renderWithBrand(<ReadyRoute />, { flags: ON });
    expect(await screen.findByText("Ready to apply isn't available here yet")).toBeInTheDocument();
  });

  it('shows the intro before setup: what it does, "You submit each application yourself.", the real kit allowance', async () => {
    api.getAgentSetup.mockResolvedValue(setupAt('profile'));
    renderWithBrand(<ReadyRoute />, { flags: ON });
    expect(await screen.findByTestId('ready-intro')).toBeInTheDocument();
    expect(screen.getByText('You submit each application yourself.')).toBeInTheDocument();
    expect(await screen.findByText(/2 of 3 kits left this week\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See Pro' })).toHaveAttribute('href', '/settings/billing#plans');
    expect(screen.getByRole('link', { name: 'Set up Ready to apply' })).toHaveAttribute('href', '/ready/setup');
    expectNoSubmitWording();
  });

  it('says "Continue setup" when setup was started; the allowance renders "—" when unknown', async () => {
    api.getAgentSetup.mockResolvedValue(setupAt('answers'));
    extraRoutes = { 'GET /api/v1/roboapply/credits': () => new Response('{}', { status: 500 }) };
    vi.unstubAllGlobals();
    installNet();
    renderWithBrand(<ReadyRoute />, { flags: ON });
    expect(await screen.findByRole('link', { name: 'Continue setup' })).toBeInTheDocument();
    expect(await screen.findByText('Kits left this week: —')).toBeInTheDocument();
  });

  it('lists kits by tab with real counts (the contract grouping), and flags expired jobs under Done', async () => {
    api.listQueue.mockResolvedValue({
      items: [
        item({ id: 'q1', jobId: 'job1', state: 'picked' }),
        item({ id: 'q2', jobId: 'job2', state: 'expired' }),
        item({ id: 'q3', jobId: 'job3', state: 'ready_for_review' }),
        item({ id: 'q4', jobId: 'job4', state: 'applied', trackerEntryId: 'te4' }),
        item({ id: 'q5', jobId: 'job5', state: 'preparing' }),
      ],
    });
    const view = renderWithBrand(<ReadyRoute />, { flags: ON });
    const progress = await screen.findByTestId('ready-progress');
    // To prepare never counts expired (or failed-and-gone) jobs; Applied counts only opened/applied.
    expect([...progress.querySelectorAll('li')].map((li) => li.firstChild?.textContent)).toEqual(['1', '1', '1', '1']);
    expect(screen.getByRole('tab', { name: /To prepare/ })).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: /^Ready/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /Done/ })).toHaveTextContent('2');
    expect(screen.queryByText(/no longer listed by the company/)).toBeNull();
    expect(await screen.findByText('Data Analyst')).toBeInTheDocument();
    expect(screen.getAllByTestId('kit-row').map((r) => r.getAttribute('data-state'))).toEqual(['picked']);
    expectNoSubmitWording();
    view.unmount();

    nav.params = new URLSearchParams('tab=done');
    renderWithBrand(<ReadyRoute />, { flags: ON });
    expect(await screen.findByText(/1 job is no longer listed by the company/)).toBeInTheDocument();
    expect(screen.getAllByTestId('kit-row').map((r) => r.getAttribute('data-state'))).toEqual(['expired', 'applied']);
  });

  it('counts the progress strip over this week only when the server names the week', async () => {
    api.listQueue.mockResolvedValue({
      weekKey: '2026-W41',
      counts: { to_prepare: 1, ready: 0, done: 2 },
      items: [
        item({ id: 'q1', jobId: 'job1', state: 'picked', weekKey: '2026-W41' }),
        item({ id: 'q2', jobId: 'job2', state: 'applied', weekKey: '2026-W38', trackerEntryId: 'te2' }),
        item({ id: 'q3', jobId: 'job3', state: 'applied', weekKey: '2026-W41', trackerEntryId: 'te3' }),
      ],
    });
    const view = renderWithBrand(<ReadyRoute />, { flags: ON });
    const progress = await screen.findByTestId('ready-progress');
    expect(progress).toHaveAttribute('data-scope', 'week');
    expect(progress).toHaveAccessibleName("This week's list");
    // Applied this week: 1 (the W38 one is not this week's progress).
    expect([...progress.querySelectorAll('li')].map((li) => li.firstChild?.textContent)).toEqual(['1', '0', '0', '1']);
    // Tabs still show every week.
    expect(screen.getByRole('tab', { name: /Done/ })).toHaveTextContent('2');
    view.unmount();

    api.listQueue.mockResolvedValue({ items: [item({ id: 'q2', jobId: 'job2', state: 'applied', weekKey: '2026-W38', trackerEntryId: 'te2' })] });
    renderWithBrand(<ReadyRoute />, { flags: ON });
    const all = await screen.findByTestId('ready-progress');
    expect(all).toHaveAttribute('data-scope', 'all');
    expect(all).toHaveAccessibleName('Your whole list');
  });

  it('uses the server tab when it sends one', async () => {
    nav.params = new URLSearchParams('tab=ready');
    api.listQueue.mockResolvedValue({ items: [item({ id: 'q5', jobId: 'job1', state: 'preparing', tab: 'ready' })] });
    renderWithBrand(<ReadyRoute />, { flags: ON });
    expect(await screen.findByText('Preparing… this updates by itself.')).toBeInTheDocument();
  });

  it('shows the Ready tab from ?tab=ready', async () => {
    nav.params = new URLSearchParams('tab=ready');
    api.listQueue.mockResolvedValue({ items: [item({ id: 'q3', jobId: 'job3', state: 'ready_for_review' }), item({ id: 'q5', jobId: 'job1', state: 'approved' })] });
    renderWithBrand(<ReadyRoute />, { flags: ON });
    expect(await screen.findByRole('link', { name: 'Review kit' })).toHaveAttribute('href', '/ready/job3');
    expect(screen.getByRole('link', { name: 'Review and open' })).toHaveAttribute('href', '/ready/job1');
    fireEvent.click(screen.getByRole('tab', { name: /Done/ }));
    expect(nav.replace).toHaveBeenCalledWith('/ready?tab=done', { scroll: false });
  });

  it('shows the cost before preparing ("Uses … ; you have … left"), then prepares with one idempotency key per kit', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ id: 'q1', jobId: 'job1', state: 'picked' }), item({ id: 'q2', jobId: 'job2', state: 'picked' })] });
    api.prepareKit.mockImplementation(async (_id: string, body: { confirm?: boolean }) =>
      body.confirm ? { credits: [], confirmed: true } : { credits: [{ bucket: 'tailor', cost: 1 }, { bucket: 'cover_letter', cost: 1 }], confirmed: false },
    );
    renderWithBrand(<ReadyRoute />, { flags: ON });
    fireEvent.click(await screen.findByLabelText('Select all 2 jobs'));
    const bar = await screen.findByTestId('prepare-bar');
    fireEvent.click(within(bar).getByRole('button', { name: 'Prepare 2 kits' }));
    const sheet = await screen.findByTestId('prepare-sheet');
    expect(await within(sheet).findByTestId('cost-ready_kits')).toHaveTextContent('Uses 2 kits; you have 2 left this week.');
    expect(within(sheet).getByTestId('cost-tailor')).toHaveTextContent('Uses 2 tailoring credits; you have 2 left today.');
    expect(within(sheet).getByTestId('cost-cover_letter')).toHaveTextContent('Uses 2 cover letter credits; you have 1 left today. Only 1 can be prepared now.');
    // Quoting spends nothing: no `confirm` yet.
    expect(api.prepareKit).toHaveBeenCalledWith('q1', {});
    expect(api.prepareKit).toHaveBeenCalledWith('q2', {});
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Prepare 2 kits' }));
    await waitFor(() => expect(api.prepareKit).toHaveBeenCalledTimes(4));
    const confirmed = api.prepareKit.mock.calls.filter((c) => c[1]?.confirm === true);
    expect(confirmed.map((c) => c[0])).toEqual(['q1', 'q2']);
    const keys = confirmed.map((c) => c[2]?.idempotencyKey);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('opens the out-of-credits sheet when the server says no kits are left (402)', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ id: 'q1', jobId: 'job1', state: 'picked' })] });
    api.prepareKit.mockImplementation(async (_id: string, body: { confirm?: boolean }) => {
      if (body.confirm) throw apiError(402, 'credits_exhausted', { bucket: 'ready_kits', resetsAt: RESETS, upgradable: true });
      return { credits: [{ bucket: 'tailor', cost: 1 }], confirmed: false };
    });
    renderWithBrand(<ReadyRoute />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare' }));
    const sheet = await screen.findByTestId('prepare-sheet');
    await within(sheet).findByTestId('cost-tailor');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Prepare 1 kit' }));
    await waitFor(() => expect(__outOfCreditsStore.get()).toEqual({ bucket: 'ready_kits', resetsAt: RESETS, upgradable: true }));
    await waitFor(() => expect(screen.queryByTestId('prepare-sheet')).toBeNull());
  });

  it('adds a suggested job to the list', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'applied' })] });
    api.getSuggestions.mockResolvedValue({ items: [feedItem('job9', 'Data Engineer')] });
    api.addToQueue.mockResolvedValue({ items: [] });
    renderWithBrand(<ReadyRoute />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Data Engineer to your list' }));
    await waitFor(() => expect(api.addToQueue).toHaveBeenCalledWith({ jobIds: ['job9'], addedVia: 'suggestions' }));
    await waitFor(() => expect(screen.queryByText('Data Engineer')).toBeNull());
  });

  it('works at 375px: every control renders, and the stylesheet collapses to one column at 760px', async () => {
    const before = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    api.listQueue.mockResolvedValue({ items: [item({ id: 'q1', state: 'picked' })] });
    renderWithBrand(<ReadyRoute />, { flags: ON });
    fireEvent.click(await screen.findByLabelText('Select all 1 job'));
    expect(await screen.findByTestId('prepare-bar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/ready/setup#weekly');
    const css = readFileSync(join(__dirname, 'ready.module.css'), 'utf8');
    const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(mobile).toMatch(/\.wizard,\s*\.review\s*{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(mobile).toMatch(/\.progress\s*{\s*grid-template-columns: repeat\(2/);
    expect(css).toMatch(/min-height: 44px/);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: before });
  });
});

// ── KitRow: every state ─────────────────────────────────────────────────────

describe('KitRow', () => {
  const cases: Array<[ReadyQueueItem['state'], string[]]> = [
    ['picked', ['Skip', 'Prepare']],
    ['failed', ['Skip', 'Try again']],
    ['preparing', []],
    ['expired', ['Remove']],
    ['skipped', ['Put back', 'Remove']],
    ['ready_for_review', ['Review kit']],
    ['approved', ['Review and open']],
    ['opened', ['See in Applications']],
    ['applied', ['See in Applications']],
  ];
  it.each(cases)('%s shows only its own actions', async (state, labels) => {
    renderWithBrand(
      <ul>
        <KitRow item={item({ state, trackerEntryId: 'te1' })} />
      </ul>,
      { flags: ON },
    );
    const row = screen.getByTestId('kit-row');
    await within(row).findByText('Data Analyst');
    const actions = [...row.querySelectorAll('button, a.btn')].map((b) => b.textContent);
    expect(actions).toEqual(labels);
    if (state === 'preparing') expect(within(row).getByText('Preparing… this updates by itself.')).toBeInTheDocument();
    expectNoSubmitWording();
  });

  it('skip and remove call the API', async () => {
    api.skipQueueItem.mockResolvedValue(item({ state: 'skipped' }));
    renderWithBrand(
      <ul>
        <KitRow item={item({ state: 'picked' })} />
      </ul>,
      { flags: ON },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(api.skipQueueItem).toHaveBeenCalledWith('q1'));
  });

  it('a failed skip, restore or remove says so in plain words (never a silent failure)', async () => {
    __toastStore.set([]);
    const toasts = () => __toastStore.get().map((x) => `${x.tone}: ${x.message}`);
    api.skipQueueItem.mockRejectedValue(apiError(409, 'conflict', { reason: 'queue_invalid_transition' }));
    api.restoreQueueItem.mockRejectedValue(apiError(409, 'conflict', { reason: 'queue_full', room: 0 }));
    const view = renderWithBrand(
      <ul>
        <KitRow item={item({ state: 'picked' })} />
      </ul>,
      { flags: ON },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(toasts()).toContain('warn: This kit changed in the meantime. The page now shows its latest state.'));
    view.unmount();
    renderWithBrand(
      <ul>
        <KitRow item={item({ state: 'skipped' })} />
      </ul>,
      { flags: ON },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Put back' }));
    await waitFor(() => expect(api.restoreQueueItem).toHaveBeenCalledWith('q1'));
    await waitFor(() => expect(toasts()).toContain('warn: Your list is full. Remove a job first.'));
  });

  it('uses the job summary on the list item (no job read per row) and reads the job only without one', async () => {
    renderWithBrand(
      <ul>
        <KitRow item={item({ jobId: 'jobX', job: { title: 'Payments Analyst', companyName: 'Initech', location: 'Lisbon', hasApplyUrl: true, closed: false, asksForCoverLetter: false } })} />
      </ul>,
      { flags: ON },
    );
    const row = screen.getByTestId('kit-row');
    expect(within(row).getByText('Payments Analyst')).toBeInTheDocument();
    expect(within(row).getByText('Initech')).toBeInTheDocument();
    expect(within(row).getByText('Lisbon')).toBeInTheDocument();
    expect(net.calls.some((c) => c.path.includes('/jobs/jobX'))).toBe(false);
    // No fit on the summary: none is shown (and none is read).
    expect(row.querySelector('[data-tier]')).toBeNull();
  });

  it('shows the fit the list sent with the row, without a job read', async () => {
    renderWithBrand(
      <ul>
        <KitRow item={item({ jobId: 'jobY', job: { title: 'Payments Analyst', companyName: 'Initech', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false, fit: { tier: 'good', score: 72 } } })} />
      </ul>,
      { flags: ON },
    );
    const row = screen.getByTestId('kit-row');
    expect(within(row).getByText(/Good fit/)).toHaveAttribute('data-tier', 'good');
    expect(net.calls.some((c) => c.path.includes('/jobs/jobY'))).toBe(false);
  });

  // M2 gate (D3): the server sends `kind` with every fit since MKT-2F. A deterministic estimate read "Good fit"
  // here with nothing saying so, while the feed card and the job page show "Quick estimate" for the same fit.
  it('a quick estimate says so next to the tier; an AI fit does not; a fit without a kind is read as an estimate (the contract\'s rule)', async () => {
    const kit = (jobId: string, fit: Record<string, unknown>) =>
      item({ id: `q_${jobId}`, jobId, job: { title: `Analyst ${jobId}`, companyName: 'Initech', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false, fit } as never });
    renderWithBrand(
      <ul>
        <KitRow item={kit('pre', { tier: 'good', score: 72, kind: 'pre' })} />
        <KitRow item={kit('ai', { tier: 'good', score: 72, kind: 'ai' })} />
        <KitRow item={kit('none', { tier: 'good', score: 72 })} />
      </ul>,
      { flags: ON },
    );
    const [pre, ai, none] = screen.getAllByTestId('kit-row');
    expect(within(pre!).getByTestId('fit-estimate-tag')).toHaveTextContent('Quick estimate');
    expect(within(ai!).queryByTestId('fit-estimate-tag')).toBeNull();
    expect(within(none!).getByTestId('fit-estimate-tag')).toHaveTextContent('Quick estimate');
  });
});

// ── /ready/[jobId] ──────────────────────────────────────────────────────────

describe('/ready/[jobId] kit review', () => {
  function withSession(sess: Record<string, unknown>) {
    extraRoutes = { 'GET /api/v1/roboapply/v2/resumes/tailor-sessions/ts1': () => ok(session(sess)) };
    vi.unstubAllGlobals();
    installNet();
  }

  it('blocks the resume until every detail is checked (Verify details is mandatory)', async () => {
    withSession({ pendingClaims: 2 });
    api.listQueue.mockResolvedValue({ items: [item({ state: 'ready_for_review', tailorSessionId: 'ts1', resumeVariantId: 'v1' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByTestId('verify-block')).toHaveTextContent('Check 2 details above before you use this resume.');
    const resume = screen.getByTestId('kit-resume');
    expect(within(resume).getByRole('button', { name: 'Use in this kit' })).toBeDisabled();
    // Two fits can be on this page (today's by the title, the tailoring's here): each says what it is.
    expect(within(resume).getByTestId('kit-fit-note')).toHaveTextContent('show your fit when this resume was tailored. The fit next to the job title is today\'s');
  });

  it('asks to save the checked resume first, then lets the user use it', async () => {
    withSession({ pendingClaims: 0, status: 'review' });
    api.listQueue.mockResolvedValue({ items: [item({ state: 'ready_for_review', tailorSessionId: 'ts1', resumeVariantId: 'v1' })] });
    const view = renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByTestId('verify-block')).toHaveTextContent('Save the checked resume above before you use it.');
    view.unmount();

    withSession({ pendingClaims: 0, status: 'finalized' });
    api.confirmKitPart.mockResolvedValue(item({ state: 'approved' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const resume = await screen.findByTestId('kit-resume');
    const use = await within(resume).findByRole('button', { name: 'Use in this kit' });
    await waitFor(() => expect(use).toBeEnabled());
    expect(screen.queryByTestId('verify-block')).toBeNull();
    fireEvent.click(use);
    await waitFor(() => expect(api.confirmKitPart).toHaveBeenCalledWith('q1', { part: 'resume', decision: 'use' }));
  });

  it('a kit with no tailoring says it uses the resume as it is, and can still be approved (base variant)', async () => {
    const it0 = item({ state: 'ready_for_review', resumeVariantId: 'v0' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    api.getKitDetail.mockResolvedValue(detailOf(it0, { aiAvailable: true }));
    // (No tailoring, so no "fit when tailored" note either.)
    api.confirmKitPart.mockRejectedValueOnce(apiError(409, 'conflict', { reason: 'kit_unverified_claims', pending: 1 })).mockResolvedValueOnce(item({ state: 'approved' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: { ...ON, 'ai.text': true } });
    const resume = await screen.findByTestId('kit-resume');
    expect(within(resume).getByText('This kit uses your resume as it is.')).toBeInTheDocument();
    // Never described as tailored.
    expect(resume).not.toHaveTextContent(/tailored/i);
    expect(within(resume).getByRole('link', { name: 'Open resume' })).toHaveAttribute('href', '/resume/v0');
    const use = within(resume).getByRole('button', { name: 'Use in this kit' });
    expect(use).toBeEnabled();
    fireEvent.click(use);
    expect(await within(resume).findByRole('alert')).toHaveTextContent('Check the details the tailored resume added before you use it.');
    fireEvent.click(use);
    await waitFor(() => expect(api.confirmKitPart).toHaveBeenLastCalledWith('q1', { part: 'resume', decision: 'use' }));
  });

  it('a kit with neither a tailoring session nor a resume variant can still be approved', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'ready_for_review' })] });
    api.confirmKitPart.mockResolvedValue(item({ state: 'approved' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const resume = await screen.findByTestId('kit-resume');
    expect(within(resume).getByText('This kit uses your resume as it is.')).toBeInTheDocument();
    expect(within(resume).queryByRole('link', { name: 'Open resume' })).toBeNull();
    fireEvent.click(within(resume).getByRole('button', { name: 'Use in this kit' }));
    await waitFor(() => expect(api.confirmKitPart).toHaveBeenCalledWith('q1', { part: 'resume', decision: 'use' }));
  });

  it('a base resume with unchecked details from the server is blocked here too', async () => {
    const it0 = item({ state: 'ready_for_review', resumeVariantId: 'v0' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    api.getKitDetail.mockResolvedValue(detailOf(it0, { resume: { pendingClaims: 1 } }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByTestId('verify-block')).toHaveTextContent('Check 1 detail above before you use this resume.');
    expect(within(screen.getByTestId('kit-resume')).getByRole('button', { name: 'Use in this kit' })).toBeDisabled();
  });

  it('the tailoring session comes from the kit detail when the list item has none', async () => {
    withSession({ pendingClaims: 1 });
    const it0 = item({ state: 'ready_for_review', resumeVariantId: 'v1' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    api.getKitDetail.mockResolvedValue(detailOf(it0, { resume: { tailorSessionId: 'ts1', tailored: true, pendingClaims: 1 } }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByTestId('verify-block')).toHaveTextContent('Check 1 detail above before you use this resume.');
    expect(screen.getByTestId('kit-resume')).toHaveAttribute('data-tailored', 'true');
  });

  it('sends "Ask for changes" with the instruction when AI is available', async () => {
    const it0 = item({ state: 'ready_for_review', resumeVariantId: 'v1' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    api.getKitDetail.mockResolvedValue(detailOf(it0, { aiAvailable: true }));
    api.confirmKitPart.mockResolvedValue(item({ state: 'preparing' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: { ...ON, 'ai.text': true } });
    const resume = await screen.findByTestId('kit-resume');
    fireEvent.click(await within(resume).findByRole('button', { name: 'Ask for changes' }));
    fireEvent.change(within(resume).getByLabelText('What should change in the resume?'), { target: { value: 'Shorter summary' } });
    fireEvent.click(within(resume).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.confirmKitPart).toHaveBeenLastCalledWith('q1', { part: 'resume', decision: 'revise', instruction: 'Shorter summary' }));
  });

  it('GoApply without AI consent: no AI control renders, and the page says kits use the resume as it is', async () => {
    extraRoutes = { 'GET /api/v1/roboapply/cover-letters/cl1': () => ok({ id: 'cl1', bodyMarkdown: 'Hello.', aiWritten: true }) };
    vi.unstubAllGlobals();
    installNet();
    const it0 = item({ state: 'ready_for_review', resumeVariantId: 'v0', coverLetterId: 'cl1' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    api.getKitDetail.mockResolvedValue(detailOf(it0, { aiAvailable: false }));
    const view = renderWithBrand(<KitReview jobId="job1" />, { brand: 'goapply', flags: { ...ON, 'ai.text': true } });
    const resume = await screen.findByTestId('kit-resume');
    expect(await within(resume).findByText('AI writing is off for your account, so kits use your resume as it is.')).toBeInTheDocument();
    await within(screen.getByTestId('kit-letter')).findByText('Hello.');
    expect(screen.queryByRole('button', { name: 'Ask for changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tailor/ })).toBeNull();
    // "Use" stays: it is not an AI step.
    expect(within(resume).getByRole('button', { name: 'Use in this kit' })).toBeEnabled();
    view.unmount();

    // The brand without an AI text model: same, whatever the detail says.
    api.getKitDetail.mockResolvedValue(detailOf(it0, { aiAvailable: true }));
    renderWithBrand(<KitReview jobId="job1" />, { brand: 'goapply', flags: ON });
    await screen.findByTestId('kit-resume');
    await within(screen.getByTestId('kit-letter')).findByText('Hello.');
    expect(screen.queryByRole('button', { name: 'Ask for changes' })).toBeNull();
  });

  it('shows the cover letter (AI line, copy, edit, use) and the answers with copy buttons and missing fields', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    extraRoutes = { 'GET /api/v1/roboapply/cover-letters/cl1': () => ok({ id: 'cl1', bodyMarkdown: 'Dear Acme team,\n\nI build dashboards.', aiWritten: true }) };
    vi.unstubAllGlobals();
    installNet();
    api.getAnswerBank.mockResolvedValue({ items: [answer()] });
    api.confirmKitPart.mockResolvedValue(item({ state: 'approved' }));
    api.listQueue.mockResolvedValue({
      items: [item({ state: 'ready_for_review', coverLetterId: 'cl1', missingFields: [{ key: 'phone', label: 'Phone number' }] })],
    });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const letter = await screen.findByTestId('kit-letter');
    expect(await within(letter).findByText(/I build dashboards\./)).toBeInTheDocument();
    expect(within(letter).getByText('Written with AI. Check every line before you use it.')).toBeInTheDocument();
    expect(within(letter).getByRole('link', { name: 'Edit letter' })).toHaveAttribute('href', '/resume/letters/cl1');
    fireEvent.click(within(letter).getByRole('button', { name: 'Copy the cover letter' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Dear Acme team,\n\nI build dashboards.'));
    fireEvent.click(within(letter).getByRole('button', { name: 'Use in this kit' }));
    await waitFor(() => expect(api.confirmKitPart).toHaveBeenCalledWith('q1', { part: 'letter', decision: 'use' }));

    const answers = screen.getByTestId('kit-answers');
    expect(within(answers).getByTestId('kit-missing')).toHaveTextContent('Phone number');
    fireEvent.click(await within(answers).findByRole('button', { name: 'Copy your answer to: What is your notice period?' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Two weeks'));
    expect(await within(answers).findByText('Copied.')).toBeInTheDocument();
  });

  it('labels the cover letter as AI-generated on GoApply only', async () => {
    extraRoutes = { 'GET /api/v1/roboapply/cover-letters/cl1': () => ok({ id: 'cl1', bodyMarkdown: 'Hello.', aiWritten: true }) };
    vi.unstubAllGlobals();
    installNet();
    api.listQueue.mockResolvedValue({ items: [item({ state: 'ready_for_review', coverLetterId: 'cl1' })] });
    const view = renderWithBrand(<KitReview jobId="job1" />, { brand: 'goapply', flags: ON });
    const letter = await screen.findByTestId('kit-letter');
    await within(letter).findByText('Hello.');
    expect(letter.querySelector('[data-ai-label="document"]')).not.toBeNull();
    view.unmount();

    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const intl = await screen.findByTestId('kit-letter');
    await within(intl).findByText('Hello.');
    expect(intl.querySelector('[data-ai-label]')).toBeNull();
  });

  it('"Open application" opens the company page after the move to Applied, and offers "Undo · I didn\'t apply"', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved', trackerEntryId: 'te1', resumeVariantId: 'v1' })] });
    api.openApplication.mockResolvedValue({ applyUrl: 'https://acme.example/apply/job1', handoff: { jobId: 'job1', variantId: 'v1', coverLetterId: null }, trackerEntryId: 'te1' });
    api.undoQueueApplied.mockResolvedValue(item({ state: 'approved' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const part = await screen.findByTestId('kit-open');
    expect(within(part).getByText('You submit each application yourself.')).toBeInTheDocument();
    await screen.findByText('Data Analyst');
    fireEvent.click(within(part).getByRole('button', { name: 'Open application' }));
    // A blank tab inside the click; no employer URL until the server answered.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(api.openApplication).toHaveBeenCalledWith('q1'));
    await waitFor(() => expect(tab.location.href).toBe('https://acme.example/apply/job1'));
    const undo = await within(part).findByTestId('kit-undo');
    expect(undo).toHaveTextContent('Moved to Applied.');
    expect(within(part).getByRole('link', { name: 'See it in Applications' })).toHaveAttribute('href', '/applications?entry=te1');
    // No separate "I applied" confirmation.
    expect(within(part).queryByRole('button', { name: 'I applied' })).toBeNull();
    fireEvent.click(within(undo).getByRole('button', { name: "Undo · I didn't apply" }));
    await waitFor(() => expect(api.undoQueueApplied).toHaveBeenCalledWith('q1'));
    expect(await within(part).findByText('Moved back. This job is not marked as applied.')).toBeInTheDocument();
    expectNoSubmitWording();
  });

  it('closes the pending tab when the server refuses, and never opens a non-web link', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved' })] });
    api.openApplication.mockRejectedValueOnce(apiError(409, 'conflict', { reason: 'kit_not_ready' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const part = await screen.findByTestId('kit-open');
    await screen.findByText('Data Analyst');
    fireEvent.click(within(part).getByRole('button', { name: 'Open application' }));
    expect(await within(part).findByRole('alert')).toHaveTextContent('This kit changed in the meantime.');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
    expect(within(part).queryByTestId('kit-undo')).toBeNull();

    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl(' https://acme.example/apply ')).toBe('https://acme.example/apply');
  });

  it('a javascript: link from the server is not opened', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    extraRoutes = { 'GET /api/v1/roboapply/jobs/job1': () => ok(jobDetail('job1', 'Data Analyst', { applyUrl: null })) };
    vi.unstubAllGlobals();
    installNet();
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved' })] });
    api.openApplication.mockResolvedValue({ applyUrl: 'javascript:alert(1)', handoff: { jobId: 'job1', variantId: null, coverLetterId: null }, trackerEntryId: 'te1' });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const part = await screen.findByTestId('kit-open');
    await screen.findByText('Data Analyst');
    fireEvent.click(within(part).getByRole('button', { name: 'Open application' }));
    await within(part).findByTestId('kit-undo');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
    expect(within(part).queryByRole('link', { name: 'Open the application page again' })).toBeNull();
  });

  it('waits for the job read before "Open application" is enabled', async () => {
    let release: (r: Response) => void = () => undefined;
    extraRoutes = { 'GET /api/v1/roboapply/jobs/job1': () => new Promise<Response>((r) => (release = r)) as unknown as Response };
    vi.unstubAllGlobals();
    installNet();
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const part = await screen.findByTestId('kit-open');
    expect(within(part).getByRole('button', { name: 'Open application' })).toBeDisabled();
    await act(async () => release(ok(jobDetail('job1', 'Data Analyst'))));
    await waitFor(() => expect(within(part).getByRole('button', { name: 'Open application' })).toBeEnabled());
  });

  it('offers no Undo when the server says the job was already applied', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved' })] });
    api.openApplication.mockResolvedValue({ applyUrl: null, handoff: { jobId: 'job1', variantId: null, coverLetterId: null }, trackerEntryId: 'te1', alreadyApplied: true });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const part = await screen.findByTestId('kit-open');
    await screen.findByText('Data Analyst');
    fireEvent.click(within(part).getByRole('button', { name: 'Open application' }));
    expect(await within(part).findByText('This job was already in Applications.')).toBeInTheDocument();
    expect(within(part).queryByRole('button', { name: "Undo · I didn't apply" })).toBeNull();
  });

  it('offers "I applied" only when the job has no application link', async () => {
    extraRoutes = { 'GET /api/v1/roboapply/jobs/job1': () => ok(jobDetail('job1', 'Data Analyst', { applyUrl: null })) };
    vi.unstubAllGlobals();
    installNet();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved' })] });
    api.openApplication.mockRejectedValue(apiError(409, 'conflict', { code: 'no_apply_link' }));
    api.markQueueApplied.mockResolvedValue(item({ state: 'applied' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const part = await screen.findByTestId('kit-open');
    await screen.findByText('Data Analyst');
    fireEvent.click(within(part).getByRole('button', { name: 'Open application' }));
    const noLink = await within(part).findByTestId('kit-no-link');
    // The pending tab was closed again; no employer page was opened.
    expect(open.mock.calls.every((c) => c[0] === '')).toBe(true);
    fireEvent.click(within(noLink).getByRole('button', { name: 'I applied' }));
    await waitFor(() => expect(api.markQueueApplied).toHaveBeenCalledWith('q1'));
    expect(await within(part).findByText('Moved to Applied.')).toBeInTheDocument();
  });

  it('an opened kit shows when it moved to Applied, with Undo', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'opened', openedAt: '2026-10-08T10:00:00.000Z' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByTestId('kit-undo')).toHaveTextContent('Moved to Applied on Oct 8.');
    expect(screen.getByRole('button', { name: "Undo · I didn't apply" })).toBeInTheDocument();
  });

  it('an Undo that can no longer revert the move says so and points to Applications (no "Try again")', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'opened', openedAt: '2026-10-01T10:00:00.000Z', trackerEntryId: 'te1' })] });
    api.undoQueueApplied.mockRejectedValue(apiError(409, 'conflict', { reason: 'kit_undo_expired' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: "Undo · I didn't apply" }));
    const note = await screen.findByTestId('kit-undo-expired');
    expect(note).toHaveTextContent("This can't be undone here any more.");
    expect(note).not.toHaveTextContent(/Try again/);
    expect(within(note).getByRole('link', { name: 'Change the status in Applications' })).toHaveAttribute('href', '/applications?entry=te1');
    expect(screen.queryByRole('button', { name: "Undo · I didn't apply" })).toBeNull();
  });

  it('shows the kit history (GET /queue/:id/history); without the kit read no file name is guessed', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved', resumeVariantId: 'v1' })] });
    api.getKitHistory.mockResolvedValue({
      items: [
        { id: 'e1', kind: 'transition', fromState: 'preparing', toState: 'ready_for_review', actor: 'system', detail: { tailorSessionId: 'ts1' }, createdAt: '2026-10-07T06:00:00.000Z' },
        { id: 'e2', kind: 'transition', fromState: 'ready_for_review', toState: 'approved', actor: 'user', detail: null, createdAt: '2026-10-08T06:00:00.000Z' },
      ],
    });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const history = await screen.findByTestId('kit-history');
    // The server names the file; a name made up here would differ from the download.
    expect(screen.queryByTestId('kit-file-name')).toBeNull();
    expect(within(screen.getByTestId('kit-files')).getByRole('button', { name: 'Download resume (PDF)' })).toBeInTheDocument();
    const rows = within(history).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Now: Ready to open');
    expect(rows[0]).toHaveTextContent('You');
    // Only a resume was prepared: the line does not claim a letter.
    expect(rows[1]).toHaveTextContent('Resume prepared');
    expect(rows[1]).not.toHaveTextContent('letter');
    expect(api.getKitHistory).toHaveBeenCalledWith('q1', expect.anything());
  });

  it('uses the kit detail for history and the server file name when it has them', async () => {
    const it0 = item({ state: 'approved', resumeVariantId: 'v1' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    api.getKitDetail.mockResolvedValue({
      ...detailOf(it0, {
        history: [{ id: 'e3', kind: 'decision', fromState: 'ready_for_review', toState: 'ready_for_review', actor: 'user', detail: { part: 'letter', decision: 'use' }, createdAt: '2026-10-08T06:00:00.000Z' }],
      }),
      kit: { ...detailOf(it0).kit, fileName: 'Jane Doe - Acme Corp - Analyst' },
    });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    await waitFor(() => expect(screen.getByTestId('kit-file-name')).toHaveTextContent('Jane Doe - Acme Corp - Analyst.pdf'));
    expect(await screen.findByTestId('kit-history')).toHaveTextContent('Cover letter chosen for this kit');
  });

  it('the file name is the server\'s on every load: nothing else is shown while the kit is read (verification finding)', async () => {
    const it0 = item({ state: 'approved', resumeVariantId: 'v1' });
    api.listQueue.mockResolvedValue({ items: [it0] });
    let serve: (d: QueueItemDetail) => void = () => undefined;
    api.getKitDetail.mockImplementation(() => new Promise<QueueItemDetail>((resolve) => (serve = resolve)));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const files = await screen.findByTestId('kit-files');
    // The job and the profile are known by now; the name still waits for the server.
    await screen.findByRole('heading', { level: 1, name: 'Data Analyst' });
    expect(screen.queryByTestId('kit-file-name')).toBeNull();
    expect(files).not.toHaveTextContent('Acme');
    serve({ ...detailOf(it0), kit: { ...detailOf(it0).kit, fileName: 'Jane Doe - Acme - Data Analyst' } });
    await waitFor(() => expect(screen.getByTestId('kit-file-name')).toHaveTextContent('Jane Doe - Acme - Data Analyst.pdf'));
  });

  it('"Your answers" lists missing details in words, not as message keys (verification finding)', async () => {
    api.listQueue.mockResolvedValue({
      items: [
        item({
          state: 'ready_for_review',
          missingFields: [
            { key: 'firstName', label: 'profile.missing.firstName' },
            { key: 'lastName', label: 'profile.missing.lastName' },
            { key: 'custom', label: 'A plain label' },
          ],
        }),
      ],
    });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const missing = await screen.findByTestId('kit-missing');
    expect(missing).toHaveTextContent('First name');
    expect(missing).toHaveTextContent('Last name');
    expect(missing).toHaveTextContent('A plain label');
    expect(missing).not.toHaveTextContent('profile.missing');
  });

  it('calls the application page "the company\'s" only when it is; a job board is named by its host (verification finding)', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved', resumeVariantId: 'v1' })] });
    extraRoutes['GET /api/v1/roboapply/jobs/job1'] = () =>
      ok({ ...jobDetail('job1', 'Data Analyst', { applyUrl: 'https://www.jobleads.com/job/123', source: { name: 'JobLeads', kind: 'provider', originalName: null } }), company: { domain: 'acme.example' } });
    installNet();
    const view = renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const lead = await screen.findByTestId('kit-open-lead');
    await waitFor(() => expect(lead).toHaveAttribute('data-page', 'other'));
    expect(lead).toHaveTextContent('Opens the application page in a new tab and moves this job to Applied. The page is on jobleads.com.');
    expect(lead).not.toHaveTextContent(/company|employer/i);
    view.unmount();

    extraRoutes['GET /api/v1/roboapply/jobs/job1'] = () => ok({ ...jobDetail('job1', 'Data Analyst', { applyUrl: 'https://careers.acme.example/apply/1' }), company: { domain: 'acme.example' } });
    installNet();
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    await waitFor(() => expect(screen.getByTestId('kit-open-lead')).toHaveAttribute('data-page', 'employer'));
    expect(screen.getByTestId('kit-open-lead')).toHaveTextContent("Opens the company's application page in a new tab and moves this job to Applied.");

    expect(isEmployerApplyPage({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', sourceKind: 'ats_public' })).toBe(true);
    expect(isEmployerApplyPage({ applyUrl: 'https://notacme.example/apply', companyDomain: 'acme.example' })).toBe(false);
    expect(isEmployerApplyPage({ applyUrl: 'https://acme.example/apply', companyDomain: 'https://www.acme.example/' })).toBe(true);
    expect(isEmployerApplyPage({ applyUrl: 'javascript:alert(1)', sourceKind: 'ats_public' })).toBe(false);
    expect(isEmployerApplyPage({ applyUrl: 'https://jobs.example.com/1' })).toBe(false);
  });

  it('names exactly what each history row shows', () => {
    const t = ((key: string, v?: Record<string, unknown>) => (v ? `${key} ${JSON.stringify(v)}` : key)) as Parameters<typeof eventLine>[1];
    const row = (detail: Record<string, unknown> | null, toState: ReadyQueueItem['state'] = 'ready_for_review') =>
      eventLine({ id: 'e', kind: 'transition', fromState: 'preparing', toState, actor: 'system', detail, createdAt: '2026-10-07T06:00:00.000Z' }, t);
    expect(row({ tailorSessionId: 'ts1', coverLetterId: 'cl1' })).toBe('review.history.generated.both');
    expect(row({ tailorSessionId: 'ts1' })).toBe('review.history.generated.resume');
    expect(row({ coverLetterId: 'cl1' })).toBe('review.history.generated.letter');
    expect(row({ part: 'resume', decision: 'revise' })).toBe('review.history.revised.resume');
    expect(row({ via: 'undo' }, 'approved')).toBe('review.history.undone');
    expect(row({ via: 'apply_click' }, 'opened')).toBe('review.history.opened');
  });

  it('hides the history when the server does not serve it yet (nothing is claimed)', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    await screen.findByTestId('kit-open');
    await waitFor(() => expect(api.getKitHistory).toHaveBeenCalled());
    expect(screen.queryByTestId('kit-history')).toBeNull();
  });

  it('"Practice for this job" opens practice for the job', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'approved', resumeVariantId: 'v1' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Practice for this job' }));
    expect(nav.push).toHaveBeenCalledWith('/practice?job=job1&resume=v1&from=ready');
  });

  it('a kit not prepared yet offers "Prepare kit" (cost first); a preparing kit says it updates by itself', async () => {
    api.prepareKit.mockResolvedValue({ credits: [{ bucket: 'tailor', cost: 1 }], confirmed: false });
    api.listQueue.mockResolvedValue({ items: [item({ state: 'picked' })] });
    const view = renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare kit' }));
    expect(await screen.findByTestId('cost-tailor')).toHaveTextContent('Uses 1 tailoring credit; you have 2 left today.');
    view.unmount();

    api.listQueue.mockResolvedValue({ items: [item({ state: 'preparing' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByTestId('kit-preparing')).toHaveTextContent('Preparing your kit. This page updates by itself.');
  });

  it('an expired job is flagged with Remove (leaving only when it worked); a failed kit can be tried again', async () => {
    api.removeQueueItem.mockRejectedValueOnce(apiError(500, 'server_error')).mockResolvedValueOnce(undefined);
    api.listQueue.mockResolvedValue({ items: [item({ state: 'expired' })] });
    const view = renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const expired = await screen.findByTestId('kit-expired');
    fireEvent.click(within(expired).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.click(within(expired).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeQueueItem).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/ready'));
    view.unmount();

    api.listQueue.mockResolvedValue({ items: [item({ state: 'failed', lastError: 'prepare_timeout' })] });
    const failedView = renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByText("This kit couldn't be prepared.")).toBeInTheDocument();
    // The server's code is never shown; a plain reason is.
    expect(screen.getByTestId('kit-failed-reason')).toHaveTextContent('Something went wrong on our side. Try again.');
    expect(screen.queryByText(/prepare_timeout/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    failedView.unmount();

    api.listQueue.mockResolvedValue({ items: [item({ state: 'failed', lastError: 'conflict:something_new' })] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    expect(await screen.findByText("This kit couldn't be prepared.")).toBeInTheDocument();
    expect(screen.queryByTestId('kit-failed-reason')).toBeNull();
    expect(screen.queryByText(/something_new/)).toBeNull();
  });

  it('a skipped job shows no kit parts, says it was skipped and can be put back', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ state: 'skipped', resumeVariantId: 'v1' })] });
    api.restoreQueueItem.mockResolvedValue(item({ state: 'picked' }));
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    const card = await screen.findByTestId('kit-skipped');
    expect(card).toHaveTextContent('You skipped this job.');
    expect(screen.queryByTestId('kit-resume')).toBeNull();
    expect(screen.queryByTestId('kit-letter')).toBeNull();
    expect(screen.queryByTestId('kit-files')).toBeNull();
    expect(screen.queryByText(/uses your resume as it is/)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Put back' }));
    await waitFor(() => expect(api.restoreQueueItem).toHaveBeenCalledWith('q1'));
  });

  it('a job not on the list can be added', async () => {
    api.addToQueue.mockResolvedValue({ items: [] });
    renderWithBrand(<KitReview jobId="job1" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Ready to apply' }));
    await waitFor(() => expect(api.addToQueue).toHaveBeenCalledWith({ jobIds: ['job1'], addedVia: 'manual' }));
  });
});

// ── /ready/setup ────────────────────────────────────────────────────────────

describe('/ready/setup', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('has five steps with the extension flag, four without; starts at the server step', async () => {
    expect(wizardSteps(true)).toEqual(['profile', 'calibrate', 'answers', 'weekly', 'extension']);
    expect(wizardSteps(false)).not.toContain('extension');
    expect(initialStep('#answers', 'profile', wizardSteps(false))).toBe('answers');
    expect(initialStep('#extension', 'weekly', wizardSteps(false))).toBe('weekly');
    expect(initialStep('', 'done', wizardSteps(false))).toBe('profile');

    // The server's "Get the extension" where that step is not shown: the last step (its Finish closes setup).
    expect(initialStep('', 'extension', wizardSteps(false))).toBe('weekly');

    publishExtension();
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate', { profileMissing: [] }));
    renderWithBrand(<SetupWizard />, { flags: { agent: true, extension: true } });
    expect(await screen.findByRole('heading', { name: 'Step 2 of 5: Check your search' })).toBeInTheDocument();
    const steps = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(steps).getAllByRole('button')).toHaveLength(5);
    expect(within(steps).getByRole('button', { name: /Confirm your profile/ })).toHaveAttribute('data-done', 'true');
  });

  it('step 1 flags missing fields and renders the profile completion card', async () => {
    api.getAgentSetup.mockResolvedValue(setupAt('profile', { profileMissing: [{ key: 'phone', label: 'Phone number' }] }));
    renderWithBrand(<SetupWizard />, { flags: ON });
    const step = await screen.findByTestId('setup-profile');
    expect(await within(step).findByText('Phone number')).toBeInTheDocument();
    expect(within(step).getAllByText('Missing').length).toBeGreaterThan(0);
    expect(within(step).getByRole('link', { name: 'Complete your profile' })).toHaveAttribute('href', '/profile');
    // Continue is never blocked by missing fields; it reports the step to the server.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Step 2 of 4: Check your search' })).toBeInTheDocument();
    expect(api.completeSetupStep).toHaveBeenCalledWith({ step: 'profile', action: 'complete' });
    expect(window.location.hash).toBe('#calibrate');
  });

  it('step 2 rates jobs (a reason for "Not right"), and "Show 3 more" moves on', async () => {
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate'));
    api.getSuggestions.mockResolvedValue({ items: [feedItem('j1', 'Analyst I'), feedItem('j2', 'Analyst II'), feedItem('j3', 'Analyst III'), feedItem('j4', 'Analyst IV')] });
    api.submitCalibration.mockResolvedValue(setupAt('calibrate'));
    renderWithBrand(<SetupWizard />, { flags: ON });
    const step = await screen.findByTestId('setup-calibrate');
    expect(await within(step).findAllByTestId('calibration-job')).toHaveLength(3);
    expect(within(step).getByText('0 of 3 rated')).toBeInTheDocument();
    const first = within(step).getAllByTestId('calibration-job')[0]!;
    fireEvent.click(within(first).getByRole('button', { name: 'Looks right' }));
    await waitFor(() => expect(api.submitCalibration).toHaveBeenCalledWith({ jobId: 'j1', verdict: 'up' }));
    const second = within(step).getAllByTestId('calibration-job')[1]!;
    fireEvent.click(within(second).getByRole('button', { name: 'Not right' }));
    // Save waits for a reason; "Something else" needs a few words too.
    expect(within(second).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(second).getByLabelText('Something else'));
    expect(within(second).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(second).getByLabelText('Wrong level'));
    fireEvent.change(within(second).getByLabelText('Anything else? (optional)'), { target: { value: 'Too senior' } });
    fireEvent.click(within(second).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.submitCalibration).toHaveBeenLastCalledWith({ jobId: 'j2', verdict: 'down', reason: 'wrong_level', note: 'Too senior' }));
    expect(await within(step).findByText('2 of 3 rated')).toBeInTheDocument();
    fireEvent.click(within(step).getByRole('button', { name: 'Show 3 more' }));
    expect(await within(step).findByText('Analyst IV')).toBeInTheDocument();
    // More than one page is asked for, so "Show 3 more" has jobs to show.
    expect(api.getSuggestions).toHaveBeenCalledWith({ limit: 12 }, expect.anything());
  });

  it('step 2 starts its count from the verdicts the server already has', async () => {
    window.history.replaceState(null, '', '/ready/setup#calibrate');
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate', { calibrationCount: 2 } as Partial<AgentSetupResponse['checks']>));
    api.getSuggestions.mockResolvedValue({ items: [feedItem('j1', 'Analyst I')] });
    renderWithBrand(<SetupWizard />, { flags: ON });
    const step = await screen.findByTestId('setup-calibrate');
    expect(await within(step).findByText('2 of 3 rated')).toBeInTheDocument();
  });

  it('Continue out of order says which step is still open and offers to go there (no "Try again")', async () => {
    window.history.replaceState(null, '', '/ready/setup#answers');
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate'));
    api.completeSetupStep.mockRejectedValueOnce(apiError(409, 'conflict', { reason: 'setup_step_out_of_order', step: 'calibrate' }));
    renderWithBrand(<SetupWizard />, { flags: ON });
    await screen.findByRole('heading', { name: 'Step 3 of 4: Application answers' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByTestId('setup-step-error');
    expect(alert).toHaveTextContent('Finish “Check your search” first.');
    expect(alert).not.toHaveTextContent(/Try again/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Go to “Check your search”' }));
    expect(await screen.findByRole('heading', { name: 'Step 2 of 4: Check your search' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#calibrate');
  });

  it('step 2 stays put with a plain message until 3 jobs are rated', async () => {
    window.history.replaceState(null, '', '/ready/setup#calibrate');
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate'));
    api.getSuggestions.mockResolvedValue({ items: [feedItem('j1', 'Analyst I'), feedItem('j2', 'Analyst II'), feedItem('j3', 'Analyst III')] });
    api.completeSetupStep.mockRejectedValueOnce(apiError(409, 'conflict', { reason: 'calibration_incomplete' }));
    renderWithBrand(<SetupWizard />, { flags: ON });
    await screen.findByTestId('setup-calibrate');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Rate 3 jobs to finish this step.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Step 2 of 4: Check your search' })).toBeInTheDocument();
  });

  it('step 3 (#answers, linked from the profile) saves the user\'s own answers with the canonical keys', async () => {
    window.history.replaceState(null, '', '/ready/setup#answers');
    api.getAgentSetup.mockResolvedValue(setupAt('profile'));
    api.getAnswerBank.mockResolvedValue({ items: [answer(), answer({ id: 'a2', questionKey: 'relocation', questionText: 'Are you willing to relocate?', answer: 'Yes' })] });
    api.putAnswerBank.mockImplementation(async (b: { answers: unknown[] }) => ({ items: b.answers }));
    renderWithBrand(<SetupWizard />, { flags: ON });
    const step = await screen.findByTestId('answers-editor');
    expect(await within(step).findByDisplayValue('Two weeks')).toBeInTheDocument();
    fireEvent.change(within(step).getByLabelText('Why do you want to work at this company?'), { target: { value: 'I like the product.' } });
    // Clearing a saved answer deletes it (the server deletes a blank answer).
    fireEvent.change(within(step).getByLabelText('Are you willing to relocate?'), { target: { value: '' } });
    // Salary expectation, per currency.
    fireEvent.change(within(step).getByLabelText('Answer in another currency'), { target: { value: 'EUR' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Add currency' }));
    fireEvent.change(within(step).getByLabelText('What pay are you expecting? (EUR)'), { target: { value: '60,000 a year' } });
    fireEvent.change(within(step).getByLabelText('Add your own question'), { target: { value: 'Do you have a driving licence?' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Add question' }));
    fireEvent.change(within(step).getByLabelText('Do you have a driving licence?'), { target: { value: 'Yes' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Save answers' }));
    await waitFor(() => expect(api.putAnswerBank).toHaveBeenCalled());
    const sent = api.putAnswerBank.mock.calls[0]![0].answers as Array<{ questionKey: string; answer: string }>;
    expect(sent).toEqual(
      expect.arrayContaining([
        { questionKey: 'why_this_company', questionText: 'Why do you want to work at this company?', answer: 'I like the product.', locale: 'en' },
        { questionKey: 'notice_period', questionText: 'What is your notice period?', answer: 'Two weeks', locale: 'en' },
        { questionKey: 'relocation', questionText: 'Are you willing to relocate?', answer: '', locale: 'en' },
        { questionKey: 'salary_expectation:EUR', questionText: 'What pay are you expecting? (EUR)', answer: '60,000 a year', locale: 'en' },
        { questionKey: customQuestionKey('Do you have a driving licence?'), questionText: 'Do you have a driving licence?', answer: 'Yes', locale: 'en' },
      ]),
    );
    expect(sent).toHaveLength(5);
    expect(await within(step).findByText('Answers saved.')).toBeInTheDocument();
  });

  it('answer keys: the server list wins; the fallback mirrors WP-52; custom keys always pass the server pattern', async () => {
    // Custom keys: 16 hex digits, stable, never short.
    for (const text of ['a', 'Do you have a driving licence?', '¿Tienes carnet?', '你有驾照吗？', ' x '.repeat(40)]) {
      expect(customQuestionKey(text)).toMatch(/^custom:[a-f0-9]{16}$/);
    }
    expect(customQuestionKey('Hello  World')).toBe(customQuestionKey('hello world'));
    // Same key as WP-52's server `customQuestionKey` (sha256 of the normalized text, first 16 hex).
    const serverKey = (q: string) => `custom:${createHash('sha256').update(q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`;
    for (const text of ['', 'a', 'Do you have a driving licence?', '  Hello\tWORLD \n', '你有驾照吗？', 'ｆｕｌｌ　ｗｉｄｔｈ', '😀 emoji', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(200)]) {
      expect(customQuestionKey(text)).toBe(serverKey(text));
    }
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // GoApply's optional 网申 questions are not offered on RoboApply.
    expect(questionsFor('intl').map((q) => q.key)).not.toContain('political_status');
    expect(questionsFor('cn').find((q) => q.key === 'political_status')).toMatchObject({ optional: true, sensitive: true });
    expect(questionsFor('cn').map((q) => q.key)).not.toContain('work_authorization');
    expect(questionsFor('intl').find((q) => q.key === 'salary_expectation')?.perCurrency).toBe(true);

    // Served list → used as is (here: only two questions).
    window.history.replaceState(null, '', '/ready/setup#answers');
    api.getQuestionKeys.mockResolvedValue({
      items: [
        { key: 'start_date', labelKey: 'ready.questions.start_date', text: { en: 'When can you start?' }, optional: true, sensitive: false, protectedType: null, perCurrency: false },
        { key: 'brand_new', labelKey: 'ready.questions.brand_new', text: { en: 'A question only the server knows' }, optional: true, sensitive: false, protectedType: null, perCurrency: false },
      ],
    });
    renderWithBrand(<SetupWizard />, { flags: ON });
    const step = await screen.findByTestId('answers-editor');
    expect(await within(step).findByLabelText('A question only the server knows')).toBeInTheDocument();
    expect(within(step).queryByLabelText('Why do you want to work at this company?')).toBeNull();
  });

  it('GoApply marks 家庭成员 / 政治面貌 optional and never sent to AI', async () => {
    window.history.replaceState(null, '', '/ready/setup#answers');
    renderWithBrand(<SetupWizard />, { brand: 'goapply', flags: ON });
    const step = await screen.findByTestId('answers-editor');
    const political = step.querySelector('[data-question="political_status"]') as HTMLElement;
    expect(political).not.toBeNull();
    expect(political).toHaveTextContent('(optional)');
    expect(political).toHaveTextContent('Only you fill this in. It is never sent to AI.');
    expect(step.querySelector('[data-question="work_authorization"]')).toBeNull();
  });

  it('step 4 saves weekly settings and previews the file name with the user\'s own name', async () => {
    window.history.replaceState(null, '', '/ready/setup#weekly');
    api.putAgentSettings.mockImplementation(async (b: AgentSettings) => b);
    renderWithBrand(<SetupWizard />, { flags: ON });
    const form = await screen.findByTestId('weekly-settings');
    expect(await within(form).findByText('Jane Doe - Company - Job title.pdf')).toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText('20 a week'));
    fireEvent.click(within(form).getByLabelText('Never'));
    fireEvent.click(within(form).getByLabelText(/Tailor my resume for each job/));
    fireEvent.click(within(form).getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(api.putAgentSettings).toHaveBeenCalledWith({ ...SETTINGS, weeklyTarget: 20, coverLetterMode: 'never', tailorEach: false }),
    );
    expect(await within(form).findByText('Settings saved.')).toBeInTheDocument();
    expect(previewFileName('company_role_name', { name: 'Jane Doe', company: 'Acme/Co', role: 'Analyst' })).toBe('Acme Co - Analyst - Jane Doe');
  });

  it('Finish on the weekly step saves unsaved settings first, finishes setup on the server and goes to /ready', async () => {
    window.history.replaceState(null, '', '/ready/setup#weekly');
    api.putAgentSettings.mockImplementation(async (b: AgentSettings) => b);
    api.completeSetupStep.mockResolvedValue({ ...setupAt('done'), firstList: { weekKey: '2026-W41', added: 4, items: [], filtersDiffer: false, reason: null } });
    renderWithBrand(<SetupWizard />, { flags: ON });
    const form = await screen.findByTestId('weekly-settings');
    await within(form).findByText('Jane Doe - Company - Job title.pdf');
    fireEvent.click(within(form).getByLabelText('5 a week'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/ready'));
    expect(api.putAgentSettings).toHaveBeenCalledWith({ ...SETTINGS, weeklyTarget: 5 });
    expect(api.completeSetupStep).toHaveBeenCalledWith({ step: 'weekly', action: 'complete' });
    expect(api.putAgentSettings.mock.invocationCallOrder[0]!).toBeLessThan(api.completeSetupStep.mock.invocationCallOrder[0]!);
  });

  it('does not leave the weekly step when the unsaved settings could not be saved', async () => {
    window.history.replaceState(null, '', '/ready/setup#weekly');
    api.putAgentSettings.mockRejectedValue(apiError(500, 'server_error'));
    renderWithBrand(<SetupWizard />, { flags: ON });
    const form = await screen.findByTestId('weekly-settings');
    await within(form).findByText('Jane Doe - Company - Job title.pdf');
    fireEvent.click(within(form).getByLabelText('30 a week'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText("Your changes on this step weren't saved. Save them, or try again.")).toBeInTheDocument();
    expect(api.completeSetupStep).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('step 5 renders the inline extension prompt; "Skip for now" skips it on the server and goes to /ready', async () => {
    publishExtension();
    window.history.replaceState(null, '', '/ready/setup#extension');
    renderWithBrand(<SetupWizard />, { flags: { agent: true, extension: true } });
    expect(await screen.findByTestId('setup-extension')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/ready'));
    expect(api.completeSetupStep).toHaveBeenCalledWith({ step: 'extension', action: 'skip' });
  });

  it('with the extension connected, the last step says "Finish setup" and completes it', async () => {
    publishExtension();
    window.history.replaceState(null, '', '/ready/setup#extension');
    api.getAgentSetup.mockResolvedValue(setupAt('extension', { extensionConnected: true }));
    renderWithBrand(<SetupWizard />, { flags: { agent: true, extension: true } });
    await screen.findByTestId('setup-extension');
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(api.completeSetupStep).toHaveBeenCalledWith({ step: 'extension', action: 'complete' }));
  });

  it('opens at the saved step when the capabilities arrive after the first render (verification finding: always step 1)', async () => {
    // Capabilities are fetched on the client here, so the setup read starts disabled:
    // a disabled query is "not loading" with no data, which used to open step 1.
    extraRoutes['GET /api/v1/public/brand'] = () => ok({ id: 'roboapply', flags: { ...flagsWith({ agent: true }) } });
    installNet();
    api.getAgentSetup.mockResolvedValue(setupAt('answers', { profileMissing: [], calibrationDone: true }));
    renderWithBrand(<SetupWizard />, { flags: null });
    expect(await screen.findByRole('heading', { name: 'Step 3 of 4: Application answers' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Step 1 of/ })).not.toBeInTheDocument();
  });

  it('with nothing to rate, step 2 says so and offers "Rate jobs later" (verification finding: no way past it)', async () => {
    window.history.replaceState(null, '', '/ready/setup#calibrate');
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate'));
    api.getSuggestions.mockResolvedValue({ items: [] });
    api.completeSetupStep.mockResolvedValueOnce(setupAt('answers'));
    renderWithBrand(<SetupWizard />, { flags: { agent: true, 'jobs.feed': true } });
    const step = await screen.findByTestId('setup-calibrate');
    expect(await within(step).findByTestId('calibrate-none')).toHaveTextContent('No jobs fit your search right now.');
    expect(within(step).getByTestId('calibrate-later')).toHaveTextContent('You can go on with setup and rate jobs later.');
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rate jobs later' }));
    await waitFor(() => expect(api.completeSetupStep).toHaveBeenCalledWith({ step: 'calibrate', action: 'skip' }));
    expect(await screen.findByRole('heading', { name: 'Step 3 of 4: Application answers' })).toBeInTheDocument();
  });

  it('GoApply with the jobs list off: step 2 does not point at filters that are not there', async () => {
    window.history.replaceState(null, '', '/ready/setup#calibrate');
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate'));
    renderWithBrand(<SetupWizard />, { brand: 'goapply', flags: { agent: true } });
    const step = await screen.findByTestId('setup-calibrate');
    expect(await within(step).findByTestId('calibrate-none')).toHaveTextContent('There are no jobs to rate here yet.');
    expect(screen.getByRole('button', { name: 'Rate jobs later' })).toBeInTheDocument();
  });

  it('jobs left to rate keep "Continue"; it turns into "Rate jobs later" only once every listed job is rated', async () => {
    window.history.replaceState(null, '', '/ready/setup#calibrate');
    api.getAgentSetup.mockResolvedValue(setupAt('calibrate'));
    api.getSuggestions.mockResolvedValue({ items: [feedItem('j1', 'Analyst I')] });
    api.submitCalibration.mockResolvedValue(setupAt('calibrate', { calibrationCount: 1 }));
    renderWithBrand(<SetupWizard />, { flags: { agent: true, 'jobs.feed': true } });
    const step = await screen.findByTestId('setup-calibrate');
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    fireEvent.click(await within(step).findByRole('button', { name: 'Looks right' }));
    expect(await screen.findByRole('button', { name: 'Rate jobs later' })).toBeInTheDocument();
  });

  it('the extension capability without a published extension: no "Get the extension" step, and Finish closes setup on the server (verification finding)', async () => {
    // The server only knows the capability, so it still counts the step.
    window.history.replaceState(null, '', '/ready/setup');
    api.getAgentSetup.mockResolvedValue(setupAt('extension', { profileMissing: [], calibrationDone: true, weeklySaved: true }));
    api.completeSetupStep.mockImplementation(async (b: { step: string }) => setupAt(b.step === 'extension' ? 'done' : 'extension'));
    renderWithBrand(<SetupWizard />, { flags: { agent: true, extension: true } });
    // Opens at the last step shown here, not at step 1.
    expect(await screen.findByRole('heading', { name: 'Step 4 of 4: Weekly settings' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Setup steps' })).queryByRole('button', { name: /Get the extension/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/ready'));
    expect(api.completeSetupStep.mock.calls.map((c) => c[0])).toEqual([
      { step: 'weekly', action: 'complete' },
      { step: 'extension', action: 'skip' },
    ]);
  });

  it('Finish refused for jobs that are now there to rate offers the way back to step 2', async () => {
    window.history.replaceState(null, '', '/ready/setup#weekly');
    api.getAgentSetup.mockResolvedValue(setupAt('weekly'));
    api.completeSetupStep.mockRejectedValueOnce(apiError(409, 'conflict', { reason: 'calibration_incomplete', step: 'calibrate' }));
    renderWithBrand(<SetupWizard />, { flags: ON });
    await screen.findByRole('heading', { name: 'Step 4 of 4: Weekly settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    const alert = await screen.findByTestId('setup-step-error');
    expect(alert).toHaveTextContent('Rate 3 jobs to finish this step.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Go to “Check your search”' }));
    expect(await screen.findByRole('heading', { name: 'Step 2 of 4: Check your search' })).toBeInTheDocument();
  });

  it('no paragraph inside a paragraph in the page headers (verification finding: hydration error on /ready and /ready/setup)', async () => {
    const wizard = renderWithBrand(<SetupWizard />, { flags: ON });
    await screen.findByRole('heading', { name: 'Set up Ready to apply' });
    expect(wizard.container.querySelector('p p, p div, p section')).toBeNull();
    expect(wizard.container.querySelector('.page-h [data-honesty="you_submit"]')).not.toBeNull();
    wizard.unmount();
    const intro = renderWithBrand(<ReadyIntro />, { flags: ON });
    expect(intro.container.querySelector('p p, p div, p section')).toBeNull();
    intro.unmount();
    api.listQueue.mockResolvedValue({ items: [item()] });
    const page = renderWithBrand(<ReadyRoute />, { flags: ON });
    await screen.findByRole('heading', { level: 1, name: 'Ready to apply' });
    expect(page.container.querySelector('p p, p div, p section')).toBeNull();
    // Plain text still gets its paragraph.
    page.unmount();
    const plain = renderWithBrand(<PageHeader title="Title" sub="Plain words" />, { flags: ON });
    expect(plain.container.querySelector('p.sub')).toHaveTextContent('Plain words');
    expect(isPlainText('a')).toBe(true);
    expect(isPlainText(['a', 1, null])).toBe(true);
    expect(isPlainText(<span>a</span>)).toBe(false);
  });

  it('is unavailable with the flag off', async () => {
    renderWithBrand(<SetupWizard />, { flags: {} });
    expect(await screen.findByText("Ready to apply isn't available here yet")).toBeInTheDocument();
  });
});

// ── F-FILT-07 ───────────────────────────────────────────────────────────────

describe('ReadySearchCard — "Use this for your main search too?"', () => {
  async function changeRemote() {
    fireEvent.click(await screen.findByRole('button', { name: 'Change filters' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remote' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    return dialog;
  }

  it('asks the question when filters change on /ready; "Yes" updates the main search, then adds matching jobs', async () => {
    extraRoutes = { 'PATCH /api/v1/roboapply/search-profiles/sp_main': () => ok(searchProfile({ version: 4, filters: { workModels: ['remote'] } })) };
    vi.unstubAllGlobals();
    installNet();
    api.generateList.mockResolvedValue({ weekKey: '2026-W41', added: 3, items: [], filtersDiffer: false, reason: null });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    expect(await screen.findByText('Also used on Jobs')).toBeInTheDocument();
    const dialog = await changeRemote();
    const ask = await within(dialog).findByTestId('ready-search-ask');
    expect(ask).toHaveTextContent('Use this for your main search too?');
    // Nothing is written before the answer.
    expect(net.writes()).toHaveLength(0);
    expect(api.generateList).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Yes, update my main search' }));
    await waitFor(() => expect(net.to('PATCH', '/api/v1/roboapply/search-profiles/sp_main')[0]?.body).toEqual({ baseVersion: 3, filters: { workModels: ['remote'] } }));
    await waitFor(() => expect(api.generateList).toHaveBeenCalledWith({ more: true }));
    expect(await screen.findByText('Saved. Your main search uses these filters, and 3 matching jobs were added to your list.')).toBeInTheDocument();
  });

  it('"No, only Ready to apply" adds jobs with the changed filters, keeps them for later lists and leaves the main search alone (no saved search is created)', async () => {
    api.generateList.mockResolvedValue({ weekKey: '2026-W41', added: 2, items: [], filtersDiffer: true, reason: null });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    const dialog = await changeRemote();
    const ask = await within(dialog).findByTestId('ready-search-ask');
    await act(async () => {
      fireEvent.click(within(ask).getByRole('button', { name: 'No, only Ready to apply' }));
    });
    // A patch over the main search (the server keeps it for the next lists, the weekly one included).
    await waitFor(() => expect(api.generateList).toHaveBeenCalledWith({ overrides: { workModels: ['remote'] }, more: true }));
    expect(await screen.findByText('2 matching jobs were added to your list. Your main search did not change; your next lists here use these filters too.')).toBeInTheDocument();
    expect(net.writes()).toHaveLength(0);
    expect(api.putAgentSettings).not.toHaveBeenCalled();
  });

  it('after "No, only Ready to apply" the card shows the kept filters at once, and a second change is sent on top of them', async () => {
    // The server keeps the overrides when the list is generated; the settings then say so.
    api.generateList.mockImplementation(async (body: { overrides?: Record<string, unknown> }) => {
      api.getAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: body.overrides ?? null } });
      return { weekKey: '2026-W41', added: 2, items: [], filtersDiffer: true, reason: null };
    });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    await screen.findByText('Also used on Jobs');
    expect(screen.queryByTestId('ready-search-own')).toBeNull();
    const dialog = await changeRemote();
    await act(async () => {
      fireEvent.click(within(await within(dialog).findByTestId('ready-search-ask')).getByRole('button', { name: 'No, only Ready to apply' }));
    });
    // No reload, no wait for the settings to go stale: the card reads them again.
    const own = await screen.findByTestId('ready-search-own');
    expect(own).toHaveTextContent('Your lists here use filter changes you kept for Ready to apply only.');
    expect(within(own).getByRole('button', { name: 'Use my main search only' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Filters' })).getByText('Remote')).toBeInTheDocument();

    // A second change starts from the filters in use, so the first one is sent again with it.
    fireEvent.click(screen.getByRole('button', { name: 'Change filters' }));
    const again = await screen.findByRole('dialog');
    fireEvent.click(await within(again).findByRole('button', { name: 'Hybrid' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await act(async () => {
      fireEvent.click(within(await within(again).findByTestId('ready-search-ask')).getByRole('button', { name: 'No, only Ready to apply' }));
    });
    await waitFor(() => expect(api.generateList).toHaveBeenCalledTimes(2));
    expect(api.generateList.mock.calls[1]![0]).toEqual({ overrides: { workModels: ['remote', 'hybrid'] }, more: true });
  });

  it('says when Ready to apply has filter changes of its own, shows the filters the lists use, and "Use my main search only" removes them', async () => {
    api.getAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: { workModels: ['remote'] } } });
    api.putAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: null } });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    const own = await screen.findByTestId('ready-search-own');
    expect(own).toHaveTextContent('Your lists here use filter changes you kept for Ready to apply only. Jobs still shows your main search.');
    // The chips are the main search with Ready to apply's changes on top.
    expect(within(screen.getByRole('list', { name: 'Filters' })).getByText('Remote')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(own).getByRole('button', { name: 'Use my main search only' }));
    });
    expect(api.putAgentSettings).toHaveBeenCalledWith({ filterOverrides: null });
    expect(await screen.findByText('Done. Your lists here use your main search again.')).toBeInTheDocument();
    expect(net.writes()).toHaveLength(0);
    expect(api.generateList).not.toHaveBeenCalled();
  });

  it('editing the filters back to the main search removes Ready to apply\'s own changes without asking', async () => {
    api.getAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: { workModels: ['remote'] } } });
    api.putAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: null } });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    await screen.findByTestId('ready-search-own');
    // The draft starts from the filters in use (Remote on); turning it off is the main search again.
    await changeRemote();
    await waitFor(() => expect(api.putAgentSettings).toHaveBeenCalledWith({ filterOverrides: null }));
    expect(screen.queryByTestId('ready-search-ask')).toBeNull();
    expect(api.generateList).not.toHaveBeenCalled();
  });

  it('"Yes" with changes of its own: the main search takes the filters and Ready to apply keeps none', async () => {
    extraRoutes = { 'PATCH /api/v1/roboapply/search-profiles/sp_main': () => ok(searchProfile({ version: 4, filters: { workModels: ['hybrid'] } })) };
    vi.unstubAllGlobals();
    installNet();
    api.getAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: { postedWithinDays: 7 } } });
    api.putAgentSettings.mockResolvedValue({ ...SETTINGS, listFilters: { searchProfileId: null, overrides: null } });
    api.generateList.mockResolvedValue({ weekKey: '2026-W41', added: 1, items: [], filtersDiffer: false, reason: null });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    await screen.findByTestId('ready-search-own');
    const dialog = await changeRemote();
    fireEvent.click(within(await within(dialog).findByTestId('ready-search-ask')).getByRole('button', { name: 'Yes, update my main search' }));
    await waitFor(() => expect(net.to('PATCH', '/api/v1/roboapply/search-profiles/sp_main')).toHaveLength(1));
    await waitFor(() => expect(api.putAgentSettings).toHaveBeenCalledWith({ filterOverrides: null }));
    await waitFor(() => expect(api.generateList).toHaveBeenCalledWith({ more: true }));
  });

  it('"No" says plainly why nothing was added', async () => {
    api.generateList.mockResolvedValue({ weekKey: '2026-W41', added: 0, items: [], filtersDiffer: true, reason: 'queue_full' });
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    const dialog = await changeRemote();
    fireEvent.click(within(await within(dialog).findByTestId('ready-search-ask')).getByRole('button', { name: 'No, only Ready to apply' }));
    // The filters are kept even though nothing was added, and the message says so.
    expect(await screen.findByText('Your list is full. Prepare, skip or remove some jobs first. Your main search did not change; your next lists here use these filters.')).toBeInTheDocument();
  });

  it('in setup, says the change applies to the main search and saves it without the question', async () => {
    extraRoutes = { 'PATCH /api/v1/roboapply/search-profiles/sp_main': () => ok(searchProfile({ version: 4, filters: { workModels: ['remote'] } })) };
    vi.unstubAllGlobals();
    installNet();
    renderWithBrand(<ReadySearchCard mode="setup" />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Change filters' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Your weekly list comes from your main search, so saving here also changes the jobs you see on Jobs.');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remote' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(net.to('PATCH', '/api/v1/roboapply/search-profiles/sp_main')).toHaveLength(1));
    expect(screen.queryByTestId('ready-search-ask')).toBeNull();
    expect(api.generateList).not.toHaveBeenCalled();
  });

  it('closes without asking when nothing changed', async () => {
    renderWithBrand(<ReadySearchCard />, { flags: ON });
    fireEvent.click(await screen.findByRole('button', { name: 'Change filters' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(net.writes()).toHaveLength(0);
  });
});

// ── Kit allowance (F-AGENT-01) and the zero-tailoring line ──────────────────

describe('useReadyBadge', () => {
  function BadgeProbe() {
    const b = useReadyBadge();
    return <span data-testid="badge">{b && b.kind === 'count' ? String(b.count) : 'none'}</span>;
  }

  it('reads the one-count badge endpoint, never the whole list', async () => {
    api.getReadyBadge.mockResolvedValue({ readyNotOpened: 2 });
    renderWithBrand(<BadgeProbe />, { flags: ON });
    await waitFor(() => expect(screen.getByTestId('badge')).toHaveTextContent('2'));
    expect(api.getReadyBadge).toHaveBeenCalledTimes(1);
    expect(api.listQueue).not.toHaveBeenCalled();
  });

  it('shows nothing with the flag off or when the endpoint is not live', async () => {
    const view = renderWithBrand(<BadgeProbe />, { flags: {} });
    expect(screen.getByTestId('badge')).toHaveTextContent('none');
    expect(api.getReadyBadge).not.toHaveBeenCalled();
    view.unmount();
    api.getReadyBadge.mockRejectedValue(apiError(501, 'not_implemented'));
    renderWithBrand(<BadgeProbe />, { flags: ON });
    await waitFor(() => expect(api.getReadyBadge).toHaveBeenCalled());
    expect(screen.getByTestId('badge')).toHaveTextContent('none');
  });
});

describe('KitAllowance', () => {
  function withCredits(readyKits: Record<string, unknown>, upgradable = true) {
    extraRoutes = { 'GET /api/v1/roboapply/credits': () => ok({ ...CREDITS, summary: { ...CREDITS.summary, upgradable, buckets: { ...CREDITS.summary.buckets, ready_kits: readyKits } } }) };
    vi.unstubAllGlobals();
    installNet();
  }

  it('shows the week\'s allowance against the cap, bonus kits on their own line, never "N of M" with N > M', async () => {
    withCredits({ ...bucket(3, 3, 'week'), grantRemaining: 2 });
    renderWithBrand(<KitAllowance />, { flags: ON });
    expect(await screen.findByText(/3 of 3 kits left this week\./)).toBeInTheDocument();
    expect(screen.getByText('Plus 2 bonus kits you received.')).toBeInTheDocument();
    expect(screen.getByTestId('kit-allowance')).toHaveAttribute('data-left', '3');
  });

  it('shows the Pro weekly figure only when the server sends it', async () => {
    withCredits({ ...bucket(3, 1, 'week'), proCap: 30 });
    const view = renderWithBrand(<KitAllowance />, { flags: ON });
    expect(await screen.findByText(/Pro: up to 30 kits a week\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See Pro' })).toBeInTheDocument();
    view.unmount();

    withCredits(bucket(3, 1, 'week'));
    renderWithBrand(<KitAllowance />, { flags: ON });
    expect(await screen.findByText(/1 of 3 kits left this week\./)).toBeInTheDocument();
    expect(screen.queryByText(/Pro: up to/)).toBeNull();
    expect(screen.getByRole('link', { name: 'See Pro' })).toBeInTheDocument();
  });
});

describe('PrepareSheet zero-tailoring line', () => {
  it('names the real reason: AI unavailable, tailoring off, or the resume as it is', () => {
    expect(noTailorKey({ aiAvailable: false }, true, true)).toBe('prepare.noTailorAi');
    expect(noTailorKey({ aiAvailable: null }, false, true)).toBe('prepare.noTailorAi');
    expect(noTailorKey({ aiAvailable: true }, true, false)).toBe('prepare.noTailor');
    expect(noTailorKey({ aiAvailable: null }, true, undefined)).toBe('prepare.noTailorAsIs');
  });

  it('says AI writing is off when the server prepares without AI', async () => {
    api.listQueue.mockResolvedValue({ items: [item({ id: 'q1', jobId: 'job1', state: 'picked' })] });
    api.prepareKit.mockResolvedValue({ credits: [{ bucket: 'ready_kits', cost: 1 }], confirmed: false, aiAvailable: false });
    renderWithBrand(<ReadyRoute />, { flags: { ...ON, 'ai.text': true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare' }));
    const sheet = await screen.findByTestId('prepare-sheet');
    expect(await within(sheet).findByText('AI writing is off for your account, so kits use your resume as it is.')).toBeInTheDocument();
    expect(within(sheet).getByTestId('cost-ready_kits')).toHaveTextContent('Uses 1 kit; you have 2 left this week.');
  });
});
