// __tests__/fixtures/jobs — job detail (fictional data).
import type { RequestFixture } from '../types';

export const jobsRequests: RequestFixture[] = [
  { contract: 'jobs/detail', schema: 'MarkAppliedBodySchema', value: { appliedAt: '2026-10-09T12:00:00.000Z' } },
  { contract: 'jobs/detail', schema: 'MarkAppliedBodySchema', value: { appliedAt: 'yesterday' }, valid: false },
  { contract: 'jobs/detail', schema: 'JobIdParamsSchema', value: { id: 'job_fixture_1' } },
];
