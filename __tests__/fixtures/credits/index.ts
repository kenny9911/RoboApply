// __tests__/fixtures/credits — a Free-plan credit summary (fictional user).
import type * as C from '../../../lib/api/contracts/credits';
import type { RequestFixture } from '../types';

type Summary = C.CreditsResponse['summary'];
type Bucket = Summary['buckets'][keyof Summary['buckets']];

const day = (cap: number, used: number): Bucket => ({
  cap,
  window: 'day',
  used,
  remaining: Math.max(0, cap - used),
  grantRemaining: 0,
  resetsAt: '2026-10-11T00:00:00.000Z',
});

export const freeSummary = {
  planKey: 'free',
  planProfile: 'free',
  legacyPlan: false,
  interval: null,
  periodEnd: null,
  timezone: 'Asia/Taipei',
  upgradable: true,
  buckets: {
    fit_analysis: day(3, 1),
    tailor: day(2, 2),
    cover_letter: day(1, 0),
    resume_check: day(2, 0),
    rewrite: day(5, 0),
    outreach: day(2, 0),
    assistant: day(10, 3),
    autofill: day(5, 0),
    ai_answer: day(5, 0),
    job_import: day(5, 0),
    ready_kits: { ...day(3, 0), window: 'week' },
    competitiveness: { ...day(1, 0), window: 'week' },
    contact_lookup: day(0, 0),
  },
  entitlements: { saved_searches: 1, instant_alerts: 1, competitivenessFull: false },
} satisfies Summary;

export const creditsResponse = { summary: freeSummary, practice: { balance: 1 } } satisfies C.CreditsResponse;

export const creditsRequests: RequestFixture[] = [{ contract: 'credits', schema: 'CreditHistoryQuerySchema', value: {} }];
