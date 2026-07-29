// __tests__/pages/jobs.test.tsx
//
// /jobs — destination 1 of 4, "what should I apply to?", and now also the one
// place first-run setup happens. Drives the page through the stub api
// (NEXT_PUBLIC_USE_STUB_API=true) and asserts the pieces that carry a ruling:
// the measured headline, the measured "Updated {time}" sub, the gap-first card,
// the trigger matrix, and the rule that no job is ever hidden for want of a
// score.
//
// This replaced __tests__/pages/home.test.tsx, which tested the same screen at
// its old route. What changed in the assertions, and why:
//   • Route + component: /home → /jobs (ruling D2 — route, nav label, H1 and
//     i18n namespace share one name).
//   • "Why I think this fits" → "Why you fit". Ruling C9 removes every speaker
//     from the product; the old string had an unnamed "I" in the most-read
//     sentence in the app.
//   • "Salary fit" → "Pay" (C6 — the rubric speaks in sentences, not analyst
//     nouns).
//   • The primary action stays "Apply on company site" and stays honest: it
//     opens the posting, nothing is submitted on the user's behalf (R1).
//
// NEW in this wave: `ResumeGate` is deleted. It used to stand in front of this
// screen and replace the whole authenticated shell for anyone with no résumé.
// Setup is now a panel mounted by this page, so the trigger is tested here —
// the decision itself is proved in __tests__/hooks/useSetupTrigger.test.tsx;
// what these cases prove is that the page WIRES it.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';

import JobsPage from '../../app/(auth)/jobs/page';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue } from '../utils/mockAuth';
import type { MeResponse } from '../../lib/api/auth';

// Match the dev default — the stub api selector reads this at module load.
beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

// next/navigation isn't available in JSDOM unit tests; mock the bits we use.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/jobs',
}));

// The page now reads `useAuth().onboardingState`. AuthWrapper does not supply a
// real context (see __tests__/utils/mockAuth.tsx) — the module gets mocked.
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

// The panel itself belongs to components/v3/setup and has its own tests. Here
// it is stubbed down to the one thing this page is responsible for: mounting
// it, at the right step, with a way out.
const setupPanelProps = vi.fn();
vi.mock('../../components/v3/setup', () => ({
  SetupPanel: (props: {
    initialStep: string;
    auto?: boolean;
    resumeVariantId?: string | null;
    onClose: () => void;
    onDone?: () => void;
  }) => {
    setupPanelProps(props);
    return (
      <div role="dialog" aria-modal="true" data-testid="setup-panel">
        <span data-testid="setup-step">{props.initialStep}</span>
        <span data-testid="setup-auto">{props.auto ? 'auto' : 'tap'}</span>
        <button type="button" onClick={props.onClose}>
          close setup
        </button>
      </div>
    );
  },
}));

import { raV2Api } from '../../lib/api/v2';

/** The default: a fully onboarded user, so the panel stays shut and the feed
 *  assertions below are not fighting a dialog. */
const COMPLETED: NonNullable<MeResponse['onboardingState']> = {
  completed: true,
  completedSteps: ['resume', 'preferences'],
  autoOpens: 0,
};

beforeEach(() => {
  setupPanelProps.mockClear();
  mockAuthState.value = buildAuthValue({ onboardingState: { ...COMPLETED } });
});

