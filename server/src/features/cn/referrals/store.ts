// server/src/features/cn/referrals/store.ts — persistence for the GoApply 内推码 hub (WP-54).
//
// SCHEMA REQUEST SR-54-1 (not in the schema yet): models `RACnReferralCode`
// and `RACnReferralReport` (fields below, ra-cn.prisma). Until SCHEMA-4 adds
// them, the Prisma adapter reaches the delegates through a narrow typed view
// and reports `available() === false` when they are missing, so the routes
// answer 503 storage_unavailable instead of crashing; after the push it works
// without a code change. The memory store backs the service tests.
//
//   model RACnReferralCode {
//     id                String    @id @default(cuid())
//     brand             String
//     userId            String
//     user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)
//     company           String
//     companyNormalized String
//     code              String
//     programme         String?
//     expiresAt         DateTime?
//     note              String?
//     /// 'pending' | 'approved' | 'rejected' | 'expired' | 'deleted'
//     /// 'deleted' = the sharer deleted it: soft delete, so it still counts toward
//     /// the 10-a-day share cap; never listed, reported or moderated again.
//     status            String    @default("pending")
//     rejectReason      String?
//     reportCount       Int       @default(0)
//     /// Set when reports take an approved code off the hub until re-review.
//     hiddenAt          DateTime?
//     moderatedAt       DateTime?
//     moderatedById     String?
//     createdAt         DateTime  @default(now())
//     updatedAt         DateTime  @updatedAt
//     reports           RACnReferralReport[]
//     @@index([brand, status, companyNormalized])
//     @@index([userId, createdAt])
//   }
//   model RACnReferralReport {
//     id        String           @id @default(cuid())
//     codeId    String
//     code      RACnReferralCode @relation(fields: [codeId], references: [id], onDelete: Cascade)
//     userId    String
//     user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)
//     reason    String
//     note      String?
//     createdAt DateTime         @default(now())
//     @@unique([codeId, userId])
//   }

import prisma from '../../../lib/prisma.js';
import type { ReferralCodeStatus, ReferralReportReason } from './contract.js';

export interface ReferralCodeRow {
  id: string;
  brand: string;
  userId: string;
  company: string;
  companyNormalized: string;
  code: string;
  programme: string | null;
  expiresAt: Date | null;
  note: string | null;
  status: ReferralCodeStatus | string;
  rejectReason: string | null;
  reportCount: number;
  hiddenAt: Date | null;
  moderatedAt: Date | null;
  moderatedById: string | null;
  createdAt: Date;
}

export interface ReferralReportRow {
  id: string;
  codeId: string;
  userId: string;
  reason: ReferralReportReason | string;
  note: string | null;
  createdAt: Date;
}

export type NewReferralCode = Pick<ReferralCodeRow, 'brand' | 'userId' | 'company' | 'companyNormalized' | 'code' | 'programme' | 'expiresAt' | 'note'>;

export interface ReferralStore {
  /** False until SR-54-1 is in the database client. */
  available(): boolean;
  /** Approved, not hidden, not expired (expiresAt ≥ today), newest first. */
  listVisible(input: { brand: string; companyNormalized?: string; programmeContains?: string; today: Date; cursor?: string; limit: number }): Promise<ReferralCodeRow[]>;
  listMine(userId: string, brand: string, limit: number): Promise<ReferralCodeRow[]>;
  /** A pending or approved code with the same company and code. */
  findLiveDuplicate(brand: string, companyNormalized: string, code: string): Promise<ReferralCodeRow | null>;
  /** Codes the user shared since `since`, INCLUDING ones they deleted (soft delete keeps the cap honest). */
  countSharedSince(userId: string, since: Date): Promise<number>;
  create(input: NewReferralCode): Promise<ReferralCodeRow>;
  find(id: string): Promise<ReferralCodeRow | null>;
  reportedBy(userId: string, codeIds: string[]): Promise<Set<string>>;
  /** false when this user already reported this code. */
  addReport(input: Omit<ReferralReportRow, 'id' | 'createdAt'>): Promise<boolean>;
  /** Atomic `reportCount = reportCount + 1`; returns the row after the increment. */
  incrementReportCount(id: string): Promise<ReferralCodeRow>;
  update(id: string, data: Partial<Pick<ReferralCodeRow, 'status' | 'rejectReason' | 'reportCount' | 'hiddenAt' | 'moderatedAt' | 'moderatedById'>>): Promise<ReferralCodeRow>;
  /** Soft delete by the sharer: status 'deleted', note cleared. */
  remove(id: string): Promise<void>;
  /** Pending codes and approved codes hidden by reports, oldest first. */
  queue(input: { brand: string; cursor?: string; limit: number }): Promise<ReferralCodeRow[]>;
  reportsFor(codeIds: string[]): Promise<ReferralReportRow[]>;
}

