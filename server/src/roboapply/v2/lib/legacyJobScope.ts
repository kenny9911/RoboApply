// server/src/roboapply/v2/lib/legacyJobScope.ts — which job rows a legacy /v2 service may read.
//
// The legacy job routes themselves (`GET /v2/jobs/:id`, `POST /v2/search/run`)
// are deleted (INT-13). What still reads a job by id from the legacy code is:
//   - `RAResumeService` (tailor / duplicate with a target job),
//   - `RAResumeAIService` (job context for a rewrite),
//   - `RAInsightService` (titles of the tracked jobs named in the weekly summary).
// Each applies the same scope as the job-detail area (WP-34 `loadJob`) and the
// GoApply recruitment-info mode (R-14, WP-41):
//   - the request brand's market only;
//   - public rows, or the viewer's own private import (never another user's);
//   - never a seed demo row;
//   - GoApply with `CN_RECRUITMENT_INFO_MODE=off`: no third-party posting.
// A refused row is treated exactly like a missing one (no existence leak).

import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import type { EnvSource } from '../../../platform/brand/index.js';
import { cnPostingVisible } from '../../../features/cn/jobs/index.js';
import prisma from '../../../lib/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';

/**
 * `provider` stays optional on the row type: `cnPostingVisible` reads it when a
 * caller hands in a job-like object that carries one. `RAJob` itself has no
 * such column (a user's own import is `visibility: 'private'` + `ownerUserId`),
 * so it is never selected.
 */
export interface LegacyJobScopeRow {
  market?: unknown;
  visibility?: unknown;
  ownerUserId?: unknown;
  provider?: unknown;
  sourceBoard?: unknown;
}

/**
 * The `RAJob` columns `legacyJobVisible` needs; spread into a Prisma `select`.
 * `satisfies Prisma.RAJobSelect` makes a column that is not on the model a
 * type error here, even though the callers reach Prisma through `as any`
 * (selecting a non-existent `provider` made every resume list answer 500).
 */
export const LEGACY_JOB_SCOPE_SELECT = {
  market: true,
  visibility: true,
  ownerUserId: true,
  sourceBoard: true,
} as const satisfies Prisma.RAJobSelect;

/** May this viewer read this job through a legacy /v2 service? */
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

/** The job row, or null when it does not exist or the viewer may not read it. */
export async function loadLegacyVisibleJob(userId: string, jobId: string): Promise<any | null> {
  const row = await (prisma as any).rAJob.findUnique({ where: { id: jobId } });
  return legacyJobVisible(row, userId) ? row : null;
}
