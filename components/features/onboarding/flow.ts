// components/features/onboarding/flow.ts — the screen order on the web (WP-30).
//
// Web copy of the server stage machine's order (ONBOARDING_STAGE_ORDER and
// BRANCH_ONLY_STAGES in server/src/features/onboarding/contract.ts); flow.test.ts
// keeps them equal. The server stays the authority: it refuses a step the
// user may not save yet.

import type { BrandId } from '../../../lib/brand/registry.generated';

/** Stages with a screen under /onboarding/<stage>, per brand (both branches). */
export const ONBOARDING_SCREEN_STAGES: Readonly<Record<BrandId, readonly string[]>> = {
  roboapply: ['situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm'],
  goapply: ['consent', 'identity', 'education', 'intent', 'tags', 'resume', 'matching', 'confirm'],
};

/** True when `/onboarding/<step>` is a screen of this brand. */
export function isOnboardingScreen(brandId: BrandId, step: string): boolean {
  return ONBOARDING_SCREEN_STAGES[brandId].includes(step);
}

export const STAGE_ORDER: Readonly<Record<string, number>> = {
  account: 10,
  consent: 15,
  situation: 20,
  identity: 20,
  education: 25,
  basics: 30,
  intent: 30,
  tags: 35,
  goal: 40,
  preferences: 50,
  resume: 60,
  matching: 70,
  confirm: 80,
  tour: 90,
  done: 100,
};

const EXPLORE_ONLY = new Set(['goal', 'preferences']);

export function stageOrder(stage: string): number {
  return STAGE_ORDER[stage] ?? 0;
}

/** Screens shown for a brand and branch, in order. */
export function screensFor(brand: BrandId, branch: string | null): string[] {
  return ONBOARDING_SCREEN_STAGES[brand].filter((s) => brand !== 'roboapply' || !EXPLORE_ONLY.has(s) || branch === 'explore');
}

// ── The start flow (RoboApply, /onboarding/start) ───────────────────────────
//
// Two screens on the web: the resume, then one screen with what the user is
// looking for. It is NOT a server stage, so it is not in
// ONBOARDING_SCREEN_STAGES (that list mirrors the stage machine). The server
// still takes its steps in order; `expressSavePlan` is that order.
//
// Who gets it: a RoboApply user whose stage machine is still at its first
// screen. The stage only moves forward and saving `situation` moves it, so
// "stage is situation" means nothing was saved yet. Everyone else (mid-way,
// GoApply, finished) keeps the screens above.

export const EXPRESS_START_ROUTE = '/onboarding/start';
/** Where the start flow lands when setup is finished. */
export const EXPRESS_LANDING_ROUTE = '/dashboard';
/** Query flag set by "Answer a few more questions instead": show the long screens to a new user. */
export const CLASSIC_FLOW_PARAM = 'classic';
export const CLASSIC_FLOW_ROUTE = `/onboarding/situation?${CLASSIC_FLOW_PARAM}=1`;

interface FlowState {
  brand: BrandId;
  stage: string;
  completed: boolean;
}

/** True for a RoboApply user who has saved no step yet. */
export function startsInExpress(state: FlowState): boolean {
  return state.brand === 'roboapply' && !state.completed && state.stage === 'situation';
}

/** True when the URL carries the user's choice of the long screens. */
export function classicFlowChosen(params: { get(name: string): string | null } | null | undefined): boolean {
  return params?.get(CLASSIC_FLOW_PARAM) === '1';
}

/**
 * Where a long screen (/onboarding/<stage>) sends a user who belongs in the
 * start flow; null = stay. A user who chose the long screens stays.
 */
export function expressRedirect(state: FlowState, classicChosen: boolean): string | null {
  return !classicChosen && startsInExpress(state) ? EXPRESS_START_ROUTE : null;
}

/**
 * The server steps the start flow saves on "Find my jobs", in the stage
 * machine's order. Any timing but "as soon as possible" is the explore branch,
 * whose `goal` and `preferences` steps come before `resume`: the start flow
 * does not ask them, so it saves them as skipped (the server refuses `resume`
 * while one of them is the current stage). `matching` starts the search:
 * setup does not wait for its end, because the server takes RoboApply's
 * `confirm` while the stage is still `matching` (docs/agent-driven/REDESIGN.md
 * §9). `complete` (not a stage with a screen) closes setup after `confirm`.
 */
export function expressSavePlan(timing: string): string[] {
  return [...screensFor('roboapply', timing === 'asap' ? 'urgent' : 'explore'), 'complete'];
}

/**
 * Where the start flow lands once setup is closed: the Dashboard (its Job
 * search lane shows the search until the picks arrive). One exception, kept
 * from the long flow (PRODUCT §4.1 "the carried job"): a user who signed up
 * from a job's page goes back to that job, which is the route POST
 * /onboarding/complete names for them (`/jobs/<id>`). Its other answer, the
 * plain job list, is replaced by Today.
 */
export function expressLanding(nextRoute: string | null | undefined): string {
  return nextRoute && /^\/jobs\/[^/?#]+$/.test(nextRoute) ? nextRoute : EXPRESS_LANDING_ROUTE;
}

/**
 * Where /onboarding sends a user whose setup state is known.
 *
 *   finished                 → the first-value page (`firstValueRoute`, else /jobs)
 *   RoboApply, nothing saved → /onboarding/start (the two-screen flow)
 *   GoApply at stage `tour`  → /onboarding/confirm. Confirm is saved but the
 *                              first-value screen was not finished. The
 *                              server's `nextRoute` at that stage is already
 *                              the first-value page, which can be /campus — a
 *                              page outside the app shell, where nothing would
 *                              ever complete setup. /onboarding/confirm shows
 *                              the first-value screen at this stage and
 *                              completes onboarding when it is closed.
 *   otherwise                → the server's `nextRoute` (RoboApply at `tour`
 *                              goes to /jobs, where the tour cards show).
 */
export function onboardingIndexTarget(state: {
  brand: BrandId;
  stage: string;
  completed: boolean;
  nextRoute: string | null;
  firstValueRoute?: string;
}): string {
  const landing = state.firstValueRoute ?? '/jobs';
  if (state.completed) return landing;
  if (startsInExpress(state)) return EXPRESS_START_ROUTE;
  if (state.brand === 'goapply' && state.stage === 'tour') return '/onboarding/confirm';
  return state.nextRoute ?? landing;
}

/**
 * Where /onboarding/start sends a user it is not for; null = show it.
 *
 *   finished (RoboApply)     → /dashboard
 *   nothing saved (RoboApply) → null
 *   anyone else              → where /onboarding would send them (their
 *                              current long screen; never back here)
 */
export function expressStartExit(state: Parameters<typeof onboardingIndexTarget>[0]): string | null {
  if (state.completed && state.brand === 'roboapply') return EXPRESS_LANDING_ROUTE;
  if (startsInExpress(state)) return null;
  return onboardingIndexTarget(state);
}
