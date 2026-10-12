// server/src/features/jobs/backfill/rematchRoles.ts
//
// Backfill for SM-2: run today's title matcher over the roles stored on live
// jobs (canonical, not archived) of one market. What the title says is decided
// in one place, for enrichment and for this backfill (enrich `roleFromTitle`):
//   - every row gets its `titleMatchScore` (how strongly the title names a
//     role; null when it names none);
//   - a title that names its role outright (0.9 or more) and a row filed
//     under another role: the row is moved to the role the title names
//     ("Microservices Architect" leaves Design). Nothing more to decide;
//   - a row whose role only the retired one-word match explains ("Java
//     Backend Architect" under the building profession, "Principal Engineer"
//     under school principals): the row takes the role the title names today,
//     or loses its role when the title names none, and is queued for
//     enrichment so the model decides among the candidates;
//   - any other title that does not decide: the stored role is left alone and
//     the job is queued for enrichment.
// Queueing: a row still stamped with an older ENRICH_VERSION gets the same
// work item jobs-maintain would queue for it (one model pass, not two); a row
// already at the current version gets one forced pass per rematch generation,
// and only when no model has ruled on it under today's rules: when its last
// pass was rules only, or when this run changed its role. A row whose role a
// model already decided at this version is counted and left alone, so running
// the backfill after jobs-maintain, or again a month later (finished work
// items are pruned), never pays for the same answer twice.
// Rows are read in pages of 500 in id order (keyset, no OFFSET). The default
// is a dry run: it reads, counts and returns the changes it would make, and
// writes nothing. Every change is reported as { jobId, from, to, score }.
// The database and the queue are passed in, so the module is tested without
// either (backfill.test.ts).

import { RULES_CHECKED_MODEL, RULES_ONLY_MODEL, roleFromTitle } from '../enrich/index.js';
import { taxonomyAncestors } from '../taxonomy/index.js';

export type BackfillMarket = 'intl' | 'cn';

/** Rows read per page. */
export const REMATCH_PAGE_SIZE = 500;

/** The columns the rematch reads. */
export interface RematchRow {
  id: string;
  title: string;
  primaryTaxonomyId: string | null;
  taxonomyIds: string[];
  titleMatchScore: number | null;
  enrichVersion: number | null;
  /** The model of the row's last enrichment pass, or one of the rules-only markers. */
  enrichModel: string | null;
}

/** The slice of the Prisma client the rematch uses. */
export interface RematchDb {
  rAJob: {
    findMany(args: {
      where: { market: string; isCanonical: true; archivedAt: null; id?: { gt: string } };
      orderBy: { id: 'asc' };
      take: number;
      select: Record<keyof RematchRow, true>;
    }): Promise<RematchRow[]>;
    update(args: { where: { id: string }; data: Record<string, unknown>; select: { id: true } }): Promise<unknown>;
  };
}

export interface RoleChange {
  jobId: string;
  title: string;
  /** The role the row holds before the run. */
  from: string | null;
  /** The role the row holds after it (equal to `from` when only queued; null when the role is removed). */
  to: string | null;
  /** The title match score, null when the title names no role. */
  score: number | null;
  /**
   * 'moved': the role is replaced by the one the title names. 'cleared': the
   * role came from a retired one-word match and the title names none.
   * 'kept': the role stays as it is.
   */
  action: 'moved' | 'cleared' | 'kept';
  /** True when the title does not decide and the job is queued for enrichment (the model decides). */
  queued: boolean;
}

export interface RematchOptions {
  market: BackfillMarket;
  /** False (the default) is a dry run: nothing is written and nothing is queued. */
  apply?: boolean;
  /** Stop after this many rows. */
  limit?: number | null;
  pageSize?: number;
  db: RematchDb;
  /**
   * Queue one enrichment for a job whose title does not decide its role.
   * `stale` is true while the row carries an older ENRICH_VERSION. Resolves
   * to false when the item already existed (a second run queues nothing new).
   */
  enqueue: (job: { jobId: string; market: BackfillMarket; stale: boolean }) => Promise<boolean>;
  /** The current ENRICH_VERSION (passed in: the command line reads it where it wires the queue). */
  enrichVersion: number;
  /** Called once per change, in id order. */
  onChange?: (change: RoleChange) => void;
}

