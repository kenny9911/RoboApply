// backend/src/roboapply/v2/services/RACareerGoalService.ts
//
// Career Goal CRUD. One row per user (UNIQUE userId). Used by the Home page
// "Career Goal" card and the goal-edit drawer. PUT /goal upserts.
//
// The shape returned matches `RACareerGoal` from
// `roboapply/lib/api/v2/types.ts` — every field stringified to ISO where the
// type expects ISO. Date columns (targetDate) round-trip as YYYY-MM-DD.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';

export type RAWorkType = 'remote' | 'hybrid' | 'onsite';

export type RASeniority =
  | 'ic'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'manager'
  | 'director'
  | 'vp'
  | 'cxo';

export interface PreferredLocations {
  countries: string[];
  cities: string[];
  remoteOk: boolean;
  hybridOk: boolean;
}

export interface RACareerGoalView {
  id: string;
  userId: string;
  targetTitle: string;
  targetDate: string | null;
  targetSalaryMin: number | null;
  targetSalaryMax: number | null;
  targetSalaryCurrency: string;
  weeklyApplicationGoal: number;
  preferredLocations: PreferredLocations | null;
  preferredWorkType: RAWorkType | null;
  seniority: RASeniority | null;
  notesMarkdown: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalUpsertInput {
  targetTitle: string;
  targetDate?: string | null;
  targetSalaryMin?: number | null;
  targetSalaryMax?: number | null;
  targetSalaryCurrency?: string;
  weeklyApplicationGoal?: number;
  preferredLocations?: PreferredLocations | null;
  preferredWorkType?: RAWorkType | null;
  seniority?: RASeniority | null;
  notesMarkdown?: string | null;
}

function toView(row: any): RACareerGoalView {
  return {
    id: row.id,
    userId: row.userId,
    targetTitle: row.targetTitle,
    targetDate: row.targetDate
      ? (row.targetDate instanceof Date
          ? row.targetDate.toISOString().slice(0, 10)
          : String(row.targetDate).slice(0, 10))
      : null,
    targetSalaryMin: row.targetSalaryMin ?? null,
    targetSalaryMax: row.targetSalaryMax ?? null,
    targetSalaryCurrency: row.targetSalaryCurrency ?? 'USD',
    weeklyApplicationGoal: row.weeklyApplicationGoal ?? 5,
    preferredLocations: (row.preferredLocations as PreferredLocations | null) ?? null,
    preferredWorkType: (row.preferredWorkType as RAWorkType | null) ?? null,
    seniority: (row.seniority as RASeniority | null) ?? null,
    notesMarkdown: row.notesMarkdown ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

export class RACareerGoalService {
  /** GET /goal — returns null when the user has not set one yet. */
  async get(userId: string): Promise<RACareerGoalView | null> {
    const p = prisma as any;
    const row = await p.rACareerGoal.findUnique({ where: { userId } });
    return row ? toView(row) : null;
  }

  /** PUT /goal — upsert by userId. */
  async upsert(userId: string, patch: GoalUpsertInput): Promise<RACareerGoalView> {
    if (!patch.targetTitle || !patch.targetTitle.trim()) {
      throw new Error('targetTitle is required');
    }
    const p = prisma as any;

    // Read existing for fallback semantics — matches stub upsert behaviour
    // where unset fields keep their previous value.
    const existing = await p.rACareerGoal.findUnique({ where: { userId } });

    const data: any = {
      targetTitle: patch.targetTitle.trim(),
      targetDate: patch.targetDate === undefined
        ? existing?.targetDate ?? null
        : patch.targetDate
          ? new Date(patch.targetDate + 'T00:00:00.000Z')
          : null,
      targetSalaryMin: patch.targetSalaryMin === undefined
        ? existing?.targetSalaryMin ?? null
        : patch.targetSalaryMin,
      targetSalaryMax: patch.targetSalaryMax === undefined
        ? existing?.targetSalaryMax ?? null
        : patch.targetSalaryMax,
      targetSalaryCurrency: patch.targetSalaryCurrency
        ?? existing?.targetSalaryCurrency
        ?? 'USD',
      weeklyApplicationGoal: patch.weeklyApplicationGoal
        ?? existing?.weeklyApplicationGoal
        ?? 5,
      preferredLocations: patch.preferredLocations === undefined
        ? existing?.preferredLocations ?? null
        : patch.preferredLocations,
      preferredWorkType: patch.preferredWorkType === undefined
        ? existing?.preferredWorkType ?? null
        : patch.preferredWorkType,
      seniority: patch.seniority === undefined
        ? existing?.seniority ?? null
        : patch.seniority,
      notesMarkdown: patch.notesMarkdown === undefined
        ? existing?.notesMarkdown ?? null
        : patch.notesMarkdown,
    };

    const row = await p.rACareerGoal.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    logger.info('RA_V2_GOAL', 'goal upserted', { userId, goalId: row.id });
    return toView(row);
  }
}

export const raCareerGoalService = new RACareerGoalService();
