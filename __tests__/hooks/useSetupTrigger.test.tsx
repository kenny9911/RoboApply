// __tests__/hooks/useSetupTrigger.test.tsx
//
// The first-run trigger matrix. This file is the specification for WHEN the
// setup panel appears, and it is deliberately separate from the /jobs page
// test: the decision is a pure reading of `onboardingState`, and it deserves
// to be provable without a feed, a query client or a panel in the way.
//
// Two things here are load-bearing enough to state out loud:
//
//   1. THE NO-RESUME ROW IGNORES `skippedAt` BUT NOT THE CAP (fix F4). Without
//      a parsed resume the scorer has nothing to compare, so a 7-day snooze
//      cannot apply — but the counter still can, or the user is trapped in a
//      panel that reopens on every visit forever. The original design counted
//      auto-opens inside POST /onboarding/bootstrap, which needs a
//      resumeVariantId the no-resume user does not have; their counter would
//      have stayed at 0 for life.
//
//   2. A TAP IS NOT AN AUTOMATIC SHOWING. Opening the panel from the feed
//      header must never spend one of the two free openings. This hook does not
//      call POST /onboarding/seen itself — SetupPanel does, gated on the `auto`
//      flag returned here — so `auto === false` on a tap IS the guarantee, and
//      it is asserted below. A user who asks for the panel every day would
//      otherwise lock themselves out of the panel they keep asking for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

import {
  decideAutoOpen,
  useSetupTrigger,
  AUTO_OPEN_CAP,
  SKIP_SNOOZE_DAYS,
} from '../../hooks/useSetupTrigger';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

// ─────────────────────────────────────────────────────────────────────────
// The pure decision
// ─────────────────────────────────────────────────────────────────────────