export interface RematchReport {
  task: 'rematch-roles';
  market: BackfillMarket;
  apply: boolean;
  scanned: number;
  /** Rows whose stored score differs from today's (they are, or would be, written). */
  scores: number;
  /** Rows moved to the role their title names. */
  moved: number;
  /** Rows whose role came from a retired one-word match and whose title names no role: the role is removed. */
  cleared: number;
  /** Rows queued for enrichment because the title does not decide (in a dry run: that would be queued). */
  queued: number;
  /** Rows whose title does not decide, left alone: a model already ruled on them at the current version. */
  decidedByModel: number;
  /** Of `queued`, new work items (an item that already existed is not counted). Always 0 in a dry run. */
  queuedNew: number;
  changes: RoleChange[];
}

const SELECT = { id: true, title: true, primaryTaxonomyId: true, taxonomyIds: true, titleMatchScore: true, enrichVersion: true, enrichModel: true } as const;

/** `enrichModel` values of a pass no model took part in. */
const RULES_ONLY_MARKERS: ReadonlySet<string> = new Set([RULES_ONLY_MODEL, RULES_CHECKED_MODEL]);

/** `titleMatchScore` is a 4-byte float in the database: 0.883 reads back as 0.88300001. */
function sameScore(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-4;
}

function storedRole(row: Pick<RematchRow, 'primaryTaxonomyId' | 'taxonomyIds'>): string | null {
  return row.primaryTaxonomyId ?? row.taxonomyIds[row.taxonomyIds.length - 1] ?? null;
}

/** Re-match the stored roles of one market. Dry run unless `apply`. */
export async function rematchRoles(options: RematchOptions): Promise<RematchReport> {
  const apply = options.apply === true;
  const pageSize = Math.max(1, options.pageSize ?? REMATCH_PAGE_SIZE);
  const limit = options.limit && options.limit > 0 ? options.limit : Infinity;
  const report: RematchReport = { task: 'rematch-roles', market: options.market, apply, scanned: 0, scores: 0, moved: 0, cleared: 0, queued: 0, decidedByModel: 0, queuedNew: 0, changes: [] };
  let cursor: string | null = null;
  while (report.scanned < limit) {
    const take = Math.min(pageSize, limit - report.scanned);
    const rows: RematchRow[] = await options.db.rAJob.findMany({
      where: { market: options.market, isCanonical: true, archivedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take,
      select: SELECT,
    });
    if (!rows.length) break;
    for (const row of rows) {
      report.scanned++;
      const held = storedRole(row);
      // The same ruling enrichment applies (a Taiwan title is matched in its mainland reading too).
      const ruling = roleFromTitle(row.title, held);
      const score = ruling.det ? ruling.det.score : null;
      const data: Record<string, unknown> = {};
      if (!sameScore(row.titleMatchScore, score)) {
        data.titleMatchScore = score;
        report.scores++;
      }
      let action: RoleChange['action'] = 'kept';
      let to = held;
      if (ruling.role !== undefined && ruling.role !== held) {
        to = ruling.role;
        data.taxonomyIds = { set: to ? taxonomyAncestors(to).map((n) => n.id).reverse() : [] };
        data.primaryTaxonomyId = to;
        action = to ? 'moved' : 'cleared';
        if (to) report.moved++;
        else report.cleared++;
      }
      const stale = row.enrichVersion === null || row.enrichVersion < options.enrichVersion;
      // A model already picked this row's role under today's rules, and this run leaves the role as it is.
      const settled = !stale && action === 'kept' && !!row.enrichModel && !RULES_ONLY_MARKERS.has(row.enrichModel);
      const queued = !ruling.decisive && !settled;
      if (queued) report.queued++;
      else if (!ruling.decisive) report.decidedByModel++;
      if (apply && Object.keys(data).length) await options.db.rAJob.update({ where: { id: row.id }, data, select: { id: true } });
      if (apply && queued && (await options.enqueue({ jobId: row.id, market: options.market, stale }))) report.queuedNew++;
      if (action !== 'kept' || queued) {
        const change: RoleChange = { jobId: row.id, title: row.title, from: held, to, score, action, queued };
        report.changes.push(change);
        options.onChange?.(change);
      }
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < take) break;
  }
  return report;
}
