// __tests__/fixtures/agent — Ready to apply queue (fictional data).
import type { RequestFixture } from '../types';

export const agentRequests: RequestFixture[] = [
  { contract: 'agent', schema: 'AddToQueueBodySchema', value: { jobIds: ['job_fixture_1'], addedVia: 'feed' } },
  { contract: 'agent', schema: 'AddToQueueBodySchema', value: { jobIds: [] }, valid: false },
  { contract: 'agent', schema: 'QueueListQuerySchema', value: { state: 'ready_for_review', weekKey: '2026-W41' } },
  { contract: 'agent', schema: 'PutAutoPrepareBodySchema', value: { on: true } },
  { contract: 'agent', schema: 'PutAutoPrepareBodySchema', value: { on: 'yes' }, valid: false },
  { contract: 'agent', schema: 'PutAutoPrepareBodySchema', value: {}, valid: false },
];
