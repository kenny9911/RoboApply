/**
 * LLM stack config resolver — DB-backed overrides with env fallback.
 *
 * Mirrors services/agentAlex/configResolver.ts: a 30s-TTL in-memory snapshot
 * per active environment, a sync getter for the hot path, a fire-and-forget
 * background refresh, env-default fallback on cold cache / DB error, and
 * invalidate-on-save so admin edits land within ~1s.
 *
 * The cached blob is OVERRIDES ONLY (nullable fields). The accessor in
 * llmModels.ts applies `override ?? env`, so a cold/empty cache degrades to
 * pure-env behaviour — never a hard failure.
 */

import { prisma } from '../prisma.js';
import { logger } from '../../services/LoggerService.js';
import {
  appConfigKeyFor,
  emptyLlmStackBlob,
  getActiveEnvironment,
  isDbConfigDisabled,
  MODEL_ENV,
  PURPOSE_KEYS,
  parseLlmStackBlob,
  type ConfigEnvironment,
  type LlmStackBrand,
  type LlmStackConfigBlob,
} from './llmStackConfigSchema.js';

const CACHE_TTL_MS = 30_000;
const STALE_TTL_MS = 10_000;

interface CachedSnapshot {
  blob: LlmStackConfigBlob;
  fetchedAt: number;
  expiresAt: number;
  source: 'db' | 'empty';
}

// One snapshot per brand (WP-14): GoApply's overrides live under their own
// AppConfig key and are never read for RoboApply, nor the other way round.
const activeCaches = new Map<LlmStackBrand, CachedSnapshot>();

/* ── Read API ─────────────────────────────────────────────────────────────── */

export async function getLlmStack(brandId: LlmStackBrand = 'roboapply'): Promise<LlmStackConfigBlob> {
  if (isDbConfigDisabled()) return emptyLlmStackBlob();
  const now = Date.now();
  const cached = activeCaches.get(brandId);
  if (cached && cached.expiresAt > now) return cached.blob;

  const env = getActiveEnvironment();
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: appConfigKeyFor(env, brandId) } });
    const parsed = parseLlmStackBlob(row?.value);
    const blob = parsed || emptyLlmStackBlob();
    activeCaches.set(brandId, { blob, fetchedAt: now, expiresAt: now + CACHE_TTL_MS, source: parsed ? 'db' : 'empty' });
    return blob;
  } catch {
    const blob = cached?.blob || emptyLlmStackBlob();
    activeCaches.set(brandId, { blob, fetchedAt: now, expiresAt: now + STALE_TTL_MS, source: 'empty' });
    return blob;
  }
}

/**
 * Synchronous accessor for the hot path (provider/model resolution). Returns
 * the cached overrides blob of one brand; on cold cache returns an all-null
 * blob (⇒ env fallback in the accessor) and warms in the background.
 */
export function getLlmStackSync(brandId: LlmStackBrand = 'roboapply'): LlmStackConfigBlob {
  if (isDbConfigDisabled()) return emptyLlmStackBlob();
  const cached = activeCaches.get(brandId);
  if (cached) {
    if (cached.expiresAt <= Date.now()) void getLlmStack(brandId).catch(() => {});
    return cached.blob;
  }
  void getLlmStack(brandId).catch(() => {});
  return emptyLlmStackBlob();
}

/** Read a specific environment's stored blob (admin UI). No caching. */
export async function getLlmStackForEnvironment(
  env: ConfigEnvironment,
  brandId: LlmStackBrand = 'roboapply',
): Promise<{
  blob: LlmStackConfigBlob;
  source: 'db' | 'empty';
  updatedAt: Date | null;
  updatedBy: string | null;
}> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: appConfigKeyFor(env, brandId) } });
    const parsed = parseLlmStackBlob(row?.value);
    if (parsed) {
      return { blob: parsed, source: 'db', updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
    }
    return { blob: emptyLlmStackBlob(), source: 'empty', updatedAt: null, updatedBy: null };
  } catch {
    return { blob: emptyLlmStackBlob(), source: 'empty', updatedAt: null, updatedBy: null };
  }
}

