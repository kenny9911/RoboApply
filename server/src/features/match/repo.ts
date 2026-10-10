// server/src/features/match/repo.ts
//
// The MATCH area's narrow, typed data adapter. MatchService talks to this
// interface only, so service tests use an in-memory repo and never touch a
// database; `createPrismaMatchRepo()` is the production implementation
// (typed Prisma, no `as any`; the client is imported lazily so importing the
// area never opens a pool).

import type { Market } from '../../platform/brand/registry.js';
import { normalizeCompanyName } from '../jobs/normalize/index.js';
import type { MatchDimension } from './contract.js';
import type { MatchJobRecord, UserMatchInputs } from './context.js';
import type { KeywordInput } from './keywordRows.js';

export interface ResumeRecord {
  id: string;
  resumeMarkdown: string;
  resumeContentHash: string;
  parsedData: unknown;
  targetJobId: string | null;
}

export interface ScoreRecord {
  userId: string;
  jobId: string;
  resumeVariantId: string;
  score: number;
  explanation: unknown;
  resumeContentHashAtScore: string;
  modelUsed: string;
  generatedAt: Date;
  scoreKind: string;
  tier: string | null;
  dimensions: unknown;
  promptVersion: string | null;
  locale: string | null;
  searchProfileVersion: number | null;
}

export type ScoreWrite = Omit<ScoreRecord, 'generatedAt'> & { generatedAt?: Date };

export interface MatchRepo {
  getJob(jobId: string): Promise<MatchJobRecord | null>;
  getJobs(jobIds: string[]): Promise<MatchJobRecord[]>;
  getUserInputs(userId: string, market: Market): Promise<Omit<UserMatchInputs, 'resumeParsed'>>;
  /** The given variant, or the user's primary (else most recent) resume. */
  getResume(userId: string, variantId?: string | null): Promise<ResumeRecord | null>;
  getScore(userId: string, jobId: string, variantId: string): Promise<ScoreRecord | null>;
  saveScore(row: ScoreWrite): Promise<ScoreRecord>;
  updateVariantCachedScore(variantId: string, score: number): Promise<void>;
  getKeywords(jobId: string): Promise<KeywordInput[] | null>;
  /** Users of a brand active since `since`, most recent first. */
  activeUsers(brandId: string, since: Date, limit: number): Promise<string[]>;
  /** Of `jobIds`, those with a fresh v3 AI score for this resume content and model. */
  freshAiScoredJobIds(input: { userId: string; jobIds: string[]; resumeVariantId: string; resumeContentHash: string; modelUsed: string; promptVersion: string }): Promise<Set<string>>;
}

// ── Prisma implementation ────────────────────────────────────────────────

const JOB_SELECT = {
  id: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  title: true,
  companyName: true,
  description: true,
  descriptionPlain: true,
  qualifications: true,
  responsibilities: true,
  benefits: true,
  taxonomyIds: true,
  primaryTaxonomyId: true,
  seniority: true,
  minYears: true,
  maxYears: true,
  educationLevel: true,
  skills: true,
  skillsDetail: true,
  workModel: true,
  remoteScope: true,
  location: true,
  locationCity: true,
  locationCountry: true,
  geoLat: true,
  geoLng: true,
  salaryAnnualMin: true,
  salaryAnnualMax: true,
  salaryCurrency: true,
  sponsorship: true,
  sponsorshipEvidence: true,
  marketTags: true,
  fraudFlags: true,
  archivedAt: true,
  company: { select: { industries: true } },
} as const;

type JobRow = {
  [K in Exclude<keyof typeof JOB_SELECT, 'company' | 'fraudFlags'>]: MatchJobRecord[K];
} & { company: { industries: string[] } | null; fraudFlags?: unknown };

function toRecord(row: JobRow): MatchJobRecord {
  const { company, fraudFlags: _fraud, ...rest } = row;
  return { ...rest, companyIndustries: company?.industries ?? [] };
}

/**
 * Company-name key for looking up past employers in RACompany.nameNormalized:
 * the ingest pipeline's canonical normalizer (WP-16a), so the lookup and the
 * stored key always agree.
 */
export function companyKey(name: string): string {
  return normalizeCompanyName(name);
}

async function db() {
  return (await import('../../lib/prisma.js')).default;
}

