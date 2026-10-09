// __tests__/fixtures/jobs — job detail (fictional data).
import type * as D from '../../../lib/api/contracts/jobs/detail';
import type { RequestFixture } from '../types';

export const applyClickResponse = {
  applyUrl: 'https://jobs.example.com/apply/1',
  atsType: 'greenhouse',
  extensionSupported: true,
  trackerEntryId: 'trk_fixture_1',
} satisfies D.ApplyClickResponse;

export const shareResponse = { url: 'https://www.roboapply.io/jobs/job_fixture_1', public: false } satisfies D.ShareResponse;

export const jobsRequests: RequestFixture[] = [
  { contract: 'jobs/detail', schema: 'MarkAppliedBodySchema', value: { appliedAt: '2026-10-09T12:00:00.000Z' } },
  { contract: 'jobs/detail', schema: 'MarkAppliedBodySchema', value: { appliedAt: 'yesterday' }, valid: false },
  { contract: 'jobs/detail', schema: 'JobIdParamsSchema', value: { id: 'job_fixture_1' } },
];
