// backend/src/roboapply/v2/services/RATrackerService.ts
//
// Job Tracker CRUD. Per (userId, jobId) UNIQUE when jobId != null; multiple
// manual rows (jobId NULL) allowed. Hydrates the `job` snapshot when the
// linked `RAJob` row resolves; falls back to `externalSnapshot` otherwise.
//
// `dateApplied` is auto-stamped when status transitions to `applied` and the
// caller hasn't supplied one explicitly. The same is true on bulk patches.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';

export type RATrackerStatus =
  | 'bookmarked'
  | 'applying'
  | 'applied'
  | 'interviewing'
  | 'negotiating'
  | 'accepted'
  | 'rejected'
  | 'withdrawn';

export type RAWorkType = 'remote' | 'hybrid' | 'onsite';
export type RAAppliedVia = 'ra_autoapply' | 'manual' | 'extension';

export interface ExternalSnapshot {
  title: string;
  companyName: string;
  location?: string;
  applyUrl: string;
}

export interface RATrackerEntryView {
  id: string;
  userId: string;
  jobId: string | null;
  status: RATrackerStatus;
  excitementStars: number;
  maxSalary: number | null;
  maxSalaryCurrency: string | null;
  notesMarkdown: string | null;
  dateSaved: string;
  dateApplied: string | null;
  deadline: string | null;
  followUpAt: string | null;
  appliedVia: RAAppliedVia | null;
  linkedRunId: string | null;
  job: {
    title: string;
    companyName: string;
    companyLogoUrl: string | null;
    location: string | null;
    workType: RAWorkType;
    applyUrl: string;
  } | null;
  externalSnapshot: ExternalSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerListParams {
  status?: RATrackerStatus | RATrackerStatus[];
  limit?: number;
  offset?: number;
  sortBy?: 'updated' | 'dateApplied' | 'deadline' | 'excitement';
  sortDir?: 'asc' | 'desc';
}

export interface TrackerListResult {
  entries: RATrackerEntryView[];
  statusCounts: Record<RATrackerStatus, number>;
  total: number;
}

export interface TrackerCreateInput {
  jobId?: string;
  externalSnapshot?: ExternalSnapshot;
  status?: RATrackerStatus;
  excitementStars?: number;
  maxSalary?: number;
  maxSalaryCurrency?: string;
  notesMarkdown?: string;
  deadline?: string;
  followUpAt?: string;
  dateApplied?: string;
}

export type TrackerPatchInput = Partial<TrackerCreateInput>;

export interface TrackerBulkInput {
  ids: string[];
  patch: {
    status?: RATrackerStatus;
    excitementStars?: number;
    deadline?: string;
  };
}

export class TrackerNotFoundError extends Error {
  constructor() {
    super('Tracker entry not found');
    this.name = 'TrackerNotFoundError';
  }
}

export class TrackerDuplicateError extends Error {
  constructor() {
    super('Already in tracker');
    this.name = 'TrackerDuplicateError';
  }
}

export class TrackerInvalidInputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TrackerInvalidInputError';
  }
}

const ALL_STATUSES: RATrackerStatus[] = [
  'bookmarked',
  'applying',
  'applied',
  'interviewing',
  'negotiating',
  'accepted',
  'rejected',
  'withdrawn',
];

function emptyStatusCounts(): Record<RATrackerStatus, number> {
  const out: Record<RATrackerStatus, number> = {
    bookmarked: 0,
    applying: 0,
    applied: 0,
    interviewing: 0,
    negotiating: 0,
    accepted: 0,
    rejected: 0,
    withdrawn: 0,
  };
  return out;
}

