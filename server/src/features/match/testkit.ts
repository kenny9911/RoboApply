// server/src/features/match/testkit.ts — in-memory MatchRepo and fixtures for
// MATCH tests (no vitest imports: the file compiles with the server).

import type { Market } from '../../platform/brand/registry.js';
import type { MatchJobRecord, UserMatchInputs } from './context.js';
import type { KeywordInput } from './keywordRows.js';
import type { MatchJob, MatchUser } from './preScore.js';
import type { MatchRepo, ResumeRecord, ScoreRecord, ScoreWrite } from './repo.js';

export function jobRecord(overrides: Partial<MatchJobRecord> = {}): MatchJobRecord {
  return {
    id: 'job1',
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    title: 'Backend Engineer',
    companyName: 'Acme',
    description: 'Build APIs in TypeScript and Go. You will own our payments service.',
    descriptionPlain: 'Build APIs in TypeScript and Go. You will own our payments service.',
    qualifications: '5+ years of backend experience. Kubernetes required.',
    responsibilities: null,
    benefits: null,
    taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
    primaryTaxonomyId: 'backend_engineer',
    seniority: 'senior',
    minYears: 5,
    maxYears: null,
    educationLevel: null,
    skills: ['typescript', 'go', 'kubernetes'],
    skillsDetail: [
      { skill: 'TypeScript', kind: 'hard', required: true },
      { skill: 'Kubernetes', kind: 'hard', required: true },
      { skill: 'Go', kind: 'hard', required: false },
    ],
    workModel: 'onsite',
    remoteScope: null,
    location: 'Berlin, DE',
    locationCity: 'Berlin',
    locationCountry: 'DE',
    geoLat: 52.52,
    geoLng: 13.405,
    salaryAnnualMin: 70000,
    salaryAnnualMax: 90000,
    salaryCurrency: 'EUR',
    sponsorship: null,
    sponsorshipEvidence: null,
    marketTags: null,
    archivedAt: null,
    companyIndustries: ['Fintech'],
    ...overrides,
  };
}

export function matchUser(overrides: Partial<MatchUser> = {}): MatchUser {
  return {
    userId: 'u1',
    market: 'intl',
    targetTaxonomyIds: ['backend_engineer'],
    targetTitles: [],
    targetSeniority: ['senior'],
    skills: ['TypeScript', 'Go'],
    employerIndustries: ['fintech'],
    locations: [{ label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 40, lat: 52.52, lng: 13.405 }],
    country: 'DE',
    workModels: [],
    salaryMin: { amount: 60000, currency: 'EUR', period: 'year' },
    needsSponsorship: null,
    workAuth: [],
    highestDegree: 'bachelor',
    highestDegreeLabel: 'BSc Computer Science',
    classYear: null,
    recentTitle: 'Software Engineer',
    yearsExperience: 6,
    searchProfileVersion: 1,
    ...overrides,
  };
}

export function matchJob(overrides: Partial<MatchJob> = {}): MatchJob {
  return {
    id: 'job1',
    market: 'intl',
    title: 'Backend Engineer',
    taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
    primaryTaxonomyId: 'backend_engineer',
    seniority: 'senior',
    skills: ['typescript', 'go', 'kubernetes'],
    skillsDetail: null,
    educationLevel: null,
    workModel: 'onsite',
    remoteScope: null,
    location: 'Berlin, DE',
    locationCity: 'Berlin',
    locationCountry: 'DE',
    geoLat: 52.52,
    geoLng: 13.405,
    salaryAnnualMin: 70000,
    salaryAnnualMax: 90000,
    salaryCurrency: 'EUR',
    sponsorship: null,
    sponsorshipEvidence: null,
    companyIndustries: ['Fintech'],
    classYears: [],
    classYearQuote: null,
    ...overrides,
  };
}

export const RESUME_MD = [
  '# Ada Lovelace',
  'ada@example.com · +49 151 2345 6789',
  '',
  '## Experience',
  'Senior Software Engineer, PayCo (2019-01 – present)',
  '- Built payment APIs in TypeScript and Go serving 2M users.',
  '',
  '## Skills',
  'TypeScript, Go, PostgreSQL',
].join('\n');

export function resumeRecord(overrides: Partial<ResumeRecord> = {}): ResumeRecord {
  return { id: 'v1', resumeMarkdown: RESUME_MD, resumeContentHash: 'hash-1', parsedData: { skills: ['TypeScript', 'Go'] }, targetJobId: null, ...overrides };
}

