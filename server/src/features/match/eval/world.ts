// server/src/features/match/eval/world.ts
//
// In-memory worlds for the harness: the existing MATCH test kit
// (features/match/testkit.ts: createMemoryRepo, jobRecord, defaultUserInputs,
// resumeRecord) plus three counting fakes (scorer, embeddings client, planner)
// and builders that turn a synthetic persona or posting into what the matcher
// reads. No vitest import: the file compiles with the server.
//
// Nothing here reaches a database, a model or the network. A counting fake
// answers like the real thing would, and counts: invariant 10 asserts the
// counts stay at zero.

import crypto from 'node:crypto';
import { runWithBrand } from '../../../lib/requestContext.js';
import { getBrand, type BrandId, type ProductBrand } from '../../../platform/brand/registry.js';
import { SCORER_PROMPT_VERSION, type MatchDimension } from '../contract.js';
import type { MatchJobRecord } from '../context.js';
import type { MatchServiceDeps } from '../MatchService.js';
import { createMemoryRepo, defaultUserInputs, jobRecord, resumeRecord, type MemoryRepoState } from '../testkit.js';
import type { Persona, Posting } from './fixtures/schema.js';
import { loadFitApi, type FitApi } from './seams.js';

export const EVAL_NOW = new Date('2026-10-01T12:00:00.000Z');
export const EVAL_SCORER_MODEL = 'eval/fake-scorer';

// ── Counting fakes ────────────────────────────────────────────────────────

export interface CountingScorer {
  calls: number;
  run(input: unknown, options: unknown): Promise<{
    dimensions: Record<'title_level' | 'skills' | 'industry' | 'career_path', { score: number | null; evidence: Array<{ text: string; source: 'resume' | 'posting' }> }>;
    strengths: string[];
    gaps: string[];
    keywordsMatched: string[];
    keywordsMissing: string[];
    summary: string | null;
  }>;
}

/** A scorer that counts its calls. It answers a fixed, valid result so a path that does call it keeps working. */
export function countingScorer(): CountingScorer {
  const scorer: CountingScorer = {
    calls: 0,
    async run() {
      scorer.calls += 1;
      return {
        dimensions: {
          title_level: { score: 70, evidence: [] },
          skills: { score: 60, evidence: [] },
          industry: { score: null, evidence: [] },
          career_path: { score: 50, evidence: [] },
        },
        strengths: [],
        gaps: [],
        keywordsMatched: [],
        keywordsMissing: [],
        summary: null,
      };
    },
  };
  return scorer;
}

export interface CountingEmbeddings {
  calls: number;
  /** The shape of `embedTexts` of platform/embeddings/client.ts (MKT-2H): unavailable, never a fake vector. */
  embedTexts(...args: unknown[]): Promise<{ unavailable: string }>;
}

export function countingEmbeddings(): CountingEmbeddings {
  const client: CountingEmbeddings = {
    calls: 0,
    async embedTexts() {
      client.calls += 1;
      return { unavailable: 'eval_fake' };
    },
  };
  return client;
}

export interface CountingPlanner {
  calls: number;
  plan(text: string, ctx: unknown): Promise<Record<string, unknown>>;
}

/** The natural-language search planner (a model call in production). */
export function countingPlanner(): CountingPlanner {
  const planner: CountingPlanner = {
    calls: 0,
    async plan() {
      planner.calls += 1;
      return {};
    },
  };
  return planner;
}

// ── A world: one in-memory repository and the match dependencies around it ──

export type MemoryRepo = ReturnType<typeof createMemoryRepo>;

export interface WorldOptions {
  brand?: BrandId;
  /** `aiAllowed(user)`: false models GoApply without the "Use AI" consent. Default true. */
  aiAllowed?: boolean;
  jobs?: MatchJobRecord[];
  users?: MemoryRepoState['users'];
  resumes?: MemoryRepoState['resumes'];
  /** Stored score rows (loose: the row gains columns in later phases). */
  scores?: Array<Record<string, unknown>>;
  now?: Date;
}

export interface World {
  brand: ProductBrand;
  now: Date;
  repo: MemoryRepo;
  scorer: CountingScorer;
  embeddings: CountingEmbeddings;
  planner: CountingPlanner;
  /** Calls of the rate-limit counter, for "a consent refusal spends no allowance". */
  consume: { calls: number };
  /** The `MatchServiceDeps` every seam of this world is built on. */
  deps: MatchServiceDeps & Record<string, unknown>;
  /** `getFit` / `getFits` on this world's fakes (throws `SeamMissing` until fit.ts exists). */
  fit(): Promise<FitApi>;
  /** Run `fn` as a unit of work of this world's brand. */
  inBrand<T>(fn: () => T): T;
}

