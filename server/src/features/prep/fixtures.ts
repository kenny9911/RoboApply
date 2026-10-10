// server/src/features/prep/fixtures.ts — a PrepService over the in-memory
// store with controllable AI, limits and jobs (tests only; no database, no model).

import { HttpError } from '../../platform/http.js';
import type { QuestionGuide } from './contract.js';
import type { GeneratedQuestion, GuideInput, QuestionSetInput } from './agents.js';
import { createMemoryJobSetIndex } from './jobSetIndex.js';
import { createMemoryPrepStore, type MemoryPrepStore } from './memoryStore.js';
import { PrepService, type BudgetKind, type PrepJob } from './service.js';

export const FIXTURE_USER = 'user_prep_1';
export const FIXTURE_ADMIN = 'admin_prep_1';

export const SAMPLE_SET: GeneratedQuestion[] = [
  { title: 'Owning database performance', body: 'Tell me about a time you made a slow query faster. What did you measure first?', category: 'behavioral', difficulty: 'medium' },
  { title: 'Designing a read path', body: 'How would you design the read path for a feed that serves 10,000 requests per second?', category: 'system_design', difficulty: 'hard' },
  { title: 'Was asked at Acme', body: 'This question was commonly asked at Acme: why do you want to join?', category: 'behavioral', difficulty: 'easy' },
];

export const SAMPLE_GUIDE: QuestionGuide = {
  approach: 'Pick one concrete example, say what you measured, what you changed and the result.',
  whatTheyTest: ['Debugging method'],
  commonMistakes: ['Talking only about tools'],
  rubric: ['States the baseline and the result'],
  followUps: ['What would you do differently?'],
};

export interface PrepFixture {
  service: PrepService;
  store: MemoryPrepStore;
  calls: { set: QuestionSetInput[]; guide: GuideInput[]; budget: Array<{ kind: BudgetKind; userId: string }> };
  state: { ai: boolean; market: 'intl' | 'cn'; budgetLeft: Partial<Record<BudgetKind, number>>; now: Date };
  jobs: Map<string, PrepJob>;
}

export function createPrepFixture(options: { set?: GeneratedQuestion[]; guide?: QuestionGuide | null } = {}): PrepFixture {
  const state: PrepFixture['state'] = { ai: true, market: 'intl', budgetLeft: {}, now: new Date('2026-10-10T12:00:00Z') };
  const store = createMemoryPrepStore(() => state.now);
  const calls: PrepFixture['calls'] = { set: [], guide: [], budget: [] };
  const jobs = new Map<string, PrepJob>([
    ['job_1', { id: 'job_1', title: 'Backend Engineer', companyName: 'Acme', companyId: 'co_acme', companySlug: 'acme', text: 'You will own database performance for our feed.' }],
    ['job_2', { id: 'job_2', title: 'Analyst', companyName: 'Nameless Ltd', companyId: null, companySlug: null, text: 'Build weekly reports.' }],
  ]);
  const service = new PrepService({
    store,
    jobSets: createMemoryJobSetIndex(),
    market: () => state.market,
    now: () => state.now,
    aiAvailable: async () => state.ai,
    budget: async (kind, userId) => {
      calls.budget.push({ kind, userId });
      const left = state.budgetLeft[kind];
      if (left === undefined) return { allowed: true, retryAfterSec: 0 };
      state.budgetLeft[kind] = left - 1;
      return left > 0 ? { allowed: true, retryAfterSec: 0 } : { allowed: false, retryAfterSec: 3600 };
    },
    loadJob: async (_userId, jobId) => {
      const job = jobs.get(jobId);
      if (!job) throw new HttpError('not_found');
      return job;
    },
    normalizeCompany: (name) => name.trim().toLowerCase().replace(/\s+(inc|ltd|llc)\.?$/, '').trim(),
    generateSet: async (input) => {
      calls.set.push(input);
      return structuredClone(options.set ?? SAMPLE_SET);
    },
    generateGuide: async (input) => {
      calls.guide.push(input);
      return options.guide === undefined ? structuredClone(SAMPLE_GUIDE) : options.guide;
    },
    modelId: () => 'test-model',
  });
  return { service, store, calls, state, jobs };
}
