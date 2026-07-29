'use client';

// hooks/useSetupTrigger.ts
//
// WHEN the first-run setup panel opens, and at which step. This is the whole
// trigger — the panel's own two-step state, bootstrap, confirm and skip live in
// hooks/useSetup.ts + components/v3/setup/SetupPanel.tsx. This file answers one
// question and owns one side effect (POST /onboarding/seen).
//
// THE SIGNAL ALREADY SHIPPED. `GET /api/v1/roboapply/auth/me` returns
// `onboardingState { completed, completedSteps[], skippedAt, autoOpens }`,
// derived server-side from a live RAResumeVariant count and
// `preferencesBlob.onboarding` (server/src/roboapply/routes/auth.ts). It has
// had ZERO consumers since the day it was written. This is that consumer.
//
// ─── THE GATE TABLE (ONBOARDING_SPEC §2.1, as amended by fix F4) ──────────
//
//   !completedSteps.includes('resume')             → auto-open STEP 1.
//                                                    Ignores skippedAt: with no
//                                                    parsed resume the scorer
//                                                    has nothing to compare, so
//                                                    a 7-day snooze would leave
//                                                    the product unable to do
//                                                    the only thing it does.
//   has 'resume', !has 'preferences'               → auto-open STEP 2. Step 1
//                                                    never renders. This is the
//                                                    single most common state
//                                                    in the existing user base:
//                                                    a ONE-screen onboarding.
//   completed                                      → closed. Filter-bar tap only.
//   skippedAt within RESTORE/SNOOZE window         → closed, except the
//                                                    no-resume row above.
//   autoOpens >= AUTO_OPEN_CAP                     → never auto-opens again.
//
// ─── FIX F4: THE CAP IS COUNTED ON OPEN, NOT ON BOOTSTRAP ─────────────────
//
// The original design incremented `autoOpens` inside POST /onboarding/bootstrap
// and flagged it `auto: true`. That cannot work: bootstrap requires a
// `resumeVariantId`, and the no-resume user — the exact person the cap protects
// from an unclosable panel — does not have one. Their counter would never move
// and the panel would reopen forever.
//
// So the count is incremented by POST /onboarding/seen on PANEL OPEN, for BOTH
// steps, including the no-resume state, and never on a tap-open: a user who
// asks for the panel has not spent one of their two automatic showings.
//
// WHO CALLS IT. `SetupPanel` does, via `useSetup().markSeen`, gated on the
// `auto` flag THIS hook computes and /jobs passes down. The split is
// deliberate and the invariant is one line long: this hook is the only thing
// that can tell an automatic opening from a tap, and the panel is the only
// thing that knows it actually mounted. Neither should call `seen` twice, so
// exactly one of them calls it at all — and it is not this file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OnboardingStep } from '../lib/api/v2/types';
import { useAuth } from '../lib/auth/AuthProvider';
import type { MeResponse } from '../lib/api/auth';

/** Hard cap on automatic showings. After this the panel is reachable only by
 *  tap, forever. Two is "we asked, and we asked once more"; three is nagging. */
export const AUTO_OPEN_CAP = 2;

/** How long a skip suppresses the auto-open. Mirrors the server's
 *  RESTORE_WINDOW_DAYS so "come back later" means the same number of days in
 *  both directions. */
export const SKIP_SNOOZE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

type OnboardingState = NonNullable<MeResponse['onboardingState']>;

/**
 * The pure decision. Exported so the trigger matrix is unit-testable without a
 * React tree, a query client or a fake clock.
 *
 * @param state `useAuth().onboardingState` — null while /auth/me is in flight.
 * @param now   milliseconds since epoch, injectable for tests.
 * @returns the step to auto-open at, or null for "stay closed".
 */
