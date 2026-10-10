// server/src/roboapply/v2/lib/legacyJobScope.ts — who may read a job through the legacy /v2 routes.
//
// The deprecated /v2 job readers (`GET /v2/jobs/:id` and its sub-routes,
// `POST /v2/search/run`, `RAResumeAIService` job context) stay mounted for the
// legacy client until WP-75 deletes them. They must apply the same scope as
// the job-detail area (WP-34 `loadJob`) and the GoApply recruitment-info mode
// (R-14, WP-41):
//   - the request brand's market only;
//   - public rows, or the viewer's own private import (never another user's);
//   - never a seed demo row;
//   - GoApply with `CN_RECRUITMENT_INFO_MODE=off`: no third-party posting.
// A refused row answers exactly like a missing one (no existence leak).

import type { NextFunction, Request, Response } from 'express';
import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import type { EnvSource } from '../../../platform/brand/index.js';
import { cnPostingVisible, cnPostingsWhere } from '../../../features/cn/jobs/index.js';
import prisma from '../../../lib/prisma.js';

export interface LegacyJobScopeRow {
  market?: unknown;
  visibility?: unknown;
  ownerUserId?: unknown;
  provider?: unknown;
  sourceBoard?: unknown;
}

/** May this viewer read this job through a legacy /v2 route? */
export function legacyJobVisible(
  row: LegacyJobScopeRow | null | undefined,
  userId: string,
  opts: { market?: string; env?: EnvSource } = {},
): boolean {
  if (!row || row.sourceBoard === 'seed') return false;
  const market = opts.market ?? getCurrentBrandOrDefault().market;
  if (row.market !== market) return false;
  const own = row.visibility === 'private' && row.ownerUserId === userId;
  if (row.visibility !== 'public' && !own) return false;
  return cnPostingVisible(row, userId, opts.env ?? process.env);
}

/** Extra `where` for legacy list queries: on GoApply, the recruitment-info mode (own imports only when off). */
export function legacyJobListScope(userId: string, opts: { market?: string; env?: EnvSource } = {}): Record<string, unknown> | null {
  const market = opts.market ?? getCurrentBrandOrDefault().market;
  return market === 'cn' ? cnPostingsWhere(userId, opts.env ?? process.env) : null;
}

/** The job row, or null when it does not exist or the viewer may not read it. */
export async function loadLegacyVisibleJob(userId: string, jobId: string): Promise<any | null> {
  const row = await (prisma as any).rAJob.findUnique({ where: { id: jobId } });
  return legacyJobVisible(row, userId) ? row : null;
}

/** Router guard for `/:id` routes: 404 `not_found` (the legacy shape) unless the viewer may read the job. */
export async function requireLegacyVisibleJob(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId || !(await loadLegacyVisibleJob(userId, req.params.id))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