/* ── Write API ────────────────────────────────────────────────────────────── */

/** Human-readable diff between two override blobs (for the audit reason). */
export function diffLlmStack(prev: LlmStackConfigBlob | null, next: LlmStackConfigBlob): string[] {
  const before = prev ?? emptyLlmStackBlob();
  const diffs: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown) => {
    if ((a ?? null) !== (b ?? null)) diffs.push(`${label}: ${a ?? '(inherit)'} → ${b ?? '(inherit)'}`);
  };
  cmp('provider', before.provider, next.provider);
  cmp('defaultModel', before.defaultModel, next.defaultModel);
  cmp('fallbackModel', before.fallbackModel, next.fallbackModel);
  for (const k of PURPOSE_KEYS) cmp(`purposes.${k}`, before.purposes[k], next.purposes[k]);
  for (const k of ['retryAttempts', 'retryBaseMs', 'retryMaxMs', 'timeoutMs'] as const) {
    cmp(`tuning.${k}`, before.tuning[k], next.tuning[k]);
  }
  return diffs;
}

/** Persist a blob for an env, write an AdminAdjustment audit row, invalidate cache. */
export async function saveLlmStack(
  env: ConfigEnvironment,
  blob: LlmStackConfigBlob,
  adminId: string,
  reason: string,
  brandId: LlmStackBrand = 'roboapply',
): Promise<{ previous: LlmStackConfigBlob | null; diffs: string[] }> {
  const key = appConfigKeyFor(env, brandId);
  const before = await prisma.appConfig.findUnique({ where: { key } });
  const previous = parseLlmStackBlob(before?.value);
  const diffs = diffLlmStack(previous, blob);

  await prisma.appConfig.upsert({
    where: { key },
    update: { value: JSON.stringify(blob), updatedBy: adminId },
    create: { key, value: JSON.stringify(blob), updatedBy: adminId },
  });

  // Audit — the blob is NON-SECRET (no API keys live here; those are in
  // SystemLLMKey). Storing the full before/after is safe and useful for restore.
  // Best-effort: never fail the save if the audit write hiccups.
  await prisma.adminAdjustment
    .create({
      data: {
        userId: adminId, // self-action — config change, no per-user target
        adminId,
        type: brandId === 'roboapply' ? `llm_stack_config:${env}` : `llm_stack_config:${brandId}:${env}`,
        oldValue: previous ? JSON.stringify(previous) : null,
        newValue: JSON.stringify(blob),
        reason: `${reason}${diffs.length ? ` — ${diffs.join('; ')}` : ''}`,
      },
    })
    .catch((err) => {
      logger.error('ADMIN', 'AdminAdjustment write failed for llm_stack config save', {
        env,
        brandId,
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  if (env === getActiveEnvironment()) invalidateLlmStack();
  return { previous, diffs };
}

/* ── Cache controls / boot ────────────────────────────────────────────────── */

export function invalidateLlmStack(): void {
  activeCaches.clear();
}

export async function warmupLlmStack(): Promise<void> {
  try {
    await Promise.all([getLlmStack('roboapply'), getLlmStack('goapply')]);
  } catch {
    /* sync readers degrade to env */
  }
}

export function getLlmStackCacheState(brandId: LlmStackBrand = 'roboapply'): {
  activeEnvironment: ConfigEnvironment;
  hasCache: boolean;
  cacheAgeMs: number | null;
  source: 'db' | 'empty' | null;
  dbDisabled: boolean;
} {
  const cached = activeCaches.get(brandId);
  return {
    activeEnvironment: getActiveEnvironment(),
    hasCache: !!cached,
    cacheAgeMs: cached ? Date.now() - cached.fetchedAt : null,
    source: cached?.source ?? null,
    dbDisabled: isDbConfigDisabled(),
  };
}

// Re-export for convenience to route/consumers.
export { MODEL_ENV };
