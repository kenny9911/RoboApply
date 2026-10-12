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

// ── The listing contract (parity plan §5: "source line and apply target") ──
//
// A feed item and a job detail expose `apply: { url, target }` and
// `source: { name, original, url, lastVerifiedAt, via }`; the feed response
// carries `sources: { gohire, employerBoards }` and `thin`. The fixtures below
// are typed as the contract's additions on top of the item, so they are valid
// both before and after the server contract names those fields.

/** The contract's additions to a feed item. */
export interface ListingContractFields {
  apply: { url: string; target: 'gohire' | 'employer' };
  source: F.FeedItem['source'] & { original: string; url: string; lastVerifiedAt: string; via: 'bank' | 'ats' | 'import' };
}
export type FeedItemWithListing = Omit<F.FeedItem, 'source'> & ListingContractFields;

/** GoApply: a mainland posting read from an employer's careers board. No pay stated. */
export const feedItemCnBoard: FeedItemWithListing = {
  ...feedItemCnRecency,
  jobId: 'job_fixture_cn_board_1',
  title: '数据分析师',
  company: { id: 'co_fixture_cn_1', name: '示例科技有限公司', logoUrl: null },
  location: '上海',
  pay: null,
  fromRecruiterBank: false,
  lastSeenAt: '2026-10-11T02:00:00.000Z',
  source: {
    name: 'SmartRecruiters',
    kind: 'ats_public',
    original: '示例科技有限公司',
    url: 'https://jobs.smartrecruiters.com/ExampleTech/744000012345678',
    lastVerifiedAt: '2026-10-11T02:00:00.000Z',
    via: 'ats',
  },
  apply: { url: 'https://careers.example-tech.cn/jobs/744000012345678', target: 'employer' },
  cardMeta: {
    cn: {
      sourceLine: { kind: 'source', sourceName: 'SmartRecruiters', originalSourceName: null, licence: null },
      salary: { text: null, disclosed: false },
      updatedAt: '2026-10-09T00:00:00.000Z',
      lastCheckedAt: '2026-10-11T02:00:00.000Z',
      expiresAt: null,
      tags: [],
      classYears: [],
      warnings: [],
    },
  },
};

/** GoApply: a recruiter-bank row (listed only once the bank has a candidate-facing posting page). */
export const feedItemCnBank: FeedItemWithListing = {
  ...feedItemCnRecency,
  jobId: 'job_fixture_cn_bank_1',
  fromRecruiterBank: true,
  source: {
    name: 'GoHire',
    kind: 'bank',
    original: 'GoHire',
    url: 'https://www.gohire.top/postings/9001',
    lastVerifiedAt: '2026-10-10T08:00:00.000Z',
    via: 'bank',
  },
  apply: { url: 'https://www.gohire.top/postings/9001', target: 'gohire' },
};

/** GoApply feed response: employer-board rows only, and a thin result set. */
export const feedResponseCnBoards = {
  items: [feedItemCnBoard],
  cursor: null,
  endOfFeed: true,
  hiddenByTier: 0,
  sessionId: 'sess_fixture_cn_1',
  order: 'recency' as const,
  sort: 'newest' as const,
  sources: { gohire: false, employerBoards: 27 },
  thin: true,
};

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