describe('decideAutoOpen', () => {
  it('opens step 1 when there is no resume', () => {
    expect(
      decideAutoOpen({ completed: false, completedSteps: [], autoOpens: 0 }, NOW),
    ).toBe('resume');
  });

  it('opens step 1 for a no-resume user even when they skipped yesterday', () => {
    // The one row of the table that outranks `skippedAt`: with nothing parsed,
    // every score on /jobs is a guess and the product cannot do its job.
    expect(
      decideAutoOpen(
        {
          completed: false,
          completedSteps: [],
          skippedAt: daysAgo(1),
          autoOpens: 0,
        },
        NOW,
      ),
    ).toBe('resume');
  });

  it('opens step 2 — never step 1 — for a user who has a resume but no preferences', () => {
    // The single most common state in the existing user base, and the reason
    // this is described as a one-screen onboarding.
    expect(
      decideAutoOpen(
        { completed: false, completedSteps: ['resume'], autoOpens: 0 },
        NOW,
      ),
    ).toBe('confirm');
  });

  it('stays closed once setup is complete', () => {
    expect(
      decideAutoOpen(
        { completed: true, completedSteps: ['resume', 'preferences'], autoOpens: 0 },
        NOW,
      ),
    ).toBeNull();
  });

  it('stays closed when `completed` is stamped but completedSteps lags behind', () => {
    // preferencesBlob.onboarding.completedAt is the stamp confirm writes; the
    // legacy intentText heuristic can disagree with it. The stamp wins.
    expect(
      decideAutoOpen(
        { completed: true, completedSteps: ['resume'], autoOpens: 0 },
        NOW,
      ),
    ).toBeNull();
  });

  it(`stays closed for ${SKIP_SNOOZE_DAYS} days after a skip`, () => {
    const state = {
      completed: false,
      completedSteps: ['resume' as const],
      skippedAt: daysAgo(SKIP_SNOOZE_DAYS - 1),
      autoOpens: 0,
    };
    expect(decideAutoOpen(state, NOW)).toBeNull();
  });

  it('opens again once the skip window has passed', () => {
    expect(
      decideAutoOpen(
        {
          completed: false,
          completedSteps: ['resume'],
          skippedAt: daysAgo(SKIP_SNOOZE_DAYS + 1),
          autoOpens: 0,
        },
        NOW,
      ),
    ).toBe('confirm');
  });

  it('ignores an unparseable skippedAt rather than treating it as "just now"', () => {
    expect(
      decideAutoOpen(
        {
          completed: false,
          completedSteps: ['resume'],
          skippedAt: 'not-a-date',
          autoOpens: 0,
        },
        NOW,
      ),
    ).toBe('confirm');
  });

  it(`never auto-opens after ${AUTO_OPEN_CAP} showings — including with no resume`, () => {
    // Fix F4. The cap has to reach the no-resume state or it protects everyone
    // except the person most likely to be stuck behind the panel.
    expect(
      decideAutoOpen(
        { completed: false, completedSteps: [], autoOpens: AUTO_OPEN_CAP },
        NOW,
      ),
    ).toBeNull();
    expect(
      decideAutoOpen(
        { completed: false, completedSteps: ['resume'], autoOpens: AUTO_OPEN_CAP },
        NOW,
      ),
    ).toBeNull();
  });

  it('still opens on the second showing', () => {
    expect(
      decideAutoOpen(
        { completed: false, completedSteps: [], autoOpens: AUTO_OPEN_CAP - 1 },
        NOW,
      ),
    ).toBe('resume');
  });

  it('does nothing while /auth/me is still in flight', () => {
    // Flashing a first-run panel at a returning user is worse than opening one
    // beat late, so an unknown state is never an open.
    expect(decideAutoOpen(null, NOW)).toBeNull();
    expect(decideAutoOpen(undefined, NOW)).toBeNull();
  });

  it('treats a missing completedSteps array as "nothing done"', () => {
    // Defensive: an older server build, or a truncated payload, must not read
    // as "fully onboarded" and silently disable setup for that user.
    expect(decideAutoOpen({ completed: false }, NOW)).toBe('resume');
  });

  it('treats a missing autoOpens as zero rather than as "cap reached"', () => {
    expect(decideAutoOpen({ completed: false, completedSteps: [] }, NOW)).toBe(
      'resume',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The hook, and the one side effect it owns
// ─────────────────────────────────────────────────────────────────────────

function Probe() {
  const setup = useSetupTrigger();
  return (
    <div>
      <span data-testid="state">
        {setup.open ? `open:${setup.step}:${setup.auto ? 'auto' : 'tap'}` : 'closed'}
      </span>
      <button type="button" onClick={setup.openSetup}>
        open
      </button>
      <button type="button" onClick={setup.closeSetup}>
        close
      </button>
    </div>
  );
}

describe('useSetupTrigger', () => {
  beforeEach(() => {
    mockAuthState.value = buildAuthValue();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const state = (o: Record<string, unknown>) =>
    buildAuthValue({ onboardingState: o as never });

  it('auto-opens at step 1, flagged auto, and decides only once', async () => {
    mockAuthState.value = state({ completed: false, completedSteps: [], autoOpens: 0 });
    const { rerender } = render(<Probe />);

    await waitFor(() =>
      expect(screen.getByTestId('state').textContent).toBe('open:resume:auto'),
    );

    // Re-renders must not re-decide. /jobs re-renders constantly — every feed
    // refetch, every card expanding — and a per-render decision would both
    // re-open a panel the user closed and (through `auto`) burn both free
    // showings inside a single visit.
    rerender(<Probe />);
    rerender(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('open:resume:auto');
  });

  it('auto-opens at step 2 for a user who already has a resume', async () => {
    mockAuthState.value = state({
      completed: false,
      completedSteps: ['resume'],
      autoOpens: 0,
    });
    render(<Probe />);

    await waitFor(() =>
      expect(screen.getByTestId('state').textContent).toBe('open:confirm:auto'),
    );
  });

  it('stays closed for a completed user', async () => {
    mockAuthState.value = state({
      completed: true,
      completedSteps: ['resume', 'preferences'],
      autoOpens: 0,
    });
    render(<Probe />);

    expect(screen.getByTestId('state').textContent).toBe('closed');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });

  it('opens by tap WITHOUT the auto flag — a tap never spends a free showing', async () => {
    mockAuthState.value = state({
      completed: true,
      completedSteps: ['resume', 'preferences'],
      autoOpens: 0,
    });
    render(<Probe />);

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click();
    });

    expect(screen.getByTestId('state').textContent).toBe('open:confirm:tap');
  });

  it('a tap-opened panel lands on step 1 when there is no resume', async () => {
    // Even when the user asked for the panel, they cannot confirm a reading of
    // a resume that does not exist. And the cap having been spent does not take
    // the panel away — it only stops it opening by itself.
    mockAuthState.value = state({
      completed: false,
      completedSteps: [],
      autoOpens: AUTO_OPEN_CAP,
    });
    render(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('closed');

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click();
    });
    expect(screen.getByTestId('state').textContent).toBe('open:resume:tap');
  });

  it('closing does not re-open it on the next render', async () => {
    mockAuthState.value = state({ completed: false, completedSteps: [], autoOpens: 0 });
    const { rerender } = render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId('state').textContent).toBe('open:resume:auto'),
    );

    await act(async () => {
      screen.getByRole('button', { name: 'close' }).click();
    });
    expect(screen.getByTestId('state').textContent).toBe('closed');

    rerender(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });
});
