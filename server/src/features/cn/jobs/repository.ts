// server/src/features/cn/jobs/repository.ts — the RAJob side of GoApply
// anti-fraud, behind a narrow interface so the service and hooks are tested
// without a database. Typed Prisma only (TASK_PLAN.md §2.1 rule 5).
//   loadJob            — the columns the fraud check reads;
//   saveFraudFields    — fraudFlags / marketTags of one job;
//   closeAsFraud       — confirm: archive the job (closeReason 'reported');
//   listFlagged        — open cn jobs with fraud flags, by id (cursor);
//   jobsByIds          — rows for the review lists;
//   reportCounts       — fraud-type user reports per job (RAJobInteraction);
//   reportedJobIds     — open cn jobs with fraud-type reports;
//   openJobsOfEmployer — open cn jobs whose company name contains a string (blacklist sweep);
//   logCost            — UsageDeductionLog row for an LLM check;
//   userLabels         — admin name (else email) per user id, for "Cleared by …".

import type prismaClient from '../../../lib/prisma.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { logger } from '../../../services/LoggerService.js';
import type { DeductionSku } from '../../../lib/matchBilling.js';

/** Feed report reasons (features/feed/contract.ts REPORT_REASONS) that feed the anti-fraud list (F-FEED-12 cn). */
export const FRAUD_REPORT_REASONS = ['scam', 'training_loan', 'pay_to_work', 'fee_required'] as const;

/**
 * The fraud check's own cost SKU (registered in raFeatureCatalog.ts and the
 * DeductionSku union): a platform cost under the brand's system user, shown
 * apart from job enrichment. `metadata.task` is kept for rows written before
 * the SKU existed (those sit under `ra_job_enrich`).
 */
export const FRAUD_COST_SKU = 'ra_cn_fraud_check' satisfies DeductionSku;

