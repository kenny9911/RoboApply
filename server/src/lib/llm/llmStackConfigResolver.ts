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

let activeCache: CachedSnapshot | null = null;

/* ── Read API ─────────────────────────────────────────────────────────────── */

export async function getLlmStack(): Promise<LlmStackConfigBlob> {
  if (isDbConfigDisabled()) return emptyLlmStackBlob();
  const now = Date.now();
  if (activeCache && activeCache.expiresAt > now) return activeCache.blob;

  const env = getActiveEnvironment();
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: appConfigKeyFor(env) } });
    const parsed = parseLlmStackBlob(row?.value);
    const blob = parsed || emptyLlmStackBlob();
    activeCache = { blob, fetchedAt: now, expiresAt: now + CACHE_TTL_MS, source: parsed ? 'db' : 'empty' };
    return blob;
  } catch {
    const blob = activeCache?.blob || emptyLlmStackBlob();
    activeCache = { blob, fetchedAt: now, expiresAt: now + STALE_TTL_MS, source: 'empty' };
    return blob;
  }
}

/**
 * Synchronous accessor for the hot path (provider/model resolution). Returns
 * the cached overrides blob; on cold cache returns an all-null blob (⇒ env
 * fallback in the accessor) and warms in the background.
 */
export function getLlmStackSync(): LlmStackConfigBlob {
  if (isDbConfigDisabled()) return emptyLlmStackBlob();
  if (activeCache) {
    if (activeCache.expiresAt <= Date.now()) void getLlmStack().catch(() => {});
    return activeCache.blob;
  }
  void getLlmStack().catch(() => {});
  return emptyLlmStackBlob();
}

/** Read a specific environment's stored blob (admin UI). No caching. */
export async function getLlmStackForEnvironment(env: ConfigEnvironment): Promise<{
  blob: LlmStackConfigBlob;
  source: 'db' | 'empty';
  updatedAt: Date | null;
  updatedBy: string | null;
}> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: appConfigKeyFor(env) } });
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
): Promise<{ previous: LlmStackConfigBlob | null; diffs: string[] }> {
  const before = await prisma.appConfig.findUnique({ where: { key: appConfigKeyFor(env) } });
  const previous = parseLlmStackBlob(before?.value);
  const diffs = diffLlmStack(previous, blob);

  await prisma.appConfig.upsert({
    where: { key: appConfigKeyFor(env) },
    update: { value: JSON.stringify(blob), updatedBy: adminId },
    create: { key: appConfigKeyFor(env), value: JSON.stringify(blob), updatedBy: adminId },
  });

  // Audit — the blob is NON-SECRET (no API keys live here; those are in
  // SystemLLMKey). Storing the full before/after is safe and useful for restore.
  // Best-effort: never fail the save if the audit write hiccups.
  await prisma.adminAdjustment
    .create({
      data: {
        userId: adminId, // self-action — config change, no per-user target
        adminId,
        type: `llm_stack_config:${env}`,
        oldValue: previous ? JSON.stringify(previous) : null,
        newValue: JSON.stringify(blob),
        reason: `${reason}${diffs.length ? ` — ${diffs.join('; ')}` : ''}`,
      },
    })
    .catch((err) => {
      logger.error('ADMIN', 'AdminAdjustment write failed for llm_stack config save', {
        env,
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  if (env === getActiveEnvironment()) invalidateLlmStack();
  return { previous, diffs };
}

/* ── Cache controls / boot ────────────────────────────────────────────────── */

export function invalidateLlmStack(): void {
  activeCache = null;
}

export async function warmupLlmStack(): Promise<void> {
  try {
    await getLlmStack();
  } catch {
    /* sync readers degrade to env */
  }
}

export function getLlmStackCacheState(): {
  activeEnvironment: ConfigEnvironment;
  hasCache: boolean;
  cacheAgeMs: number | null;
  source: 'db' | 'empty' | null;
  dbDisabled: boolean;
} {
  return {
    activeEnvironment: getActiveEnvironment(),
    hasCache: !!activeCache,
    cacheAgeMs: activeCache ? Date.now() - activeCache.fetchedAt : null,
    source: activeCache?.source ?? null,
    dbDisabled: isDbConfigDisabled(),
  };
}

// Re-export for convenience to route/consumers.
export { MODEL_ENV };
