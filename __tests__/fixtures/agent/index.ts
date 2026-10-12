// __tests__/fixtures/agent — Ready to apply queue (fictional data).
import type * as A from '../../../lib/api/contracts/agent';
import type { RequestFixture } from '../types';

export const queueItem = {
  id: 'q_fixture_1',
  jobId: 'job_fixture_1',
  state: 'ready_for_review',
  weekKey: '2026-W41',
  trackerEntryId: null,
  resumeVariantId: 'rv_fixture_1',
  coverLetterId: null,
  missingFields: [{ key: 'workAuth', label: 'Work authorization' }],
  addedVia: 'weekly',
  openedAt: null,
  userMarkedSubmitted: false,
  updatedAt: '2026-10-09T00:00:00.000Z',
} satisfies A.QueueItemView;

export const openApplicationResponse = {
  applyUrl: 'https://jobs.example.com/apply/1',
  handoff: { jobId: 'job_fixture_1', variantId: 'rv_fixture_1', coverLetterId: null },
  trackerEntryId: 'trk_fixture_1',
} satisfies A.OpenApplicationResponse;

export const agentRequests: RequestFixture[] = [
  { contract: 'agent', schema: 'AddToQueueBodySchema', value: { jobIds: ['job_fixture_1'], addedVia: 'feed' } },
  { contract: 'agent', schema: 'AddToQueueBodySchema', value: { jobIds: [] }, valid: false },
  { contract: 'agent', schema: 'QueueListQuerySchema', value: { state: 'ready_for_review', weekKey: '2026-W41' } },
];
