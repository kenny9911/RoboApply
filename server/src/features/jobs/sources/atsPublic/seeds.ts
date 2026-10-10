// server/src/features/jobs/sources/atsPublic/seeds.ts — the verified first list of
// employer boards for a market (GOAPPLY_PARITY_PLAN.md §3.9; MARKET_STRATEGY JC-4).
//
// seeds.cn.json holds the public boards that listed postings located in
// mainland China when each was re-checked through its connector (the file
// records the date, the method and the count per board). Nothing in it is
// typed from memory: a board's name is the board's own metadata, or its token
// where the job-board system publishes no name.
//
// Which of them are registered. A board is read for ONE market in this wave
// (`RACareerSiteSource` is unique on (ats, boardToken) with one market column),
// so a board registered for market cn can no longer be added on the
// international site: its postings outside mainland China are not read at all.
// That is a fair trade for a board with many mainland postings and a poor one
// for a global board with one or two, so only boards that listed at least
// SEED_MIN_MAINLAND_POSTINGS mainland postings are registered. The others stay
// in the file as measured (nothing is thrown away) and are free for either
// site's admin to add by hand; they can all be registered once a board can
// feed several countries (MARKET_STRATEGY JC-4, `RACareerSiteSource.countries`).
//
// `ensureSeedCareerSources` registers those boards ONCE per seed version as
// career sources of the market (market cn, countryCode CN). It never touches
// a board an admin already has (whatever its market: a board is read for one
// market in this wave), never re-adds a board an admin removed (the
// registered tokens are remembered in AppConfig under
// `jobs.atsPublic.seed:<market>`), and writes no job: the regular ingest run
// reads the new sources. A later seed version adds only its new boards.

import type prisma from '../../../../lib/prisma.js';
import type { Market } from '../../../../platform/brand/index.js';
import { PUBLIC_ATS, type PublicAts } from './contract.js';
import { isPublicAts } from './shared.js';
import seedsCn from './seeds.cn.json' with { type: 'json' };

export interface SeedBoard {
  ats: PublicAts;
  boardToken: string;
  companyName: string;
  /** 'board_metadata' (the board's own name) or 'board_token' (the system publishes no name). */
  nameSource: 'board_metadata' | 'board_token';
  /** Mainland postings the connector listed on `verifiedAt` (a measurement, never shown as a live count). */
  mainlandPostings: number;
}

export interface SeedFile {
  market: Market;
  countryCode: string;
  version: string;
  verifiedAt: string;
  method: string;
  boards: SeedBoard[];
}

/** A measured board is registered for the market only from this many mainland postings up (see the header). */
export const SEED_MIN_MAINLAND_POSTINGS = 10;

/** The boards of a seed file that are registered: those at or above SEED_MIN_MAINLAND_POSTINGS. */
export function seedBoardsToRegister(file: SeedFile): SeedBoard[] {
  return file.boards.filter((b) => b.mainlandPostings >= SEED_MIN_MAINLAND_POSTINGS);
}

const BOARD_TOKEN_RE = /^[A-Za-z0-9_.-]{1,120}$/;

