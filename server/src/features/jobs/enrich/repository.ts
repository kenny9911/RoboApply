// server/src/features/jobs/enrich/repository.ts
//
// The database side of enrichment, behind a narrow interface so the service
// is tested without a database. Typed Prisma only (TASK_PLAN.md §2.1 rule 5).
//   loadJob      — the RAJob columns enrichment reads (and the place and link
//                  columns the market hooks need, so they do not re-read the row);
//                  from ENRICH_VERSION 2 it selects `titleMatchScore`, and from
//                  version 3 `skillIds`, `requirements` and `sponsorshipSource`,
//                  so the database needs the SCHEMA-7 push before this code runs;
//   clearedScamRules — the scam rules an admin cleared when restoring the job
//                  (RAJobReview, the latest 'restore'): never raised again;
//   saveJob      — one RAJob update with the reconciled columns (version 3:
//                  `skillIds` and `sponsorshipSource` among them). The requirement
//                  list (`requirements`, SM-8) is written by a second statement
//                  that holds only while the row's list is still what enrichment
//                  read: the scorer stores a list when a row has none, and the
//                  first writer wins;
//   saveKeywords — upsert the job's RAKeywordExtraction row (top 30). A rewrite
//                  that made no model call of its own keeps the stored model
//                  and cost (`keepModelAndCost`);
//   logCost      — one UsageDeductionLog row, SKU `ra_job_enrich`, under the
//                  brand's system user (ARCH §4.5 step 4). Failures are logged,
//                  never thrown: a lost audit row must not fail the job.

import prisma from '../../../lib/prisma.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { logger } from '../../../services/LoggerService.js';
import type { EnrichJobRecord, EnrichUpdate } from './reconcile.js';
import type { JobKeyword } from './keywords.js';

export const ENRICH_COST_SKU = 'ra_job_enrich';

export interface KeywordRow {
  keywords: JobKeyword[];
  modelUsed: string;
  /** USD; null when no model ran. */
  tokenCost: number | null;
  generatedAt: Date;
  /**
   * True for a rewrite that made no model call of its own (a skills-only
   * pass): an existing row keeps the model and the cost of the pass that paid
   * for it, and only its keywords and date change. A row that does not exist
   * yet is created with `modelUsed` and `tokenCost` as given.
   */
  keepModelAndCost?: boolean;
}

export interface EnrichCostEntry {
  userId: string;
  jobId: string;
  brand: string;
  market: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requestId: string | null;
}

export interface EnrichRepository {
  loadJob(jobId: string): Promise<EnrichJobRecord | null>;
  /**
   * International scam rule ids an admin cleared on the job's latest
   * 'restore' decision (admin "Keep", RAJobReview.clearedRules). Re-enrichment
   * must not bring them back. Optional so a caller's own repository double
   * need not model it (absent = nothing cleared).
   */
  clearedScamRules?(jobId: string): Promise<string[]>;
  saveJob(jobId: string, update: EnrichUpdate): Promise<void>;
  saveKeywords(jobId: string, row: KeywordRow): Promise<void>;
  logCost(entry: EnrichCostEntry): Promise<void>;
}

export type EnrichDb = Pick<typeof prisma, 'rAJob' | 'rAKeywordExtraction' | 'usageDeductionLog' | 'rAJobReview'>;

