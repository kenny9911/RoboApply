// @vitest-environment node
// resume.primaryVariantId (wave4 REQ-50-03): primary first, else most recent, else null.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { primaryVariantId, setPrimaryVariantLookup } from './primaryVariant.js';

interface Row {
  id: string;
  userId: string;
  isPrimary: boolean;
  lastEditedAt: Date;
  deletedAt: Date | null;
}

/** A lookup over rows, with the same filters as the Prisma one. */
function lookupOver(rows: Row[]) {
  const live = (userId: string) => rows.filter((r) => r.userId === userId && r.deletedAt === null);
  return {
    findPrimary: vi.fn(async (userId: string) => live(userId).find((r) => r.isPrimary) ?? null),
    findLatest: vi.fn(async (userId: string) => live(userId).sort((a, b) => b.lastEditedAt.getTime() - a.lastEditedAt.getTime())[0] ?? null),
  };
}

const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, userId: 'u1', isPrimary: false, lastEditedAt: new Date('2026-10-01T00:00:00Z'), deletedAt: null, ...extra });

afterEach(() => setPrimaryVariantLookup(null));

describe('primaryVariantId', () => {
  it('returns the resume marked primary, even when another was edited later', async () => {
    const lookup = lookupOver([row('old', { isPrimary: true }), row('new', { lastEditedAt: new Date('2026-10-09T00:00:00Z') })]);
    setPrimaryVariantLookup(lookup);
    await expect(primaryVariantId('u1')).resolves.toBe('old');
    expect(lookup.findLatest).not.toHaveBeenCalled();
  });

  it('with no primary, returns the most recently edited resume', async () => {
    setPrimaryVariantLookup(lookupOver([row('a'), row('b', { lastEditedAt: new Date('2026-10-05T00:00:00Z') }), row('c', { lastEditedAt: new Date('2026-10-03T00:00:00Z') })]));
    await expect(primaryVariantId('u1')).resolves.toBe('b');
  });

  it('ignores deleted resumes and other users', async () => {
    setPrimaryVariantLookup(
      lookupOver([
        row('gone', { isPrimary: true, deletedAt: new Date() }),
        row('theirs', { userId: 'u2', isPrimary: true }),
        row('mine'),
      ]),
    );
    await expect(primaryVariantId('u1')).resolves.toBe('mine');
  });

  it('returns null when the user has no resume', async () => {
    setPrimaryVariantLookup(lookupOver([row('theirs', { userId: 'u2' })]));
    await expect(primaryVariantId('u1')).resolves.toBeNull();
  });
});
