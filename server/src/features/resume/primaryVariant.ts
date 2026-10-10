// server/src/features/resume/primaryVariant.ts
//
// `resume.primaryVariantId(userId)` — the resume other areas should use for a
// user when they are not told which one (the Assistant, wave4 REQ-50-03):
// the one marked primary; otherwise the most recently edited one; null when
// the user has no resume. Deleted resumes never count.

export interface PrimaryVariantLookup {
  /** The user's live primary resume, if one is marked. */
  findPrimary(userId: string): Promise<{ id: string } | null>;
  /** The user's most recently edited live resume. */
  findLatest(userId: string): Promise<{ id: string } | null>;
}

export function createPrismaPrimaryVariantLookup(): PrimaryVariantLookup {
  const db = async () => (await import('../../lib/prisma.js')).default;
  return {
    async findPrimary(userId) {
      const p = await db();
      return p.rAResumeVariant.findFirst({ where: { userId, deletedAt: null, isPrimary: true }, select: { id: true } });
    },
    async findLatest(userId) {
      const p = await db();
      return p.rAResumeVariant.findFirst({ where: { userId, deletedAt: null }, orderBy: { lastEditedAt: 'desc' }, select: { id: true } });
    },
  };
}

let lookup: PrimaryVariantLookup | null = null;

/** Test seam: replace the lookup (null restores the Prisma one). */
export function setPrimaryVariantLookup(next: PrimaryVariantLookup | null): void {
  lookup = next;
}

/** The user's primary resume id, else their most recently edited one, else null. */
export async function primaryVariantId(userId: string): Promise<string | null> {
  lookup ??= createPrismaPrimaryVariantLookup();
  const primary = await lookup.findPrimary(userId);
  if (primary) return primary.id;
  const latest = await lookup.findLatest(userId);
  return latest?.id ?? null;
}