export function decideAutoOpen(
  state: OnboardingState | null | undefined,
  now: number = Date.now(),
): OnboardingStep | null {
  // Unknown state = do nothing. Flashing a first-run panel at a returning user
  // while /auth/me is still in flight is worse than opening one beat late.
  if (!state) return null;

  const steps = state.completedSteps ?? [];
  const hasResume = steps.includes('resume');
  const hasPreferences = steps.includes('preferences');
  const autoOpens = state.autoOpens ?? 0;

  // The cap applies to EVERY row of the table, including no-resume (fix F4).
  // Paired with the close control on Step 1, this is what guarantees the user
  // is never trapped.
  if (autoOpens >= AUTO_OPEN_CAP) return null;

  // Row 1 — no resume. Opens regardless of skippedAt or `completed`, because
  // without a parsed resume there is nothing to score against and every other
  // screen is degraded. `completedSteps` is authoritative here: the server
  // recomputes it from a LIVE variant count, so deleting every resume flips
  // this back on by itself.
  if (!hasResume) return 'resume';

  // Row 3 — done. `completed` is belt and braces over `hasPreferences`; the
  // server sets it from preferencesBlob.onboarding.completedAt, which can be
  // stamped without the legacy intentText heuristic agreeing.
  if (state.completed || hasPreferences) return null;

  // Row 4 — skipped recently. Only reachable from here, i.e. the user HAS a
  // resume: they told us "not now" and the feed still works, just unfiltered.
  const skippedAt = state.skippedAt ? Date.parse(state.skippedAt) : NaN;
  if (Number.isFinite(skippedAt) && now - skippedAt < SKIP_SNOOZE_DAYS * DAY_MS) {
    return null;
  }

  // Row 2 — has a resume, has not said what they want. One screen.
  return 'confirm';
}

export interface SetupTrigger {
  /** Render the panel? */
  open: boolean;
  /** Which step the panel should show. Meaningless while `open` is false. */
  step: OnboardingStep;
  /** True when this opening was automatic (vs. a feed-header tap). Pass it to
   *  `SetupPanel`: it is what gates POST /onboarding/seen, and therefore the
   *  only reason a tap does not spend one of the user's two free showings. */
  auto: boolean;
  /** Open by tap. Never counts against the cap, and always lands on the step
   *  the user actually needs. */
  openSetup: () => void;
  /** Dismiss without finishing. Does NOT write anything — POST /onboarding/skip
   *  is the panel's call to make, because only it knows there is a session. */
  closeSetup: () => void;
}

/**
 * The /jobs mount hook. Reads the already-threaded auth signal and decides,
 * exactly once per mount. It performs no requests of its own — the one side
 * effect an opening has (POST /onboarding/seen) belongs to SetupPanel and is
 * authorised by the `auto` flag returned here.
 */
export function useSetupTrigger(): SetupTrigger {
  const { onboardingState } = useAuth();

  // `null` = undecided/closed. Set once by the auto-open effect, or by a tap.
  const [openStep, setOpenStep] = useState<OnboardingStep | null>(null);
  const [auto, setAuto] = useState(false);

  // One automatic decision per mount. Without this, a user who closed the panel
  // would have it reopened by the next re-render of /jobs — and /jobs
  // re-renders constantly (every feed refetch, every card expanding). A ref,
  // not state: it must survive React 18 StrictMode's double-invoked effect,
  // which a state flag set inside the effect does not.
  const decided = useRef(false);

  // What the panel would open at if the user tapped for it right now. A user
  // with no resume needs Step 1 even when they asked for the panel themselves.
  const tapStep: OnboardingStep = useMemo(
    () =>
      (onboardingState?.completedSteps ?? []).includes('resume')
        ? 'confirm'
        : 'resume',
    [onboardingState],
  );

  useEffect(() => {
    if (decided.current) return;
    // Wait for /auth/me. `onboardingState` is null while the session loads and
    // for an unauthenticated visitor (AuthGate is already redirecting them).
    if (!onboardingState) return;

    decided.current = true;

    const step = decideAutoOpen(onboardingState);
    if (!step) return;

    // `auto: true` is what authorises the panel to spend one of the two free
    // showings (POST /onboarding/seen). Set it here and nowhere else.
    setOpenStep(step);
    setAuto(true);
  }, [onboardingState]);

  const openSetup = useCallback(() => {
    // A tap is not an automatic showing: no `seen` call, no counter.
    decided.current = true;
    setAuto(false);
    setOpenStep(tapStep);
  }, [tapStep]);

  const closeSetup = useCallback(() => {
    setOpenStep(null);
    setAuto(false);
  }, []);

  return {
    open: openStep !== null,
    step: openStep ?? tapStep,
    auto,
    openSetup,
    closeSetup,
  };
}
