// server/src/features/growth/checklistStore.ts — where getting-started
// checklist progress lives (F-GROW-05).
//
// Progress is functional account state, not analytics: it must survive the
// event retention prune, must not depend on the analytics consent, and must
// not be writable by the client (so `PATCH /ui-state` values are not used).
// It lives in its own table, requested from SCHEMA-2 as SR-23-1:
//
//   model RAGrowthChecklist {          // ra-growth.prisma
//     userId      String    @id
//     user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
//     tailorAt    DateTime?
//     practiceAt  DateTime?
//     saveJobAt   DateTime?
//     rewardedAt  DateTime?
//     dismissedAt DateTime?
//     createdAt   DateTime  @default(now())
//     updatedAt   DateTime  @updatedAt
//   }
//   // User: raGrowthChecklist RAGrowthChecklist?
//
// Until that model is generated the Prisma delegate does not exist, so this
// adapter reads it through a narrow typed view and reports `null` (store
// unavailable): the checklist route answers 404 feature_disabled and
// `markChecklistStep` is a logged no-op. After SCHEMA-2 the same code runs
// against the real table; nothing else changes.

import type { ChecklistStep } from './contract.js';

export interface ChecklistRow {
  userId: string;
  tailorAt: Date | null;
  practiceAt: Date | null;
  saveJobAt: Date | null;
  rewardedAt: Date | null;
  dismissedAt: Date | null;
}

type DateField = 'tailorAt' | 'practiceAt' | 'saveJobAt' | 'rewardedAt' | 'dismissedAt';

export const STEP_FIELD: Record<ChecklistStep, DateField> = {
  tailor: 'tailorAt',
  practice: 'practiceAt',
  save_job: 'saveJobAt',
};

export interface ChecklistStore {
  get(userId: string): Promise<ChecklistRow | null>;
  /** Stamp a date field once (the first time wins). */
  stamp(userId: string, field: DateField, at: Date): Promise<void>;
}

/** The subset of the (requested) Prisma delegate this adapter uses. */
export interface ChecklistDelegate {
  findUnique(args: { where: { userId: string }; select: Record<keyof ChecklistRow, true> }): Promise<ChecklistRow | null>;
  updateMany(args: { where: { userId: string } & Partial<Record<DateField, null>>; data: Partial<Record<DateField, Date>> }): Promise<{ count: number }>;
  create(args: { data: { userId: string } & Partial<Record<DateField, Date>> }): Promise<unknown>;
}

const SELECT = { userId: true, tailorAt: true, practiceAt: true, saveJobAt: true, rewardedAt: true, dismissedAt: true } as const;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** A store over a `rAGrowthChecklist`-shaped delegate (the real one after SR-23-1, or a test fake). */
export function createDelegateChecklistStore(delegate: ChecklistDelegate): ChecklistStore {
  return {
    async get(userId) {
      return delegate.findUnique({ where: { userId }, select: SELECT });
    },
    async stamp(userId, field, at) {
      // updateMany with `field: null` keeps the first stamp under concurrency.
      const { count } = await delegate.updateMany({ where: { userId, [field]: null }, data: { [field]: at } });
      if (count > 0) return;
      const existing = await delegate.findUnique({ where: { userId }, select: SELECT });
      if (existing) return; // already stamped
      try {
        await delegate.create({ data: { userId, [field]: at } });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Another request created the row first; stamp it if still empty.
        await delegate.updateMany({ where: { userId, [field]: null }, data: { [field]: at } });
      }
    },
  };
}

/**
 * The store backed by `prisma.rAGrowthChecklist`, or null while the model is
 * not in the generated client (SR-23-1 pending).
 */
export function resolvePrismaChecklistStore(db: unknown): ChecklistStore | null {
  let delegate: unknown;
  try {
    delegate = (db as { rAGrowthChecklist?: unknown } | null)?.rAGrowthChecklist;
  } catch {
    return null;
  }
  const d = delegate as Partial<ChecklistDelegate> | undefined;
  if (!d || typeof d.findUnique !== 'function' || typeof d.updateMany !== 'function' || typeof d.create !== 'function') return null;
  return createDelegateChecklistStore(d as ChecklistDelegate);
}
