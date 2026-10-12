// server/src/features/compliance/cron.ts — compliance-daily (05:00 UTC), per brand (WP-13).
//
// Called by server/src/cron/handlers.ts inside `runWithBrand(brand, …)` with a
// 240 s budget, next to WP-63a's interview retention. Steps:
//   1. the retention schedule (retention.ts) for this brand;
//   2. expired data-export files (dataExport.ts);
//   3. personal-information requests: close deletion/withdrawal requests whose
//      account is gone, and report what is open and overdue.
// Each step is cheap when nothing is due (indexed range queries), so an idle
// run answers in well under 2 s.

import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import type { CronContext, CronResult, CronTask } from '../../platform/queue/index.js';
import { sweepExpiredExports } from './dataExport.js';
import { runRetention, type RetentionDb } from './retention.js';

export type ComplianceCronDb = RetentionDb & Pick<typeof prisma, 'rAPersonalInfoRequest'>;

export interface ComplianceCronDeps {
  db?: ComplianceCronDb;
  sweepExports?: typeof sweepExpiredExports;
}

/** Close deletion/withdrawal requests whose user row no longer exists; count open/overdue. */
export async function reconcilePiRequests(
  db: Pick<typeof prisma, 'rAPersonalInfoRequest'>,
  brand: string,
  now: Date,
): Promise<{ closed: number; open: number; overdue: number }> {
  const { count: closed } = await db.rAPersonalInfoRequest.updateMany({
    where: { brand, userId: null, kind: { in: ['deletion', 'withdraw_consent'] }, status: { in: ['open', 'in_progress'] } },
    data: { status: 'done', closedAt: now },
  });
  const open = await db.rAPersonalInfoRequest.count({ where: { brand, status: { in: ['open', 'in_progress'] } } });
  const overdue = open
    ? await db.rAPersonalInfoRequest.count({ where: { brand, status: { in: ['open', 'in_progress'] }, dueAt: { lt: now } } })
    : 0;
  return { closed, open, overdue };
}

export function createComplianceDaily(deps: ComplianceCronDeps = {}): CronTask {
  return async (ctx: CronContext): Promise<CronResult> => {
    const db = deps.db ?? prisma;
    const brand = ctx.brand.id;
    const log = (msg: string, meta: Record<string, unknown>) => logger.warn('COMPLIANCE', msg, { brand, ...meta });

    const retention = await runRetention({ db, brand, now: ctx.now, budget: ctx.budget }, log);
    let exportsRemoved = 0;
    try {
      exportsRemoved = await (deps.sweepExports ?? sweepExpiredExports)({ brand, now: () => ctx.now });
    } catch (err) {
      log('export sweep failed', { error: err instanceof Error ? err.message : String(err) });
    }
    const requests = await reconcilePiRequests(db, brand, ctx.now);
    if (requests.overdue > 0) log('personal-information requests overdue', { overdue: requests.overdue });

    const processed = retention.total + exportsRemoved + requests.closed;
    return {
      ...(processed === 0 ? { skipped: 'no_work' } : {}),
      processed,
      retention: retention.deleted,
      retentionBlocked: retention.blocked,
      exportsRemoved,
      piRequests: requests,
    };
  };
}

/** compliance-daily (05:00 UTC daily): retention schedule, export files, PI request due dates. */
export const runComplianceDaily: CronTask = createComplianceDaily();
