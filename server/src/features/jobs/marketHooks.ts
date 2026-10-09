// server/src/features/jobs/marketHooks.ts — the market hook registry (FND-5).
//
// The job pipeline (WP-16b ingest, WP-17 enrich, WP-35 import) and the card
// renderers call three hook points; market-specific modules fill them:
//   - afterNormalize(job, ctx) → job   (deterministic; may add fields)
//   - afterEnrich(job, ctx)            (e.g. GoApply fraud classifier, WP-41)
//   - cardMeta(job, ctx) → meta        (CN/TW card lines: JobMetaCn / JobMetaTw)
//
// The hook modules are imported STATICALLY (TASK_PLAN.md F18): bundlers and
// Vercel's file tracing see them, and there is no registration-order bug.
//   - ../cn/jobs/hooks.ts                (WP-41: GoApply)
//   - ./sources/atsPublic/hooks.ts       (WP-42: Taiwan / public ATS boards)
// Both start as no-op stubs. To add a market, add a hook module and list it
// in MARKET_HOOK_SETS (an FND/INT hot-file change).
//
// Error policy: afterNormalize/afterEnrich errors propagate to the caller
// (the pipeline decides whether to retry); cardMeta never throws — a failing
// hook contributes nothing, so a card always renders.

import type { BrandId, Market } from '../../platform/brand/registry.js';
import { cnJobsHooks } from '../cn/jobs/hooks.js';
import { atsPublicHooks } from './sources/atsPublic/hooks.js';

/** A job as the pipeline holds it. WP-16a's NormalizedJob is assignable to this shape. */
export type MarketHookJob = Record<string, unknown> & {
  id?: string;
  market: Market;
  /** JobProvider key ('activejobs' | 'bank_gohire' | 'ats_public' | 'user_import' | …). */
  provider?: string;
};

export interface MarketHookContext {
  brand: BrandId;
  market: Market;
  /** Where the call comes from. */
  stage: 'ingest' | 'enrich' | 'import' | 'card';
  /** The importing user, for user imports. */
  userId?: string | null;
}

export interface MarketHookSet {
  /** Unique id; also the key of this set's entry in `cardMeta` results. */
  id: string;
  appliesTo(job: MarketHookJob, ctx: MarketHookContext): boolean;
  afterNormalize?(job: MarketHookJob, ctx: MarketHookContext): MarketHookJob | Promise<MarketHookJob>;
  afterEnrich?(job: MarketHookJob, ctx: MarketHookContext): void | Promise<void>;
  cardMeta?(job: MarketHookJob, ctx: MarketHookContext): Record<string, unknown> | null;
}

/** Statically imported hook sets, in call order. */
export const MARKET_HOOK_SETS: readonly MarketHookSet[] = [cnJobsHooks, atsPublicHooks];

function applicable(job: MarketHookJob, ctx: MarketHookContext, sets: readonly MarketHookSet[]): MarketHookSet[] {
  return sets.filter((set) => {
    try {
      return set.appliesTo(job, ctx);
    } catch {
      return false;
    }
  });
}

export async function afterNormalize(
  job: MarketHookJob,
  ctx: MarketHookContext,
  sets: readonly MarketHookSet[] = MARKET_HOOK_SETS,
): Promise<MarketHookJob> {
  let current = job;
  for (const set of applicable(job, ctx, sets)) {
    if (set.afterNormalize) current = await set.afterNormalize(current, ctx);
  }
  return current;
}

export async function afterEnrich(job: MarketHookJob, ctx: MarketHookContext, sets: readonly MarketHookSet[] = MARKET_HOOK_SETS): Promise<void> {
  for (const set of applicable(job, ctx, sets)) {
    if (set.afterEnrich) await set.afterEnrich(job, ctx);
  }
}

/** Card meta from every applicable set, keyed by set id. Never throws. */
export function cardMeta(
  job: MarketHookJob,
  ctx: MarketHookContext,
  sets: readonly MarketHookSet[] = MARKET_HOOK_SETS,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const set of applicable(job, ctx, sets)) {
    if (!set.cardMeta) continue;
    try {
      const meta = set.cardMeta(job, ctx);
      if (meta) out[set.id] = meta;
    } catch {
      // A card always renders; a failing hook contributes nothing.
    }
  }
  return out;
}

export const marketHooks = { afterNormalize, afterEnrich, cardMeta } as const;
