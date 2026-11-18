// __tests__/fixtures/onboarding — stage machine responses (fictional data).
import type { RequestFixture } from '../types';

export const onboardingRequests: RequestFixture[] = [
  { contract: 'onboarding', schema: 'StepParamsSchema', value: { step: 'basics' } },
  { contract: 'onboarding', schema: 'OnboardingResumeBodySchema', value: { resumeVariantId: 'rv_fixture_1' } },
];
