// @vitest-environment node
//
// The Prisma cover-letter store (INT-10; wave3 WP-93 #20): an application
// holds one letter. Attaching a letter points the application at it and
// detaches the letter that was attached before. Prisma is a small in-memory
// fake; no database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({ letters: [] as Row[], entries: [] as Row[] }));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && 'not' in cond) return v !== cond.not;
    if (cond === null) return v === null || v === undefined;
    return v === cond;
  });
}
function table(rows: () => Row[]) {
  return {
    findFirst: async ({ where }: Row) => rows().find((r) => matches(r, where)) ?? null,
    updateMany: async ({ where, data }: Row) => {
      const hit = rows().filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}
vi.mock('../../lib/prisma.js', () => {
  const client: Row = { rACoverLetter: table(() => db.letters), rATrackerEntry: table(() => db.entries) };
  client.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(client);
  return { default: client };
});

import { createPrismaCoverLetterStore } from './store.js';

const U = 'u1';
const letter = (id: string, trackerEntryId: string | null = null, extra: Row = {}): Row => ({ id, userId: U, trackerEntryId, deletedAt: null, ...extra });
const entry = (id: string, coverLetterId: string | null = null, extra: Row = {}): Row => ({ id, userId: U, coverLetterId, deletedAt: null, ...extra });
const letterOf = (id: string) => db.letters.find((l) => l.id === id)!;
const entryOf = (id: string) => db.entries.find((e) => e.id === id)!;

/** What CoverLetterService.patch does for an attach: set the letter's field, then sync the application. */
async function attach(letterId: string, entryId: string | null) {
  const store = createPrismaCoverLetterStore();
  const before = letterOf(letterId).trackerEntryId as string | null;
  await store.updateLetter(U, letterId, { trackerEntryId: entryId });
  await store.linkTrackerEntry(U, letterId, entryId, before);
}

beforeEach(() => {
  db.letters = [];
  db.entries = [];
});

describe('one letter per application', () => {
  it('attaching a second letter detaches the first and points the application at the new one', async () => {
    db.letters = [letter('A'), letter('B')];
    db.entries = [entry('te_1')];
    await attach('A', 'te_1');
    expect(entryOf('te_1').coverLetterId).toBe('A');
    expect(letterOf('A').trackerEntryId).toBe('te_1');

    await attach('B', 'te_1');
    expect(entryOf('te_1').coverLetterId).toBe('B');
    expect(letterOf('B').trackerEntryId).toBe('te_1');
    // The application holds one letter: A no longer points at it.
    expect(letterOf('A').trackerEntryId).toBeNull();
    expect(db.letters.filter((l) => l.trackerEntryId === 'te_1')).toHaveLength(1);
  });

  it('moving a letter to another application clears the first application', async () => {
    db.letters = [letter('A')];
    db.entries = [entry('te_1'), entry('te_2')];
    await attach('A', 'te_1');
    await attach('A', 'te_2');
    expect(entryOf('te_1').coverLetterId).toBeNull();
    expect(entryOf('te_2').coverLetterId).toBe('A');
  });

  it('detaching clears the application only while it still points at this letter', async () => {
    db.letters = [letter('A'), letter('B')];
    db.entries = [entry('te_1')];
    await attach('A', 'te_1');
    await attach('B', 'te_1');
    // A stale detach of A (an old tab) must not unlink B.
    await createPrismaCoverLetterStore().linkTrackerEntry(U, 'A', null, 'te_1');
    expect(entryOf('te_1').coverLetterId).toBe('B');
    await attach('B', null);
    expect(entryOf('te_1').coverLetterId).toBeNull();
  });

  it('never touches another user\'s application or letters', async () => {
    db.letters = [letter('A'), letter('X', 'te_theirs', { userId: 'someone_else' })];
    db.entries = [entry('te_theirs', 'X', { userId: 'someone_else' })];
    await createPrismaCoverLetterStore().linkTrackerEntry(U, 'A', 'te_theirs', null);
    expect(entryOf('te_theirs').coverLetterId).toBe('X');
    expect(letterOf('X').trackerEntryId).toBe('te_theirs');
  });

  it('deleting a letter clears the application link', async () => {
    db.letters = [letter('A')];
    db.entries = [entry('te_1')];
    await attach('A', 'te_1');
    expect(await createPrismaCoverLetterStore().softDelete(U, 'A', new Date('2026-10-10T00:00:00Z'))).toBe(true);
    expect(entryOf('te_1').coverLetterId).toBeNull();
  });
});