// ── Prisma adapter (narrow typed view over the SR-54-1 delegates) ───────

interface Delegate<Row> {
  findMany(args: object): Promise<Row[]>;
  findFirst(args: object): Promise<Row | null>;
  findUnique(args: object): Promise<Row | null>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  count(args: object): Promise<number>;
}

interface ReferralDelegates {
  rACnReferralCode: Delegate<ReferralCodeRow>;
  rACnReferralReport: Delegate<ReferralReportRow>;
}

const CODE_SELECT = {
  id: true,
  brand: true,
  userId: true,
  company: true,
  companyNormalized: true,
  code: true,
  programme: true,
  expiresAt: true,
  note: true,
  status: true,
  rejectReason: true,
  reportCount: true,
  hiddenAt: true,
  moderatedAt: true,
  moderatedById: true,
  createdAt: true,
} as const;

function unavailable(): Error {
  return new Error('SR-54-1: RACnReferralCode is not in the database client yet');
}

export function createPrismaReferralStore(db: object = prisma): ReferralStore {
  const view = db as Partial<ReferralDelegates>;
  const codes = (): Delegate<ReferralCodeRow> => {
    if (!view.rACnReferralCode) throw unavailable();
    return view.rACnReferralCode;
  };
  const reports = (): Delegate<ReferralReportRow> => {
    if (!view.rACnReferralReport) throw unavailable();
    return view.rACnReferralReport;
  };
  const page = (cursor: string | undefined) => (cursor ? { cursor: { id: cursor }, skip: 1 } : {});
  return {
    available: () => Boolean(view.rACnReferralCode && view.rACnReferralReport),
    async listVisible({ brand, companyNormalized, programmeContains, today, cursor, limit }) {
      return codes().findMany({
        where: {
          brand,
          status: 'approved',
          hiddenAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gte: today } }],
          ...(companyNormalized ? { companyNormalized: { contains: companyNormalized } } : {}),
          ...(programmeContains ? { programme: { contains: programmeContains } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        ...page(cursor),
        select: CODE_SELECT,
      });
    },
    async listMine(userId, brand, limit) {
      return codes().findMany({ where: { userId, brand, status: { not: 'deleted' } }, orderBy: { createdAt: 'desc' }, take: limit, select: CODE_SELECT });
    },
    async findLiveDuplicate(brand, companyNormalized, code) {
      return codes().findFirst({ where: { brand, companyNormalized, code, status: { in: ['pending', 'approved'] } }, select: CODE_SELECT });
    },
    async countSharedSince(userId, since) {
      return codes().count({ where: { userId, createdAt: { gte: since } } });
    },
    async create(input) {
      return codes().create({ data: { ...input, status: 'pending' }, select: CODE_SELECT });
    },
    async find(id) {
      return codes().findUnique({ where: { id }, select: CODE_SELECT });
    },
    async reportedBy(userId, codeIds) {
      if (!codeIds.length) return new Set();
      const rows = await reports().findMany({ where: { userId, codeId: { in: codeIds } }, select: { codeId: true } });
      return new Set(rows.map((r) => r.codeId));
    },
    async addReport(input) {
      const existing = await reports().findFirst({ where: { codeId: input.codeId, userId: input.userId }, select: { id: true } });
      if (existing) return false;
      try {
        await reports().create({ data: input });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') return false; // unique (codeId, userId) race
        throw err;
      }
    },
    async incrementReportCount(id) {
      return codes().update({ where: { id }, data: { reportCount: { increment: 1 } }, select: CODE_SELECT });
    },
    async update(id, data) {
      return codes().update({ where: { id }, data, select: CODE_SELECT });
    },
    async remove(id) {
      await codes().update({ where: { id }, data: { status: 'deleted', note: null, hiddenAt: null }, select: { id: true } });
    },
    async queue({ brand, cursor, limit }) {
      return codes().findMany({
        where: { brand, OR: [{ status: 'pending' }, { status: 'approved', hiddenAt: { not: null } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
        ...page(cursor),
        select: CODE_SELECT,
      });
    },
    async reportsFor(codeIds) {
      if (!codeIds.length) return [];
      return reports().findMany({ where: { codeId: { in: codeIds } }, orderBy: { createdAt: 'desc' } });
    },
  };
}

// ── Memory store (tests) ────────────────────────────────────────────────

export function createMemoryReferralStore(): ReferralStore & { codes: ReferralCodeRow[]; reports: ReferralReportRow[] } {
  const codes: ReferralCodeRow[] = [];
  const reports: ReferralReportRow[] = [];
  let seq = 0;
  const id = (p: string) => `${p}_${(++seq).toString().padStart(4, '0')}`;
  const after = <T extends { id: string }>(rows: T[], cursor?: string) => {
    if (!cursor) return rows;
    const i = rows.findIndex((r) => r.id === cursor);
    return i >= 0 ? rows.slice(i + 1) : rows;
  };
  const newestFirst = (a: ReferralCodeRow, b: ReferralCodeRow) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  return {
    codes,
    reports,
    available: () => true,
    async listVisible({ brand, companyNormalized, programmeContains, today, cursor, limit }) {
      const rows = codes
        .filter(
          (c) =>
            c.brand === brand &&
            c.status === 'approved' &&
            !c.hiddenAt &&
            (!c.expiresAt || c.expiresAt.getTime() >= today.getTime()) &&
            (!companyNormalized || c.companyNormalized.includes(companyNormalized)) &&
            (!programmeContains || (c.programme ?? '').includes(programmeContains)),
        )
        .sort(newestFirst);
      return after(rows, cursor).slice(0, limit).map((r) => ({ ...r }));
    },
    async listMine(userId, brand, limit) {
      return codes.filter((c) => c.userId === userId && c.brand === brand && c.status !== 'deleted').sort(newestFirst).slice(0, limit).map((r) => ({ ...r }));
    },
    async findLiveDuplicate(brand, companyNormalized, code) {
      return codes.find((c) => c.brand === brand && c.companyNormalized === companyNormalized && c.code === code && (c.status === 'pending' || c.status === 'approved')) ?? null;
    },
    async countSharedSince(userId, since) {
      return codes.filter((c) => c.userId === userId && c.createdAt.getTime() >= since.getTime()).length;
    },
    async create(input) {
      const row: ReferralCodeRow = {
        ...input,
        id: id('rc'),
        status: 'pending',
        rejectReason: null,
        reportCount: 0,
        hiddenAt: null,
        moderatedAt: null,
        moderatedById: null,
        createdAt: new Date(Date.UTC(2026, 9, 10, 12, 0, seq)),
      };
      codes.push(row);
      return { ...row };
    },
    async find(cid) {
      const row = codes.find((c) => c.id === cid);
      return row ? { ...row } : null;
    },
    async reportedBy(userId, codeIds) {
      return new Set(reports.filter((r) => r.userId === userId && codeIds.includes(r.codeId)).map((r) => r.codeId));
    },
    async addReport(input) {
      if (reports.some((r) => r.codeId === input.codeId && r.userId === input.userId)) return false;
      reports.push({ ...input, id: id('rr'), createdAt: new Date() });
      return true;
    },
    async incrementReportCount(cid) {
      const row = codes.find((c) => c.id === cid);
      if (!row) throw new Error('not found');
      row.reportCount += 1;
      return { ...row };
    },
    async update(cid, data) {
      const row = codes.find((c) => c.id === cid);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    },
    async remove(cid) {
      const row = codes.find((c) => c.id === cid);
      if (row) Object.assign(row, { status: 'deleted', note: null, hiddenAt: null });
    },
    async queue({ brand, cursor, limit }) {
      const rows = codes
        .filter((c) => c.brand === brand && (c.status === 'pending' || (c.status === 'approved' && c.hiddenAt)))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      return after(rows, cursor).slice(0, limit).map((r) => ({ ...r }));
    },
    async reportsFor(codeIds) {
      return reports.filter((r) => codeIds.includes(r.codeId));
    },
  };
}
