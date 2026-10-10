// server/src/features/admin/reports.ts — "Reports to review" (PRODUCT F-TRUST-04;
// ARCHITECTURE.md §4.9; carry-over from WP-17 and WP-32).
//
// One item per public job that needs a look:
//   - users reported it (RAJobInteraction kind 'report'), newer than the last
//     admin decision;
//   - the feed closed it after three reports (closeReason 'reported') and no
//     admin has decided yet;
//   - an international job carries rule-based scam signals (WP-17
//     INTL_SCAM_RULES, quote-backed `fraudFlags`) newer than the last decision.
// GoApply jobs reported only for fraud reasons (scam, 培训贷, pay to work,
// fees) and GoApply fraud flags are decided on /admin/fraud (WP-41); those
// items say so and cannot be decided here.
//
// Decisions: `close` (closedAt + closeReason 'reported', like the feed's
// three-report rule) or `restore` (clears closedAt/closeReason of a job closed
// as 'reported' and drops its international scam flags; archivedAt is left
// alone, so a posting that aged out or was removed by its source stays
// archived). Each decision is stored as an RAJobInteraction row of kind
// 'admin_review' by the admin (Schema request SR-74-2 asks for a proper review
// table) and audited in SeekerActivityLog.
//
// Known limits until other owners act (handoff Requests):
//   - The feed's three-report rule counts every report ever made, so the next
//     single report closes a restored job again; it then reappears here as
//     open (fresh reports), but the restore does not hold (WP-93 request).
//   - The 'admin_review' rows sit under the admin's userId, so compliance
//     retention (13 months) and the admin's data export include them
//     (compliance-owner request; SR-74-2).

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { httpError } from '../../platform/http.js';
import { redactPii } from '../../platform/pii/index.js';
import { hasCnFraudFlags } from '../cn/jobs/index.js';
import { INTL_SCAM_RULES, mergeFraudFlags } from '../jobs/enrich/index.js';
import { writeAdminAudit, type AuditStore } from './audit.js';
import {
  ADMIN_AUDIT_EVENTS,
  CN_FRAUD_REPORT_REASONS,
  type ReportItem,
  type ReportsResponse,
  type ResolveDecision,
  type ResolveReportResponse,
} from './contract.js';

export const REPORTS_PAGE_SIZE = 30;
/** Jobs read per source when building the list (reports are rare; the cap keeps the read bounded). */
export const REPORT_SOURCE_CAP = 500;
export const ADMIN_REVIEW_KIND = 'admin_review';
const NOTE_CHARS = 200;
const MAX_NOTES = 3;

export interface ReportJobRow {
  id: string;
  title: string;
  companyName: string;
  market: string;
  visibility: string;
  sourceName: string | null;
  applyUrl: string | null;
  closedAt: Date | null;
  archivedAt: Date | null;
  closeReason: string | null;
  fraudFlags: unknown;
}

export interface ReportRow {
  jobId: string;
  reasonCode: string | null;
  note: string | null;
  createdAt: Date;
}

export interface DecisionRow {
  jobId: string;
  decision: ResolveDecision;
  at: Date;
  by: string;
  note: string | null;
}

export interface ReportsStore {
  /** Job ids with user reports, most recently reported first. */
  reportedJobIds(take: number): Promise<string[]>;
  /** Public jobs the feed closed as 'reported', most recent first. */
  closedReportedJobIds(take: number): Promise<string[]>;
  /** Open international jobs with any fraud flags. */
  flaggedIntlJobIds(take: number): Promise<string[]>;
  jobs(ids: readonly string[]): Promise<ReportJobRow[]>;
  reports(ids: readonly string[]): Promise<ReportRow[]>;
  decisions(ids: readonly string[]): Promise<DecisionRow[]>;
  loadJob(id: string): Promise<ReportJobRow | null>;
  updateJob(id: string, data: { closedAt?: Date | null; archivedAt?: Date | null; closeReason?: string | null; fraudFlags?: unknown }): Promise<void>;
  addDecision(row: DecisionRow): Promise<void>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

const INTL_RULES = new Set<string>(INTL_SCAM_RULES);

export function intlScamFlags(fraudFlags: unknown): Array<{ rule: string; evidence: string; at: string }> {
  if (!Array.isArray(fraudFlags)) return [];
  return fraudFlags.flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const { rule, evidence, at } = f as Record<string, unknown>;
    if (typeof rule !== 'string' || !INTL_RULES.has(rule)) return [];
    return [{ rule, evidence: typeof evidence === 'string' ? evidence : '', at: typeof at === 'string' ? at : '' }];
  });
}

