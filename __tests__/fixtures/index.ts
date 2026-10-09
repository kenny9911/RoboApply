// __tests__/fixtures/index.ts — every area's request fixtures, for the contract test.
import type { RequestFixture } from './types';
import { agentRequests } from './agent';
import { copilotRequests } from './copilot';
import { creditsRequests } from './credits';
import { feedRequests } from './feed';
import { jobsRequests } from './jobs';
import { notificationsRequests } from './notifications';
import { offersRequests } from './offers';
import { onboardingRequests } from './onboarding';
import { resumeRequests } from './resume';
import { searchProfileRequests } from './search';
import { uiStateRequests } from './uistate';

export type { RequestFixture } from './types';

export const REQUEST_FIXTURES: RequestFixture[] = [
  ...agentRequests,
  ...copilotRequests,
  ...creditsRequests,
  ...feedRequests,
  ...jobsRequests,
  ...notificationsRequests,
  ...offersRequests,
  ...onboardingRequests,
  ...resumeRequests,
  ...searchProfileRequests,
  ...uiStateRequests,
];
