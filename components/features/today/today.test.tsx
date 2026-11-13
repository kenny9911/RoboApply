// /today — the desk (docs/agent-driven/REDESIGN.md §5). What these tests hold:
//
//   • "Waiting for you": at most four cards, most urgent first, one fact and
//     one action each; the first card's action is the screen's ONLY primary
//     button;
//   • every number is a real loaded number: "—" while loading or failed, never 0;
//   • a lane whose read failed says so and offers "Try again", and the other
//     lanes still render;
//   • lanes adapt to the capabilities: no kit numbers and no Prepare button
//     without `agent`, no Ask without `copilot`;
//   • a fit tier or score never shows without "This is not your chance of
//     getting hired." (C5);
//   • nothing on the page says the product applies or submits (D1), and
//     nothing speaks in the first person (C9).
//
// TodayDesk is handed its reads (today.testkit `sourcesWith`), so no request
// is made for them. The few reads its children make themselves (the week's
// allowance) answer from a fetch double.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/today',
}));

// `Change` opens the shared filters editor. The editor has its own tests; here it is a marker that says what it was given.
vi.mock('../filters', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  FiltersDrawer: ({ open, profile, onClose }: { open: boolean; profile: { id: string } | null; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="All filters" data-profile={profile?.id}>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

import { installFetch, ok } from '../filters/filters.testkit';
import { __assistantRailStore } from '../../../hooks/shared/useOpenAssistant';
import type { CheckState } from '../resume';
import { TodayDesk } from './TodayDesk';
import { waitingHref } from './WaitingList';
import type { AutoPrepareView } from '../../../lib/api/agent';
import type { TodaySources } from '../../../hooks/today';
import { NOW, autoPrepareView, board, daysAgo, entry, failed, kit, loading, off, pick, ready, renderToday, resume, searchProfile, sourcesWith } from './today.testkit';

const RESETS = '2026-11-15T00:00:00.000Z';
const CREDITS = {
  summary: {
    planKey: 'free',
    planProfile: 'free',
    legacyPlan: false,
    interval: null,
    periodEnd: null,
    timezone: 'UTC',
    upgradable: false,
    buckets: { ready_kits: { cap: 3, window: 'week', used: 1, remaining: 2, grantRemaining: 0, resetsAt: RESETS } },
    entitlements: {},
  },
  practice: null,
};

const ALL_ON = { agent: true, copilot: true, 'jobs.feed': true } as const;
const CHECK_DONE: CheckState = { kind: 'done', label: 'good', score: 74, counts: { urgent: 1, critical: 2, optional: 0 }, stale: false, checkedAt: daysAgo(3) };

let net: ReturnType<typeof installFetch>;

beforeEach(() => {
  net = installFetch({ 'GET /api/v1/roboapply/credits': () => ok(CREDITS) });
  __assistantRailStore.set({ open: false, request: null, seq: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const primaryButtons = () => Array.from(document.querySelectorAll('.btn.primary, button.primary, a.primary'));
const cards = () => screen.queryAllByTestId('waiting-card');
const numberOf = (key: string) => screen.getByTestId(`today-number-${key}`);

/** A day that needs everything: two applications, a version to verify, no reply, profile details, setup. */
function busyDay() {
  return sourcesWith({
    queue: ready([
      kit({ id: 'q_open', jobId: 'job_open', state: 'approved', job: { title: 'BI Developer', companyName: 'Initech', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false } }),
      kit({ id: 'q_review', jobId: 'job_review', state: 'ready_for_review' }),
      kit({ id: 'q_prep', jobId: 'job_prep', state: 'preparing' }),
    ]),
    resumes: ready([resume(), resume({ id: 'rv_t', kind: 'tailored_for_jd', isPrimary: false, name: 'For Hooli', unverifiedClaims: 2, tailorSessionId: 'ts 9' })]),
    board: ready(board([entry({ id: 'e_old', dateApplied: daysAgo(12) }), entry({ id: 'e_new', dateApplied: daysAgo(0) })])),
    profileMissing: ready(3),
    setupStepsLeft: ready(2),
    picks: ready([pick('p1', 'Analytics Engineer'), pick('p2', 'Data Scientist'), pick('p3', 'Insights Lead')]),
    newJobs: ready({ count: 12, since: '2026-11-09T08:00:00.000Z', capped: false }),
  });
}

// ── Header ──────────────────────────────────────────────────────────────────

describe('/today header', () => {
  it('shows the date, states the count in the one h1 and builds the goal line from the saved search', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    // Six things wait (2 applications, 1 version, no reply, profile, setup); four are cards.
    expect(headings[0]).toHaveTextContent('6 things are waiting for you');
    expect(screen.getByText('Wednesday, November 11')).toBeInTheDocument();
    expect(screen.getByTestId('today-goal')).toHaveTextContent('Looking for Product designer · Senior · Remote or London');
  });

  it('says "1 thing" for one and "Nothing is waiting for you" for none', () => {
    const one = renderToday(<TodayDesk sources={sourcesWith({ profileMissing: ready(1) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1 thing is waiting for you');
    one.unmount();
    renderToday(<TodayDesk sources={sourcesWith()} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nothing is waiting for you');
  });

  it('prints only the values the search holds, and says so when it holds none', () => {
    const titlesOnly = renderToday(<TodayDesk sources={sourcesWith({ search: ready(searchProfile({ filters: { titles: ['Nurse', 'Midwife', 'Carer', 'Doula', 'Porter'] } })) })} check={null} now={NOW} />, {
      flags: ALL_ON,
    });
    expect(screen.getByTestId('today-goal')).toHaveTextContent('Looking for Nurse, Midwife, Carer and 2 more');
    expect(screen.getByTestId('today-goal')).not.toHaveTextContent('·');
    titlesOnly.unmount();

    renderToday(<TodayDesk sources={sourcesWith({ search: ready(searchProfile({ filters: {} })) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByTestId('today-goal')).toHaveTextContent('Your search is open to any job.');
  });

  // docs/agent-driven/REDESIGN.md §8 scenario 4: target companies close the goal line, and `Change` edits them.
  it('closes the line with the companies the search wants to work at: two named, then "and N more"', () => {
    const base = searchProfile().filters;
    const four = renderToday(
      <TodayDesk sources={sourcesWith({ search: ready(searchProfile({ filters: { ...base, preferredCompanies: ['Stripe', 'Figma', 'Linear', 'Ramp'] } })) })} check={null} now={NOW} />,
      { flags: ALL_ON },
    );
    expect(screen.getByTestId('today-goal')).toHaveTextContent('Looking for Product designer · Senior · Remote or London · at Stripe, Figma and 2 more');
    expect(screen.getByRole('button', { name: 'Change what you are looking for' })).toBeInTheDocument();
    four.unmount();

    const two = renderToday(<TodayDesk sources={sourcesWith({ search: ready(searchProfile({ filters: { ...base, preferredCompanies: ['Stripe', 'Figma'] } })) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByTestId('today-goal')).toHaveTextContent('Looking for Product designer · Senior · Remote or London · at Stripe or Figma');
    two.unmount();

    // Only companies: the search is still open to any job (they narrow nothing), and the line says it favours them.
    renderToday(<TodayDesk sources={sourcesWith({ search: ready(searchProfile({ filters: { preferredCompanies: ['Stripe'] } })) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByTestId('today-goal')).toHaveTextContent('Looking for any job, ideally at Stripe');
    expect(screen.getByTestId('today-goal')).not.toHaveTextContent('open to any job.');
  });

  it('`Change` opens the shared filters editor on the search Jobs uses', async () => {
    renderToday(<TodayDesk sources={sourcesWith()} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change what you are looking for' }));
    const editor = await screen.findByRole('dialog', { name: 'All filters' });
    expect(editor).toHaveAttribute('data-profile', 'sp_main');
    fireEvent.click(within(editor).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('an account with no saved search is sent to where one is made', () => {
    renderToday(<TodayDesk sources={sourcesWith({ search: ready(null) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByRole('link', { name: 'Set up your search' })).toHaveAttribute('href', '/settings#search');
    expect(screen.queryByRole('button', { name: 'Change what you are looking for' })).not.toBeInTheDocument();
  });

  it('a search that failed to load says so and can be asked again, without hiding the rest', () => {
    const retry = vi.fn();
    renderToday(<TodayDesk sources={sourcesWith({ search: failed(retry) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByText('Your search could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('today-applications')).toBeInTheDocument();
  });
});

// ── Waiting for you ─────────────────────────────────────────────────────────

describe('/today "Waiting for you"', () => {
  it('shows at most four cards, most urgent first, and says how many more wait', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    expect(cards().map((c) => c.getAttribute('data-kind'))).toEqual(['review', 'open', 'verify', 'no_reply']);
    expect(screen.getByTestId('waiting-more')).toHaveTextContent('2 more are waiting. They show here as you finish these.');
    // A real list, one item per card.
    const list = cards()[0]!.closest('ul')!;
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });

  it('each card is one fact and one action that goes to the right place', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const [review, open, verify, noReply] = cards();
    expect(review).toHaveTextContent('Data Analyst at Acme is ready to check.');
    expect(within(review!).getByRole('link', { name: 'Check and open' })).toHaveAttribute('href', '/ready/job_review');
    expect(open).toHaveTextContent('BI Developer at Initech is ready to open.');
    expect(within(open!).getByRole('link', { name: 'Open application' })).toHaveAttribute('href', '/ready/job_open');
    expect(verify).toHaveTextContent('2 new details in For Hooli need your OK.');
    expect(within(verify!).getByRole('link', { name: 'Verify details' })).toHaveAttribute('href', '/resume?tailorSession=ts%209');
    expect(noReply).toHaveTextContent('1 application has had no reply in 10 days.');
    expect(within(noReply!).getByRole('link', { name: 'See them' })).toHaveAttribute('href', '/applications');
    for (const card of cards()) {
      expect(within(card).getAllByRole('link')).toHaveLength(1);
      expect(within(card).queryAllByRole('button')).toHaveLength(0);
      // The action is described by its own fact (several cards may share an action word).
      const link = within(card).getByRole('link');
      expect(document.getElementById(link.getAttribute('aria-describedby')!)).toHaveTextContent(/\.$/);
    }
  });

  it('the other kinds: profile details, no resume, setup left early', () => {
    renderToday(<TodayDesk sources={sourcesWith({ resumes: ready([]), profileMissing: ready(1), setupStepsLeft: ready(1) })} check={null} now={NOW} />, { flags: ALL_ON });
    const [profile, noResume, setup] = cards();
    expect(profile).toHaveTextContent('Your profile is missing 1 detail that application forms ask for.');
    expect(within(profile!).getByRole('link', { name: 'Add details' })).toHaveAttribute('href', '/profile');
    expect(noResume).toHaveTextContent('You have not added a resume yet.');
    expect(within(noResume!).getByRole('link', { name: 'Add a resume' })).toHaveAttribute('href', '/resume');
    expect(setup).toHaveTextContent('Setup has 1 step left.');
    expect(within(setup!).getByRole('link', { name: 'Finish setting up' })).toHaveAttribute('href', '/onboarding');
  });

  it('names the job only as far as the server did', () => {
    const titleOnly = { title: 'Analyst', companyName: '', location: null, hasApplyUrl: true, closed: false, asksForCoverLetter: false };
    renderToday(
      <TodayDesk
        sources={sourcesWith({
          queue: ready([
            kit({ id: 'a', jobId: 'j1', job: titleOnly }),
            kit({ id: 'b', jobId: 'j2', job: null }),
            kit({ id: 'c', jobId: 'j3', state: 'approved', job: titleOnly }),
            kit({ id: 'd', jobId: 'j4', state: 'approved', job: null }),
          ]),
        })}
        check={CHECK_DONE}
        now={NOW}
      />,
      { flags: ALL_ON },
    );
    expect(cards().map((card) => card.querySelector('p')!.textContent)).toEqual([
      'Analyst is ready to check.',
      'An application is ready to check.',
      'Analyst is ready to open.',
      'An application is ready to open.',
    ]);
  });

  it('a version made without a session opens the resume itself', () => {
    expect(waitingHref({ kind: 'verify', key: 'v', resumeId: 'rv/1', sessionId: null, name: 'x', count: 1 })).toBe('/resume/rv%2F1');
  });

  it('the first card carries the screen’s only primary button', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const primary = primaryButtons();
    expect(primary).toHaveLength(1);
    expect(primary[0]).toBe(within(cards()[0]!).getByRole('link', { name: 'Check and open' }));
    // Every pick's action is a default button, not a second primary.
    for (const button of screen.getAllByTestId('prepare-application')) expect(button).not.toHaveClass('primary');
  });

  it('with nothing waiting there is one calm line that points at the picks, and the first pick carries the primary button', () => {
    renderToday(
      <TodayDesk sources={sourcesWith({ picks: ready([pick('p1', 'Analytics Engineer'), pick('p2', 'Data Analyst')]) })} check={CHECK_DONE} now={NOW} />,
      { flags: ALL_ON },
    );
    const empty = screen.getByTestId('waiting-empty');
    expect(empty).toHaveTextContent('Nothing needs you right now. The best picks are below.');
    const pointer = within(empty).getByRole('link', { name: 'Go to the picks' });
    expect(document.querySelector(pointer.getAttribute('href')!)).toBe(screen.getByTestId('today-job-search'));
    expect(cards()).toHaveLength(0);
    // A new account has nothing waiting: the next move is the first pick, and only that one (review finding 1).
    const primary = primaryButtons();
    expect(primary).toHaveLength(1);
    const rows = screen.getAllByTestId('today-pick');
    expect(rows[0]).toContainElement(primary[0] as HTMLElement);
    expect(primary[0]).toHaveTextContent('Prepare application');
    expect(within(rows[1]!).getByTestId('prepare-application')).not.toHaveClass('primary');
  });

  it('a waiting card keeps the primary button: no pick competes with it', () => {
    renderToday(
      <TodayDesk sources={sourcesWith({ queue: ready([kit()]), picks: ready([pick('p1', 'Analytics Engineer')]) })} check={CHECK_DONE} now={NOW} />,
      { flags: ALL_ON },
    );
    const primary = primaryButtons();
    expect(primary).toHaveLength(1);
    expect(screen.getByTestId('today-waiting')).toContainElement(primary[0] as HTMLElement);
    expect(within(screen.getByTestId('today-pick')).getByTestId('prepare-application')).not.toHaveClass('primary');
  });

  it('while the waiting list loads no pick takes the primary button (a card may still be about to)', () => {
    renderToday(
      <TodayDesk sources={sourcesWith({ queue: loading, picks: ready([pick('p1', 'Analytics Engineer')]) })} check={CHECK_DONE} now={NOW} />,
      { flags: ALL_ON },
    );
    expect(primaryButtons()).toHaveLength(0);
  });

  it('without `agent` the first pick’s link to the job carries the primary button when nothing waits', () => {
    // The page is handed its flags with the reads (hooks/today): `agent` off there is what turns the row's action into a link.
    const sources = sourcesWith({
      flags: { ready: true, agent: false, copilot: false, feed: true },
      queue: off,
      picksFrom: 'feed',
      picks: ready([pick('p1', 'Analytics Engineer'), pick('p2', 'Data Analyst')]),
    });
    renderToday(<TodayDesk sources={sources} check={CHECK_DONE} now={NOW} />, { flags: { 'jobs.feed': true } });
    const views = screen.getAllByTestId('pick-view');
    expect(views[0]).toHaveClass('primary');
    expect(views[1]).not.toHaveClass('primary');
    expect(primaryButtons()).toHaveLength(1);
  });

  it('does not point at picks that are not there', () => {
    renderToday(<TodayDesk sources={sourcesWith()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByTestId('waiting-empty')).toHaveTextContent(/^Nothing needs you right now\.$/);
  });

  it('while its reads load it shows a loading state, not an empty one and not a count', () => {
    renderToday(<TodayDesk sources={sourcesWith({ queue: loading, board: loading })} check={null} now={NOW} />, { flags: ALL_ON });
    const section = screen.getByTestId('today-waiting');
    expect(section).toHaveAttribute('aria-busy', 'true');
    expect(within(section).getByRole('status')).toHaveTextContent('Checking what is waiting for you…');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Checking what is waiting for you…');
    expect(screen.queryByTestId('waiting-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent(/\d|Nothing/);
  });

  it('a read that failed is said plainly with a retry; what did load still shows', () => {
    const retry = vi.fn();
    renderToday(<TodayDesk sources={sourcesWith({ queue: ready([kit()]), profileMissing: failed(retry) })} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const section = screen.getByTestId('today-waiting');
    expect(cards()).toHaveLength(1);
    expect(within(section).getByText('Part of this list did not load, so there may be more.')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('never says "nothing" when the list could not be read', () => {
    renderToday(<TodayDesk sources={sourcesWith({ resumes: failed(), board: failed() })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("Part of today's list did not load");
    expect(screen.queryByTestId('waiting-empty')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing/)).not.toBeInTheDocument();
  });
});

// ── Job search ──────────────────────────────────────────────────────────────

describe('/today "Job search"', () => {
  it('states the work done in the past tense, from the real count and its date', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const evidence = screen.getByTestId('today-evidence');
    expect(evidence).toHaveTextContent(/^Found 12 new jobs that fit since Nov \d+\.$/);
    expect(evidence).toHaveAttribute('data-known', 'true');
  });

  it('words one, none, a capped count and a count with no date', () => {
    const cases: Array<[{ count: number; since: string | null; capped: boolean }, RegExp]> = [
      [{ count: 1, since: null, capped: false }, /^Found 1 new job that fits since your last visit\.$/],
      [{ count: 0, since: null, capped: false }, /^Found no new jobs that fit since your last visit\.$/],
      [{ count: 0, since: '2026-11-09T08:00:00.000Z', capped: false }, /^Found no new jobs that fit since Nov \d+\.$/],
      [{ count: 400, since: null, capped: true }, /^Found more than 400 new jobs that fit since your last visit\.$/],
    ];
    for (const [newJobs, text] of cases) {
      const view = renderToday(<TodayDesk sources={sourcesWith({ newJobs: ready(newJobs) })} check={null} now={NOW} />, { flags: ALL_ON });
      expect(screen.getByTestId('today-evidence')).toHaveTextContent(text);
      view.unmount();
    }
  });

  it('shows "—" for the count while it loads and when it failed, never 0', () => {
    for (const newJobs of [loading, failed()]) {
      const view = renderToday(<TodayDesk sources={sourcesWith({ newJobs })} check={null} now={NOW} />, { flags: ALL_ON });
      const evidence = screen.getByTestId('today-evidence');
      expect(evidence).toHaveAttribute('data-known', 'false');
      expect(evidence).toHaveTextContent('New jobs that fit since your last visit: —');
      expect(evidence).not.toHaveTextContent(/\d/);
      view.unmount();
    }
  });

  it('each pick leads with the gap, then what lines up, then the job and ONE action', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const rows = screen.getAllByTestId('today-pick');
    expect(rows).toHaveLength(3);
    const row = rows[0]!;
    const text = row.textContent ?? '';
    const order = ["What's missing:", 'What lines up:', 'Good fit', '74 / 100', 'This is not your chance of getting hired.', 'Globex', 'Analytics Engineer', 'Austin, TX', 'Prepare application'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(within(row).getByRole('link', { name: 'Open Analytics Engineer at Globex' })).toHaveAttribute('href', '/jobs/p1');
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).getByRole('group', { name: 'Actions for Analytics Engineer' })).toContainElement(within(row).getByRole('button', { name: 'Prepare application' }));
    expect(screen.getByRole('link', { name: 'See all jobs' })).toHaveAttribute('href', '/jobs');
  });

  // docs/agent-driven/REDESIGN.md §8 scenario 4: a pick at a company the search wants to work at says so, after the gap and the score.
  it('a pick at a company on the list says "On your list of companies", after the gap, the score and the honesty line (R2, C5)', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({ picks: ready([pick('p1', 'Analytics Engineer', { atTargetCompany: true }), pick('p2', 'Data Scientist'), pick('p3', 'Insights Lead', { atTargetCompany: false })]) })}
        check={CHECK_DONE}
        now={NOW}
      />,
      { flags: ALL_ON },
    );
    const [listed, other, notListed] = screen.getAllByTestId('today-pick');
    const note = within(listed!).getByTestId('pick-target');
    expect(note).toHaveTextContent('On your list of companies');
    const text = listed!.textContent ?? '';
    const order = ["What's missing:", '74 / 100', 'This is not your chance of getting hired.', 'On your list of companies', 'Globex', 'Analytics Engineer'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only where the server said so (D3).
    expect(within(other!).queryByTestId('pick-target')).toBeNull();
    expect(within(notListed!).queryByTestId('pick-target')).toBeNull();
    // A note, not a second action: the row keeps its one button.
    expect(within(listed!).getAllByRole('button')).toHaveLength(1);
  });

  it('no pick shows a tier or a score without the honesty line (C5)', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({
          picks: ready([
            pick('ai', 'Analytics Engineer'),
            pick('estimate', 'Data Scientist', { fit: { tier: 'possible', score: 55, kind: 'pre', topGap: null, topOverlap: null } }),
            pick('nofit', 'Insights Lead', { fit: null }),
          ]),
        })}
        check={CHECK_DONE}
        now={NOW}
      />,
      { flags: ALL_ON },
    );
    const [ai, estimate, noFit] = screen.getAllByTestId('today-pick');
    for (const row of [ai!, estimate!]) {
      expect(within(row).getByTestId('pick-fit')).toBeInTheDocument();
      expect(row.querySelector('[data-honesty="fit"]')).toHaveTextContent('This is not your chance of getting hired.');
    }
    // A quick estimate says it is one.
    expect(within(estimate!).getByTestId('fit-estimate-tag')).toHaveTextContent('Quick estimate');
    // No fit known (no resume): no tier, no score, nothing made up, and so no line about one.
    expect(within(noFit!).queryByTestId('pick-fit')).not.toBeInTheDocument();
    expect(noFit!).not.toHaveTextContent(/\/ 100|fit/i);
    expect(noFit!.querySelector('[data-honesty="fit"]')).toBeNull();
    // On the whole page: as many honesty lines as fits shown.
    expect(document.querySelectorAll('[data-honesty="fit"]')).toHaveLength(screen.getAllByTestId('pick-fit').length);
  });

  it('a score the server did not send is "—" with no tier word', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({ picks: ready([pick('odd', 'Analyst', { fit: { tier: 'great', score: Number.NaN, kind: 'ai', topGap: null, topOverlap: null } })]) })}
        check={null}
        now={NOW}
      />,
      { flags: ALL_ON },
    );
    const fit = screen.getByTestId('pick-fit');
    expect(fit).toHaveTextContent('—');
    expect(fit).not.toHaveTextContent(/Great fit|\d/);
  });

  it('GoApply: a pick names where it was published, and one with no named source is not shown', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({
          picks: ready([
            pick('board', 'Analytics Engineer'),
            pick('unnamed', 'Data Scientist', { source: { name: ' ', kind: 'provider' } }),
            pick('own', 'Insights Lead', { source: { name: '', kind: 'user_import' } }),
          ]),
        })}
        check={CHECK_DONE}
        now={NOW}
      />,
      { flags: ALL_ON, brand: 'goapply' },
    );
    const rows = screen.getAllByTestId('today-pick');
    expect(rows.map((r) => r.getAttribute('data-job-id'))).toEqual(['board', 'own']);
    expect(within(rows[0]!).getByTestId('pick-source')).toHaveTextContent('Source: Example Board');
    expect(within(rows[1]!).getByTestId('pick-source')).toHaveTextContent('Added by you');
  });

  it('RoboApply: the row keeps to company · title · location', () => {
    renderToday(<TodayDesk sources={sourcesWith({ picks: ready([pick('p1', 'Analytics Engineer')]) })} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    expect(screen.queryByTestId('pick-source')).not.toBeInTheDocument();
  });

  it('keeps the rows it shows when the picks refresh: nothing vanishes or moves under the reader', () => {
    const view = renderToday(<TodayDesk sources={sourcesWith({ picks: ready([pick('p1', 'Analytics Engineer'), pick('p2', 'Data Scientist'), pick('p3', 'Insights Lead')]) })} check={CHECK_DONE} now={NOW} />, {
      flags: ALL_ON,
    });
    const ids = () => screen.getAllByTestId('today-pick').map((r) => r.getAttribute('data-job-id'));
    expect(ids()).toEqual(['p1', 'p2', 'p3']);

    // A refresh: p1 is on the list now (so no longer a suggestion), p4 is new, and p2's fit was read again.
    const rescored = pick('p2', 'Data Scientist', { fit: { tier: 'great', score: 88, kind: 'ai', topGap: null, topOverlap: null } });
    view.rerender(<TodayDesk sources={sourcesWith({ picks: ready([rescored, pick('p3', 'Insights Lead'), pick('p4', 'Staff Analyst')]) })} check={CHECK_DONE} now={NOW} />);
    expect(ids()).toEqual(['p1', 'p2', 'p3']);
    expect(screen.getAllByTestId('today-pick')[1]).toHaveTextContent('88 / 100');

    // Asked for afresh (the search changed): the new answer is taken as it is.
    view.rerender(<TodayDesk sources={sourcesWith({ picks: loading })} check={CHECK_DONE} now={NOW} />);
    expect(screen.queryByTestId('today-pick')).not.toBeInTheDocument();
    view.rerender(<TodayDesk sources={sourcesWith({ picks: ready([pick('p4', 'Staff Analyst'), pick('p5', 'BI Lead')]) })} check={CHECK_DONE} now={NOW} />);
    expect(ids()).toEqual(['p4', 'p5']);
  });

  it('an empty lane takes the first picks that arrive', () => {
    const view = renderToday(<TodayDesk sources={sourcesWith({ picks: ready([]) })} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByTestId('today-picks-none')).toBeInTheDocument();
    view.rerender(<TodayDesk sources={sourcesWith({ picks: ready([pick('p1', 'Analytics Engineer')]) })} check={CHECK_DONE} now={NOW} />);
    expect(screen.getAllByTestId('today-pick')).toHaveLength(1);
  });

  it('`Prepare application` keeps its cost sheet open when the job leaves the suggestions', async () => {
    // Putting the job on the list makes the server drop it from the suggestions; the sheet that shows the cost
    // lives in the row. If the row went with the refresh, nothing could be confirmed and nothing would be prepared.
    const onList = kit({ id: 'q_p1', jobId: 'p1', state: 'picked' });
    net = installFetch({
      'GET /api/v1/roboapply/credits': () => ok(CREDITS),
      'POST /api/v1/roboapply/agent/queue': () => ok({ items: [onList] }),
      'POST /api/v1/roboapply/agent/queue/q_p1/prepare': () => ok({ credits: [{ bucket: 'ready_kits', cost: 1 }], confirmed: false }),
    });
    const view = renderToday(<TodayDesk sources={sourcesWith({ picks: ready([pick('p1', 'Analytics Engineer'), pick('p2', 'Data Scientist')]) })} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    fireEvent.click(within(screen.getAllByTestId('today-pick')[0]!).getByRole('button', { name: 'Prepare application' }));
    const sheet = await screen.findByRole('dialog', { name: 'Prepare 1 application' });
    expect(net.to('POST', '/api/v1/roboapply/agent/queue')[0]!.body).toEqual({ jobIds: ['p1'], addedVia: 'suggestions' });
    // The cost is on screen before anything is spent; nothing has been confirmed.
    expect(await within(sheet).findByTestId('cost-ready_kits')).toHaveTextContent('Uses 1 application; you have 2 left this week.');
    expect(net.to('POST', '/api/v1/roboapply/agent/queue/q_p1/prepare').map((c) => c.body)).toEqual([{}]);

    // The refreshed suggestions no longer hold p1.
    view.rerender(<TodayDesk sources={sourcesWith({ queue: ready([onList]), picks: ready([pick('p2', 'Data Scientist'), pick('p3', 'Insights Lead')]) })} check={CHECK_DONE} now={NOW} />);
    expect(screen.getByRole('dialog', { name: 'Prepare 1 application' })).toBeInTheDocument();
    expect(screen.getAllByTestId('today-pick').map((r) => r.getAttribute('data-job-id'))).toEqual(['p1', 'p2']);
    expect(within(screen.getByRole('dialog', { name: 'Prepare 1 application' })).getByRole('button', { name: 'Prepare 1 application' })).toBeEnabled();
  });

  it('a pick whose list state the server sent says where it is up front; one not on the list keeps `Prepare application` (REDESIGN §9)', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({
          picks: ready([
            pick('p1', 'Analytics Engineer', { application: { state: 'ready_for_review', trackerEntryId: null } }),
            pick('p2', 'Data Scientist', { application: { state: 'preparing', trackerEntryId: null } }),
            pick('p3', 'Insights Lead', { application: null }),
          ]),
        })}
        check={CHECK_DONE}
        now={NOW}
      />,
      { flags: ALL_ON },
    );
    const [one, two, three] = screen.getAllByTestId('today-pick');
    expect(within(one!).getByRole('link', { name: 'Check and open' })).toHaveAttribute('href', '/ready/p1');
    expect(within(two!).getByRole('link', { name: 'Being prepared' })).toHaveAttribute('href', '/ready/p2');
    expect(within(three!).getByRole('button', { name: 'Prepare application' })).toBeEnabled();
    expect(within(one!).queryByRole('button', { name: 'Prepare application' })).toBeNull();
    // Gap first and the honesty line under every score still hold on such a row (R2, C5).
    expect(within(one!).getByTestId('pick-gap')).toBeInTheDocument();
    expect(within(one!).getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });

  it('says when there is no new pick, when the picks are loading and when they failed', () => {
    const none = renderToday(<TodayDesk sources={sourcesWith()} check={null} now={NOW} />, { flags: ALL_ON });
    expect(screen.getByTestId('today-picks-none')).toHaveTextContent('No new picks right now.');
    none.unmount();

    const busy = renderToday(<TodayDesk sources={sourcesWith({ picks: loading })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(within(screen.getByTestId('today-job-search')).getByRole('status')).toHaveTextContent('Loading picks…');
    expect(screen.queryByTestId('today-picks-none')).not.toBeInTheDocument();
    busy.unmount();

    const retry = vi.fn();
    renderToday(<TodayDesk sources={sourcesWith({ picks: failed(retry) })} check={null} now={NOW} />, { flags: ALL_ON });
    const lane = screen.getByTestId('today-job-search');
    expect(within(lane).getByText('The picks could not be loaded.')).toBeInTheDocument();
    fireEvent.click(within(lane).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    // The other lanes are still there.
    expect(screen.getByTestId('today-applications')).toBeInTheDocument();
    expect(screen.getByTestId('today-resume')).toBeInTheDocument();
  });

  // docs/agent-driven/REDESIGN.md §9: setup is finished before its search; the lane waits for the picks in words.
  it.each(['desk', 'dashboard'] as const)('while the setup search runs (%s), the loading picks say the search is running', (variant) => {
    renderToday(<TodayDesk variant={variant} sources={sourcesWith({ picks: loading, searching: true })} check={null} now={NOW} />, { flags: ALL_ON });
    const status = within(screen.getByTestId('today-job-search')).getByRole('status');
    expect(status).toHaveTextContent('Searching for jobs that fit your answers. The best picks show here when the search is done.');
    expect(status).not.toHaveTextContent('Loading picks…');
    expect(screen.getByTestId('today-picks-searching')).toBeVisible();
    expect(screen.queryByTestId('today-picks-none')).not.toBeInTheDocument();
  });
});

// ── Applications ────────────────────────────────────────────────────────────

describe('/today "Applications"', () => {
  it('shows the real counts, the week’s allowance, the honesty line and the way to the applications', async () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    expect(numberOf('preparing')).toHaveTextContent(/^Being prepared1$/);
    expect(numberOf('waiting')).toHaveTextContent(/^Waiting for you2$/);
    expect(numberOf('sent')).toHaveTextContent(/^Sent this week1$/);
    const lane = screen.getByTestId('today-applications');
    expect(await within(lane).findByText(/2 of 3 applications left this week\./)).toBeInTheDocument();
    expect(lane.querySelector('[data-honesty="you_submit"]')).toHaveTextContent('You submit each application yourself.');
    expect(within(lane).getByRole('link', { name: 'Open applications' })).toHaveAttribute('href', '/applications');
    expect(net.to('GET', '/api/v1/roboapply/credits')).toHaveLength(1);
  });

  it('shows "—" instead of 0 while the numbers load', () => {
    renderToday(<TodayDesk sources={sourcesWith({ queue: loading, board: loading })} check={null} now={NOW} />, { flags: ALL_ON });
    for (const key of ['preparing', 'waiting', 'sent']) {
      const cell = numberOf(key);
      expect(cell.querySelector('dd')).toHaveTextContent(/^—Not loaded$/);
      expect(cell.querySelector('[data-unknown]')).not.toBeNull();
      expect(cell).not.toHaveTextContent(/\d/);
    }
  });

  it('shows 0 once the reads have answered with none', () => {
    renderToday(<TodayDesk sources={sourcesWith()} check={null} now={NOW} />, { flags: ALL_ON });
    for (const key of ['preparing', 'waiting', 'sent']) expect(numberOf(key).querySelector('dd')).toHaveTextContent(/^0$/);
  });

  it('a failed read leaves its own numbers at "—", says so, and keeps the numbers that loaded', () => {
    const retry = vi.fn();
    renderToday(<TodayDesk sources={sourcesWith({ queue: failed(retry), board: ready(board([entry({ dateApplied: daysAgo(0) })])) })} check={null} now={NOW} />, { flags: ALL_ON });
    expect(numberOf('preparing').querySelector('dd')).toHaveTextContent('—');
    expect(numberOf('waiting').querySelector('dd')).toHaveTextContent('—');
    expect(numberOf('sent').querySelector('dd')).toHaveTextContent(/^1$/);
    const lane = screen.getByTestId('today-applications');
    expect(within(lane).getByText('Some of these numbers could not be loaded.')).toBeInTheDocument();
    fireEvent.click(within(lane).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  // "Prepare my weekly list automatically" (docs/agent-driven/REDESIGN.md §9).
  const run = (over: Partial<NonNullable<AutoPrepareView['lastRun']>> = {}): AutoPrepareView['lastRun'] => ({
    at: '2026-11-09T11:00:00.000Z',
    weekKey: '2026-W46',
    started: 3,
    left: 0,
    stoppedBy: null,
    thisWeek: true,
    ...over,
  });
  const laneWith = (autoPrepare: TodaySources['autoPrepare'], variant: 'desk' | 'dashboard' = 'desk') => {
    renderToday(<TodayDesk sources={sourcesWith({ autoPrepare })} check={null} now={NOW} variant={variant} />, { flags: ALL_ON });
    return screen.getByTestId('today-applications');
  };

  it('says when this week’s list was prepared automatically and how many used the allowance (the server’s counts), on the Dashboard too', () => {
    const lane = laneWith(ready(autoPrepareView({ on: true, since: daysAgo(10), lastRun: run({ started: 3, left: 2, stoppedBy: 'ready_kits' }) })), 'dashboard');
    const line = within(lane).getByTestId('auto-prepare-state');
    expect(line).toHaveTextContent(/^This week's list was prepared automatically on .*Nov 9.*: 3 applications used your weekly allowance\./);
    expect(line).toHaveTextContent('2 jobs are left in To prepare because your weekly allowance ran out.');
    // Above the week's allowance it used.
    expect(Boolean(line.compareDocumentPosition(within(lane).getByTestId('kit-allowance')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('on with no run this week says what will happen (an earlier week’s run is not this week’s)', () => {
    expect(within(laneWith(ready(autoPrepareView({ on: true, lastRun: run({ thisWeek: false, weekKey: '2026-W45' }) })))).getByTestId('auto-prepare-state')).toHaveTextContent(
      /^Your weekly list is prepared automatically when jobs are added to it\.$/,
    );
  });

  it('off and not run this week: no line at all', () => {
    expect(within(laneWith(ready(autoPrepareView({ lastRun: run({ thisWeek: false }) })))).queryByTestId('auto-prepare-state')).toBeNull();
  });

  it('while the option loads no line is guessed', () => {
    expect(within(laneWith(loading)).queryByTestId('auto-prepare-state')).toBeNull();
  });

  it('a read that failed draws no line either (the numbers keep their own retry)', () => {
    expect(within(laneWith(failed())).queryByTestId('auto-prepare-state')).toBeNull();
  });
});

// ── Resume ──────────────────────────────────────────────────────────────────

describe('/today "Resume"', () => {
  it('names the main resume, shows its latest check and what jobs ask for', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({
          resumes: ready([resume({ id: 'rv_old', name: 'Older', isPrimary: false }), resume({ id: 'rv_main', name: 'Avery Chen — Product' })]),
          skills: ready([
            { skill: 'SQL', askedIn: 12, outOf: 50 },
            { skill: 'Figma', askedIn: 4, outOf: 50 },
          ]),
        })}
        check={CHECK_DONE}
        now={NOW}
      />,
      { flags: ALL_ON },
    );
    const lane = screen.getByTestId('today-resume');
    expect(within(lane).getByTestId('today-resume-name')).toHaveTextContent('Avery Chen — Product');
    expect(lane).toHaveTextContent('74 of 100 on the checklist');
    expect(within(lane).getByRole('link', { name: 'See the check for Avery Chen — Product' })).toHaveAttribute('href', '/resume/rv_main/check');
    const asked = within(lane).getByTestId('today-asked');
    // The server compares with profile skills, so the line says "your profile".
    expect(asked).toHaveTextContent('Jobs in your search ask for these, and your profile does not list them:');
    expect(within(asked).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['SQL · asked in 12 of 50 jobs', 'Figma · asked in 4 of 50 jobs']);
    expect(within(lane).getByRole('link', { name: 'Improve my resume' })).toHaveAttribute('href', '/resume');
  });

  it('leaves the "ask for" block out when there is nothing to list or it did not load', () => {
    for (const skills of [ready([]), loading, failed(), off]) {
      const view = renderToday(<TodayDesk sources={sourcesWith({ skills })} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
      expect(screen.queryByTestId('today-asked')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('with no resume it says so and offers the way to add one', () => {
    renderToday(<TodayDesk sources={sourcesWith({ resumes: ready([]) })} check={null} now={NOW} />, { flags: ALL_ON });
    const lane = screen.getByTestId('today-resume');
    expect(within(lane).getByTestId('today-resume-none')).toHaveTextContent('No resume yet.');
    expect(within(lane).getByRole('link', { name: 'Add a resume' })).toHaveAttribute('href', '/resume');
    expect(within(lane).queryByRole('link', { name: 'Improve my resume' })).not.toBeInTheDocument();
  });

  it('a failed read says so, with a retry', () => {
    const retry = vi.fn();
    renderToday(<TodayDesk sources={sourcesWith({ resumes: failed(retry) })} check={null} now={NOW} />, { flags: ALL_ON });
    const lane = screen.getByTestId('today-resume');
    expect(within(lane).getByText('Your resumes could not be loaded.')).toBeInTheDocument();
    fireEvent.click(within(lane).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

// ── Ask ─────────────────────────────────────────────────────────────────────

describe('/today "Ask"', () => {
  it('opens the Assistant with the question in its box, and sends nothing itself', () => {
    renderToday(<TodayDesk sources={sourcesWith()} check={null} now={NOW} />, { flags: ALL_ON });
    const input = screen.getByRole('textbox', { name: 'Ask about your job search' });
    const submit = screen.getByRole('button', { name: 'Ask' });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: '  Which of these jobs fits best?  ' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(__assistantRailStore.get()).toMatchObject({ open: true, request: { prompt: 'Which of these jobs fits best?', source: 'other' } });
    expect(input).toHaveValue('');
    expect(net.writes()).toEqual([]);
  });
});

// ── Capabilities ────────────────────────────────────────────────────────────

describe('/today with capabilities off', () => {
  const noAgent = (over = {}) =>
    sourcesWith({
      flags: { ready: true, agent: false, copilot: false, feed: true },
      queue: off,
      autoPrepare: off,
      picksFrom: 'feed',
      picks: ready([pick('p1', 'Analytics Engineer'), pick('p2', 'Data Scientist')]),
      board: ready(board([entry({ id: 'a', dateApplied: daysAgo(0) }), entry({ id: 's1', status: 'bookmarked', dateApplied: null }), entry({ id: 's2', status: 'bookmarked', dateApplied: null })])),
      ...over,
    });

  it('without `agent`: no kit numbers, no allowance, no Prepare button; the tracker’s numbers and a link to each job', () => {
    renderToday(<TodayDesk sources={noAgent()} check={CHECK_DONE} now={NOW} />, { flags: { 'jobs.feed': true } });
    expect(screen.queryByTestId('today-number-preparing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('today-number-waiting')).not.toBeInTheDocument();
    expect(numberOf('saved')).toHaveTextContent(/^Saved2$/);
    expect(numberOf('sent')).toHaveTextContent(/^Sent this week1$/);
    expect(screen.queryByTestId('kit-allowance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-prepare-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prepare-application')).not.toBeInTheDocument();
    const rows = screen.getAllByTestId('today-pick');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'View job' })).toHaveAttribute('href', '/jobs/p1');
    expect(within(rows[0]!).getAllByRole('link')).toHaveLength(1);
    // The honesty line stays wherever a fit shows.
    expect(document.querySelectorAll('[data-honesty="fit"]')).toHaveLength(2);
    // Nothing was asked for the allowance.
    expect(net.calls).toEqual([]);
  });

  it('without `agent` the Applications lane carries no "Agent" tag; the Job search and Resume lanes keep theirs', () => {
    renderToday(<TodayDesk sources={noAgent()} check={CHECK_DONE} now={NOW} />, { flags: { 'jobs.feed': true } });
    expect(within(screen.getByTestId('today-applications')).queryByText('Agent')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('today-job-search')).getByText('Agent')).toBeInTheDocument();
    expect(within(screen.getByTestId('today-resume')).getByText('Agent')).toBeInTheDocument();
  });

  it('without `copilot` there is no Ask', () => {
    renderToday(<TodayDesk sources={noAgent()} check={CHECK_DONE} now={NOW} />, { flags: { 'jobs.feed': true } });
    expect(screen.queryByTestId('today-ask')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('with `copilot` on and `agent` off, Ask is there', () => {
    renderToday(<TodayDesk sources={noAgent({ flags: { ready: true, agent: false, copilot: true, feed: true } })} check={null} now={NOW} />, { flags: { copilot: true, 'jobs.feed': true } });
    expect(screen.getByTestId('today-ask')).toBeInTheDocument();
  });

  it('with no job list at all the lane says so instead of showing picks or a count', () => {
    renderToday(
      <TodayDesk sources={sourcesWith({ flags: { ready: true, agent: false, copilot: false, feed: false }, queue: off, picks: off, picksFrom: null, newJobs: off, skills: off })} check={CHECK_DONE} now={NOW} />,
      { flags: {} },
    );
    expect(screen.getByTestId('today-jobs-off')).toHaveTextContent('The job list is not available on this account.');
    expect(screen.queryByTestId('today-evidence')).not.toBeInTheDocument();
    expect(screen.queryByTestId('today-pick')).not.toBeInTheDocument();
    expect(screen.getByTestId('waiting-empty')).toHaveTextContent(/^Nothing needs you right now\.$/);
  });

  it('while the capabilities are not known yet, no numbers are named and nothing reads 0', () => {
    renderToday(
      <TodayDesk
        sources={sourcesWith({ flags: { ready: false, agent: false, copilot: false, feed: false }, queue: loading, picks: loading, picksFrom: null, newJobs: loading })}
        check={null}
        now={NOW}
      />,
      { flags: {} },
    );
    expect(screen.queryByTestId('today-number-saved')).not.toBeInTheDocument();
    expect(screen.queryByTestId('today-number-preparing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('today-jobs-off')).not.toBeInTheDocument();
    expect(screen.getByTestId('today-applications')).not.toHaveTextContent(/\d/);
  });
});

// ── Structure and wording ───────────────────────────────────────────────────

describe('/today structure and wording', () => {
  it('has one h1 and an h2 per section, in reading order', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Waiting for you', 'Job search', 'Applications', 'Resume', 'Ask']);
    // Each section is named by its heading.
    for (const name of ['Waiting for you', 'Job search', 'Applications', 'Resume', 'Ask']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
  });

  it('never says the product applies or submits, and never speaks in the first person', () => {
    renderToday(<TodayDesk sources={busyDay()} check={CHECK_DONE} now={NOW} />, { flags: ALL_ON });
    const page = screen.getByTestId('today-desk').parentElement!;
    const text = page.textContent ?? '';
    expect(text).not.toMatch(/apply for you|on your behalf|auto[- ]?appl|autopilot|we apply|review queue|pipeline|\bmatch|\bATS\b|unlimited|guarantee/i);
    // "Improve my resume" is the user's own voice on their button; no other first person.
    expect(text.replace('Improve my resume', '')).not.toMatch(/\b(I|I'm|I've|I'll|[Mm]e|[Mm]y|[Ww]e|[Oo]ur|[Uu]s)\b/);
    for (const control of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) {
      expect(control.textContent ?? '').not.toMatch(/\bsubmit\b|apply now/i);
      expect((control.textContent ?? '').trim() || control.getAttribute('aria-label')).toBeTruthy();
    }
  });
});
