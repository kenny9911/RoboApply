// server/src/roboapply/services/RoboApplyMissionService.ts
//
// Read-only remnant of the V1 mission service (WP-75 cleanup, ARCH §10.6).
// The V1 auto-apply engine (mission CRUD, intent parsing, pause/resume, the
// /missions router) is gone; `RoboApplyMission` rows stay in the schema (no
// destructive DDL). The only remaining reader is `GET /auth/me`
// (`server/src/roboapply/routes/auth.ts`), which still treats an old V1
// mission's resume / intent as "onboarding done" for accounts created before
// the new onboarding flow.
//
// @deprecated Delete this file once `routes/auth.ts` stops calling
// `getMissionForUser` (requested from WP-79 / INT in the WP-75 handoff).

import prisma from '../../lib/prisma.js';

/** The two V1 mission fields `/auth/me` still reads. */
export interface MissionSnapshot {
  id: string;
  userId: string;
  intentText: string;
  resumeId: string | null;
}

/** The user's V1 mission (legacy accounts only), or null. */
export async function getMissionForUser(userId: string): Promise<MissionSnapshot | null> {
  const row = await prisma.roboApplyMission.findUnique({
    where: { userId },
    select: { id: true, userId: true, intentText: true, resumeId: true },
  });
  if (!row) return null;
  return { id: row.id, userId: row.userId, intentText: row.intentText, resumeId: row.resumeId ?? null };
}
