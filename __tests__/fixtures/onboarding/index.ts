// __tests__/fixtures/onboarding — stage machine responses (fictional data).
import type * as O from '../../../lib/api/contracts/onboarding';
import type { RequestFixture } from '../types';

export const stepResponse = { stage: 'basics', nextStage: 'resume', nextRoute: '/onboarding/resume' } satisfies O.StepResponse;

export const onboardingRequests: RequestFixture[] = [
  { contract: 'onboarding', schema: 'StepParamsSchema', value: { step: 'basics' } },
  { contract: 'onboarding', schema: 'OnboardingResumeBodySchema', value: { resumeVariantId: 'rv_fixture_1' } },
];
