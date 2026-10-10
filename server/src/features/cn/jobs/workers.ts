// server/src/features/cn/jobs/workers.ts — queue workers for GoApply jobs (WP-41).
//
// server/src/platform/queue/registry.ts (FND-5) imports `workers` from every
// area and registers them. Kinds:
//   - 'cn.jobs.fraudCheck': the cheap CN LLM anti-fraud check of one job
//     (招转培 / 培训贷 / 先交钱 / MLM / gambling / telecom lures, CN-E-08).
//     Produced by the afterEnrich hook for gray-zone postings with no keyword
//     flag; dedupe key `cn.jobs.fraudCheck:<jobId>:v1`.

import { PermanentWorkError, type WorkerDefinition } from '../../../platform/queue/index.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { z } from 'zod';
import { CN_JOBS_FRAUD_CHECK_KIND, defaultCnJobsDeps, runFraudCheck, type CnJobsDeps } from './service.js';

export const CN_JOBS_WORK_KINDS = { fraudCheck: CN_JOBS_FRAUD_CHECK_KIND } as const;

/** Checks run in parallel within one drain batch (cheap calls). */
export const FRAUD_CHECK_CONCURRENCY = 5;

const PayloadSchema = z.object({ jobId: z.string().min(1).max(64) });

let depsOverride: CnJobsDeps | null = null;

/** Test seam: replace the worker's dependencies (null restores the defaults). */
export function setCnJobsDepsForTests(deps: CnJobsDeps | null): void {
  depsOverride = deps;
}

export const fraudCheckWorker: WorkerDefinition<Prisma.JsonValue> = {
  kind: CN_JOBS_WORK_KINDS.fraudCheck,
  concurrency: FRAUD_CHECK_CONCURRENCY,
  handler: async (item) => {
    const parsed = PayloadSchema.safeParse(item.payload);
    if (!parsed.success) throw new PermanentWorkError(`${CN_JOBS_WORK_KINDS.fraudCheck}: invalid payload`);
    await runFraudCheck(parsed.data.jobId, depsOverride ?? defaultCnJobsDeps(), `cn-fraud-${item.id}`);
  },
};

export const workers: WorkerDefinition[] = [fraudCheckWorker];
