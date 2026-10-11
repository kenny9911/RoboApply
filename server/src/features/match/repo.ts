// server/src/features/match/repo.ts
//
// The MATCH area's narrow, typed data adapter. MatchService talks to this
// interface only, so service tests use an in-memory repo and never touch a
// database; `createPrismaMatchRepo()` is the production implementation
// (typed Prisma, no `as any`; the client is imported lazily so importing the
// area never opens a pool).

import { Prisma } from '../../generated/prisma/client.js';
import type { Market } from '../../platform/brand/registry.js';
import { normalizeCompanyName } from '../jobs/normalize/index.js';
import type { MatchDimension } from './contract.js';
import type { MatchJobRecord, UserMatchInputs } from './context.js';
import type { KeywordInput } from './keywordRows.js';
import type { StoredRequirementsDoc } from './scorerV4.js';

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
  /** `jobContentHash` of the posting the score was written for; null on rows older than the column. */
  jobContentHash?: string | null;
  /** 'fit_v3' | 'fit_v4': the rubric the stored components follow; null on rows older than the column. */
  rubricVersion?: string | null;
}

export type ScoreWrite = Omit<ScoreRecord, 'generatedAt'> & { generatedAt?: Date };

/** What a list reads of a stored AI score (no prose). */
export type StoredFitRow = Pick<
  ScoreRecord,
  'score' | 'tier' | 'dimensions' | 'generatedAt' | 'modelUsed' | 'promptVersion' | 'jobContentHash' | 'rubricVersion' | 'searchProfileVersion' | 'resumeContentHashAtScore' | 'resumeVariantId'
>;

/** One (estimate, AI) pair for calibration: numbers only, never text. */
export interface CalibrationPair {
  /** The v2 estimate at score time (`explanation.estimateAtScore.score`). */
  estimate: number;
  /** The AI total stored with the row. */
  ai: number;
  /** The AI's component scores (0–100), for the components it scored. */
  components: Partial<Record<MatchDimension['key'], number>>;
}

export interface MatchRepo {
  getJob(jobId: string): Promise<MatchJobRecord | null>;
  getJobs(jobIds: string[]): Promise<MatchJobRecord[]>;
  /**
   * The rows a list of fits needs: every column the estimate reads and no
   * long text (`description`, `descriptionPlain`, `responsibilities` and
   * `benefits` come back empty: a list never sends a posting to a model and
   * never loads a description, not even for the content hash, which a list
   * reads from the stored `contentHash` column only).
   */
  getFitJobs(jobIds: string[]): Promise<MatchJobRecord[]>;
  getUserInputs(userId: string, market: Market): Promise<Omit<UserMatchInputs, 'resumeParsed'>>;
  /** The given variant, or the user's primary (else most recent) resume. */
  getResume(userId: string, variantId?: string | null): Promise<ResumeRecord | null>;
  getScore(userId: string, jobId: string, variantId: string): Promise<ScoreRecord | null>;
  /**
   * The stored AI scores of `jobIds` for this resume content: job id → the
   * row's numbers and versions. Rows of every model and prompt come back:
   * fit.ts decides which one is a fit and whether it is stale (I7), so a
   * version change never reads as "no score".
   */
  listAiScores(input: { userId: string; jobIds: string[]; resumeVariantId: string; resumeContentHash: string }): Promise<Map<string, StoredFitRow>>;
  saveScore(row: ScoreWrite): Promise<ScoreRecord>;
  /**
   * Store the requirement lines of a posting that has none for the text it
   * has now (scorer v4: the first score of a posting copies them; enrichment
   * writes them otherwise). The first writer wins: a job that already has a
   * list for this text (the same `contentHash`) is left as it is. A list of
   * an earlier text of the posting is replaced. Answers whether this call
   * wrote it.
   *
   * Optional so a repository that has no job table to write to (an in-memory
   * one) still satisfies the interface: the caller then stores nothing, and
   * every score of that posting copies its own lines.
   */
  saveJobRequirements?(jobId: string, doc: StoredRequirementsDoc): Promise<boolean>;
  /**
   * @deprecated Never called. The fit of a resume version is read through
   * `getVariantFit`; `RAResumeVariant.matchScoreCached` was a frozen copy of
   * it outside the fit contract and is no longer written (nothing reads it
   * since the M2 gate). The member is still declared only because the
   * in-memory repository of testkit.ts implements it; it goes when that does.
   */
  updateVariantCachedScore?(variantId: string, score: number): Promise<void>;
  getKeywords(jobId: string): Promise<KeywordInput[] | null>;
  /** Users of a brand active since `since`, most recent first. */
  activeUsers(brandId: string, since: Date, limit: number): Promise<string[]>;
  /**
   * Of `jobIds`, those with an AI score that needs no re-scoring: written for
   * this resume content by the pinned model and prompt, and (when
   * `jobContentHashes` names the job) for the posting as it is now. A row of
   * an older model, an older prompt or an older posting is not in the set, so
   * the precompute cron picks it again: that is the planned backfill.
   */
  freshAiScoredJobIds(input: {
    userId: string;
    jobIds: string[];
    resumeVariantId: string;
    resumeContentHash: string;
    modelUsed: string;
    promptVersion: string;
    jobContentHashes?: ReadonlyMap<string, string>;
  }): Promise<Set<string>>;
  /**
   * (estimate, AI) pairs of a market since `since`, newest first: AI rows of
   * primary resumes that stored the estimate they were scored next to. With
   * `promptVersion`, only rows that scorer prompt wrote: two scorers put
   * their totals on two scales, and a map learned from both fits neither.
   */
  listCalibrationPairs(input: { market: Market; since: Date; limit: number; promptVersion?: string | null }): Promise<CalibrationPair[]>;
  /** One AppConfig value (the calibration document); null when the key is not stored. */
  getConfigValue(key: string): Promise<string | null>;
  setConfigValue(key: string, value: string): Promise<void>;
}

