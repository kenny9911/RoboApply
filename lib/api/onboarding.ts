// lib/api/onboarding.ts — Onboarding stage machine (RoboApply O1–O8; GoApply steps via the same /steps route, WP-31).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-30 (filled:
// `getOnboardingState` and `suggestTitles` return WP-30's extended views).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/onboarding/state
//   PUT    /api/v1/roboapply/onboarding/steps/:step
//   GET    /api/v1/roboapply/onboarding/title-suggest
//   GET    /api/v1/roboapply/onboarding/market-snapshot
//   POST   /api/v1/roboapply/onboarding/resume
//   POST   /api/v1/roboapply/onboarding/match
//   POST   /api/v1/roboapply/onboarding/confirm
//   POST   /api/v1/roboapply/onboarding/complete
//   POST   /api/v1/roboapply/onboarding/skip

import { call, type CallOptions, type In, type Items, postStream, seg, type StreamOptions, withQuery } from './contracts/wire';
import type * as O from './contracts/onboarding';

/** `onboarding.state` — GET /api/v1/roboapply/onboarding/state */
export function getOnboardingState(opts?: CallOptions): Promise<O.OnboardingStateView> {
  return call<O.OnboardingStateView>('GET', `/api/v1/roboapply/onboarding/state`, opts);
}

/** `onboarding.step` — PUT /api/v1/roboapply/onboarding/steps/:step */
export function putOnboardingStep(step: string, body: In<typeof O.StepBodySchema> = {}, opts?: CallOptions): Promise<O.StepResponse> {
  return call<O.StepResponse>('PUT', `/api/v1/roboapply/onboarding/steps/${seg(step)}`, { ...opts, body });
}

/** `onboarding.titleSuggest` — GET /api/v1/roboapply/onboarding/title-suggest */
export function suggestTitles(query: In<typeof O.TitleSuggestQuerySchema>, opts?: CallOptions): Promise<Items<O.TitleSuggestionView>> {
  return call<Items<O.TitleSuggestionView>>('GET', withQuery(`/api/v1/roboapply/onboarding/title-suggest`, query), opts);
}

/** `onboarding.marketSnapshot` — GET /api/v1/roboapply/onboarding/market-snapshot */
export function getMarketSnapshot(query: In<typeof O.MarketSnapshotQuerySchema>, opts?: CallOptions): Promise<O.MarketSnapshotResponse> {
  return call<O.MarketSnapshotResponse>('GET', withQuery(`/api/v1/roboapply/onboarding/market-snapshot`, query), opts);
}

/** `onboarding.resume` — POST /api/v1/roboapply/onboarding/resume */
export function submitOnboardingResume(body: In<typeof O.OnboardingResumeBodySchema>, opts?: CallOptions): Promise<O.OnboardingResumeResponse> {
  return call<O.OnboardingResumeResponse>('POST', `/api/v1/roboapply/onboarding/resume`, { ...opts, body });
}

/** `onboarding.match` — POST /api/v1/roboapply/onboarding/match (SSE) */
export function streamOnboardingMatch(opts: StreamOptions<O.OnboardingMatchEvent>): Promise<void> {
  return postStream<O.OnboardingMatchEvent>(`/api/v1/roboapply/onboarding/match`, undefined, opts);
}

/** `onboarding.confirm` — POST /api/v1/roboapply/onboarding/confirm */
export function confirmOnboarding(body: In<typeof O.OnboardingConfirmBodySchema>, opts?: CallOptions): Promise<O.OnboardingStageResponse> {
  return call<O.OnboardingStageResponse>('POST', `/api/v1/roboapply/onboarding/confirm`, { ...opts, body });
}

/** `onboarding.complete` — POST /api/v1/roboapply/onboarding/complete */
export function completeOnboarding(opts?: CallOptions): Promise<O.OnboardingStageResponse> {
  return call<O.OnboardingStageResponse>('POST', `/api/v1/roboapply/onboarding/complete`, opts);
}

/** `onboarding.skip` — POST /api/v1/roboapply/onboarding/skip */
export function skipOnboarding(opts?: CallOptions): Promise<O.OnboardingStageResponse> {
  return call<O.OnboardingStageResponse>('POST', `/api/v1/roboapply/onboarding/skip`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const onboardingApi = {
  getOnboardingState,
  putOnboardingStep,
  suggestTitles,
  getMarketSnapshot,
  submitOnboardingResume,
  streamOnboardingMatch,
  confirmOnboarding,
  completeOnboarding,
  skipOnboarding,
};
