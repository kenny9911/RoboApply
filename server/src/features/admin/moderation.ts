// server/src/features/admin/moderation.ts — GoApply referral-code moderation
// from the console, with an audit row (ARCHITECTURE.md §10.5: "overrides and
// moderation write an audit SeekerActivityLog row").
//
// The rules and storage are WP-54's (cn/referrals `CnReferralService.moderate`:
// approve/reject, reason codes, report-count reset). This module reads the
// code first (owner and status before), calls the service, then writes the
// audit row against the person who shared the code.

import { writeAdminAudit, type AuditStore } from './audit.js';
import { ADMIN_AUDIT_EVENTS } from './contract.js';

export type ReferralDecision = 'approve' | 'reject';

/** The slice of cn/referrals this module needs (service + store from its index.ts). */
export interface ReferralModeration {
  /** The code's owner and status before the decision; null when unknown (the service then answers 404). */
  find(id: string): Promise<{ userId: string; status: string } | null>;
  moderate(moderatorId: string, id: string, body: { decision: ReferralDecision; reason?: string }): Promise<{ id: string; status: string }>;
}

export async function moderateReferral(
  deps: { referrals: ReferralModeration; audit: AuditStore },
  id: string,
  body: { decision: ReferralDecision; reason?: string },
  adminId: string,
): Promise<{ id: string; status: string }> {
  const before = await deps.referrals.find(id);
  const result = await deps.referrals.moderate(adminId, id, body);
  await writeAdminAudit(deps.audit, {
    adminId,
    subjectUserId: before?.userId ?? null,
    eventType: ADMIN_AUDIT_EVENTS.referralModerated,
    payload: { referralCodeId: id, decision: body.decision, reason: body.reason ?? null, before: { status: before?.status ?? null }, after: { status: result.status } },
  });
  return result;
}

/** Default wiring over the cn/referrals public surface (loaded on first use). */
export async function defaultReferralModeration(): Promise<ReferralModeration> {
  const m = await import('../cn/referrals/index.js');
  const service = m.getCnReferralService();
  const store = m.createPrismaReferralStore();
  return {
    async find(id) {
      // Table not in the client yet (SR-54-1): the service answers storage_unavailable.
      if (!store.available()) return null;
      const row = await store.find(id);
      return row ? { userId: row.userId, status: row.status } : null;
    },
    moderate: (moderatorId, id, body) => service.moderate(moderatorId, id, body as Parameters<typeof service.moderate>[2]),
  };
}