function isoDate(d: any): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function isoDateOnly(d: any): string | null {
  if (d == null) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function toView(row: any, job?: any): RATrackerEntryView {
  const jobShape = job
    ? {
        title: job.title,
        companyName: job.companyName,
        companyLogoUrl: job.companyLogoUrl ?? null,
        location: job.location ?? null,
        workType: (job.workType ?? 'onsite') as RAWorkType,
        applyUrl: job.applyUrl,
      }
    : null;
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId ?? null,
    status: row.status as RATrackerStatus,
    excitementStars: row.excitementStars ?? 0,
    maxSalary: row.maxSalary ?? null,
    maxSalaryCurrency: row.maxSalaryCurrency ?? null,
    notesMarkdown: row.notesMarkdown ?? null,
    dateSaved: isoDate(row.dateSaved),
    dateApplied: row.dateApplied ? isoDate(row.dateApplied) : null,
    deadline: isoDateOnly(row.deadline),
    followUpAt: row.followUpAt ? isoDate(row.followUpAt) : null,
    appliedVia: (row.appliedVia ?? null) as RAAppliedVia | null,
    linkedRunId: row.linkedRunId ?? null,
    job: jobShape,
    externalSnapshot: (row.externalSnapshot as ExternalSnapshot | null) ?? null,
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  };
}

export class RATrackerService {
  async list(userId: string, params: TrackerListParams = {}): Promise<TrackerListResult> {
    const p = prisma as any;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);
    const sortBy = params.sortBy ?? 'updated';
    const sortDir = params.sortDir ?? 'desc';

    const statusFilter: RATrackerStatus[] | null = Array.isArray(params.status)
      ? params.status
      : params.status
        ? [params.status]
        : null;

    const where: any = { userId, deletedAt: null };
    if (statusFilter && statusFilter.length > 0) {
      where.status = { in: statusFilter };
    }

    const orderBy: any =
      sortBy === 'dateApplied'
        ? { dateApplied: sortDir }
        : sortBy === 'deadline'
          ? { deadline: sortDir }
          : sortBy === 'excitement'
            ? { excitementStars: sortDir }
            : { updatedAt: sortDir };