/** A cn job whose reports are all fraud reasons (or that carries cn fraud flags) is decided on /admin/fraud. */
export function reviewedElsewhere(job: Pick<ReportJobRow, 'market' | 'fraudFlags'>, reasons: readonly string[]): boolean {
  if (job.market !== 'cn') return false;
  if (hasCnFraudFlags(job.fraudFlags)) return true;
  const fraud = new Set<string>(CN_FRAUD_REPORT_REASONS);
  return reasons.length > 0 && reasons.every((r) => fraud.has(r));
}

function latestDecision(rows: readonly DecisionRow[]): Map<string, DecisionRow> {
  const out = new Map<string, DecisionRow>();
  for (const r of rows) {
    const prev = out.get(r.jobId);
    if (!prev || prev.at <= r.at) out.set(r.jobId, r);
  }
  return out;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Build one item and say whether it is open. Pure. */
export function buildItem(job: ReportJobRow, reports: readonly ReportRow[], decision: DecisionRow | null): { item: ReportItem; open: boolean; sortAt: number } {
  const since = decision?.at ?? null;
  const fresh = since ? reports.filter((r) => r.createdAt > since) : [...reports];
  const flags = intlScamFlags(job.fraudFlags);
  const freshFlags = since ? flags.filter((f) => f.at && new Date(f.at) > since) : flags;
  const closedUndecided = job.closeReason === 'reported' && job.closedAt !== null && !decision;
  const open = fresh.length > 0 || freshFlags.length > 0 || closedUndecided;
  const shown = open ? fresh : [...reports];

  const byReason = new Map<string, number>();
  for (const r of shown) byReason.set(r.reasonCode ?? 'other', (byReason.get(r.reasonCode ?? 'other') ?? 0) + 1);
  const times = shown.map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
  const notes = shown
    .filter((r) => r.note && r.note.trim())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_NOTES)
    .map((r) => redactPii(r.note!.trim().slice(0, NOTE_CHARS)).text);
  const reasons = [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const flagTimes = flags.map((f) => Date.parse(f.at)).filter(Number.isFinite);
  const sortAt = Math.max(times[times.length - 1] ?? 0, ...flagTimes, job.closedAt?.getTime() ?? 0, decision?.at.getTime() ?? 0);

  return {
    open,
    sortAt,
    item: {
      id: job.id,
      title: job.title,
      companyName: job.companyName,
      market: job.market,
      sourceName: job.sourceName,
      applyUrl: job.applyUrl,
      state: job.closedAt || job.archivedAt ? 'closed' : 'open',
      closeReason: job.closeReason,
      closedAt: iso(job.closedAt),
      reasons,
      reportCount: shown.length,
      firstReportedAt: times.length ? new Date(times[0]!).toISOString() : null,
      lastReportedAt: times.length ? new Date(times[times.length - 1]!).toISOString() : null,
      notes,
      scamSignals: flags,
      reviewElsewhere: reviewedElsewhere(job, reasons.map((r) => r.reason)),
      lastDecision: decision ? { decision: decision.decision, at: decision.at.toISOString(), by: decision.by, note: decision.note } : null,
    },
  };
}

// ── List ─────────────────────────────────────────────────────────────────

export async function listReports(
  store: ReportsStore,
  query: { status?: 'open' | 'resolved'; market?: 'intl' | 'cn'; cursor?: string },
): Promise<ReportsResponse> {
  const status = query.status ?? 'open';
  const [reported, closed, flagged] = await Promise.all([
    store.reportedJobIds(REPORT_SOURCE_CAP),
    store.closedReportedJobIds(REPORT_SOURCE_CAP),
    store.flaggedIntlJobIds(REPORT_SOURCE_CAP),
  ]);
  const ids = [...new Set([...reported, ...closed, ...flagged])];
  if (!ids.length) return { items: [], cursor: null };
  const [jobs, reports, decisions] = await Promise.all([store.jobs(ids), store.reports(ids), store.decisions(ids)]);
  const latest = latestDecision(decisions);
  const reportsByJob = new Map<string, ReportRow[]>();
  for (const r of reports) reportsByJob.set(r.jobId, [...(reportsByJob.get(r.jobId) ?? []), r]);

  const built = jobs
    .filter((j) => j.visibility === 'public' && (!query.market || j.market === query.market))
    .map((j) => buildItem(j, reportsByJob.get(j.id) ?? [], latest.get(j.id) ?? null))
    // A flagged job with no reports and no flags left (e.g. cleared elsewhere) is not listed.
    .filter((b) => b.item.reportCount > 0 || b.item.scamSignals.length > 0 || b.item.closeReason === 'reported' || b.item.lastDecision)
    .filter((b) => (status === 'open' ? b.open : !b.open && b.item.lastDecision !== null))
    .sort((a, b) => b.sortAt - a.sortAt || a.item.id.localeCompare(b.item.id));

  const offset = query.cursor?.startsWith('o:') ? Math.max(0, Number(query.cursor.slice(2)) || 0) : 0;
  const page = built.slice(offset, offset + REPORTS_PAGE_SIZE).map((b) => b.item);
  return { items: page, cursor: offset + REPORTS_PAGE_SIZE < built.length ? `o:${offset + REPORTS_PAGE_SIZE}` : null };
}

// ── Resolve ──────────────────────────────────────────────────────────────

export async function resolveReport(
  deps: { store: ReportsStore; audit: AuditStore; now?: () => Date },
  jobId: string,
  body: { decision: ResolveDecision; note?: string },
  adminId: string,
): Promise<ResolveReportResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const job = await deps.store.loadJob(jobId);
  if (!job || job.visibility !== 'public') throw httpError('not_found', 'No public job with this id.');
  const reasons = (await deps.store.reports([jobId])).map((r) => r.reasonCode ?? 'other');
  if (reviewedElsewhere(job, reasons)) {
    throw httpError('conflict', 'Decide this job on the suspicious-jobs page (/admin/fraud).', { reviewAt: '/admin/fraud' });
  }
  const note = body.note?.trim() || null;
  let state: 'open' | 'closed' = job.closedAt || job.archivedAt ? 'closed' : 'open';
  const before = { closedAt: iso(job.closedAt), closeReason: job.closeReason };

  if (body.decision === 'close') {
    if (!job.closedAt) {
      await deps.store.updateJob(job.id, { closedAt: now, closeReason: 'reported' });
    }
    state = 'closed';
  } else if (job.closeReason === 'reported') {
    const flags = intlScamFlags(job.fraudFlags).length ? { fraudFlags: mergeFraudFlags(job.fraudFlags, []) } : {};
    await deps.store.updateJob(job.id, { closedAt: null, closeReason: null, ...flags });
    state = job.archivedAt ? 'closed' : 'open';
  } else if (intlScamFlags(job.fraudFlags).length) {
    await deps.store.updateJob(job.id, { fraudFlags: mergeFraudFlags(job.fraudFlags, []) });
  }

  await deps.store.addDecision({ jobId: job.id, decision: body.decision, at: now, by: adminId, note });
  await writeAdminAudit(deps.audit, {
    adminId,
    eventType: ADMIN_AUDIT_EVENTS.reportResolved,
    payload: { jobId: job.id, decision: body.decision, note, before, after: { state } },
  });
  return { id: job.id, state, decision: body.decision };
}

