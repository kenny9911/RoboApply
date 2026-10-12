// Interview-prep fixtures for the /practice setup tests: what the prep routes
// answer (lib/api/interviewEngine.ts `prepApi`) — the industry list, an
// industry's roles, a job search, and the interview plan.
//
// The plan is written for a backend role: two generated interviewers that
// borrow the catalog personas `kai` and `maya` (their `baseId`), and three
// focuses on the catalog formats `system`, `behavioral` and `technical`. The
// plan recommends Dana Okafor on "Payments system design", so a test that
// lands on Leo Martins or "Ownership stories" proves a choice (or a restored
// preference) won over the recommendation.

import type {
  PrepCompanyStyle,
  PrepFocus,
  PrepIndustry,
  PrepInterviewer,
  PrepPlan,
  PrepPosting,
  PrepRoleSuggestion,
  PrepSearchResult,
} from '../../lib/api/interviewEngine';

export function prepInterviewer(overrides: Partial<PrepInterviewer> & Pick<PrepInterviewer, 'key' | 'name' | 'baseId'>): PrepInterviewer {
  return {
    title: 'Interviewer',
    background: '',
    style: '',
    archetype: 'depth',
    difficulty: 2,
    voiceGender: 'female',
    focusKeys: [],
    patterns: [],
    ...overrides,
  };
}

export function prepFocus(overrides: Partial<PrepFocus> & Pick<PrepFocus, 'key' | 'label' | 'format'>): PrepFocus {
  return { description: '', patterns: [], topics: [], ...overrides };
}

export const DANA = prepInterviewer({
  key: 'i1',
  name: 'Dana Okafor',
  title: 'Staff backend engineer',
  baseId: 'kai',
  difficulty: 3,
  voiceGender: 'female',
  style: 'Digs into the decision behind every design',
  focusKeys: ['f1', 'f3'],
});

export const LEO = prepInterviewer({
  key: 'i2',
  name: 'Leo Martins',
  title: 'Engineering manager',
  baseId: 'maya',
  difficulty: 2,
  voiceGender: 'male',
  style: 'Warm, asks for the story behind the work',
  focusKeys: ['f2'],
});

export const SYSTEM_FOCUS = prepFocus({
  key: 'f1',
  label: 'Payments system design',
  format: 'system',
  description: 'Design a payment ledger and defend the trade-offs',
  topics: ['Idempotency', 'Consistency'],
});

export const STORIES_FOCUS = prepFocus({
  key: 'f2',
  label: 'Ownership stories',
  format: 'behavioral',
  description: 'Times you owned an outage end to end',
  topics: ['Incidents', 'Disagreement'],
});

export const CODING_FOCUS = prepFocus({
  key: 'f3',
  label: 'API coding',
  format: 'technical',
  description: 'Write and test an endpoint while you talk it through',
  topics: ['Go', 'Testing'],
});

export function companyStyle(overrides: Partial<PrepCompanyStyle> = {}): PrepCompanyStyle {
  return {
    company: 'Acme',
    summary: 'Acme runs a recruiter call, a technical screen and an onsite loop.',
    stages: [
      { name: 'Recruiter call', description: 'Background and motivation' },
      { name: 'Onsite loop', description: 'Design, coding and values' },
    ],
    values: ['Ownership'],
    evaluates: ['Clear trade-offs'],
    questionThemes: [],
    tips: [],
    patterns: [],
    sources: [{ title: 'How Acme hires', url: 'https://acme.example/hiring' }],
    basis: 'sources',
    ...overrides,
  };
}