export interface CnFraudJob {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  sourceBoard: string;
  externalId: string;
  title: string;
  companyName: string;
  companyNameNormalized: string;
  sourceName: string | null;
  description: string;
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  fraudFlags: unknown;
  marketTags: unknown;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface FraudCostEntry {
  userId: string;
  jobId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requestId: string | null;
}

export interface CnJobsRepository {
  loadJob(jobId: string): Promise<CnFraudJob | null>;
  saveFraudFields(jobId: string, data: { fraudFlags?: unknown; marketTags?: unknown }): Promise<void>;
  closeAsFraud(jobId: string, at: Date): Promise<void>;
  listFlagged(options: { afterId: string | null; take: number }): Promise<CnFraudJob[]>;
  jobsByIds(ids: readonly string[]): Promise<CnFraudJob[]>;
  reportCounts(jobIds: readonly string[]): Promise<Map<string, { count: number; firstAt: Date | null }>>;
  reportedJobIds(limit: number): Promise<string[]>;
  openJobsOfEmployer(nameContains: string, take: number): Promise<CnFraudJob[]>;
  logCost(entry: FraudCostEntry): Promise<void>;
  /** Display label (name, else email) per user id; unknown ids are absent. */
  userLabels(userIds: readonly string[]): Promise<Map<string, string>>;
}

export type CnJobsDb = Pick<typeof prismaClient, 'rAJob' | 'rAJobInteraction' | 'usageDeductionLog' | 'user'>;

const JOB_SELECT = {
  id: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  sourceBoard: true,
  externalId: true,
  title: true,
  companyName: true,
  companyNameNormalized: true,
  sourceName: true,
  description: true,
  descriptionPlain: true,
  qualifications: true,
  responsibilities: true,
  benefits: true,
  fraudFlags: true,
  marketTags: true,
  archivedAt: true,
  createdAt: true,
} as const;

function json(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null || v === undefined ? Prisma.DbNull : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
}

export function createPrismaCnJobsRepository(getDb: () => Promise<CnJobsDb>): CnJobsRepository {
  return {
    async loadJob(jobId) {
      const db = await getDb();
      return db.rAJob.findUnique({ where: { id: jobId }, select: JOB_SELECT });
    },
    async saveFraudFields(jobId, data) {
      const db = await getDb();
      const update: Prisma.RAJobUpdateInput = {};
      if (data.fraudFlags !== undefined) update.fraudFlags = json(data.fraudFlags);
      if (data.marketTags !== undefined) update.marketTags = json(data.marketTags);
      if (Object.keys(update).length === 0) return;
      await db.rAJob.update({ where: { id: jobId }, data: update, select: { id: true } });
    },
    async closeAsFraud(jobId, at) {
      const db = await getDb();
      await db.rAJob.update({ where: { id: jobId }, data: { archivedAt: at, closedAt: at, closeReason: 'reported' }, select: { id: true } });
    },
    async listFlagged({ afterId, take }) {
      const db = await getDb();
      return db.rAJob.findMany({
        where: { market: 'cn', archivedAt: null, NOT: { fraudFlags: { equals: Prisma.DbNull } }, ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        take,
        select: JOB_SELECT,
      });
    },
    async jobsByIds(ids) {
      if (!ids.length) return [];
      const db = await getDb();
      return db.rAJob.findMany({ where: { id: { in: [...ids] }, market: 'cn' }, select: JOB_SELECT });
    },
    async reportCounts(jobIds) {
      const out = new Map<string, { count: number; firstAt: Date | null }>();
      if (!jobIds.length) return out;
      const db = await getDb();
      const rows = await db.rAJobInteraction.groupBy({
        by: ['jobId'],
        where: { jobId: { in: [...jobIds] }, kind: 'report', reasonCode: { in: [...FRAUD_REPORT_REASONS] } },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      for (const r of rows) out.set(r.jobId, { count: r._count._all, firstAt: r._min.createdAt ?? null });
      return out;
    },
    async reportedJobIds(limit) {
      const db = await getDb();
      const rows = await db.rAJobInteraction.findMany({
        where: { kind: 'report', reasonCode: { in: [...FRAUD_REPORT_REASONS] } },
        distinct: ['jobId'],
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { jobId: true },
      });
      if (!rows.length) return [];
      const open = await db.rAJob.findMany({
        where: { id: { in: rows.map((r) => r.jobId) }, market: 'cn', archivedAt: null },
        select: { id: true },
      });
      return open.map((r) => r.id);
    },
    async openJobsOfEmployer(nameContains, take) {
      const db = await getDb();
      return db.rAJob.findMany({
        where: { market: 'cn', archivedAt: null, companyName: { contains: nameContains, mode: 'insensitive' } },
        take,
        select: JOB_SELECT,
      });
    },
    async logCost(entry) {
      try {
        const db = await getDb();
        await db.usageDeductionLog.create({
          data: {
            userId: entry.userId,
            sku: FRAUD_COST_SKU,
            source: 'free_tier',
            units: 1,
            platformCostUsd: entry.costUsd,
            requestId: entry.requestId,
            relatedEntityType: 'job',
            relatedEntityId: entry.jobId,
            metadata: { task: 'cn_fraud_check', brand: 'goapply', market: 'cn', model: entry.model, promptTokens: entry.promptTokens, completionTokens: entry.completionTokens },
          },
          select: { id: true },
        });
      } catch (err) {
        logger.error('CN_JOBS', 'failed to write the fraud-check cost row', { jobId: entry.jobId, error: err instanceof Error ? err.message : String(err) });
      }
    },
    async userLabels(userIds) {
      const out = new Map<string, string>();
      if (!userIds.length) return out;
      const db = await getDb();
      const rows = await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true } });
      for (const r of rows) {
        const label = r.name?.trim() || r.email;
        if (label) out.set(r.id, label);
      }
      return out;
    },
  };
}

let defaultRepo: CnJobsRepository | null = null;
export function defaultCnJobsRepository(): CnJobsRepository {
  return (defaultRepo ??= createPrismaCnJobsRepository(async () => (await import('../../../lib/prisma.js')).default));
}
