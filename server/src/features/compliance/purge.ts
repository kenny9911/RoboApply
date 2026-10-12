// server/src/features/compliance/purge.ts
//
// `compliance.purge`: close and delete an account because the user withdrew
// a consent the service cannot run without (GoApply CN-0 `pipl_cross_border`;
// PRODUCT §4.5 G1). Steps:
//   1. close the account at once — SeekerProfile.deletedAt + every session
//      revoked (the same soft delete as /account/delete, WP-10);
//   2. hard-delete it — stored files first, then the User row with its
//      cascades — through the account-purge seam `purgeAccountNow(userId)`
//      exported by SeekerAccountPurgeService (added at the Wave 2 gate). When
//      it refuses (non-seeker role) or is blocked (a stored file could not be
//      deleted), or if the export were missing, the closed account is
//      hard-deleted by the nightly account-purge sweep
//      (ACCOUNT_PURGE_RETENTION_DAYS after closing, default 30 calendar days),
//      which is later than the 15-working-day due date. The request then stays
//      `in_progress` with a handling note giving the expected sweep date and,
//      when that is after the due date, telling staff to delete the account by
//      hand before it; compliance-daily closes the request once the account is
//      gone.

import prisma from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PermanentWorkError, type LeasedWorkItem } from '../../platform/queue/index.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { resolveRetentionDays } from '../../roboapply/services/accountPurgeHelpers.js';
import { parseDetail } from './piRequests.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgePayload {
  userId: string;
  piRequestId?: string;
  reason?: string;
}

export interface AccountCloser {
  /** Soft-close: deletedAt + revoke sessions. */
  close(userId: string): Promise<void>;
  /** Hard purge now; `false` when the seam is not available (the nightly sweep finishes later). */
  purgeNow(userId: string): Promise<boolean>;
}

/** Narrow adapter over WP-10's services (structural check; no edits to them). */
export const defaultAccountCloser: AccountCloser = {
  async close(userId) {
    const { seekerAuthService } = await import('../../roboapply/engine/services/SeekerAuthService.js');
    await seekerAuthService.softDeleteAccount(userId);
  },
  async purgeNow(userId) {
    const mod = (await import('../../roboapply/services/SeekerAccountPurgeService.js')) as Record<string, unknown>;
    const fn = mod.purgeAccountNow;
    if (typeof fn !== 'function') return false;
    const outcome = (await (fn as (id: string) => Promise<{ blocked?: boolean } | boolean>)(userId)) as { blocked?: boolean } | boolean;
    return typeof outcome === 'boolean' ? outcome : !outcome?.blocked;
  },
};

export interface PurgeDeps {
  db?: Pick<typeof prisma, 'rAPersonalInfoRequest'>;
  closer?: AccountCloser;
  now?: () => Date;
  env?: EnvSource;
}

/** The staff note when the account is closed but not yet deleted. */
export function pendingPurgeNote(closedAt: Date, dueAt: Date | null, env: EnvSource): string {
  const days = resolveRetentionDays(env.ACCOUNT_PURGE_RETENTION_DAYS);
  const expected = new Date(closedAt.getTime() + days * DAY_MS);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const base = `account closed; the account-purge sweep deletes it on or after ${day(expected)} (${days} days after closing)`;
  if (dueAt && expected.getTime() > dueAt.getTime()) {
    return `${base}, which is after this request's due date ${day(dueAt)}: delete the account by hand before ${day(dueAt)}`;
  }
  return base;
}

export async function handleAccountPurge(item: Pick<LeasedWorkItem<unknown>, 'payload'>, deps: PurgeDeps = {}): Promise<{ purged: boolean }> {
  const db = deps.db ?? prisma;
  const closer = deps.closer ?? defaultAccountCloser;
  const now = (deps.now ?? (() => new Date()))();
  const payload = item.payload as Partial<PurgePayload> | null;
  if (!payload?.userId) throw new PermanentWorkError('compliance.purge: missing userId');

  await closer.close(payload.userId);
  const purged = await closer.purgeNow(payload.userId);

  if (payload.piRequestId) {
    const row = await db.rAPersonalInfoRequest.findUnique({ where: { id: payload.piRequestId }, select: { detail: true, dueAt: true } });
    if (row) {
      const detail = parseDetail(row.detail);
      detail.handlingNotes = [
        ...(detail.handlingNotes ?? []),
        { at: now.toISOString(), by: 'system', note: purged ? 'account closed and deleted' : pendingPurgeNote(now, row.dueAt ?? null, deps.env ?? process.env) },
      ];
      await db.rAPersonalInfoRequest.update({
        where: { id: payload.piRequestId },
        data: purged
          ? { status: 'done', closedAt: now, detail: detail as Prisma.InputJsonValue }
          : { status: 'in_progress', detail: detail as Prisma.InputJsonValue },
      });
    }
  }
  return { purged };
}