    const [rows, total, allByStatus] = await Promise.all([
      p.rATrackerEntry.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
      }),
      p.rATrackerEntry.count({ where }),
      p.rATrackerEntry.groupBy({
        by: ['status'],
        where: { userId, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const counts = emptyStatusCounts();
    for (const s of ALL_STATUSES) counts[s] = 0;
    for (const g of allByStatus as Array<{ status: string; _count: { _all: number } }>) {
      const key = g.status as RATrackerStatus;
      counts[key] = g._count._all;
    }

    const jobIds = (rows as any[]).map((r) => r.jobId).filter((x): x is string => !!x);
    const jobs = jobIds.length
      ? await p.rAJob.findMany({ where: { id: { in: jobIds } } })
      : [];
    const jobsById = new Map<string, any>(jobs.map((j: any) => [j.id, j]));

    return {
      entries: (rows as any[]).map((r) => toView(r, r.jobId ? jobsById.get(r.jobId) : undefined)),
      statusCounts: counts,
      total,
    };
  }

  async getById(userId: string, id: string): Promise<RATrackerEntryView> {
    const p = prisma as any;
    const row = await p.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!row) throw new TrackerNotFoundError();
    const job = row.jobId ? await p.rAJob.findUnique({ where: { id: row.jobId } }) : null;
    return toView(row, job);
  }

  async create(userId: string, body: TrackerCreateInput): Promise<RATrackerEntryView> {
    const p = prisma as any;
    if (!body.jobId && !body.externalSnapshot) {
      throw new TrackerInvalidInputError('Missing jobId or externalSnapshot');
    }
    if (body.jobId) {
      // Only a live (non-soft-deleted) row blocks re-adding — a deleted entry
      // must not 409 the same job forever.
      const collide = await p.rATrackerEntry.findFirst({
        where: { userId, jobId: body.jobId, deletedAt: null },
      });
      if (collide) throw new TrackerDuplicateError();
    }
    const status = (body.status ?? 'bookmarked') as RATrackerStatus;
    let appliedVia: RAAppliedVia | null = null;
    let dateApplied: Date | null = null;
    if (status === 'applied') {
      appliedVia = 'manual';
      dateApplied = body.dateApplied ? new Date(body.dateApplied) : new Date();
    } else if (body.dateApplied) {
      dateApplied = new Date(body.dateApplied);
    }

    const job = body.jobId
      ? await p.rAJob.findUnique({ where: { id: body.jobId } })
      : null;

    const data: any = {
      userId,
      jobId: body.jobId ?? null,
      externalSnapshot: body.jobId ? null : (body.externalSnapshot ?? null),
      status,
      excitementStars: body.excitementStars ?? 0,
      maxSalary: body.maxSalary ?? job?.salaryMax ?? null,
      maxSalaryCurrency: body.maxSalaryCurrency ?? job?.salaryCurrency ?? null,
      notesMarkdown: body.notesMarkdown ?? null,
      dateApplied,
      deadline: body.deadline ? new Date(body.deadline + 'T00:00:00.000Z') : null,
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
      appliedVia,
      linkedRunId: null,
    };
    const row = await p.rATrackerEntry.create({ data });
    logger.info('RA_V2_TRACKER', 'tracker entry created', {
      userId,
      entryId: row.id,
      jobId: row.jobId,
      status: row.status,
    });
    return toView(row, job);
  }

  async patch(userId: string, id: string, body: TrackerPatchInput): Promise<RATrackerEntryView> {
    const p = prisma as any;
    const existing = await p.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new TrackerNotFoundError();
    const data: any = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.excitementStars !== undefined) data.excitementStars = body.excitementStars;
    if (body.maxSalary !== undefined) data.maxSalary = body.maxSalary;
    if (body.maxSalaryCurrency !== undefined) data.maxSalaryCurrency = body.maxSalaryCurrency;
    if (body.notesMarkdown !== undefined) data.notesMarkdown = body.notesMarkdown;
    if (body.deadline !== undefined) {
      data.deadline = body.deadline ? new Date(body.deadline + 'T00:00:00.000Z') : null;
    }
    if (body.followUpAt !== undefined) {
      data.followUpAt = body.followUpAt ? new Date(body.followUpAt) : null;
    }
    if (body.dateApplied !== undefined) {
      data.dateApplied = body.dateApplied ? new Date(body.dateApplied) : null;
    }
    // Auto-stamp dateApplied when status transitions to applied AND not supplied.
    if (body.status === 'applied' && !existing.dateApplied && body.dateApplied === undefined) {
      data.dateApplied = new Date();
    }
    const row = await p.rATrackerEntry.update({ where: { id }, data });
    const job = row.jobId ? await p.rAJob.findUnique({ where: { id: row.jobId } }) : null;
    return toView(row, job);
  }

  /** Soft delete: stamp `deletedAt` so the entry drops out of every read path
   *  (board/list, counts, get, patch, bulk, and the duplicate check) while the
   *  row is retained for recovery/audit. Idempotent — a second delete is a
   *  no-op since the already-deleted row is filtered out below. */
  async delete(userId: string, id: string): Promise<void> {
    const p = prisma as any;
    const existing = await p.rATrackerEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new TrackerNotFoundError();
    await p.rATrackerEntry.update({ where: { id }, data: { deletedAt: new Date() } });
    logger.info('RA_V2_TRACKER', 'tracker entry soft-deleted', { userId, entryId: id });
  }

