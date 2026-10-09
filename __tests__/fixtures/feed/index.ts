// __tests__/fixtures/feed — feed cards and queries (fictional data).
import type * as F from '../../../lib/api/contracts/feed';
import type { RequestFixture } from '../types';

export const feedItem = {
  jobId: 'job_fixture_1',
  title: 'Frontend Engineer',
  company: { id: 'co_fixture_1', name: 'Example Labs', logoUrl: null },
  location: 'Taipei, Taiwan',
  workModel: 'hybrid',
  employmentType: 'full_time',
  seniority: 'mid',
  pay: null,
  postedAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-09T00:00:00.000Z',
  source: { name: 'Example Board', kind: 'provider' },
  fromRecruiterBank: false,
  employerVerified: false,
  isAgency: false,
  badges: [],
  fit: { tier: 'good', score: 72, kind: 'pre', topGap: 'GraphQL', topOverlap: 'React, TypeScript' },
  tracker: null,
} satisfies F.FeedItem;

export const feedQueryResponse = {
  items: [feedItem],
  cursor: null,
  endOfFeed: true,
  hiddenByTier: 0,
  sessionId: 'sess_fixture_1',
} satisfies F.FeedQueryResponse;

export const feedRequests: RequestFixture[] = [
  { contract: 'feed', schema: 'FeedQueryBodySchema', value: { sort: 'newest', fitTier: 'good' } },
  { contract: 'feed', schema: 'FeedQueryBodySchema', value: { sort: 'loudest' }, valid: false },
  { contract: 'feed', schema: 'HideJobBodySchema', value: { reasonCode: 'wrong_title' } },
  { contract: 'feed', schema: 'ReportJobBodySchema', value: { reason: 'scam', note: 'Asks for a fee.' } },
];