/** The plan prep/plan returns (the hook selects `data.plan`). */
export function prepPlan(overrides: Partial<PrepPlan> = {}): PrepPlan {
  return {
    v: 1,
    role: 'Backend Engineer',
    company: null,
    industry: null,
    market: 'intl',
    language: 'en',
    jobId: null,
    posting: null,
    requirements: {
      summary: 'Builds and runs the payment APIs.',
      seniority: 'Mid-level',
      mustHave: ['Go', 'PostgreSQL'],
      niceToHave: ['Kafka'],
      responsibilities: ['Own the ledger service'],
      competencies: ['System design'],
    },
    companyStyle: null,
    interviewers: [DANA, LEO],
    focuses: [SYSTEM_FOCUS, STORIES_FOCUS, CODING_FOCUS],
    recommended: { interviewerKey: 'i1', focusKey: 'f1' },
    strategy: {
      summary: 'A short warm-up, then one deep design problem.',
      stages: [
        { name: 'Warm-up', goal: 'Your background', share: 1 },
        { name: 'Design', goal: 'A payment ledger', share: 2 },
        { name: 'Wrap-up', goal: 'Your questions', share: 1 },
      ],
      tactics: ['Asks for the number behind each claim'],
      prepTips: ['Have one outage story ready'],
    },
    domain: null,
    sources: [],
    generatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A plan written without the language model (`fallback: true`): catalog
 * personas and formats with the server's English catalog strings, which the
 * screen replaces with the bundle's own labels.
 */
export function fallbackPlan(overrides: Partial<PrepPlan> = {}): PrepPlan {
  return prepPlan({
    fallback: true,
    interviewers: [
      prepInterviewer({ key: 'i1', name: 'Priya', title: 'The Behavioral Probe', baseId: 'priya', difficulty: 2, style: 'STAR enforcement' }),
      prepInterviewer({ key: 'i2', name: 'Maya', title: 'The Warm Recruiter', baseId: 'maya', difficulty: 1, style: 'Calm, unhurried pace' }),
    ],
    focuses: [
      prepFocus({ key: 'f1', label: 'Behavioral (STAR)', format: 'behavioral', description: 'Ownership, conflict, failure' }),
      prepFocus({ key: 'f2', label: 'Culture & values', format: 'culture', description: 'How you work' }),
    ],
    recommended: { interviewerKey: 'i1', focusKey: 'f1' },
    strategy: { summary: '', stages: [], tactics: [], prepTips: [] },
    ...overrides,
  });
}

export function prepPosting(overrides: Partial<PrepPosting> & Pick<PrepPosting, 'ref' | 'title'>): PrepPosting {
  return {
    source: 'provider',
    provider: null,
    jobId: null,
    company: null,
    location: null,
    postedAt: null,
    url: null,
    snippet: null,
    description: null,
    ...overrides,
  };
}

export const ROLE_BACKEND: PrepRoleSuggestion = {
  title: 'Backend Engineer',
  titleEn: null,
  source: 'ai',
  context: 'Builds the server side of products',
  taxonomyId: null,
};

export const ROLE_PLATFORM: PrepRoleSuggestion = {
  title: 'Platform Engineer',
  titleEn: null,
  source: 'ai',
  context: 'Runs the internal developer platform',
  taxonomyId: null,
};

/** Our own job (`index`): practised as that job, by its id. */
export const POSTING_OURS = prepPosting({
  ref: 'index:job_42',
  source: 'index',
  jobId: 'job_42',
  title: 'Senior Backend Engineer',
  company: 'Stripe',
  location: 'Berlin',
  url: 'https://www.roboapply.io/jobs/job_42',
  snippet: 'Own the payments API.',
});

/** A job board's posting: planned from the post itself. */
export const POSTING_BOARD = prepPosting({
  ref: 'provider:jsearch:9',
  source: 'provider',
  provider: 'jsearch',
  title: 'Backend Engineer, Payments',
  company: 'Monzo',
  location: 'London',
  url: 'https://boards.example/jobs/9',
  snippet: 'Build the ledger.',
  description: 'Build and run the ledger service that moves money between accounts.',
});

export function prepSearchResult(overrides: Partial<PrepSearchResult> = {}): PrepSearchResult {
  return {
    query: 'backend',
    understood: { titles: ['Backend Engineer'], seniority: null, industry: null },
    roles: [ROLE_BACKEND, ROLE_PLATFORM],
    postings: [POSTING_OURS, POSTING_BOARD],
    market: { key: 'intl', country: null },
    sources: [
      { id: 'index', status: 'ok', count: 1 },
      { id: 'providers', status: 'ok', count: 1 },
      { id: 'web', status: 'empty', count: 0 },
    ],
    ...overrides,
  };
}

export const PREP_INDUSTRIES: PrepIndustry[] = [
  { id: 'software', label: 'Software and internet', top: true },
  { id: 'finance', label: 'Banking and finance', top: true },
  { id: 'health', label: 'Healthcare', top: true },
  { id: 'energy', label: 'Energy and utilities', top: false },
];

export const INDUSTRY_ROLES: PrepRoleSuggestion[] = [
  { title: 'Site Reliability Engineer', titleEn: null, source: 'ai', context: 'Keeps production up' },
  { title: 'Data Engineer', titleEn: null, source: 'ai', context: 'Builds the data pipelines' },
];