/** Validates a seed file's shape (unique boards, known job-board systems). Throws on a bad file. */
export function parseSeedFile(raw: unknown): SeedFile {
  const f = raw as Partial<SeedFile> | null;
  if (!f || (f.market !== 'cn' && f.market !== 'intl')) throw new Error('seed file: market must be cn or intl');
  if (typeof f.countryCode !== 'string' || !/^[A-Z]{2}$/.test(f.countryCode)) throw new Error('seed file: countryCode must be ISO alpha-2');
  if (typeof f.version !== 'string' || !f.version.trim()) throw new Error('seed file: version is required');
  if (!Array.isArray(f.boards)) throw new Error('seed file: boards must be a list');
  const seen = new Set<string>();
  const boards = f.boards.map((b, i) => {
    const board = b as Partial<SeedBoard>;
    if (!isPublicAts(board.ats)) throw new Error(`seed file: board ${i} has an unknown job-board system (allowed: ${PUBLIC_ATS.join(', ')})`);
    if (typeof board.boardToken !== 'string' || !BOARD_TOKEN_RE.test(board.boardToken)) throw new Error(`seed file: board ${i} has an invalid token`);
    if (typeof board.companyName !== 'string' || !board.companyName.trim()) throw new Error(`seed file: board ${i} has no company name`);
    if (board.nameSource !== 'board_metadata' && board.nameSource !== 'board_token') throw new Error(`seed file: board ${i} must say where its name comes from`);
    if (typeof board.mainlandPostings !== 'number' || !Number.isInteger(board.mainlandPostings) || board.mainlandPostings < 1) {
      throw new Error(`seed file: board ${i} must list at least one verified posting`);
    }
    const key = `${board.ats}:${board.boardToken.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`seed file: board ${board.ats}/${board.boardToken} is listed twice`);
    seen.add(key);
    return { ats: board.ats, boardToken: board.boardToken, companyName: board.companyName.trim(), nameSource: board.nameSource, mainlandPostings: board.mainlandPostings };
  });
  return { market: f.market, countryCode: f.countryCode, version: f.version.trim(), verifiedAt: String(f.verifiedAt ?? ''), method: String(f.method ?? ''), boards };
}

const SEED_FILES: Readonly<Partial<Record<Market, unknown>>> = { cn: seedsCn };

/** The market's seed file, or null when it ships none. */
export function seedFileFor(market: Market): SeedFile | null {
  const raw = SEED_FILES[market];
  return raw ? parseSeedFile(raw) : null;
}

export type SeedDb = Pick<typeof prisma, 'rACareerSiteSource' | 'appConfig'>;

export function seedStateKey(market: Market): string {
  return `jobs.atsPublic.seed:${market}`;
}

interface SeedState {
  version: string;
  /** `<ats>:<boardToken>` of every board this loader has ever offered (added or found present). */
  offered: string[];
}

function parseSeedState(value: string | null | undefined): SeedState | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Partial<SeedState> | null;
    if (!raw || typeof raw.version !== 'string' || !Array.isArray(raw.offered)) return null;
    return { version: raw.version, offered: raw.offered.filter((t): t is string => typeof t === 'string') };
  } catch {
    return null;
  }
}

export interface SeedResult {
  /** 'no_seed': the market ships no list; 'up_to_date': this version was registered before. */
  status: 'registered' | 'up_to_date' | 'no_seed';
  version: string | null;
  added: number;
  /** Boards an admin already has (in any market): left exactly as they are. */
  alreadyPresent: number;
}

/**
 * Registers the market's seed boards once per seed version (see the header).
 * Idempotent; safe to call from every `jobs-plan` run.
 */
export async function ensureSeedCareerSources(db: SeedDb, market: Market, file: SeedFile | null = seedFileFor(market)): Promise<SeedResult> {
  if (!file || file.market !== market) return { status: 'no_seed', version: null, added: 0, alreadyPresent: 0 };
  const key = seedStateKey(market);
  const state = parseSeedState((await db.appConfig.findUnique({ where: { key }, select: { value: true } }))?.value);
  if (state?.version === file.version) return { status: 'up_to_date', version: file.version, added: 0, alreadyPresent: 0 };

  const offered = new Set(state?.offered ?? []);
  // Only the boards at or above the threshold; a board below it is not remembered as offered either,
  // so a later version that registers it (after JC-4) still can.
  const fresh = seedBoardsToRegister(file).filter((b) => !offered.has(`${b.ats}:${b.boardToken}`));
  let added = 0;
  let alreadyPresent = 0;
  for (const board of fresh) {
    // (ats, boardToken) is unique across markets: a board an admin already reads stays as it is.
    const existing = await db.rACareerSiteSource.findFirst({ where: { ats: board.ats, boardToken: board.boardToken }, select: { id: true } });
    if (existing) {
      alreadyPresent += 1;
    } else {
      await db.rACareerSiteSource.create({
        data: { market, ats: board.ats, boardToken: board.boardToken, companyName: board.companyName, countryCode: file.countryCode, enabled: true, createdBy: `seed:${file.version}` },
      });
      added += 1;
    }
    offered.add(`${board.ats}:${board.boardToken}`);
  }
  const value = JSON.stringify({ version: file.version, offered: [...offered] } satisfies SeedState);
  await db.appConfig.upsert({ where: { key }, create: { key, value, updatedBy: 'jobs-plan' }, update: { value, updatedBy: 'jobs-plan' } });
  return { status: 'registered', version: file.version, added, alreadyPresent };
}