export function createWorld(options: WorldOptions = {}): World {
  const brand = getBrand(options.brand ?? 'roboapply');
  const now = options.now ?? EVAL_NOW;
  const repo = createMemoryRepo({
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.users ? { users: options.users } : {}),
    ...(options.resumes ? { resumes: options.resumes } : {}),
    ...(options.scores ? { scores: options.scores as unknown as MemoryRepoState['scores'] } : {}),
  });
  const scorer = countingScorer();
  const embeddings = countingEmbeddings();
  const planner = countingPlanner();
  const consume = { calls: 0 };
  const aiAllowed = options.aiAllowed ?? true;
  const deps: MatchServiceDeps & Record<string, unknown> = {
    repo,
    scorer,
    resolveModel: () => EVAL_SCORER_MODEL,
    routeAllowed: () => true,
    aiAllowed: async () => aiAllowed,
    consume: async () => {
      consume.calls += 1;
      return { allowed: true, retryAfterSec: 0, remaining: 1000, windows: [] };
    },
    withCredit: async (_opts, fn) => fn(),
    profileSnapshot: async () => null,
    costLog: async () => undefined,
    brand: () => brand,
    // An empty environment: MATCH_WEIGHTS, MATCH_TIERS, MATCH_PRIORS and the recruitment-info mode take their defaults.
    env: {},
    now: () => now,
    // Later phases read these from the same bag (retrieval, hybrid feed).
    embeddings,
    planner: (text: string, ctx: unknown) => planner.plan(text, ctx),
  };
  const inBrand = <T>(fn: () => T): T => runWithBrand(brand.id, fn);
  let fitApi: Promise<FitApi> | null = null;
  const fit = (): Promise<FitApi> => {
    if (!fitApi) {
      fitApi = loadFitApi(deps).then((api) => ({
        boundBy: api.boundBy,
        raw: { getFit: (...args) => inBrand(() => api.raw.getFit(...args)), getFits: (...args) => inBrand(() => api.raw.getFits(...args)) },
        getFit: (userId, jobId, opts) => inBrand(() => api.getFit(userId, jobId, opts)),
        getFits: (userId, jobIds) => inBrand(() => api.getFits(userId, jobIds)),
        getVariantFit: api.getVariantFit ? (userId, jobId, variantId) => inBrand(() => api.getVariantFit!(userId, jobId, variantId)) : null,
      }));
      fitApi.catch(() => {
        fitApi = null;
      });
    }
    return fitApi;
  };
  return { brand, now, repo, scorer, embeddings, planner, consume, deps, fit, inBrand };
}

// ── Test-kit shortcuts (one user `u1`, one resume `v1`) ───────────────────

export { defaultUserInputs, jobRecord, resumeRecord };

export type UserSeed = MemoryRepoState['users'][string];

/** The test kit's default user with another saved search (`filters`) and, optionally, other profile parts. */
export function userWith(filters: Record<string, unknown>, over: Partial<UserSeed> = {}): UserSeed {
  const base = defaultUserInputs();
  return { ...base, ...over, searchProfile: { version: base.searchProfile?.version ?? 1, filters } };
}

const DEFAULT_WEIGHTS = { title_level: 35, skills: 30, industry: 15, logistics: 10, career_path: 10 } as const;

/** Stored AI components that parse as `RAJobMatchScore.dimensions`. */
export function aiDimensions(scores: { title_level: number; skills: number; industry: number | null; logistics: number | null; career_path: number | null }): MatchDimension[] {
  return (Object.keys(DEFAULT_WEIGHTS) as Array<keyof typeof DEFAULT_WEIGHTS>).map((key) => {
    const score = scores[key];
    return { key, weight: DEFAULT_WEIGHTS[key], score, status: score === null ? ('not_stated' as const) : ('scored' as const), evidence: [] };
  });
}

function weightedTotal(dims: MatchDimension[]): number {
  let sum = 0;
  let weight = 0;
  for (const d of dims) {
    if (d.score === null) continue;
    sum += d.weight * d.score;
    weight += d.weight;
  }
  return weight ? Math.round(sum / weight) : 0;
}

/**
 * A stored AI fit row of the user's primary resume as it is now: fresh by
 * every rule of the contract (same resume content hash, a fit rubric, valid
 * components, no job content hash recorded yet).
 */
export function freshAiRow(input: { userId?: string; jobId?: string; resumeVariantId?: string; resumeContentHash?: string; dimensions?: MatchDimension[]; generatedAt?: Date } = {}): Record<string, unknown> {
  const dimensions = input.dimensions ?? aiDimensions({ title_level: 80, skills: 60, industry: 50, logistics: 100, career_path: 70 });
  const score = weightedTotal(dimensions);
  return {
    userId: input.userId ?? 'u1',
    jobId: input.jobId ?? 'job1',
    resumeVariantId: input.resumeVariantId ?? 'v1',
    score,
    explanation: { strengths: [], gaps: [], rationale: '', keywordsMatched: [], keywordsMissing: [], responseLanguage: 'en', promptVersion: SCORER_PROMPT_VERSION },
    resumeContentHashAtScore: input.resumeContentHash ?? 'hash-1',
    modelUsed: EVAL_SCORER_MODEL,
    generatedAt: input.generatedAt ?? new Date(EVAL_NOW.getTime() - 3_600_000),
    scoreKind: 'ai',
    tier: score >= 80 ? 'great' : score >= 65 ? 'good' : score >= 45 ? 'possible' : 'unlikely',
    dimensions,
    promptVersion: SCORER_PROMPT_VERSION,
    locale: 'en',
    searchProfileVersion: 1,
    // Columns of the fit contract (MKT-0 schema; written by MKT-1F). Null hash: recorded before the column existed.
    jobContentHash: null,
    rubricVersion: 'fit_v3',
  };
}

