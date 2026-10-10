// server/src/features/jobs/enrich/repository.ts
//
// The database side of enrichment, behind a narrow interface so the service
// is tested without a database. Typed Prisma only (TASK_PLAN.md §2.1 rule 5).
//   loadJob      — the RAJob columns enrichment reads (and the place and link
//                  columns the market hooks need, so they do not re-read the row);
//   clearedScamRules — the scam rules an admin cleared when restoring the job
//                  (RAJobReview, the latest 'restore'): never raised again;
//   saveJob      — one RAJob update with the reconciled columns;
//   saveKeywords — upsert the job's RAKeywordExtraction row (top 30);
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
  sponsorship: true,
  sponsorshipEvidence: true,
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
  // For marketHooks.afterEnrich (WP-42: is the job in Taiwan, and which link backs a quoted tag).
  locationCountry: true,
  locations: true,
  sourceUrl: true,
  applyUrl: true,
} as const satisfies Prisma.RAJobSelect;

function json(value: unknown[] | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** The Prisma `data` for an EnrichUpdate (absent keys stay unchanged). */
export function toJobUpdateData(update: EnrichUpdate): Prisma.RAJobUpdateInput {
  const data: Prisma.RAJobUpdateInput = {};
  if (update.taxonomyIds !== undefined) data.taxonomyIds = { set: update.taxonomyIds };
  if (update.primaryTaxonomyId !== undefined) data.primaryTaxonomyId = update.primaryTaxonomyId;
  if (update.seniority !== undefined) data.seniority = update.seniority;
  if (update.educationLevel !== undefined) data.educationLevel = update.educationLevel;
  if (update.skills !== undefined) data.skills = { set: update.skills };
  if (update.skillsDetail !== undefined) data.skillsDetail = json(update.skillsDetail);
  if (update.sponsorship !== undefined) data.sponsorship = update.sponsorship;
  if (update.sponsorshipEvidence !== undefined) data.sponsorshipEvidence = update.sponsorshipEvidence;
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
      if (Object.keys(data).length === 0) return;
      await db.rAJob.update({ where: { id: jobId }, data, select: { id: true } });
    },
    async saveKeywords(jobId, row) {
      const keywords = JSON.parse(JSON.stringify(row.keywords)) as Prisma.InputJsonValue;
      await db.rAKeywordExtraction.upsert({
        where: { jobId },
        create: { jobId, keywords, modelUsed: row.modelUsed, tokenCost: row.tokenCost, generatedAt: row.generatedAt },
        update: { keywords, modelUsed: row.modelUsed, tokenCost: row.tokenCost, generatedAt: row.generatedAt },
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
