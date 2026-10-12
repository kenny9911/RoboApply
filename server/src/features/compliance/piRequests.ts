// server/src/features/compliance/piRequests.ts
//
// Personal-information requests (PIPL Art. 44–47 and 50; GDPR Art. 12–22;
// Taiwan PDPA Art. 3, 10, 11): a queue with a statutory due date.
//   GoApply   — 15 working days (PIPL rights handling, CN plan C-5).
//   RoboApply — 30 calendar days (GDPR one month, the stricter common bound).
// Working days skip Saturdays and Sundays only. Public holidays would push the
// statutory deadline later, so ignoring them can only make `dueAt` earlier —
// the conservative direction.
//
// Execution reuses what exists: account deletion is the #danger flow
// (`/account/delete`, WP-10) and data copies are the `compliance.export` job.
// The queue makes every request visible to staff with its due date
// (`GET /admin/compliance/pi-requests?overdue=true`).

import prisma from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import type { BrandId } from '../../platform/brand/registry.js';
import {
  COMPLIANCE_ERROR_CODES,
  PI_REQUEST_DUE,
  PiRequestDetailSchema,
  type AdminPiRequestView,
  type PiRequestDetail,
  type PiRequestKind,
  type PiRequestStatus,
  type PiRequestView,
} from './contract.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Add `n` working days (Mon–Fri) to `from`, keeping the time of day. */
export function addWorkingDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setTime(d.getTime() + DAY_MS);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

/** The statutory due date of a request filed at `from` on `brand`. */
export function piRequestDueAt(brand: BrandId, from: Date): Date {
  return brand === 'goapply'
    ? addWorkingDays(from, PI_REQUEST_DUE.goapplyWorkingDays)
    : new Date(from.getTime() + PI_REQUEST_DUE.roboapplyDays * DAY_MS);
}

export type PiRequestDb = Pick<typeof prisma, 'rAPersonalInfoRequest'>;

export interface PiRequestRow {
  id: string;
  brand: string;
  userId: string | null;
  kind: string;
  status: string;
  dueAt: Date;
  detail: unknown;
  createdAt: Date;
  closedAt: Date | null;
}

export function parseDetail(raw: unknown): PiRequestDetail {
  const parsed = PiRequestDetailSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export function toPiRequestView(row: PiRequestRow, now: Date = new Date()): PiRequestView {
  const detail = parseDetail(row.detail);
  const exp = detail.export;
  const downloadable = row.status === 'done' && exp && !exp.purgedAt && Date.parse(exp.expiresAt) > now.getTime();
  return {
    id: row.id,
    kind: row.kind as PiRequestKind,
    status: row.status as PiRequestStatus,
    dueAt: row.dueAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.closedAt ? row.closedAt.toISOString() : null,
    download: downloadable ? { expiresAt: exp.expiresAt, bytes: exp.bytes } : null,
  };
}

export function isOverdue(row: Pick<PiRequestRow, 'status' | 'dueAt'>, now: Date): boolean {
  return (row.status === 'open' || row.status === 'in_progress') && row.dueAt.getTime() < now.getTime();
}

export function toAdminPiRequestView(row: PiRequestRow, now: Date = new Date()): AdminPiRequestView {
  const detail = parseDetail(row.detail);
  return {
    ...toPiRequestView(row, now),
    brand: row.brand,
    userId: row.userId,
    overdue: isOverdue(row, now),
    userNote: detail.userNote ?? null,
    handlingNotes: detail.handlingNotes ?? [],
  };
}

const SELECT = {
  id: true,
  brand: true,
  userId: true,
  kind: true,
  status: true,
  dueAt: true,
  detail: true,
  createdAt: true,
  closedAt: true,
} as const;

export interface PiRequestServiceDeps {
  db?: PiRequestDb;
  now?: () => Date;
}

/** File a request. One open request per kind at a time (409 with its id). */
export async function createPiRequest(
  input: { userId: string; brand: BrandId; kind: PiRequestKind; userNote?: string; status?: PiRequestStatus; reason?: string },
  deps: PiRequestServiceDeps = {},
): Promise<PiRequestRow> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const existing = await db.rAPersonalInfoRequest.findFirst({
    where: { userId: input.userId, kind: input.kind, status: { in: ['open', 'in_progress'] } },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError('conflict', 'A request of this kind is already open.', {
      reason: COMPLIANCE_ERROR_CODES.requestOpen,
      requestId: existing.id,
    });
  }
  const detail: PiRequestDetail = {};
  if (input.userNote) detail.userNote = input.userNote;
  if (input.reason) detail.reason = input.reason;
  return db.rAPersonalInfoRequest.create({
    data: {
      brand: input.brand,
      userId: input.userId,
      kind: input.kind,
      status: input.status ?? 'open',
      dueAt: piRequestDueAt(input.brand, now),
      detail: detail as Prisma.InputJsonValue,
    },
    select: SELECT,
  });
}

export async function listUserPiRequests(userId: string, deps: PiRequestServiceDeps = {}): Promise<PiRequestView[]> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const rows = await db.rAPersonalInfoRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: SELECT,
  });
  return rows.map((r) => toPiRequestView(r, now));
}

export const ADMIN_PAGE_SIZE = 50;

export async function adminListPiRequests(
  query: { brand?: BrandId; status?: PiRequestStatus; overdue?: boolean; cursor?: string },
  deps: PiRequestServiceDeps = {},
): Promise<{ items: AdminPiRequestView[]; cursor: string | null }> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const where: Record<string, unknown> = {};
  if (query.brand) where.brand = query.brand;
  if (query.overdue) {
    where.status = { in: ['open', 'in_progress'] };
    where.dueAt = { lt: now };
  } else if (query.status) {
    where.status = query.status;
  }
  const rows = await db.rAPersonalInfoRequest.findMany({
    where,
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: ADMIN_PAGE_SIZE + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: SELECT,
  });
  const page = rows.slice(0, ADMIN_PAGE_SIZE);
  return {
    items: page.map((r) => toAdminPiRequestView(r, now)),
    cursor: rows.length > ADMIN_PAGE_SIZE ? page[page.length - 1]!.id : null,
  };
}

/** Staff update: status change and/or a handling note (who, when, what). */
export async function adminUpdatePiRequest(
  id: string,
  patch: { status?: PiRequestStatus; note?: string },
  staff: { id: string },
  deps: PiRequestServiceDeps = {},
): Promise<AdminPiRequestView> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const row = await db.rAPersonalInfoRequest.findUnique({ where: { id }, select: SELECT });
  if (!row) throw new HttpError('not_found');
  const detail = parseDetail(row.detail);
  if (patch.note) detail.handlingNotes = [...(detail.handlingNotes ?? []), { at: now.toISOString(), by: staff.id, note: patch.note }];
  const closing = patch.status === 'done' || patch.status === 'rejected';
  const updated = await db.rAPersonalInfoRequest.update({
    where: { id },
    data: {
      detail: detail as Prisma.InputJsonValue,
      ...(patch.status ? { status: patch.status } : {}),
      ...(closing ? { closedAt: now } : patch.status ? { closedAt: null } : {}),
    },
    select: SELECT,
  });
  return toAdminPiRequestView(updated, now);
}
