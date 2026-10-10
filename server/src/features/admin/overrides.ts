// server/src/features/admin/overrides.ts — per-user overrides (credit caps,
// entitlements, beta flags) from the user page, with an audit row
// (ARCHITECTURE.md §10.5). The rules and storage are the credits area's
// (`creditsAreaService`, WP-21a: validation, entitlement cache invalidation);
// this module adds the SeekerActivityLog audit row on every change.

import { writeAdminAudit, type AuditStore } from './audit.js';
import { ADMIN_AUDIT_EVENTS, type AdminOverrideView, type AdminOverridesResponse } from './contract.js';

/** The credits area's override service (credits/index.ts `creditsAreaService`). */
export interface OverridesService {
  listOverrides(query: { userId?: string; cursor?: string }): Promise<{ items: AdminOverrideView[]; cursor: string | null }>;
  createOverride(
    body: { userId: string; key: string; value: number | boolean | 'off' | 'deeplinks_only' | 'on'; expiresAt?: string; reason: string },
    adminId: string | null,
  ): Promise<AdminOverrideView>;
  deleteOverride(id: string, adminId: string | null): Promise<void>;
}

export interface OverridesDeps {
  service: OverridesService;
  audit: AuditStore;
}

export async function listAdminOverrides(deps: OverridesDeps, query: { userId?: string; cursor?: string }): Promise<AdminOverridesResponse> {
  return deps.service.listOverrides({ userId: query.userId, cursor: query.cursor });
}

export async function createAdminOverride(
  deps: OverridesDeps,
  body: { userId: string; key: string; value: number | boolean | 'off' | 'deeplinks_only' | 'on'; expiresAt?: string; reason: string },
  adminId: string,
): Promise<AdminOverrideView> {
  const row = await deps.service.createOverride(body, adminId);
  await writeAdminAudit(deps.audit, {
    adminId,
    subjectUserId: row.userId,
    eventType: ADMIN_AUDIT_EVENTS.overrideCreated,
    payload: { overrideId: row.id, key: row.key, value: row.value, expiresAt: row.expiresAt, reason: row.reason },
  });
  return row;
}

export async function deleteAdminOverride(deps: OverridesDeps, id: string, adminId: string, userId?: string): Promise<void> {
  // Read the row first so the audit names the person and the key (the delete returns nothing);
  // the user page passes `userId`, which narrows the read to that person's overrides.
  let found: AdminOverrideView | undefined;
  let cursor: string | undefined;
  for (let i = 0; i < 20 && !found; i += 1) {
    const page = await deps.service.listOverrides({ userId, cursor });
    found = page.items.find((o) => o.id === id);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  await deps.service.deleteOverride(id, adminId);
  await writeAdminAudit(deps.audit, {
    adminId,
    subjectUserId: found?.userId ?? null,
    eventType: ADMIN_AUDIT_EVENTS.overrideDeleted,
    payload: { overrideId: id, key: found?.key ?? null, value: found?.value ?? null },
  });
}