const JOB_SELECT = {
  id: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  sourceBoard: true,
  title: true,
  titleNormalized: true,
  companyName: true,
  companyNameNormalized: true,
  description: true,
  descriptionPlain: true,
  qualifications: true,
  responsibilities: true,
  benefits: true,
  taxonomyIds: true,
  primaryTaxonomyId: true,
  seniority: true,
  educationLevel: true,
  skills: true,
  skillsDetail: true,
  // SM-6, SM-8: the canonical ids the row holds (a skill is counted once per posting) and the stored requirement list.
  skillIds: true,
  requirements: true,
  sponsorship: true,
  sponsorshipEvidence: true,
  // JI-11: who states the sponsorship value (a provider's reading is never cleared by enrichment).
  sponsorshipSource: true,
  citizenshipRequired: true,
  clearanceRequired: true,
  employerTags: true,
  fraudFlags: true,
  marketTags: true,
  summary: true,
  enrichedAt: true,
  enrichVersion: true,
  enrichModel: true,
  archivedAt: true,
  // The company row the employer's industry is written to, and the stored strength of the title match (SM-10, SM-2).
  companyId: true,
  titleMatchScore: true,
  // For marketHooks.afterEnrich (WP-42: is the job in Taiwan, and which link backs a quoted tag).
  locationCountry: true,
  locations: true,
  sourceUrl: true,
  applyUrl: true,
} as const satisfies Prisma.RAJobSelect;

