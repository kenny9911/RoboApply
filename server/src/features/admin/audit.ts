// server/src/features/admin/audit.ts — audit rows for admin writes
// (ARCHITECTURE.md §10.5; SR-74-1).
//
// Every admin write (overrides, report decisions, referral-code moderation,
// queue retries, and other areas' admin writes that call `writeAdminAudit`)
// is one RAAdminAuditLog row: who did it (`adminId`), who it is about
// (`subjectUserId`, when there is one), what (`eventType`) and the details
// (`payload`). The table has no foreign keys, so a row outlives both
// accounts. Rows written before the table existed stay in SeekerActivityLog
// and are not copied.
//
// `writeAdminAudit` never throws: an audit failure is logged and must not
// undo the action it records.
//
// The System panel's "Admin actions" view reads the table through
// `listAdminAudit` (GET /admin/system/audit).

import prisma from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { redactPii } from '../../platform/pii/index.js';
import { logger } from '../../services/LoggerService.js';
import type { AdminAuditResponse, AdminAuditView } from './contract.js';

export interface AuditInput {
  adminId: string;
  /** The user the action is about, when there is one. */
  subjectUserId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

/** One row as stored. */
export interface AdminAuditRow {
  adminId: string;
  subjectUserId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface StoredAdminAuditRow extends AdminAuditRow {
  id: string;
  createdAt: Date;
}

export interface AdminAuditQuery {
  eventType?: string;
  subjectUserId?: string;
  adminId?: string;
  /** Rows strictly older than this (createdAt, then id). */
  before?: { createdAt: Date; id: string };
  take: number;
}

/** The RAAdminAuditLog store. */
export interface AdminAuditStore {
  record(row: AdminAuditRow): Promise<void>;
  /** Newest first. */
  list(query: AdminAuditQuery): Promise<StoredAdminAuditRow[]>;
}

/**
 * @deprecated The SeekerActivityLog-era store shape (a row needed a seeker
 * profile). Still accepted by `writeAdminAudit` so test doubles written
 * against it keep working; nothing in production builds one. Remove once no
 * caller passes it.
 */
export interface LegacyAuditStore {
  profileIdFor(userId: string): Promise<string | null>;
  write(seekerProfileId: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
}

export type AuditStore = AdminAuditStore | LegacyAuditStore;

function isLegacy(store: AuditStore): store is LegacyAuditStore {
  return typeof (store as Partial<AdminAuditStore>).record !== 'function';
}

type Db = Pick<typeof prisma, 'rAAdminAuditLog'>;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function createPrismaAuditStore(db: Db = prisma): AdminAuditStore {
  return {
    async record(row) {
      await db.rAAdminAuditLog.create({
        data: { adminId: row.adminId, subjectUserId: row.subjectUserId, eventType: row.eventType, payload: row.payload as Prisma.InputJsonValue },
        select: { id: true },
      });
    },
    async list(q) {
      const rows = await db.rAAdminAuditLog.findMany({
        where: {
          ...(q.eventType ? { eventType: q.eventType } : {}),
          ...(q.subjectUserId ? { subjectUserId: q.subjectUserId } : {}),
          ...(q.adminId ? { adminId: q.adminId } : {}),
          ...(q.before ? { OR: [{ createdAt: { lt: q.before.createdAt } }, { createdAt: q.before.createdAt, id: { lt: q.before.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.take,
        select: { id: true, adminId: true, subjectUserId: true, eventType: true, payload: true, createdAt: true },
      });
      return rows.map((r) => ({ id: r.id, adminId: r.adminId, subjectUserId: r.subjectUserId, eventType: r.eventType, payload: asRecord(r.payload), createdAt: r.createdAt }));
    },
  };
}

/** Legacy shape: the row went to the subject's or the admin's seeker profile, else nowhere. */
async function writeLegacy(store: LegacyAuditStore, input: AuditInput, payload: Record<string, unknown>): Promise<'subject' | 'admin' | null> {
  const subject = input.subjectUserId ? await store.profileIdFor(input.subjectUserId) : null;
  if (subject) {
    await store.write(subject, input.eventType, payload);
    return 'subject';
  }
  const own = await store.profileIdFor(input.adminId);
  if (!own) return null;
  await store.write(own, input.eventType, payload);
  return 'admin';
}

/**
 * Write one audit row. Returns 'subject' when the row names a subject user,
 * 'admin' when it names only the admin, and 'log_only' when the row could not
 * be stored (the action is then in the server log). Never throws.
 */
export async function writeAdminAudit(store: AuditStore, input: AuditInput): Promise<'subject' | 'admin' | 'log_only'> {
  const subjectUserId = input.subjectUserId ?? null;
  try {
    if (isLegacy(store)) {
      const payload = { ...input.payload, adminId: input.adminId, ...(subjectUserId ? { subjectUserId } : {}) };
      const landed = await writeLegacy(store, input, payload);
      if (landed) return landed;
    } else {
      await store.record({ adminId: input.adminId, subjectUserId, eventType: input.eventType, payload: input.payload });
      return subjectUserId ? 'subject' : 'admin';
    }
  } catch (err) {
    logger.error('ADMIN', 'audit row failed', { eventType: input.eventType, error: err instanceof Error ? err.message : String(err) });
  }
  logger.warn('ADMIN', 'admin action (audit row not stored)', { eventType: input.eventType, adminId: input.adminId, ...(subjectUserId ? { subjectUserId } : {}), ...input.payload });
  return 'log_only';
}

// ── GET /system/audit ────────────────────────────────────────────────────

export const AUDIT_PAGE_SIZE = 50;
/** Longest details line sent to the console. */
export const AUDIT_DETAIL_CHARS = 400;

function encodeCursor(row: StoredAdminAuditRow): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

export function decodeAuditCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const at = cursor.indexOf('|');
  if (at < 1) return undefined;
  const createdAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return Number.isNaN(createdAt.getTime()) || !id ? undefined : { createdAt, id };
}

/**
 * The payload as one line for the console: `key: value` pairs, contact
 * details redacted (notes and reasons are free text), shortened. The ids in
 * the row's own columns are not repeated.
 */
export function auditDetails(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'adminId' || key === 'subjectUserId' || value === null || value === undefined || value === '') continue;
    parts.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  const text = redactPii(parts.join(' · ')).text;
  return text.length > AUDIT_DETAIL_CHARS ? `${text.slice(0, AUDIT_DETAIL_CHARS - 1)}…` : text;
}

export function toAuditView(row: StoredAdminAuditRow): AdminAuditView {
  return {
    id: row.id,
    adminId: row.adminId,
    subjectUserId: row.subjectUserId,
    eventType: row.eventType,
    details: auditDetails(row.payload),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Recent admin actions, newest first. A legacy store has no list (empty). */
export async function listAdminAudit(store: AuditStore, query: { eventType?: string; subjectUserId?: string; adminId?: string; cursor?: string }): Promise<AdminAuditResponse> {
  if (isLegacy(store)) return { items: [], cursor: null };
  const rows = await store.list({
    ...(query.eventType ? { eventType: query.eventType } : {}),
    ...(query.subjectUserId ? { subjectUserId: query.subjectUserId } : {}),
    ...(query.adminId ? { adminId: query.adminId } : {}),
    before: decodeAuditCursor(query.cursor),
    take: AUDIT_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  return { items: page.map(toAuditView), cursor: rows.length > AUDIT_PAGE_SIZE ? encodeCursor(page[page.length - 1]!) : null };
}
