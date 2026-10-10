// server/src/features/admin/audit.ts — audit rows for admin writes
// (ARCHITECTURE.md §10.5: "overrides and moderation write an audit
// SeekerActivityLog row (reused)").
//
// SeekerActivityLog hangs off a SeekerProfile. The row goes to the subject
// user's profile (an override is about that person), else to the acting
// admin's own profile (job moderation has no subject user). With neither,
// the action is still logged to the server log so nothing is silent; Schema
// request SR-74-1 asks for a dedicated admin audit table without that limit.

import prisma from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';

export interface AuditInput {
  adminId: string;
  /** The user the action is about, when there is one. */
  subjectUserId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface AuditStore {
  profileIdFor(userId: string): Promise<string | null>;
  write(seekerProfileId: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
}

type Db = Pick<typeof prisma, 'seekerProfile' | 'seekerActivityLog'>;

export function createPrismaAuditStore(db: Db = prisma): AuditStore {
  return {
    async profileIdFor(userId) {
      const row = await db.seekerProfile.findUnique({ where: { userId }, select: { id: true } });
      return row?.id ?? null;
    },
    async write(seekerProfileId, eventType, payload) {
      await db.seekerActivityLog.create({ data: { seekerProfileId, eventType, payload: payload as Prisma.InputJsonValue } });
    },
  };
}

/** Where the row landed: 'subject' | 'admin' | 'log_only'. Never throws (an audit failure must not undo the action). */
export async function writeAdminAudit(store: AuditStore, input: AuditInput): Promise<'subject' | 'admin' | 'log_only'> {
  const payload = { ...input.payload, adminId: input.adminId, ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}) };
  try {
    const subject = input.subjectUserId ? await store.profileIdFor(input.subjectUserId) : null;
    if (subject) {
      await store.write(subject, input.eventType, payload);
      return 'subject';
    }
    const own = await store.profileIdFor(input.adminId);
    if (own) {
      await store.write(own, input.eventType, payload);
      return 'admin';
    }
  } catch (err) {
    logger.error('ADMIN', 'audit row failed', { eventType: input.eventType, error: err instanceof Error ? err.message : String(err) });
  }
  logger.warn('ADMIN', 'admin action (no seeker profile for an audit row)', { eventType: input.eventType, ...payload });
  return 'log_only';
}