export interface MemoryRepoState {
  jobs: MatchJobRecord[];
  resumes: Array<ResumeRecord & { userId: string }>;
  scores: ScoreRecord[];
  keywords: Record<string, KeywordInput[]>;
  users: Record<string, Omit<UserMatchInputs, 'resumeParsed' | 'userId' | 'market'>>;
  active: Array<{ id: string; brand: string; lastActiveAt: Date }>;
  cachedScores: Record<string, number>;
}

export function defaultUserInputs(): MemoryRepoState['users'][string] {
  return {
    profile: { firstName: 'Ada', lastName: 'Lovelace', country: 'DE', skills: [{ name: 'TypeScript', confirmed: true }], workAuth: [], cnFields: null },
    education: [{ degree: 'BSc', major: 'Computer Science', endYm: '2014-06' }],
    experience: [{ title: 'Senior Software Engineer', company: 'PayCo', startYm: '2019-01', endYm: null, current: true, kind: 'work' }],
    searchProfile: {
      version: 1,
      filters: {
        taxonomyIds: ['backend_engineer'],
        seniority: ['senior'],
        locations: [{ label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 40, lat: 52.52, lng: 13.405 }],
        salaryMin: { amount: 60000, currency: 'EUR', period: 'year' },
      },
    },
    employerIndustries: ['Fintech'],
  };
}

export function createMemoryRepo(seed: Partial<MemoryRepoState> = {}): MatchRepo & { state: MemoryRepoState; calls: Record<string, number> } {
  const state: MemoryRepoState = {
    jobs: seed.jobs ?? [jobRecord()],
    resumes: seed.resumes ?? [{ ...resumeRecord(), userId: 'u1' }],
    scores: seed.scores ?? [],
    keywords: seed.keywords ?? {},
    users: seed.users ?? { u1: defaultUserInputs() },
    active: seed.active ?? [],
    cachedScores: {},
  };
  const calls: Record<string, number> = {};
  const hit = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    state,
    calls,
    async getJob(id) {
      hit('getJob');
      return state.jobs.find((j) => j.id === id) ?? null;
    },
    async getJobs(ids) {
      return state.jobs.filter((j) => ids.includes(j.id));
    },
    async getUserInputs(userId: string, market: Market) {
      const u = state.users[userId] ?? { profile: null, education: [], experience: [], searchProfile: null, employerIndustries: [] };
      return { userId, market, ...u };
    },
    async getResume(userId, variantId) {
      const mine = state.resumes.filter((r) => r.userId === userId);
      const r = variantId ? mine.find((x) => x.id === variantId) : mine[0];
      if (!r) return null;
      const { userId: _u, ...rest } = r;
      return rest;
    },
    async getScore(userId, jobId, variantId) {
      return state.scores.find((s) => s.userId === userId && s.jobId === jobId && s.resumeVariantId === variantId) ?? null;
    },
    async saveScore(row: ScoreWrite) {
      hit('saveScore');
      const saved: ScoreRecord = { ...row, generatedAt: row.generatedAt ?? new Date() };
      state.scores = state.scores.filter((s) => !(s.userId === row.userId && s.jobId === row.jobId && s.resumeVariantId === row.resumeVariantId));
      state.scores.push(saved);
      return saved;
    },
    async updateVariantCachedScore(variantId, score) {
      state.cachedScores[variantId] = score;
    },
    async getKeywords(jobId) {
      return state.keywords[jobId] ?? null;
    },
    async activeUsers(brandId, since, limit) {
      return state.active
        .filter((u) => u.brand === brandId && u.lastActiveAt >= since)
        .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
        .slice(0, limit)
        .map((u) => u.id);
    },
    async candidateJobs({ market, limit }) {
      return state.jobs.filter((j) => j.market === market && j.visibility === 'public').slice(0, limit);
    },
    async freshAiScoredJobIds({ userId, jobIds, resumeVariantId, resumeContentHash, modelUsed, promptVersion }) {
      return new Set(
        state.scores
          .filter(
            (s) =>
              s.userId === userId &&
              jobIds.includes(s.jobId) &&
              s.resumeVariantId === resumeVariantId &&
              s.resumeContentHashAtScore === resumeContentHash &&
              s.modelUsed === modelUsed &&
              s.promptVersion === promptVersion,
          )
          .map((s) => s.jobId),
      );
    },
  };
}
