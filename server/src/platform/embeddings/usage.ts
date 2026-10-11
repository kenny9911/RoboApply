// server/src/platform/embeddings/usage.ts
//
// The cost row of one embeddings call: one `UsageDeductionLog` row, SKU
// `ra_embed`, units = the tokens the endpoint reported, under the brand's
// system user (GoApply: CN_RA_SYSTEM_USER_ID when set, else the shared
// RA_SYSTEM_USER_ID, else the shared-cost sentinel), the same place the job
// enrichment cost rows go. An embedding is a platform cost, never a user credit.
//
// The cost in USD is written only when the model has a price read from its
// vendor (lib/modelPricing.ts `calculateEmbeddingCost`) AND the call went to
// that vendor's own host: the prices on file are OpenAI's list prices, read
// for api.openai.com. The same model id served by a gateway (OpenRouter, a
// proxy behind OPENAI_BASE_URL or EMBED_BASE_URL) is billed by the gateway at
// its own rate. Without a price the row still carries the tokens and says the
// cost is unknown: no assumed price (D3).
//
// A failed write is logged and never thrown: a lost audit row must not fail
// the work. A system user id that names no account is reported once an hour,
// not once per call.

import { brandEnv, type EnvSource } from '../brand/brandEnv.js';
import { getBrand, type BrandId, type Market } from '../brand/registry.js';
import { calculateEmbeddingCost } from '../../lib/modelPricing.js';
import { SHARED_COST_USER_ID } from '../../roboapply/v2/lib/raFeatureCatalog.js';
import { logger } from '../../services/LoggerService.js';

export const EMBED_COST_SKU = 'ra_embed';

/** Endpoint hosts whose list prices `calculateEmbeddingCost` holds. */
export const EMBEDDING_PRICED_HOSTS: ReadonlySet<string> = new Set(['api.openai.com']);

export interface EmbeddingUsageEntry {
  brand: BrandId;
  market: Market;
  /** `<model>@1024`. */
  modelTag: string;
  /** The model id sent to the endpoint. */
  wireModel: string;
  /** Host of the endpoint the call went to (lower case); null when it could not be read. */
  host: string | null;
  purpose: 'job' | 'user' | 'query' | 'skill';
  /** Tokens the endpoint reported (0 when it reported none). */
  tokens: number;
  /** False when at least one response carried no usage field. */
  usageReported: boolean;
  inputs: number;
  requests: number;
  /** The person the call was made for, when there is one (kept as the related entity; the row's owner is the system user). */
  userId: string | null;
  requestId: string | null;
  env?: EnvSource;
}

/** The row as it is written (exported so a test can state it without a database). */
export function embeddingUsageRow(entry: EmbeddingUsageEntry) {
  const pricedHost = !!entry.host && EMBEDDING_PRICED_HOSTS.has(entry.host.toLowerCase());
  const costUsd = entry.usageReported && pricedHost ? calculateEmbeddingCost(entry.modelTag, entry.tokens) : null;
  return {
    userId: brandEnv(getBrand(entry.brand), 'RA_SYSTEM_USER_ID', entry.env ?? process.env) ?? SHARED_COST_USER_ID,
    sku: EMBED_COST_SKU,
    source: 'free_tier',
    units: entry.tokens,
    platformCostUsd: costUsd,
    requestId: entry.requestId,
    relatedEntityType: entry.userId ? 'user' : null,
    relatedEntityId: entry.userId,
    metadata: {
      brand: entry.brand,
      market: entry.market,
      model: entry.modelTag,
      wireModel: entry.wireModel,
      host: entry.host,
      purpose: entry.purpose,
      promptTokens: entry.tokens,
      usageReported: entry.usageReported,
      inputs: entry.inputs,
      requests: entry.requests,
      costSource: costUsd === null ? 'unknown' : 'vendor_list_price',
    },
  };
}

const MISSING_USER_RECHECK_MS = 60 * 60_000;
const missingCostUsers = new Map<string, number>();

/** Tests only. */
export function resetMissingEmbeddingCostUsersForTests(): void {
  missingCostUsers.clear();
}

function isMissingUser(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { field_name?: unknown; constraint?: unknown } } | null;
  if (!e || typeof e !== 'object') return false;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.meta?.field_name === 'string' ? e.meta.field_name : ''} ${typeof e.meta?.constraint === 'string' ? e.meta.constraint : ''}`;
  return (e.code === 'P2003' || /foreign key constraint/i.test(text)) && /userId/i.test(text);
}

export type EmbeddingUsageDb = { usageDeductionLog: { create(args: { data: ReturnType<typeof embeddingUsageRow>; select: { id: true } }): Promise<unknown> } };

export function createEmbeddingUsageLog(getDb: () => Promise<EmbeddingUsageDb>, now: () => number = Date.now) {
  return async (entry: EmbeddingUsageEntry): Promise<void> => {
    const row = embeddingUsageRow(entry);
    const skipUntil = missingCostUsers.get(row.userId);
    if (skipUntil !== undefined) {
      if (now() < skipUntil) return;
      missingCostUsers.delete(row.userId);
    }
    try {
      await (await getDb()).usageDeductionLog.create({ data: row, select: { id: true } });
    } catch (err) {
      if (isMissingUser(err)) {
        missingCostUsers.set(row.userId, now() + MISSING_USER_RECHECK_MS);
        logger.warn('EMBEDDINGS', 'embedding cost rows are not being written: the system user id names no account. Set RA_SYSTEM_USER_ID (CN_RA_SYSTEM_USER_ID for GoApply) to a real user; rows are skipped until then', {
          userId: row.userId,
          brand: entry.brand,
        });
        return;
      }
      logger.error('EMBEDDINGS', 'failed to write the embedding cost row', { brand: entry.brand, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export const defaultEmbeddingUsageLog = createEmbeddingUsageLog(async () => (await import('../../lib/prisma.js')).default as unknown as EmbeddingUsageDb);