// ── Prisma implementation ────────────────────────────────────────────────

type Db = Pick<typeof prisma, 'rAJob' | 'rAJobInteraction'>;

const JOB_SELECT = {
  id: true,
  title: true,
  companyName: true,
  market: true,
  visibility: true,
  sourceName: true,
  applyUrl: true,
  closedAt: true,
  archivedAt: true,
  closeReason: true,
  fraudFlags: true,
} as const;

function noteOf(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const note = (detail as Record<string, unknown>).note;
  return typeof note === 'string' ? note : null;
}

export function createPrismaReportsStore(db: Db = prisma): ReportsStore {
  return {
    async reportedJobIds(take) {
      const rows = await db.rAJobInteraction.groupBy({
        by: ['jobId'],
        where: { kind: 'report' },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: 'desc' } },
        take,
      });
      return rows.map((r) => r.jobId);
    },
    async closedReportedJobIds(take) {
      const rows = await db.rAJob.findMany({
        where: { closeReason: 'reported', visibility: 'public' },
        orderBy: [{ closedAt: 'desc' }, { id: 'asc' }],
        take,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async flaggedIntlJobIds(take) {
      const rows = await db.rAJob.findMany({
        where: { market: 'intl', visibility: 'public', archivedAt: null, closedAt: null, NOT: { fraudFlags: { equals: Prisma.DbNull } } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    jobs(ids) {
      return db.rAJob.findMany({ where: { id: { in: [...ids] } }, select: JOB_SELECT });
    },
    async reports(ids) {
      const rows = await db.rAJobInteraction.findMany({
        where: { jobId: { in: [...ids] }, kind: 'report' },
        orderBy: { createdAt: 'desc' },
        select: { jobId: true, reasonCode: true, detail: true, createdAt: true },
      });
      return rows.map((r) => ({ jobId: r.jobId, reasonCode: r.reasonCode, note: noteOf(r.detail), createdAt: r.createdAt }));
    },
    async decisions(ids) {
      const rows = await db.rAJobInteraction.findMany({
        where: { jobId: { in: [...ids] }, kind: ADMIN_REVIEW_KIND },
        orderBy: { createdAt: 'desc' },
        select: { jobId: true, userId: true, reasonCode: true, detail: true, createdAt: true },
      });
      return rows
        .filter((r) => r.reasonCode === 'close' || r.reasonCode === 'restore')
        .map((r) => ({ jobId: r.jobId, decision: r.reasonCode as ResolveDecision, at: r.createdAt, by: r.userId, note: noteOf(r.detail) }));
    },
    loadJob(id) {
      return db.rAJob.findUnique({ where: { id }, select: JOB_SELECT });
    },
    async updateJob(id, data) {
      const update: Prisma.RAJobUpdateInput = {};
      if (data.closedAt !== undefined) update.closedAt = data.closedAt;
      if (data.archivedAt !== undefined) update.archivedAt = data.archivedAt;
      if (data.closeReason !== undefined) update.closeReason = data.closeReason;
      if (data.fraudFlags !== undefined) update.fraudFlags = data.fraudFlags === null ? Prisma.DbNull : (data.fraudFlags as Prisma.InputJsonValue);
      await db.rAJob.update({ where: { id }, data: update, select: { id: true } });
    },
    async addDecision(row) {
      await db.rAJobInteraction.create({
        data: { userId: row.by, jobId: row.jobId, kind: ADMIN_REVIEW_KIND, reasonCode: row.decision, detail: row.note ? { note: row.note } : undefined, createdAt: row.at },
      });
    },
  };
}
