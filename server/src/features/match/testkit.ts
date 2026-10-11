// server/src/features/match/testkit.ts — in-memory MatchRepo and fixtures for
// MATCH tests (no vitest imports: the file compiles with the server).

import type { Market } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import type { FeedCountResult, LimitingFilter } from '../feed/index.js';
import type { SearchProfileWire } from '../search/index.js';
import type { SkillRecord } from '../skills/index.js';
import type { ReportInventory } from './reportInventory.js';
import type { MatchJobRecord, UserMatchInputs } from './context.js';
import type { KeywordInput } from './keywordRows.js';
import type { MatchJob, MatchUser } from './preScore.js';
import { jobHashCurrent, toCalibrationPair, type CalibrationPair, type MatchRepo, type ResumeRecord, type ScoreRecord, type ScoreWrite, type StoredFitRow } from './repo.js';

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
    // The role this person's record shows (their experience titles): the estimate's only role input.
    evidenceRoleIds: ['backend_engineer'],
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

// ── A fixture skill vocabulary (SM-6) ─────────────────────────────────────

/** One skill of a fixture vocabulary: reviewed and hard unless the overrides say otherwise. */
export function skillRecord(id: string, labelEn: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return { id, kind: 'hard', labelEn, labelZh: null, labelZhHant: null, aliases: [], parentId: null, esco: null, onet: null, status: 'reviewed', ...overrides };
}

/**
 * A small vocabulary for tests of the estimate and the keyword check. Pin it
 * with `setVocabularyForTests(FIXTURE_SKILLS)` (features/skills) and call
 * `resetVocabularyForTests()` in `afterEach`.
 *
 *   postgresql, mysql → sql → relational_databases     the related-evidence chain
 *   react → frontend_frameworks                        an everyday word under a broader skill
 *   go, excel                                          everyday words
 *   nodejs                                             three spellings, one skill
 *   machine_learning                                   labels in three scripts, a short alias with another reading
 *   cpa                                                a certificate with an ambiguous abbreviation
 *   communication                                      a soft skill
 *   vertex_ai                                          a skill nobody has reviewed
 */
export const FIXTURE_SKILLS: SkillRecord[] = [
  skillRecord('relational_databases', 'Relational databases', { labelZh: '关系型数据库', labelZhHant: '關聯式資料庫', aliases: ['relational database', 'rdbms'] }),
  skillRecord('sql', 'SQL', { parentId: 'relational_databases' }),
  skillRecord('postgresql', 'PostgreSQL', { aliases: ['postgres'], parentId: 'sql' }),
  skillRecord('mysql', 'MySQL', { parentId: 'sql' }),
  skillRecord('frontend_frameworks', 'Frontend frameworks', { labelZh: '前端框架', labelZhHant: '前端框架' }),
  skillRecord('react', 'React', { aliases: ['react.js', 'reactjs'], parentId: 'frontend_frameworks', everydayWord: true }),
  skillRecord('go', 'Go', { aliases: ['golang'], everydayWord: true }),
  skillRecord('excel', 'Excel', { aliases: ['microsoft excel'], everydayWord: true }),
  skillRecord('nodejs', 'Node.js', { aliases: ['node'] }),
  skillRecord('typescript', 'TypeScript'),
  skillRecord('kubernetes', 'Kubernetes', { aliases: ['k8s'] }),
  skillRecord('machine_learning', 'Machine learning', { labelZh: '机器学习', labelZhHant: '機器學習', aliases: ['ml'] }),
  skillRecord('cpa', 'CPA', { kind: 'certification', labelZh: '注册会计师', aliases: ['certified public accountant', '注会'] }),
  skillRecord('communication', 'Communication', { kind: 'soft', labelZh: '沟通能力', labelZhHant: '溝通能力', aliases: ['communication skills'] }),
  skillRecord('vertex_ai', 'Vertex AI', { status: 'unreviewed' }),
];

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
  /** AppConfig values by key (the calibration document). */
  config: Record<string, string>;
  /** Variant ids that are NOT a primary resume (calibration reads primary resumes only). Default: every variant is primary. */
  nonPrimary: string[];
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
    config: seed.config ?? {},
    nonPrimary: seed.nonPrimary ?? [],
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
    async getFitJobs(ids) {
      hit('getFitJobs');
      // The list projection: no long text at all.
      return state.jobs.filter((j) => ids.includes(j.id)).map((j) => ({ ...j, description: '', descriptionPlain: '', responsibilities: null, benefits: null }));
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
    // The production rule (repo.ts): the first writer wins for a text of the posting; a list of another text is replaced.
    async saveJobRequirements(jobId, doc) {
      hit('saveJobRequirements');
      const job = state.jobs.find((j) => j.id === jobId);
      if (!job) return false;
      const had = job.requirements as { contentHash?: unknown } | null | undefined;
      if (had && had.contentHash === doc.contentHash) return false;
      job.requirements = doc;
      return true;
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
    async listAiScores({ userId, jobIds, resumeVariantId, resumeContentHash }) {
      hit('listAiScores');
      const out = new Map<string, StoredFitRow>();
      for (const s of state.scores) {
        if (s.userId !== userId || !jobIds.includes(s.jobId) || s.resumeVariantId !== resumeVariantId) continue;
        if (s.scoreKind !== 'ai' || s.resumeContentHashAtScore !== resumeContentHash) continue;
        out.set(s.jobId, s);
      }
      return out;
    },
    async freshAiScoredJobIds({ userId, jobIds, resumeVariantId, resumeContentHash, modelUsed, promptVersion, jobContentHashes }) {
      return new Set(
        state.scores
          .filter(
            (s) =>
              s.userId === userId &&
              jobIds.includes(s.jobId) &&
              s.resumeVariantId === resumeVariantId &&
              s.resumeContentHashAtScore === resumeContentHash &&
              s.modelUsed === modelUsed &&
              s.promptVersion === promptVersion &&
              jobHashCurrent(s.jobContentHash, jobContentHashes?.get(s.jobId)),
          )
          .map((s) => s.jobId),
      );
    },
    async listCalibrationPairs({ market, since, limit, promptVersion }) {
      hit('listCalibrationPairs');
      const marketOf = new Map(state.jobs.map((j) => [j.id, j.market]));
      return state.scores
        .filter((s) => s.scoreKind === 'ai' && s.generatedAt >= since && marketOf.get(s.jobId) === market && !state.nonPrimary.includes(s.resumeVariantId))
        // As the Prisma repository: with a prompt version named, only the rows that scorer wrote.
        .filter((s) => !promptVersion || s.promptVersion === promptVersion)
        .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())
        .map((s) =>
          toCalibrationPair({
            ai: s.score,
            estimateAtScore: s.explanation && typeof s.explanation === 'object' ? (s.explanation as { estimateAtScore?: unknown }).estimateAtScore : null,
            dimensions: s.dimensions,
          }),
        )
        .filter((x): x is CalibrationPair => !!x)
        .slice(0, limit);
    },
    async getConfigValue(key) {
      hit('getConfigValue');
      return state.config[key] ?? null;
    },
    async setConfigValue(key, value) {
      hit('setConfigValue');
      state.config[key] = value;
    },
  };
}