describe('/jobs', () => {
  it('renders the measured header, updated stamp, and job feed against the stub API', async () => {
    renderWithProviders(<JobsPage />);

    // The h1 + feed header render immediately. While the feed is in flight the
    // headline is uncounted ("Jobs that fit you.") — it never guesses a number
    // it has not measured (rule D9).
    const h1 = screen.getByRole('heading', { level: 1, name: /jobs that fit/i });
    expect(h1).toBeInTheDocument();
    expect(screen.getByText(/Jobs that fit you, best fit first/i)).toBeInTheDocument();

    // Once search.run lands, the headline states the count the feed actually
    // returned. Asserting the shape (not a hardcoded fixture length) still
    // proves the ICU interpolation ran: a missing key would leave the literal
    // "jobs.headline" — next-intl renders the dotted path rather than throwing
    // (C30) — and a broken one would leave a raw "{count}".
    await waitFor(
      () => {
        expect(h1.textContent).toMatch(/^\d+ jobs? that fits? you\.$/);
      },
      { timeout: 4000 },
    );

    // The sub is the query's own dataUpdatedAt, formatted client-side in an
    // effect — so it appears only after the response lands, and it is the only
    // number in the header besides the count. Both are measured (rule D9).
    expect(screen.getByText(/^Updated .+\.$/)).toBeInTheDocument();

    // The feed hydrates from search.run — at least one fixture job title shows
    // up as a card heading.
    await waitFor(
      () => {
        expect(
          screen.getAllByRole('heading', { level: 3 }).length,
        ).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );

    // The first card is auto-expanded → its reasoning + facet strip resolve
    // once jobs.score (very_slow stub) lands. Both strings are the post-ruling
    // vocabulary: no speaker, no analyst noun.
    await waitFor(
      () => {
        expect(screen.getByText('Why you fit')).toBeInTheDocument();
        expect(screen.getByText('Pay')).toBeInTheDocument();
      },
      { timeout: 6000 },
    );

    // Exactly one card is expanded → exactly one apply action (also guards the
    // accordion + valid ARIA: the card header is the toggle, not a button
    // wrapping the nested action buttons). getByRole throws on >1 match.
    expect(
      screen.getByRole('button', { name: /Apply on company site/i }),
    ).toBeInTheDocument();

    // Ruling C7: "Pass" is a guaranteed mistranslation in the exact spot where
    // a wrong tap deletes a job, so the dismiss action names the outcome.
    expect(
      screen.getByRole('button', { name: /Not interested/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pass$/i })).toBeNull();
  });

  it('leads with the gap and never lets the score stand alone', async () => {
    const { container } = renderWithProviders(<JobsPage />);

    // ── The gap leads (ruling R2) ──
    // The scorer returns explanation.gaps as an array, so the first one is a
    // sentence on the card face — not buried in the expanded rationale, and
    // not a caveat under the score. This is the one thing on the card a
    // competitor funded by employers will never ship, so its position is the
    // product decision, and a regression here is silent otherwise.
    await waitFor(
      () => {
        expect(container.querySelector('.match-gap')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    // Anchor on the gap itself, not on "the first card": every card scores
    // independently (useJobScore is lazy per row) and the stub deliberately
    // makes jobs.score slow, so the first card in DOM order is not necessarily
    // the first one to resolve.
    const gap = container.querySelector('.match-gap')!;
    const card = gap.closest('.match')!;
    const overlap = card.querySelector('.match-overlap');
    expect(gap.textContent?.trim()).toBeTruthy();

    // Order matters, not just presence: gap above overlap. DOCUMENT_POSITION_
    // FOLLOWING means `overlap` comes after `gap` in document order.
    if (overlap) {
      expect(
        gap.compareDocumentPosition(overlap) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    // ── The score is never the primary element (ruling C5) ──
    // The tier word carries the quality signal; the number is secondary. The
    // 56px donut that used to own this slot is gone.
    expect(container.querySelector('.score-donut')).toBeNull();
    const fit = card.querySelector('.match-fit');
    expect(fit).not.toBeNull();
    const tierWord = fit?.querySelector('.tier')?.textContent?.trim() ?? '';
    expect(tierWord).toMatch(/^(Great fit|Good fit|Possible|Unlikely)$/);

    // The number renders as "N / 100", never as a bare integer — a naked 0-100
    // beside a job reads as a percentage chance of getting it.
    const num = fit?.querySelector('.num')?.textContent?.trim() ?? '';
    expect(num).toMatch(/^\d+ \/ 100$/);

    // ── The disclaimer is required, not an FAQ entry (ruling C5) ──
    expect(
      screen.getByText('This is not your chance of getting hired.'),
    ).toBeInTheDocument();

    // ── The rubric is published in sentences, not analyst nouns (C6) ──
    expect(screen.getByText(/The skills they ask for — 30/)).toBeInTheDocument();
    expect(screen.queryByText(/trajectory|domain weight|logistics/i)).toBeNull();

    // ── Missing keywords are always labelled (C17) ──
    // A bare chip cluster reads as FEATURES, which is the exact inverse of
    // what these are. If chips render, the label renders with them.
    if (card.querySelector('.gap-chip')) {
      expect(
        screen.getByText(/They ask for these and your resume doesn't mention them:/),
      ).toBeInTheDocument();
    }

    // The tier word appears once per card, not twice — it has its own slot, so
    // deriveTags' tier tag is filtered out of the tag row.
    const tierMentions = Array.from(card.querySelectorAll('.tag')).filter(
      (el) => /^(Great fit|Good fit|Possible|Unlikely)$/.test(el.textContent?.trim() ?? ''),
    );
    expect(tierMentions).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F1 — an unscored row is still a job
// ─────────────────────────────────────────────────────────────────────────

describe('/jobs — unscored rows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every row the server returned while no score has resolved', async () => {
    // THE BUG THIS EXISTS TO PREVENT, stated plainly: `matchScoreCached` is
    // derived from RAJobMatchScore rows, and a brand-new account has none. If
    // the feed rendered "scored rows, stopping at the score floor", the user
    // who has just finished setup — the one person the whole flow exists to
    // serve — would arrive at an EMPTY screen. There is no score floor in
    // MatchFeed, and this case is what says so out loud.
    //
    // The account is forced into that shape rather than assumed into it: the
    // feed is stripped of every `matchScoreCached` (the server has no
    // RAJobMatchScore rows to derive them from) and `jobs.score` is pinned to
    // "never resolves". Nothing here can be rescued by a fast stub or by scores
    // an earlier test in this file warmed into the shared stub store.
    const realRun = raV2Api.search.run.bind(raV2Api.search);
    vi.spyOn(raV2Api.search, 'run').mockImplementation(async (params) => {
      const res = await realRun(params);
      return { ...res, jobs: res.jobs.map((j) => ({ ...j, matchScoreCached: null })) };
    });
    vi.spyOn(raV2Api.jobs, 'score').mockImplementation(
      () => new Promise(() => {}) as never,
    );

    const { container } = renderWithProviders(<JobsPage />);

    // The measured headline is the count the SERVER returned...
    const h1 = screen.getByRole('heading', { level: 1, name: /jobs that fit/i });
    await waitFor(
      () => expect(h1.textContent).toMatch(/^\d+ jobs? that fits? you\.$/),
      { timeout: 4000 },
    );
    const claimed = Number(h1.textContent!.match(/^(\d+)/)![1]);
    expect(claimed).toBeGreaterThan(0);

    // ...and the feed renders exactly that many cards, with not one score
    // between them. A count mismatch here is the floor sneaking back in.
    await waitFor(
      () => {
        expect(container.querySelectorAll('.matches .match').length).toBe(claimed);
      },
      { timeout: 4000 },
    );
    expect(container.querySelectorAll('.match-fit').length).toBe(0);

    // Not a skeleton, not a placeholder: real titles the user can act on.
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBe(claimed);

    // And the empty state is nowhere near this screen.
    expect(screen.queryByText(/No jobs fit you yet/i)).toBeNull();
  });

  it('re-sorts into score order as the scores land, having shown the list first', async () => {
    // The other half of the rule: nothing is hidden while it is unscored, and
    // the header's promise ("best fit first") is still kept — the list simply
    // arrives in retrieval order and converges. Order is not cosmetic here; the
    // first card is the one that auto-expands and the one most people read.
    let served: { id: string; title: string }[] = [];
    const wanted = [40, 90, 65]; // deliberately NOT the order served

    const realRun = raV2Api.search.run.bind(raV2Api.search);
    vi.spyOn(raV2Api.search, 'run').mockImplementation(async (params) => {
      const res = await realRun(params);
      const jobs = res.jobs.slice(0, 3).map((j) => ({ ...j, matchScoreCached: null }));
      served = jobs.map((j) => ({ id: j.id, title: j.title }));
      return { ...res, jobs };
    });

    // Scoring is held behind a gate the test opens, so "the list rendered
    // before any score existed" is a fact this case establishes rather than a
    // race it happens to win against the stub's latency profile.
    let releaseScores = () => {};
    const scoresReleased = new Promise<void>((resolve) => {
      releaseScores = resolve;
    });
    const realScore = raV2Api.jobs.score.bind(raV2Api.jobs);
    vi.spyOn(raV2Api.jobs, 'score').mockImplementation(async (id, body) => {
      await scoresReleased;
      const res = await realScore(id, body);
      const idx = served.findIndex((j) => j.id === id);
      return {
        ...res,
        matchScore: { ...res.matchScore, score: wanted[idx] ?? 50 },
      };
    });

    const { container } = renderWithProviders(<JobsPage />);

    const titles = () =>
      Array.from(container.querySelectorAll('.matches .match h3')).map((el) =>
        el.textContent?.trim(),
      );

    // Retrieval order, immediately, before a single score exists.
    await waitFor(() => expect(titles()).toHaveLength(3), { timeout: 4000 });
    expect(new Set(served.map((j) => j.title)).size).toBe(3); // titles disambiguate
    expect(titles()).toEqual(served.map((j) => j.title));
    expect(container.querySelectorAll('.match-fit').length).toBe(0);

    // …then score order, without the list ever having been empty or short.
    await act(async () => {
      releaseScores();
    });
    await waitFor(
      () => {
        expect(titles()).toEqual([served[1]!.title, served[2]!.title, served[0]!.title]);
      },
      { timeout: 8000 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The first-run trigger
// ─────────────────────────────────────────────────────────────────────────

describe('/jobs — first-run setup trigger', () => {
  const withState = (o: Record<string, unknown>) => {
    mockAuthState.value = buildAuthValue({ onboardingState: o as never });
  };

  it('auto-opens the panel at step 1 when the user has no resume', async () => {
    withState({ completed: false, completedSteps: [], autoOpens: 0 });
    renderWithProviders(<JobsPage />);

    await waitFor(() =>
      expect(screen.getByTestId('setup-panel')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('setup-step').textContent).toBe('resume');
    // `auto` is what authorises the panel to spend one of the two free
    // showings (POST /onboarding/seen). It must be true here and only here.
    expect(screen.getByTestId('setup-auto').textContent).toBe('auto');
  });

  it('auto-opens at step 2 for a user with a resume and no preferences — step 1 never renders', async () => {
    // The most common state in the existing user base: a ONE-screen onboarding.
    withState({ completed: false, completedSteps: ['resume'], autoOpens: 0 });
    renderWithProviders(<JobsPage />);

    await waitFor(() =>
      expect(screen.getByTestId('setup-panel')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('setup-step').textContent).toBe('confirm');
    // Every render of the panel this page performed started at 'confirm'.
    for (const call of setupPanelProps.mock.calls) {
      expect(call[0].initialStep).toBe('confirm');
    }
  });

  it('stays closed for a completed user, and for a recent skip, and after two auto-opens', async () => {
    withState({ ...COMPLETED });
    const done = renderWithProviders(<JobsPage />);
    expect(screen.queryByTestId('setup-panel')).toBeNull();
    done.unmount();

    withState({
      completed: false,
      completedSteps: ['resume'],
      skippedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      autoOpens: 0,
    });
    const skipped = renderWithProviders(<JobsPage />);
    expect(screen.queryByTestId('setup-panel')).toBeNull();
    skipped.unmount();

    // The cap reaches the no-resume state too (fix F4) — otherwise the panel
    // reopens forever for exactly the people it can trap.
    withState({ completed: false, completedSteps: [], autoOpens: 2 });
    renderWithProviders(<JobsPage />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('setup-panel')).toBeNull();
  });

  it('leaves the rest of the screen mounted behind the panel, and closes without a reload', async () => {
    // "ResumeGate as a wall dies": the panel is a layer over a working screen.
    // The header and the feed keep rendering, so closing the panel drops the
    // user onto real jobs rather than onto whatever the gate replaced.
    withState({ completed: false, completedSteps: [], autoOpens: 0 });
    renderWithProviders(<JobsPage />);

    await waitFor(() =>
      expect(screen.getByTestId('setup-panel')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('heading', { level: 1, name: /jobs that fit/i }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0),
      { timeout: 4000 },
    );

    await act(async () => {
      screen.getByRole('button', { name: 'close setup' }).click();
    });
    expect(screen.queryByTestId('setup-panel')).toBeNull();
    // Still on /jobs, still holding a list of jobs.
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  });

  it('opens on tap from the feed header for a user who already finished setup', async () => {
    // The button in this slot used to be labelled "Filter" and had no onClick
    // at all — the first control a curious first-run user reaches, wired to
    // nothing. It is now the only entry point to setup (ruling C21).
    withState({ ...COMPLETED });
    const { container } = renderWithProviders(<JobsPage />);
    expect(screen.queryByTestId('setup-panel')).toBeNull();

    // Scoped to the feed header: the empty state offers the same action under
    // the same name, which is the point of C21 and the reason a bare
    // getByRole would be ambiguous here.
    const head = container.querySelector('.matches-head') as HTMLElement;
    const cta = within(head).getByRole('button', {
      name: /Tell us what you're looking for/i,
    });
    await act(async () => {
      cta.click();
    });

    // `waitFor`, not a bare assertion: a step-2 opening is held until the
    // resume variant resolves, so the panel appears on the query's beat.
    await waitFor(() =>
      expect(screen.getByTestId('setup-panel')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('setup-step').textContent).toBe('confirm');
    // A tap is not an automatic showing: `auto` false, so the panel does not
    // report it and the user's two free openings are untouched.
    expect(screen.getByTestId('setup-auto').textContent).toBe('tap');
  });

  it('never mounts the step 2 panel before the resume variant is known', async () => {
    // Opening straight at step 2 means confirming a reading of a SPECIFIC
    // resume, and SetupPanel resolves its session once, in a mount effect. Hand
    // it a null variant and it falls back to step 1 — which is the one thing
    // this state must never do, since "has a resume, no preferences" is the
    // one-screen onboarding. The variant arrives from a separate query, so the
    // panel is held until it lands: EVERY mount, not just the last, carries it.
    withState({ completed: false, completedSteps: ['resume'], autoOpens: 0 });
    renderWithProviders(<JobsPage />);

    await waitFor(() =>
      expect(screen.getByTestId('setup-panel')).toBeInTheDocument(),
    );
    expect(setupPanelProps.mock.calls.length).toBeGreaterThan(0);
    for (const [props] of setupPanelProps.mock.calls) {
      expect(props.initialStep).toBe('confirm');
      expect(typeof props.resumeVariantId).toBe('string');
      expect(props.resumeVariantId).toBeTruthy();
    }
  });
});
