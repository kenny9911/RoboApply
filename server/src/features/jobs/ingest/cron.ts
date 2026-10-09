// server/src/features/jobs/ingest/cron.ts — the inventory crons (WP-16b; FND-3 contract).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// (node-cron) inside `runWithBrand(brand, …)` with the shared 240 s budget.
// Each returns `{ skipped }` at once when there is nothing to do and reports
// the work it did otherwise.
//
// GoApply (market cn): the inventory is the GoHire bank, used only when the
// R-14 recruitment-info mode lets jobs reach users (`jobs.feed` or
// `jobs.recommendations`); in mode `off` plan and ingest skip ('disabled').

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import type { EnvSource, ProductBrand } from '../../../platform/brand/index.js';
import { isEnabledForBrand } from '../../../platform/flags.js';
import { kickDrain, type CronResult, type CronTask } from '../../../platform/queue/index.js';
import type { IngestDb } from './db.js';
import { runMaintenance } from './maintain.js';
import { ENRICH_KIND, type EnqueueManyFn } from './pipeline.js';
import { runPlanner } from './planner.js';
import { adaptersForBrand } from './providers.js';
import { runIngestTick } from './run.js';
import { perQueryTrackingAvailable } from './tracking.js';

const TAG = 'JOBS_INGEST';

/** Whether the brand's market may ingest right now (R-14 for GoApply). */
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
  const result = await runPlanner(db(), ctx.brand, adapters, { now: ctx.now, env: env() });
  logger.info(TAG, 'jobs-plan', { brand: ctx.brand.id, ...result });
  return { processed: result.written + result.bankQueries, ...result };
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
 * jobs-maintain (03:30 UTC daily): expire/archive and dedupe repair (ARCH §4.6).
 * The missed-refresh archive runs only once Schema request SR-16b-1 is in place
 * (`missedRule: false` in the result until then).
 */
export const runJobsMaintain: CronTask = async (ctx): Promise<CronResult> => {
  const adapters = adaptersForBrand(ctx.brand, env());
  const perQueryTracking = deps.perQueryTracking ?? (await perQueryTrackingAvailable(db()));
  const result = await runMaintenance(db(), ctx.brand.market, adapters, { perQueryTracking });
  logger.info(TAG, 'jobs-maintain', { brand: ctx.brand.id, ...result });
  return { processed: result.expired + result.missed + result.dedupeRepaired, ...result };
};
