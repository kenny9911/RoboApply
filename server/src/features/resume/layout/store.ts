// server/src/features/resume/layout/store.ts
//
// The narrow, typed Prisma adapter for resume layouts (WP-65): read one
// variant's markdown + layout, save a layout. Every read is scoped to the
// user and skips soft-deleted rows. Tests use the in-memory twin.

import type { Prisma } from '../../../generated/prisma/client.js';

export interface LayoutVariantRow {
  id: string;
  resumeMarkdown: string;
  layout: unknown;
}

export interface LayoutStore {
  find(userId: string, id: string): Promise<LayoutVariantRow | null>;
  /** Replace the stored layout; false when the variant is not the user's. */
  save(userId: string, id: string, layout: Record<string, unknown>): Promise<boolean>;
}

export function createPrismaLayoutStore(): LayoutStore {
  const db = async () => (await import('../../../lib/prisma.js')).default;
  return {
    async find(userId, id) {
      const prisma = await db();
      return prisma.rAResumeVariant.findFirst({
        where: { id, userId, deletedAt: null },
        select: { id: true, resumeMarkdown: true, layout: true },
      });
    },
    async save(userId, id, layout) {
      const prisma = await db();
      const res = await prisma.rAResumeVariant.updateMany({
        where: { id, userId, deletedAt: null },
        data: { layout: layout as Prisma.InputJsonValue, lastEditedAt: new Date() },
      });
      return res.count > 0;
    },
  };
}

export interface MemoryLayoutStore extends LayoutStore {
  rows: Map<string, LayoutVariantRow & { userId: string }>;
}

export function createMemoryLayoutStore(): MemoryLayoutStore {
  const rows = new Map<string, LayoutVariantRow & { userId: string }>();
  return {
    rows,
    async find(userId, id) {
      const row = rows.get(id);
      return row && row.userId === userId ? { id: row.id, resumeMarkdown: row.resumeMarkdown, layout: row.layout } : null;
    },
    async save(userId, id, layout) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return false;
      row.layout = JSON.parse(JSON.stringify(layout));
      return true;
    },
  };
}