function json(value: unknown[] | object | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * The `where` of the requirement write: the row, and what its list was when
 * enrichment read it (`requirementsWere`: null = it had none, a string = the
 * content hash of the list it had, absent = whatever it holds).
 */
export function requirementsWhere(jobId: string, were: string | null | undefined): Prisma.RAJobWhereInput {
  if (were === undefined) return { id: jobId };
  if (were === null) return { id: jobId, requirements: { equals: Prisma.DbNull } };
  return { id: jobId, requirements: { path: ['contentHash'], equals: were } };
}

/**
 * The Prisma `data` for an EnrichUpdate (absent keys stay unchanged). The
 * requirement list is not part of it: `saveJob` writes it with its own guard.
 */
export function toJobUpdateData(update: EnrichUpdate): Prisma.RAJobUpdateInput {
  const data: Prisma.RAJobUpdateInput = {};
  if (update.taxonomyIds !== undefined) data.taxonomyIds = { set: update.taxonomyIds };
  if (update.primaryTaxonomyId !== undefined) data.primaryTaxonomyId = update.primaryTaxonomyId;
  if (update.titleMatchScore !== undefined) data.titleMatchScore = update.titleMatchScore;
  if (update.seniority !== undefined) data.seniority = update.seniority;
  if (update.educationLevel !== undefined) data.educationLevel = update.educationLevel;
  if (update.skills !== undefined) data.skills = { set: update.skills };
  if (update.skillsDetail !== undefined) data.skillsDetail = json(update.skillsDetail);
  if (update.skillIds !== undefined) data.skillIds = { set: update.skillIds };
  if (update.sponsorship !== undefined) data.sponsorship = update.sponsorship;
  if (update.sponsorshipEvidence !== undefined) data.sponsorshipEvidence = update.sponsorshipEvidence;
  if (update.sponsorshipSource !== undefined) data.sponsorshipSource = update.sponsorshipSource;
  if (update.citizenshipRequired !== undefined) data.citizenshipRequired = update.citizenshipRequired;
  if (update.clearanceRequired !== undefined) data.clearanceRequired = update.clearanceRequired;
  if (update.employerTags !== undefined) data.employerTags = { set: update.employerTags };
  if (update.marketTags !== undefined) data.marketTags = json(update.marketTags);
  if (update.fraudFlags !== undefined) data.fraudFlags = json(update.fraudFlags);
  if (update.summary !== undefined) data.summary = update.summary;
  if (update.searchText !== undefined) data.searchText = update.searchText;
  if (update.enrichedAt !== undefined) data.enrichedAt = update.enrichedAt;
  if (update.enrichVersion !== undefined) data.enrichVersion = update.enrichVersion;
  if (update.enrichModel !== undefined) data.enrichModel = update.enrichModel;
  return data;
}

/** How long a cost user found missing is not tried again (a user created meanwhile is picked up without a restart). */
export const MISSING_COST_USER_RECHECK_MS = 60 * 60_000;
/** Cost user ids the database has no account for → when to try again (process-wide: one warning per id per window). */
const missingCostUsers = new Map<string, number>();
const now = () => Date.now();

/** Tests only. */
export function resetMissingCostUsersForTests(): void {
  missingCostUsers.clear();
}

/** The foreign key from a usage row to its user failed (Prisma P2003 on `userId`). */
function isMissingUser(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { field_name?: unknown; constraint?: unknown } } | null;
  if (!e || typeof e !== 'object') return false;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.meta?.field_name === 'string' ? e.meta.field_name : ''} ${typeof e.meta?.constraint === 'string' ? e.meta.constraint : ''}`;
  return (e.code === 'P2003' || /foreign key constraint/i.test(text)) && /userId/i.test(text);
}

export function createPrismaEnrichRepository(db: EnrichDb = prisma): EnrichRepository {
  return {
    async loadJob(jobId) {
      return db.rAJob.findUnique({ where: { id: jobId }, select: JOB_SELECT });
    },
    async clearedScamRules(jobId) {
      const row = await db.rAJobReview.findFirst({
        where: { jobId, decision: 'restore' },
        orderBy: { at: 'desc' },
        select: { clearedRules: true },
      });
      return row?.clearedRules ?? [];
    },
    async saveJob(jobId, update) {
      const data = toJobUpdateData(update);
      if (Object.keys(data).length > 0) await db.rAJob.update({ where: { id: jobId }, data, select: { id: true } });
      // A list another writer stored since the row was read is left alone (no row matches).
      if (update.requirements !== undefined) {
        await db.rAJob.updateMany({ where: requirementsWhere(jobId, update.requirementsWere), data: { requirements: json(update.requirements) } });
      }
    },
    async saveKeywords(jobId, row) {
      const keywords = JSON.parse(JSON.stringify(row.keywords)) as Prisma.InputJsonValue;
      await db.rAKeywordExtraction.upsert({
        where: { jobId },
        create: { jobId, keywords, modelUsed: row.modelUsed, tokenCost: row.tokenCost, generatedAt: row.generatedAt },
        update: row.keepModelAndCost ? { keywords, generatedAt: row.generatedAt } : { keywords, modelUsed: row.modelUsed, tokenCost: row.tokenCost, generatedAt: row.generatedAt },
        select: { id: true },
      });
    },
    async logCost(entry) {
      // The cost user is not a real account here: said once (see below), then skipped.
      const skipUntil = missingCostUsers.get(entry.userId);
      if (skipUntil !== undefined) {
        if (now() < skipUntil) return;
        missingCostUsers.delete(entry.userId);
      }
      try {
        await db.usageDeductionLog.create({
          data: {
            userId: entry.userId,
            sku: ENRICH_COST_SKU,
            source: 'free_tier',
            units: 1,
            platformCostUsd: entry.costUsd,
            requestId: entry.requestId,
            relatedEntityType: 'job',
            relatedEntityId: entry.jobId,
            metadata: {
              brand: entry.brand,
              market: entry.market,
              model: entry.model,
              promptTokens: entry.promptTokens,
              completionTokens: entry.completionTokens,
            },
          },
          select: { id: true },
        });
      } catch (err) {
        if (isMissingUser(err)) {
          // Configuration, not a failure of this job: the system user id (RA_SYSTEM_USER_ID /
          // CN_RA_SYSTEM_USER_ID, OPS-A2) is unset or names no account. One warning, not an error per job.
          missingCostUsers.set(entry.userId, now() + MISSING_COST_USER_RECHECK_MS);
          logger.warn('JOB_ENRICH', 'enrichment cost rows are not being written: the system user id names no account. Set RA_SYSTEM_USER_ID (CN_RA_SYSTEM_USER_ID for GoApply) to a real user; rows are skipped until then', {
            userId: entry.userId,
            brand: entry.brand,
            recheckInMinutes: MISSING_COST_USER_RECHECK_MS / 60_000,
          });
          return;
        }
        logger.error('JOB_ENRICH', 'failed to write the enrichment cost row', {
          jobId: entry.jobId,
          userId: entry.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
