// server/src/features/match/reportStore.ts
//
// Narrow typed adapter over `RAFitReport` (kind 'competitiveness'; ARCH §2.5).
// The service talks to this interface only; tests use the memory store.
// Typed Prisma, imported lazily so importing the area never opens a pool.

export const COMPETITIVENESS_KIND = 'competitiveness' as const;

export interface FitReportRow {
  id: string;
  userId: string;
  kind: string;
  inputHash: string;
  report: unknown;
  creditLedgerId: string | null;
  createdAt: Date;
}

export interface FitReportStore {
  /** The newest report with this inputs hash created at or after `since`. */
  findReusable(userId: string, inputHash: string, since: Date): Promise<FitReportRow | null>;
  /** The user's newest reports, newest first (at most `limit`). */
  latest(userId: string, limit: number): Promise<FitReportRow[]>;
  save(row: { userId: string; inputHash: string; report: unknown; creditLedgerId: string | null }): Promise<FitReportRow>;
}

const SELECT = { id: true, userId: true, kind: true, inputHash: true, report: true, creditLedgerId: true, createdAt: true } as const;

async function db() {
  return (await import('../../lib/prisma.js')).default;
}

export function createPrismaFitReportStore(): FitReportStore {
  return {
    async findReusable(userId, inputHash, since) {
      const p = await db();
      return p.rAFitReport.findFirst({
        where: { userId, kind: COMPETITIVENESS_KIND, inputHash, createdAt: { gte: since } },
        select: SELECT,
        orderBy: { createdAt: 'desc' },
      });
    },
    async latest(userId, limit) {
      const p = await db();
      return p.rAFitReport.findMany({ where: { userId, kind: COMPETITIVENESS_KIND }, select: SELECT, orderBy: { createdAt: 'desc' }, take: limit });
    },
    async save(row) {
      const p = await db();
      return p.rAFitReport.create({
        data: { userId: row.userId, kind: COMPETITIVENESS_KIND, inputHash: row.inputHash, report: row.report as object, creditLedgerId: row.creditLedgerId, model: null },
        select: SELECT,
      });
    },
  };
}

/** In-memory store for tests (no vitest imports). */
export function createMemoryFitReportStore(now: () => Date = () => new Date()): FitReportStore & { rows: FitReportRow[] } {
  const rows: FitReportRow[] = [];
  let seq = 0;
  const newestFirst = (a: FitReportRow, b: FitReportRow) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  return {
    rows,
    async findReusable(userId, inputHash, since) {
      return rows.filter((r) => r.userId === userId && r.inputHash === inputHash && r.createdAt >= since).sort(newestFirst)[0] ?? null;
    },
    async latest(userId, limit) {
      return rows.filter((r) => r.userId === userId).sort(newestFirst).slice(0, limit);
    },
    async save(row) {
      seq += 1;
      const saved: FitReportRow = { id: `rep_${String(seq).padStart(3, '0')}`, kind: COMPETITIVENESS_KIND, createdAt: now(), ...row };
      rows.push(saved);
      return saved;
    },
  };
}