// ── Competitiveness report (WP-77) ────────────────────────────────────────

/** A saved search as the search seam answers it. */
export function searchProfileWire(overrides: Partial<SearchProfileWire> = {}): SearchProfileWire {
  return {
    id: 'sp1',
    name: 'Backend in Berlin',
    isDefault: true,
    isActive: true,
    version: 3,
    schemaVersion: 1,
    filters: { taxonomyIds: ['backend_engineer'], workModels: ['onsite'], postedWithinDays: 7 },
    alertInstantMax: 0,
    alertDigest: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** `n` posts for one search: ids `p00`…, each stating what `make(i)` returns. */
export function reportJobs(n: number, make: (i: number) => Partial<MatchJobRecord> = () => ({})): MatchJobRecord[] {
  return Array.from({ length: n }, (_, i) => jobRecord({ id: `p${String(i).padStart(2, '0')}`, ...make(i) }));
}

export interface MemoryInventoryState {
  profiles: SearchProfileWire[];
  /** Job ids the feed preview lists for each profile id, newest first. */
  samples: Record<string, string[]>;
  count: FeedCountResult;
  limiting: LimitingFilter[];
  calls: { sample: number; count: number; limiting: number };
  fail?: { count?: boolean; limiting?: boolean };
}

export function createMemoryReportInventory(seed: Partial<MemoryInventoryState> = {}): ReportInventory & { state: MemoryInventoryState } {
  const state: MemoryInventoryState = {
    profiles: seed.profiles ?? [searchProfileWire()],
    samples: seed.samples ?? {},
    count: seed.count ?? { count: 240, capped: false },
    limiting: seed.limiting ?? [],
    calls: { sample: 0, count: 0, limiting: 0 },
    fail: seed.fail,
  };
  const find = (id: string) => {
    const p = state.profiles.find((x) => x.id === id);
    if (!p) throw new HttpError('not_found', 'Saved search not found.', { reason: 'search_profile_not_found' });
    return p;
  };
  return {
    state,
    async getProfile(_userId, id) {
      return find(id);
    },
    async sampleJobIds(_userId, profile, limit) {
      state.calls.sample += 1;
      return (state.samples[profile.id] ?? []).slice(0, limit);
    },
    async count() {
      state.calls.count += 1;
      if (state.fail?.count) throw new Error('count down');
      return state.count;
    },
    async limiting() {
      state.calls.limiting += 1;
      if (state.fail?.limiting) throw new Error('limiting down');
      return state.limiting;
    },
  };
}
