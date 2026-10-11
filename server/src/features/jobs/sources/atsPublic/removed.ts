// server/src/features/jobs/sources/atsPublic/removed.ts — the boards an admin
// removed (MARKET_STRATEGY 1.2 "Company list for tier 0"; JI-3).
//
// Removing a board deletes its row, so nothing on the row can say "do not
// bring this back". The memory of a removal is this list, kept in AppConfig
// (`jobs.careerSources.removed.v1`): `<ats>:<board id in lower case>` of every
// board an admin removed. Discovery reads it before it records a candidate
// (./discovery.ts) and the seed loader before it adds a board (./seeds.ts), so
// a board removed on request (a wrong company, a takedown) is not found again
// by the next posting that links to it. An admin who adds the board again, by
// hand or in an import, takes it off the list: that is a decision too.
//
// The list holds board ids only: no company name, no reason, no admin. It is
// capped (the oldest removals are forgotten first), and it is written by one
// read-modify-write: two admins removing boards in the same instant could
// lose one entry, which costs one board being proposed again as a candidate
// (off until an admin or its check switches it on), never a wrong posting.

import type prisma from '../../../../lib/prisma.js';

export const REMOVED_BOARDS_CONFIG_KEY = 'jobs.careerSources.removed.v1';
/** Removals remembered; beyond this the oldest are forgotten. */
export const REMOVED_BOARDS_MAX = 5000;

export type RemovedBoardsDb = Pick<typeof prisma, 'appConfig'>;

/** `<ats>:<board id in lower case>`: one board under any spelling ("BoschGroup" / "boschgroup"). */
export function removedBoardKey(board: { ats: string; boardToken: string }): string {
  return `${board.ats.trim().toLowerCase()}:${board.boardToken.trim().toLowerCase()}`;
}

function parse(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const raw = JSON.parse(value) as { boards?: unknown } | null;
    return Array.isArray(raw?.boards) ? raw.boards.filter((b): b is string => typeof b === 'string' && b.length > 0) : [];
  } catch {
    return [];
  }
}

/** The removed boards, oldest first. An unreadable document is an empty list. */
export async function readRemovedBoards(db: RemovedBoardsDb): Promise<string[]> {
  const row = await db.appConfig.findUnique({ where: { key: REMOVED_BOARDS_CONFIG_KEY }, select: { value: true } });
  return parse(row?.value);
}

async function write(db: RemovedBoardsDb, boards: string[], by: string | null): Promise<void> {
  const value = JSON.stringify({ boards });
  const updatedBy = by ?? 'admin';
  await db.appConfig.upsert({ where: { key: REMOVED_BOARDS_CONFIG_KEY }, create: { key: REMOVED_BOARDS_CONFIG_KEY, value, updatedBy }, update: { value, updatedBy } });
}

/** Remembers that an admin removed this board. */
export async function rememberRemovedBoard(db: RemovedBoardsDb, board: { ats: string; boardToken: string }, by: string | null = null): Promise<void> {
  const key = removedBoardKey(board);
  const boards = (await readRemovedBoards(db)).filter((b) => b !== key);
  boards.push(key);
  await write(db, boards.slice(-REMOVED_BOARDS_MAX), by);
}

/** Forgets the removal of boards an admin added again. Writes nothing when none of them was removed. */
export async function forgetRemovedBoards(db: RemovedBoardsDb, added: ReadonlyArray<{ ats: string; boardToken: string }>, by: string | null = null): Promise<number> {
  if (added.length === 0) return 0;
  const boards = await readRemovedBoards(db);
  if (boards.length === 0) return 0;
  const back = new Set(added.map(removedBoardKey));
  const kept = boards.filter((b) => !back.has(b));
  if (kept.length === boards.length) return 0;
  await write(db, kept, by);
  return boards.length - kept.length;
}