export function createPrismaMatchRepo(): MatchRepo {
  return {
    async getJob(jobId) {
      const p = await db();
      const row = await p.rAJob.findUnique({ where: { id: jobId }, select: JOB_SELECT });
      return row ? toRecord(row as JobRow) : null;
    },

    async getJobs(jobIds) {
      if (!jobIds.length) return [];
      const p = await db();
      const rows = await p.rAJob.findMany({ where: { id: { in: jobIds } }, select: JOB_SELECT });
      return rows.map((r) => toRecord(r as JobRow));
    },

    async getUserInputs(userId, market) {
      const p = await db();
      const [profile, education, experience, searchProfile] = await Promise.all([
        p.rAProfile.findUnique({
          where: { userId },
          select: { firstName: true, lastName: true, country: true, skills: true, workAuth: true, cnFields: true },
        }),
        p.rAProfileEducation.findMany({ where: { userId }, select: { degree: true, major: true, endYm: true }, orderBy: { sortOrder: 'asc' } }),
        p.rAProfileExperience.findMany({
          where: { userId },
          select: { title: true, company: true, startYm: true, endYm: true, current: true, kind: true },
          orderBy: { sortOrder: 'asc' },
        }),
        p.rASearchProfile.findFirst({
          where: { userId },
          select: { filters: true, version: true },
          orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
        }),
      ]);
      const names = [...new Set(experience.map((e) => companyKey(e.company)).filter(Boolean))];
      const companies = names.length
        ? await p.rACompany.findMany({ where: { market, nameNormalized: { in: names } }, select: { industries: true } })
        : [];
      return {
        userId,
        market,
        profile,
        education,
        experience,
        searchProfile,
        employerIndustries: [...new Set(companies.flatMap((c) => c.industries))],
      };
    },

    async getResume(userId, variantId) {
      const p = await db();
      const select = { id: true, resumeMarkdown: true, resumeContentHash: true, parsedData: true, targetJobId: true } as const;
      if (variantId) return p.rAResumeVariant.findFirst({ where: { id: variantId, userId, deletedAt: null }, select });
      return (
        (await p.rAResumeVariant.findFirst({ where: { userId, deletedAt: null, isPrimary: true }, select })) ??
        (await p.rAResumeVariant.findFirst({ where: { userId, deletedAt: null }, select, orderBy: { lastEditedAt: 'desc' } }))
      );
    },

    async getScore(userId, jobId, resumeVariantId) {
      const p = await db();
      return p.rAJobMatchScore.findUnique({
        where: { userId_jobId_resumeVariantId: { userId, jobId, resumeVariantId } },
        select: {
          userId: true,
          jobId: true,
          resumeVariantId: true,
          score: true,
          explanation: true,
          resumeContentHashAtScore: true,
          modelUsed: true,
          generatedAt: true,
          scoreKind: true,
          tier: true,
          dimensions: true,
          promptVersion: true,
          locale: true,
          searchProfileVersion: true,
        },
      });
    },

    async saveScore(row) {
      const p = await db();
      const data = {
        score: row.score,
        explanation: row.explanation as object,
        resumeContentHashAtScore: row.resumeContentHashAtScore,
        modelUsed: row.modelUsed,
        generatedAt: row.generatedAt ?? new Date(),
        scoreKind: row.scoreKind,
        tier: row.tier,
        dimensions: row.dimensions as MatchDimension[] as unknown as object,
        promptVersion: row.promptVersion,
        locale: row.locale,
        searchProfileVersion: row.searchProfileVersion,
      };
      const saved = await p.rAJobMatchScore.upsert({
        where: { userId_jobId_resumeVariantId: { userId: row.userId, jobId: row.jobId, resumeVariantId: row.resumeVariantId } },
        create: { userId: row.userId, jobId: row.jobId, resumeVariantId: row.resumeVariantId, ...data },
        update: data,
      });
      return saved;
    },

    async updateVariantCachedScore(variantId, score) {
      const p = await db();
      await p.rAResumeVariant.update({ where: { id: variantId }, data: { matchScoreCached: score } });
    },

    async getKeywords(jobId) {
      const p = await db();
      const row = await p.rAKeywordExtraction.findUnique({ where: { jobId }, select: { keywords: true } });
      if (!row || !Array.isArray(row.keywords)) return null;
      const out: KeywordInput[] = [];
      for (const k of row.keywords) {
        if (!k || typeof k !== 'object' || Array.isArray(k)) continue;
        const { keyword, importance } = k as { keyword?: unknown; importance?: unknown };
        if (typeof keyword !== 'string') continue;
        out.push({ keyword, importance: importance === 'high' || importance === 'low' ? importance : 'medium' });
      }
      return out;
    },

    async activeUsers(brandId, since, limit) {
      const p = await db();
      const rows = await p.user.findMany({
        where: { brand: brandId, lastActiveAt: { gte: since } },
        select: { id: true },
        orderBy: { lastActiveAt: 'desc' },
        take: limit,
      });
      return rows.map((r) => r.id);
    },

    async freshAiScoredJobIds({ userId, jobIds, resumeVariantId, resumeContentHash, modelUsed, promptVersion }) {
      if (!jobIds.length) return new Set();
      const p = await db();
      const rows = await p.rAJobMatchScore.findMany({
        where: { userId, resumeVariantId, jobId: { in: jobIds }, resumeContentHashAtScore: resumeContentHash, modelUsed, promptVersion },
        select: { jobId: true },
      });
      return new Set(rows.map((r) => r.jobId));
    },
  };
}
