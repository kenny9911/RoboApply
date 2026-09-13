import prisma from '../lib/prisma.js';
import { JobSearchAccessError } from './keys.js';

const ENDPOINT = '/api/v1/job-search/search';
function configuredLimit(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export class SearchQuotaError extends JobSearchAccessError {
  constructor(public retryAfter: number) {
    super('rate_limited', 429, 'Search limit reached. Retry after the indicated interval.');
  }
}

/** Durable reservations count attempts, including cached and failed searches. */
export class JobSearchQuota {
  constructor(private readonly db = prisma) {}

  async reserve(userId: string, apiKeyId?: string, requestId?: string) {
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const minute = new Date(now.getTime() - 60_000);
    const dayRetry = Math.ceil((day.getTime() + 86_400_000 - now.getTime()) / 1000);
    return this.db.$transaction(async (tx) => {
      // One lock covers both website and partner requests on every instance.
      // No upstream work occurs inside this short transaction.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'job-search-quota:v1'}))::text`;
      const [daily, burst, global] = await Promise.all([
        tx.apiUsageRecord.count({ where: { endpoint: ENDPOINT, userId, createdAt: { gte: day } } }),
        tx.apiUsageRecord.count({ where: { endpoint: ENDPOINT, userId, createdAt: { gte: minute } } }),
        tx.apiUsageRecord.count({ where: { endpoint: ENDPOINT, createdAt: { gte: day } } }),
      ]);
      if (burst >= configuredLimit('JOB_SEARCH_USER_PER_MINUTE', 10)) throw new SearchQuotaError(60);
      if (daily >= configuredLimit('JOB_SEARCH_USER_DAILY_LIMIT', 100) ||
          global >= configuredLimit('JOB_SEARCH_GLOBAL_DAILY_LIMIT', 250)) throw new SearchQuotaError(dayRetry);
      const record = await tx.apiUsageRecord.create({ data: {
        userId, apiKeyId, requestId, endpoint: ENDPOINT, method: 'POST',
        statusCode: 102, provider: 'job-search',
      }, select: { id: true } });
      return record.id;
    }, { isolationLevel: 'ReadCommitted' });
  }

  async finish(id: string, statusCode: number, durationMs: number, apiKeyId?: string) {
    await this.db.apiUsageRecord.update({ where: { id }, data: { statusCode, durationMs } });
    if (apiKeyId) await this.db.apiKey.update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } });
  }
}

export const jobSearchQuota = new JobSearchQuota();