// ── Synthetic fixtures → what the matcher reads ───────────────────────────

const ANNUAL_FACTOR: Record<string, number> = { year: 1, month: 12, hour: 2080 };

/** A synthetic posting as the RAJob projection the matcher reads (an enriched, canonical, public row). */
export function postingRecord(p: Posting): MatchJobRecord {
  const pay = p.pay && p.pay.plausible ? p.pay : null;
  const factor = pay ? (pay.period === 'month' && pay.months ? pay.months : (ANNUAL_FACTOR[pay.period] ?? 1)) : 1;
  return {
    id: p.id,
    market: p.market,
    visibility: 'public',
    ownerUserId: null,
    title: p.title,
    companyName: p.companyName,
    description: p.description,
    descriptionPlain: p.description,
    qualifications: p.qualifications,
    responsibilities: null,
    benefits: null,
    taxonomyIds: [p.categoryId, p.groupId, p.roleId],
    primaryTaxonomyId: p.roleId,
    seniority: p.level,
    minYears: p.minYears,
    maxYears: null,
    educationLevel: p.educationLevel,
    skills: p.skills.map((s) => s.name.toLowerCase()),
    skillsDetail: p.skills.map((s) => ({ skill: s.name, kind: s.kind, required: s.required })),
    workModel: p.workModel,
    remoteScope: p.remoteScope,
    location: p.location.text,
    locationCity: p.location.city,
    locationCountry: p.location.country,
    geoLat: null,
    geoLng: null,
    // A figure that cannot be pay is not stored as an amount (normalize/salary.ts); its words are kept.
    salaryAnnualMin: pay ? Math.round(pay.min * factor) : null,
    salaryAnnualMax: pay ? Math.round(pay.max * factor) : null,
    salaryCurrency: pay ? pay.currency : null,
    salaryText: p.pay?.text ?? null,
    sponsorship: p.sponsorship,
    sponsorshipEvidence: p.sponsorshipQuote,
    marketTags: p.classYears.map((y) => ({ tag: `class_year:${y}`, evidenceQuote: p.classYearQuote })),
    archivedAt: null,
    companyIndustries: p.companyIndustries,
  };
}

export function resumeHash(markdown: string): string {
  return crypto.createHash('sha1').update(markdown).digest('hex');
}

/** A persona's profile, experience, education and saved search, as the match repository returns them. */
export function personaUser(p: Persona): UserSeed {
  const filters: Record<string, unknown> = {
    // A realistic saved search: the role they are looking for, their level, where, and their pay floor.
    taxonomyIds: [p.targetRoleId],
    seniority: [p.level],
    locations: [p.location],
    salaryMin: p.payFloor,
    ...(p.needsSponsorship ? { needsSponsorship: true } : {}),
  };
  return {
    profile: {
      firstName: 'Persona',
      lastName: p.id,
      country: p.location.country,
      skills: p.skills.map((name) => ({ name, confirmed: true })),
      workAuth: [],
      cnFields: p.market === 'cn' ? { ...(typeof p.classYear === 'number' ? { graduationClass: p.classYear } : {}), degree: p.degree } : null,
    },
    education: p.education.map((e) => ({ degree: e.label, major: e.field, endYm: `${e.endYear}-06` })),
    experience: p.experience.map((e) => ({ title: e.title, company: e.company, startYm: e.start, endYm: e.end, current: e.current, kind: e.kind })),
    searchProfile: { version: 1, filters },
    employerIndustries: p.employerIndustries,
  };
}

export function personaResume(p: Persona): MemoryRepoState['resumes'][number] {
  return {
    id: `rv-${p.id}`,
    userId: p.id,
    resumeMarkdown: p.resumeMarkdown,
    resumeContentHash: resumeHash(p.resumeMarkdown),
    parsedData: {
      skills: p.skills,
      experience: p.experience.map((e) => ({ role: e.title, company: e.company, startDate: e.start, endDate: e.end ?? 'present', employmentType: e.kind === 'internship' ? 'internship' : 'full_time' })),
      education: p.education.map((e) => ({ degree: e.label, field: e.field })),
    },
    targetJobId: null,
  };
}

/** One world holding the given personas and job rows of a market (synthetic personas; rows from fixtures or a live snapshot). */
export function recordsWorld(market: 'intl' | 'cn', personas: Persona[], jobs: MatchJobRecord[]): World {
  const users: MemoryRepoState['users'] = {};
  for (const p of personas) users[p.id] = personaUser(p);
  return createWorld({ brand: market === 'cn' ? 'goapply' : 'roboapply', jobs, users, resumes: personas.map(personaResume) });
}

/** One world holding every persona and every posting of a market's fixtures. */
export function fixtureWorld(market: 'intl' | 'cn', personas: Persona[], postings: Posting[]): World {
  return recordsWorld(market, personas, postings.map(postingRecord));
}