  async bulk(userId: string, body: TrackerBulkInput): Promise<{ updated: number; entries: RATrackerEntryView[] }> {
    const p = prisma as any;
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return { updated: 0, entries: [] };
    }
    const existing = await p.rATrackerEntry.findMany({
      where: { id: { in: body.ids }, userId, deletedAt: null },
    });
    const existingIds = new Set(existing.map((e: any) => e.id));
    // Spec §5.2 — entire op rejected if any id not owner-owned. The route
    // layer surfaces 403 when the count mismatches.
    if (existingIds.size !== body.ids.length) {
      throw new TrackerInvalidInputError('Some ids not owned by user');
    }
    const data: any = {};
    if (body.patch.status !== undefined) data.status = body.patch.status;
    if (body.patch.excitementStars !== undefined) {
      data.excitementStars = body.patch.excitementStars;
    }
    if (body.patch.deadline !== undefined) {
      data.deadline = body.patch.deadline
        ? new Date(body.patch.deadline + 'T00:00:00.000Z')
        : null;
    }
    // If status -> applied, stamp dateApplied for rows where it is currently null.
    if (body.patch.status === 'applied') {
      const needStamp = (existing as any[]).filter((e) => !e.dateApplied).map((e) => e.id);
      if (needStamp.length > 0) {
        await p.rATrackerEntry.updateMany({
          where: { id: { in: needStamp } },
          data: { dateApplied: new Date() },
        });
      }
    }
    await p.rATrackerEntry.updateMany({
      where: { id: { in: body.ids } },
      data,
    });
    const updatedRows = await p.rATrackerEntry.findMany({
      where: { id: { in: body.ids } },
    });
    const jobIds = (updatedRows as any[]).map((r) => r.jobId).filter((x): x is string => !!x);
    const jobs = jobIds.length
      ? await p.rAJob.findMany({ where: { id: { in: jobIds } } })
      : [];
    const jobsById = new Map<string, any>(jobs.map((j: any) => [j.id, j]));
    return {
      updated: updatedRows.length,
      entries: (updatedRows as any[]).map((r) => toView(r, r.jobId ? jobsById.get(r.jobId) : undefined)),
    };
  }

  /** Idempotent: returns existing entry if (userId, jobId) row exists, else
   *  creates one in the supplied status. Used by /jobs/:id/save and
   *  /jobs/:id/apply. `body.appliedVia` only applied when status='applied'. */
  async upsertForJob(
    userId: string,
    jobId: string,
    args: {
      status: RATrackerStatus;
      excitementStars?: number;
      appliedVia?: RAAppliedVia | null;
    },
  ): Promise<RATrackerEntryView> {
    const p = prisma as any;
    // Ignore a soft-deleted prior entry so save/apply after a delete creates a
    // fresh live row instead of resurrecting the tombstone.
    const existing = await p.rATrackerEntry.findFirst({ where: { userId, jobId, deletedAt: null } });
    const job = await p.rAJob.findUnique({ where: { id: jobId } });
    if (!job) throw new TrackerNotFoundError();

    if (existing) {
      const data: any = { updatedAt: new Date() };
      if (args.status === 'applied') {
        data.status = 'applied';
        if (!existing.dateApplied) data.dateApplied = new Date();
        if (args.appliedVia !== undefined) data.appliedVia = args.appliedVia;
      } else if (args.status === 'bookmarked') {
        // Don't downgrade an existing higher status — match stub semantics:
        // returns the existing row unchanged except optional excitement bump.
        if (args.excitementStars !== undefined) data.excitementStars = args.excitementStars;
      } else {
        data.status = args.status;
      }
      if (args.excitementStars !== undefined && data.excitementStars === undefined) {
        data.excitementStars = args.excitementStars;
      }
      const updated = await p.rATrackerEntry.update({ where: { id: existing.id }, data });
      return toView(updated, job);
    }

    const created = await p.rATrackerEntry.create({
      data: {
        userId,
        jobId,
        status: args.status,
        excitementStars: args.excitementStars ?? 0,
        maxSalary: job.salaryMax ?? null,
        maxSalaryCurrency: job.salaryCurrency ?? null,
        notesMarkdown: null,
        dateApplied: args.status === 'applied' ? new Date() : null,
        deadline: null,
        followUpAt: null,
        appliedVia: args.status === 'applied' ? (args.appliedVia ?? 'manual') : null,
        linkedRunId: null,
      },
    });
    return toView(created, job);
  }
}

export const raTrackerService = new RATrackerService();
export const _internal_toTrackerView = toView;
