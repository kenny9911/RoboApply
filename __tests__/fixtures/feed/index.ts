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
  // Market card lines from marketHooks.cardMeta(): a Taiwan posting whose pay is 面議 (not listed).
  cardMeta: {
    ats_public: {
      country: 'TW',
      pay: { text: '待遇面議', posted: '待遇面議', disclosed: false, negotiable: true },
      permitTags: [],
      source: { name: 'Example Labs · Greenhouse', url: 'https://boards.example.com/example-labs/jobs/1', board: 'greenhouse' },
    },
  },
  // "Why this job" (explainMatch): message keys under legal.explain.*, never a hiring chance.
  explanation: {
    mode: 'personalized',
    headline: { key: 'legal.explain.headline.personalized', params: { tier: 'good' } },
    reasons: [{ key: 'legal.explain.reason.skillsAligned', params: { skills: 'React, TypeScript' } }],
    gaps: [{ key: 'legal.explain.gap.skillsMissing', params: { skills: 'GraphQL' } }],
    notices: [{ key: 'legal.explain.notice.notHiringChance' }, { key: 'legal.explain.notice.quickEstimate' }, { key: 'legal.explain.notice.factors' }],
  },
} satisfies F.FeedItem;

/** A GoApply card in a list ordered by date (个性化推荐 off or not chosen): no fit, and the card says why. */
export const feedItemCnRecency = {
  ...feedItem,
  jobId: 'job_fixture_cn_1',
  title: '后端开发工程师',
  company: { id: 'co_fixture_cn_1', name: '示例科技有限公司', logoUrl: null },
  location: '上海',
  source: { name: 'GoHire', kind: 'bank' },
  fit: null,
  cardMeta: {
    cn: {
      sourceLine: { kind: 'source', sourceName: 'GoHire', originalSourceName: null, licence: null },
      salary: { text: null, disclosed: false },
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastCheckedAt: '2026-10-09T00:00:00.000Z',
      expiresAt: null,
      tags: [],
      classYears: [],
      warnings: [],
    },
  },
  explanation: {
    mode: 'non_personalized',
    headline: { key: 'legal.explain.headline.nonPersonalized' },
    reasons: [],
    gaps: [],
    notices: [{ key: 'legal.explain.notice.factorsNone' }, { key: 'legal.explain.notice.turnOn' }],
  },
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
  // Explore → a category: overrides.taxonomyIds with no searchProfileId is a browse.
  { contract: 'feed', schema: 'FeedQueryBodySchema', value: { sort: 'recommended', overrides: { taxonomyIds: ['software_engineering'] } } },
  { contract: 'feed', schema: 'HideJobBodySchema', value: { reasonCode: 'wrong_title' } },
  { contract: 'feed', schema: 'ReportJobBodySchema', value: { reason: 'scam', note: 'Asks for a fee.' } },
];
