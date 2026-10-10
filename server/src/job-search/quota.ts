import prisma from '../lib/prisma.js';
import { JobSearchAccessError } from './keys.js';
import { BRAND_IDS, DEFAULT_BRAND, brandEnv, getCurrentBrandOrDefault, type ProductBrand } from '../platform/brand/index.js';

const ENDPOINT = '/api/v1/job-search/search';
/**
 * A limit of the brand the reservation is for. GoApply reads its own value
 * when one is set (`CN_<NAME>`), else the shared one (platform/brand brandEnv),
 * so the two brands can be given different budgets.
 */
function configuredLimit(brand: ProductBrand, name: string, fallback: number) {
  const raw = brandEnv(brand, name, process.env);
  const value = raw ? Number(raw) : fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The accounts whose reservations count against a brand's deployment budget.
 * Each brand has its own sources and its own budget: RoboApply's cap bounds
 * its paid provider calls, GoApply's searches read our own index. So one
 * brand's traffic never spends the other's budget, on a shared database too.
 * An account whose stored brand is not a known one is a RoboApply account
 * (the same rule as keys.ts).
 */
function brandAccounts(brand: ProductBrand) {
  return brand.id === DEFAULT_BRAND
    ? { brand: { notIn: BRAND_IDS.filter((id) => id !== DEFAULT_BRAND) } }
    : { brand: brand.id };
}

export class SearchQuotaError extends JobSearchAccessError {
  constructor(public retryAfter: number) {
    super('rate_limited', 429, 'Search limit reached. Retry after the indicated interval.');
  }
}

/** Durable reservations count attempts, including cached and failed searches. */
export class JobSearchQuota {
  constructor(private readonly db = prisma) {}

  /** `brand` is the brand the search is for (default: the brand of the current request). */
  async reserve(userId: string, apiKeyId?: string, requestId?: string, brand: ProductBrand = getCurrentBrandOrDefault()) {
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
        // The deployment budget of this brand only (see brandAccounts).
        tx.apiUsageRecord.count({ where: { endpoint: ENDPOINT, createdAt: { gte: day }, user: brandAccounts(brand) } }),
      ]);
      if (burst >= configuredLimit(brand, 'JOB_SEARCH_USER_PER_MINUTE', 10)) throw new SearchQuotaError(60);
      if (daily >= configuredLimit(brand, 'JOB_SEARCH_USER_DAILY_LIMIT', 100) ||
          global >= configuredLimit(brand, 'JOB_SEARCH_GLOBAL_DAILY_LIMIT', 250)) throw new SearchQuotaError(dayRetry);
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