/** A stored row counts for a posting when it carries no hash (older than the column) or the posting's current one. */
export function jobHashCurrent(stored: string | null | undefined, current: string | null | undefined): boolean {
  return !stored || !current || stored === current;
}

/** A calibration pair from a stored row's numbers; null when the row carries no usable estimate. */
export function toCalibrationPair(row: { ai: unknown; estimateAtScore: unknown; dimensions: unknown }): CalibrationPair | null {
  const est = row.estimateAtScore && typeof row.estimateAtScore === 'object' ? (row.estimateAtScore as { score?: unknown }).score : null;
  if (typeof est !== 'number' || !Number.isFinite(est) || typeof row.ai !== 'number' || !Number.isFinite(row.ai)) return null;
  const components: CalibrationPair['components'] = {};
  if (Array.isArray(row.dimensions)) {
    for (const d of row.dimensions) {
      if (!d || typeof d !== 'object') continue;
      const { key, score, status } = d as { key?: unknown; score?: unknown; status?: unknown };
      if (status !== 'scored' || typeof score !== 'number' || !Number.isFinite(score)) continue;
      if (key === 'title_level' || key === 'skills' || key === 'industry' || key === 'logistics' || key === 'career_path') components[key] = score;
    }
  }
  return { estimate: est, ai: row.ai, components };
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
  salaryText: true,
  sponsorship: true,
  sponsorshipEvidence: true,
  marketTags: true,
  fraudFlags: true,
  archivedAt: true,
  // Market wave columns (MKT-0): carried now, read by later phases.
  skillIds: true,
  contentHash: true,
  lang: true,
  requirements: true,
  titleMatchScore: true,
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
 * The list projection: JOB_SELECT without the long text a list never reads.
 * The stored requirement lines are long text too (up to a dozen lines of the
 * posting): only the model call reads them, and a list never makes one.
 */
const { description: _d, descriptionPlain: _p, responsibilities: _r, benefits: _b, requirements: _q, ...FIT_JOB_SELECT } = JOB_SELECT;
type FitJobRow = Omit<JobRow, 'description' | 'descriptionPlain' | 'responsibilities' | 'benefits' | 'requirements'>;

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

    async getFitJobs(jobIds) {
      if (!jobIds.length) return [];
      const p = await db();
      const rows = (await p.rAJob.findMany({ where: { id: { in: jobIds } }, select: FIT_JOB_SELECT })) as unknown as FitJobRow[];
      return rows.map((r) => toRecord({ ...r, description: '', descriptionPlain: '', responsibilities: null, benefits: null, requirements: null }));
    },

    async getUserInputs(userId, market) {
      const p = await db();
      const [profile, education, experience, searchProfile] = await Promise.all([
        p.rAProfile.findUnique({
          where: { userId },
          select: { firstName: true, lastName: true, country: true, skills: true, workAuth: true, cnFields: true, headline: true, seekerType: true },
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
          jobContentHash: true,
          rubricVersion: true,
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
        jobContentHash: row.jobContentHash ?? null,
        rubricVersion: row.rubricVersion ?? null,
      };
      const saved = await p.rAJobMatchScore.upsert({
        where: { userId_jobId_resumeVariantId: { userId: row.userId, jobId: row.jobId, resumeVariantId: row.resumeVariantId } },
        create: { userId: row.userId, jobId: row.jobId, resumeVariantId: row.resumeVariantId, ...data },
        update: data,
      });
      return saved;
    },

    async saveJobRequirements(jobId, doc) {
      const p = await db();
      // One statement, so two first scores of one posting cannot both write: the row is updated only while it has no
      // list for this text. That is SQL NULL, a JSON null an earlier writer left, or a list whose content hash is not
      // this one (copied from an earlier text of the posting; a list with no hash reads as one). `updatedAt` is not
      // moved: the posting did not change.
      const written = await p.$executeRaw(Prisma.sql`
        UPDATE "RAJob"
        SET "requirements" = ${JSON.stringify(doc)}::jsonb
        WHERE "id" = ${jobId}
          AND ("requirements" IS NULL
            OR "requirements" = 'null'::jsonb
            OR ("requirements"->>'contentHash') IS DISTINCT FROM ${doc.contentHash})`);
      return written > 0;
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

    async listAiScores({ userId, jobIds, resumeVariantId, resumeContentHash }) {
      const out = new Map<string, StoredFitRow>();
      if (!jobIds.length) return out;
      const p = await db();
      const rows = await p.rAJobMatchScore.findMany({
        where: { userId, resumeVariantId, jobId: { in: jobIds }, scoreKind: 'ai', resumeContentHashAtScore: resumeContentHash },
        select: {
          jobId: true,
          resumeVariantId: true,
          score: true,
          tier: true,
          dimensions: true,
          generatedAt: true,
          modelUsed: true,
          promptVersion: true,
          jobContentHash: true,
          rubricVersion: true,
          searchProfileVersion: true,
          resumeContentHashAtScore: true,
        },
      });
      for (const { jobId, ...row } of rows) out.set(jobId, row);
      return out;
    },

    async freshAiScoredJobIds({ userId, jobIds, resumeVariantId, resumeContentHash, modelUsed, promptVersion, jobContentHashes }) {
      if (!jobIds.length) return new Set();
      const p = await db();
      const rows = await p.rAJobMatchScore.findMany({
        where: { userId, resumeVariantId, jobId: { in: jobIds }, resumeContentHashAtScore: resumeContentHash, modelUsed, promptVersion },
        select: { jobId: true, jobContentHash: true },
      });
      return new Set(rows.filter((r) => jobHashCurrent(r.jobContentHash, jobContentHashes?.get(r.jobId))).map((r) => r.jobId));
    },

    async listCalibrationPairs({ market, since, limit, promptVersion }) {
      const p = await db();
      const onePrompt = promptVersion ? Prisma.sql`AND s."promptVersion" = ${promptVersion}` : Prisma.empty;
      // Numbers only: the estimate stored at score time, the AI total and its components. No prose is read.
      const rows = await p.$queryRaw<Array<{ ai: number; estimateAtScore: unknown; dimensions: unknown }>>(Prisma.sql`
        SELECT s."score" AS "ai", s."explanation"->'estimateAtScore' AS "estimateAtScore", s."dimensions" AS "dimensions"
        FROM "RAJobMatchScore" s
        JOIN "RAJob" j ON j."id" = s."jobId"
        JOIN "RAResumeVariant" v ON v."id" = s."resumeVariantId"
        WHERE s."scoreKind" = 'ai'
          AND s."generatedAt" >= ${since}::timestamp(3)
          AND j."market" = ${market}
          AND v."isPrimary" = true
          AND v."deletedAt" IS NULL
          AND (s."explanation"->'estimateAtScore') IS NOT NULL
          ${onePrompt}
        ORDER BY s."generatedAt" DESC
        LIMIT ${Math.max(1, Math.floor(limit))}`);
      return rows.map((r) => toCalibrationPair(r)).filter((x): x is CalibrationPair => !!x);
    },

    async getConfigValue(key) {
      const p = await db();
      const row = await p.appConfig.findUnique({ where: { key }, select: { value: true } });
      return row?.value ?? null;
    },

    async setConfigValue(key, value) {
      const p = await db();
      await p.appConfig.upsert({ where: { key }, create: { key, value, updatedBy: 'score-precompute' }, update: { value, updatedBy: 'score-precompute' } });
    },
  };
}
