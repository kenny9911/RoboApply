// server/src/features/jobs/ingest/cron.ts — the inventory crons (WP-16b; FND-3 contract).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// (node-cron) inside `runWithBrand(brand, …)` with the shared 240 s budget.
// Each returns `{ skipped }` at once when there is nothing to do and reports
// the work it did otherwise.
//
// Both brands plan, ingest and maintain by default (D5). GoApply (market cn)
// reads the employer boards' mainland postings and the GoHire bank; its feed
// capabilities are on unless CN_RECRUITMENT_INFO_MODE=off, the kill switch,
// under which plan and ingest skip ('disabled'). Before planning, a market
// that ships a verified seed list of employer boards registers it once
// (sources/atsPublic/seeds.ts).

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import type { EnvSource, ProductBrand } from '../../../platform/brand/index.js';
import { isEnabledForBrand } from '../../../platform/flags.js';
import { enqueueMany as platformEnqueueMany, kickDrain, type CronResult, type CronTask } from '../../../platform/queue/index.js';
import type { IngestDb } from './db.js';
import { runMaintenance } from './maintain.js';
import { ENRICH_KIND, type EnqueueManyFn } from './pipeline.js';
import { runPlanner } from './planner.js';
import { adaptersForBrand } from './providers.js';
import { runIngestTick } from './run.js';
import { perQueryTrackingAvailable } from './tracking.js';
import type { SeedResult } from '../sources/atsPublic/index.js';

const TAG = 'JOBS_INGEST';

/** Whether the brand's market may ingest right now (GoApply: false only under CN_RECRUITMENT_INFO_MODE=off). */
export function ingestAllowed(brand: ProductBrand, env: EnvSource = process.env): boolean {
  if (brand.market !== 'cn') return true;
  return isEnabledForBrand('jobs.feed', brand, env) || isEnabledForBrand('jobs.recommendations', brand, env);
}

/** Injected dependencies (tests); defaults are the real ones. */
export interface IngestCronDeps {
  db?: IngestDb;
  env?: EnvSource;
  kick?: (kinds: string[]) => unknown;
  enqueueMany?: EnqueueManyFn;
  /** SR-16b-1 tracking override (default: probed). */
  perQueryTracking?: boolean;
}

let deps: IngestCronDeps = {};

/** Test seam. */
export function setIngestCronDepsForTests(next: IngestCronDeps): void {
  deps = next;
}

const db = (): IngestDb => deps.db ?? prisma;
const env = (): EnvSource => deps.env ?? process.env;

/** jobs-plan (02:00 UTC daily): the demand-driven query planner (ARCH §4.3). */
export const runJobsPlan: CronTask = async (ctx): Promise<CronResult> => {
  if (!ingestAllowed(ctx.brand, env())) return { skipped: 'disabled' };
  const adapters = adaptersForBrand(ctx.brand, env());
  if (adapters.length === 0) return { skipped: 'no_providers' };
  // The market's verified seed list of employer boards, registered once per seed version.
  let seed: SeedResult | null = null;
  if (adapters.some((a) => a.provider === 'ats_public' && a.isEnabled())) {
    try {
      // Loaded on demand through the boards' public surface (that area imports ingest's own surface back).
      const { ensureSeedCareerSources } = await import('../sources/atsPublic/index.js');
      seed = await ensureSeedCareerSources(db(), ctx.brand.market);
    } catch (err) {
      // Planning goes on: the boards an admin already added are still read.
      logger.warn(TAG, 'employer board seed not registered', { brand: ctx.brand.id, error: err instanceof Error ? err.message.slice(0, 160) : 'error' });
    }
  }
  const result = await runPlanner(db(), ctx.brand, adapters, { now: ctx.now, env: env() });
  logger.info(TAG, 'jobs-plan', { brand: ctx.brand.id, ...result, seedBoardsAdded: seed?.added ?? 0 });
  return { processed: result.written + result.bankQueries + (seed?.added ?? 0), ...result, seedBoardsAdded: seed?.added ?? 0 };
};

/** jobs-ingest (every 10 min): fetch → normalize → upsert per brand (ARCH §4.4). */
export const runJobsIngest: CronTask = async (ctx): Promise<CronResult> => {
  if (!ingestAllowed(ctx.brand, env())) return { skipped: 'disabled' };
  const adapters = adaptersForBrand(ctx.brand, env());
  if (!adapters.some((a) => a.isEnabled())) return { skipped: 'no_providers' };
  const tally = await runIngestTick({ db: db(), brand: ctx.brand, adapters, budgetMs: ctx.budget.remainingMs(), env: env(), enqueueMany: deps.enqueueMany, perQueryTracking: deps.perQueryTracking });
  if (tally.queries === 0) return { skipped: 'no_work' };
  if (tally.enrichQueued > 0) (deps.kick ?? kickDrain)([ENRICH_KIND]);
  logger.info(TAG, 'jobs-ingest', { brand: ctx.brand.id, ...tally });
  return { processed: tally.queries, ...tally };
};

/**
 * jobs-maintain (03:30 UTC daily): expire/archive, dedupe repair and the
 * enrichment catch-up (ARCH §4.6; maintain.ts). The missed-refresh archive
 * runs only once Schema request SR-16b-1 is in place (`missedRule: false` in
 * the result until then). Runs inside `runWithBrand(ctx.brand)`; the items it
 * queues carry that brand.
 */
export const runJobsMaintain: CronTask = async (ctx): Promise<CronResult> => {
  const adapters = adaptersForBrand(ctx.brand, env());
  const perQueryTracking = deps.perQueryTracking ?? (await perQueryTrackingAvailable(db()));
  const enqueueMany: EnqueueManyFn = deps.enqueueMany ?? ((items) => platformEnqueueMany(items));
  const result = await runMaintenance(db(), ctx.brand.market, adapters, { perQueryTracking, enrich: { brand: ctx.brand, enqueueMany, env: env() } });
  if (result.enrichQueued > 0) (deps.kick ?? kickDrain)([ENRICH_KIND]);
  logger.info(TAG, 'jobs-maintain', { brand: ctx.brand.id, ...result });
  return { processed: result.expired + result.missed + result.dedupeRepaired + result.enrichQueued, ...result };
};
