// server/src/features/jobs/sources/atsPublic/discovery.ts — finding boards from
// the links of postings we already hold (MARKET_STRATEGY 1.2 "Company list for
// tier 0" (1) and (4); JI-3).
//
// Collect. Every ingested or imported posting whose link points at a public
// job board names that board: the normalizer writes the posting's key
// `<ats>:<tenant>:<postingId>` (`atsPostingKey`), and `noteDiscoveredBoard`
// records `(ats, tenant)` as a CANDIDATE source: `enabled false`, `origin
// 'discovered'`, `discoveredFrom '<sourceBoard>:<externalId>'` of the posting
// that named it. For a job a user imported, `discoveredFrom` is exactly
// 'user_import': no user id, no link, no text. The user's job stays private;
// only the public board id is kept, and nothing personal is stored on a
// candidate.
//
// It never gets in the way: a posting without a key, a key we cannot read, a
// board we already know and the kill switch are all a quiet no-op; a database
// error is swallowed and counted, and pauses collecting for a minute so a
// database that is down costs one failed attempt, not one per posting. A
// per-process memory of 5,000 boards means a board seen a thousand times is
// offered to the database once.
//
// A board an admin removed is not proposed again (./removed.ts): the removal
// is remembered, and only an admin adding the board again undoes it.
//
// Validate. A candidate is switched on only after ONE list-only read of the
// board that lists at least one posting AND matches the company
// (`judgeCandidate`; the read itself is ingest/boards.ts `validateCandidates`):
//   - where the board states its company (Greenhouse, SmartRecruiters) the
//     two names must be the same employer (`companyNamesMatch`): equal once
//     normalised, or the words of the shorter one are a run of whole words in
//     the longer one ("Bosch" in "Bosch Group"; never "Arc" in "Search
//     Party"). The board's own name then becomes the name of a discovered
//     source, so its postings carry the employer's name, not an aggregator's;
//   - where it states none (Lever, Ashby) the board id must be the candidate's
//     company name written as one word, or the first label of its employer
//     domain. A candidate registered WITHOUT a company name carries its board
//     id as a placeholder; comparing that with the board id proves nothing,
//     so only the domain can confirm it.
// A candidate that does not pass stays off with `lastError
// 'validation:<reason>'` and is not tried again; an admin can still switch it
// on by hand.

import type { EnvSource } from '../../../../platform/brand/index.js';
import { parseBoolEnv } from '../../../../platform/brand/index.js';
import type { MarketHookContext, MarketHookJob } from '../../marketHooks.js';
import { atsPostingKeyOf, atsPostingRefFromUrl, normalizeCompanyName } from '../../normalize/index.js';
import { hasPlaceholderName } from './connectors.js';
import { PUBLIC_ATS } from './contract.js';
import { readRemovedBoards, removedBoardKey, type RemovedBoardsDb } from './removed.js';
import { isBoardToken } from './shared.js';
import type { CareerSourceDb } from './sync.js';

/**
 * Job-board systems a candidate is recorded for: the ones we read today, plus
 * the ones whose connector is planned (their candidates wait, untouched, until
 * it exists).
 */
export const DISCOVERY_ATS = [...PUBLIC_ATS, 'workable', 'lever_eu'] as const;

/** Boards remembered per process. */
export const DISCOVERY_MEMORY = 5000;
/** After a database error nothing is offered for this long. */
export const DISCOVERY_PAUSE_MS = 60_000;

const KILL_SWITCH = 'ATS_PUBLIC_SOURCES_DISABLED';

export interface PostingKey {
  ats: string;
  tenant: string;
  postingId: string;
}

/** `<ats>:<tenant>:<postingId>` -> its parts, or null for anything else. */
export function parsePostingKey(key: unknown): PostingKey | null {
  if (typeof key !== 'string') return null;
  const first = key.indexOf(':');
  const second = first < 0 ? -1 : key.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === key.length - 1) return null;
  const ats = key.slice(0, first).trim().toLowerCase();
  const tenant = key.slice(first + 1, second).trim();
  const postingId = key.slice(second + 1).trim();
  if (!ats || !postingId || !isBoardToken(tenant)) return null;
  return { ats, tenant, postingId };
}

export type DiscoveryOutcome = 'offered' | 'known' | 'ignored' | 'paused' | 'failed';

export interface DiscoveryStats {
  offered: number;
  known: number;
  ignored: number;
  paused: number;
  failed: number;
}

/** The delegates discovery uses: the source list, and the list of boards an admin removed. */
export type DiscoveryDb = Pick<CareerSourceDb, 'rACareerSiteSource'> & RemovedBoardsDb;

export interface DiscoveryDeps {
  db?: () => Promise<DiscoveryDb> | DiscoveryDb;
  env?: EnvSource;
  now?: () => number;
}

async function defaultDb(): Promise<DiscoveryDb> {
  return (await import('../../../../lib/prisma.js')).default;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The tenant of the job's posting key in the spelling of the link it was read
 * from (`applyUrl`, else `sourceUrl`); null when neither link gives that key.
 */
function tenantAsWritten(job: MarketHookJob, postingKey: string): string | null {
  for (const url of [text(job.applyUrl), text(job.sourceUrl)]) {
    const ref = atsPostingRefFromUrl(url);
    if (ref && atsPostingKeyOf(ref) === postingKey && isBoardToken(ref.tenant)) return ref.tenant;
  }
  return null;
}

export function createBoardDiscovery(deps: DiscoveryDeps = {}) {
  /** Insertion-ordered: the oldest board is forgotten first. */
  const seen = new Map<string, true>();
  const stats: DiscoveryStats = { offered: 0, known: 0, ignored: 0, paused: 0, failed: 0 };
  let pausedUntil = 0;
  const clock = () => (deps.now ? deps.now() : Date.now());
  const count = (outcome: DiscoveryOutcome): DiscoveryOutcome => {
    stats[outcome] += 1;
    return outcome;
  };

  function remember(key: string): void {
    seen.delete(key);
    seen.set(key, true);
    if (seen.size > DISCOVERY_MEMORY) seen.delete(seen.keys().next().value as string);
  }

  return {
    /** Records the board a posting's link names as a candidate source. Never throws. */
    async note(job: MarketHookJob, ctx?: Pick<MarketHookContext, 'stage'>): Promise<DiscoveryOutcome> {
      let memo: string | null = null;
      try {
        // Our own board rows are sources already.
        if (job.provider === 'ats_public') return count('ignored');
        const key = parsePostingKey(job.atsPostingKey);
        if (!key || !(DISCOVERY_ATS as readonly string[]).includes(key.ats)) return count('ignored');
        if (parseBoolEnv((deps.env ?? process.env)[KILL_SWITCH])) return count('ignored');
        const boardKey = removedBoardKey({ ats: key.ats, boardToken: key.tenant });
        if (seen.has(boardKey)) return count('known');
        if (clock() < pausedUntil) return count('paused');
        remember(boardKey);
        memo = boardKey;
        // The token the board's API is asked with is the tenant as the posting's own link writes it:
        // the key is lower case (an identity for comparison), and a Lever site name is case-sensitive
        // (`…/postings/SomeCo` answers, `…/postings/someco` is a 404, which is a final verdict for a
        // candidate). The key stays what boards are compared and remembered by.
        const boardToken = tenantAsWritten(job, String(job.atsPostingKey).toLowerCase()) ?? key.tenant;
        const imported = ctx?.stage === 'import' || job.provider === 'user_import';
        const board = text(job.sourceBoard);
        const externalId = text(job.externalId);
        // A user's import records nothing about the user or the job: only that an import named the board.
        const discoveredFrom = imported ? 'user_import' : board && externalId ? `${board}:${externalId}`.slice(0, 300) : null;
        const db = await (deps.db ?? defaultDb)();
        // The same board under another spelling ("BoschGroup" / "boschgroup") is one board.
        const existing = await db.rACareerSiteSource.findFirst({ where: { ats: key.ats, boardToken: { equals: key.tenant, mode: 'insensitive' } }, select: { id: true } });
        if (existing) return count('known');
        // An admin removed this board: it is not proposed again (remembered above, so this is asked once per process).
        if ((await readRemovedBoards(db)).includes(boardKey)) return count('known');
        await db.rACareerSiteSource.createMany({
          data: [
            {
              market: job.market === 'cn' ? 'cn' : 'intl',
              ats: key.ats,
              boardToken,
              companyName: (text(job.companyName) ?? boardToken).slice(0, 200),
              origin: 'discovered',
              discoveredFrom,
              enabled: false,
              countries: [],
            },
          ],
          skipDuplicates: true,
        });
        return count('offered');
      } catch {
        // A card and an ingest run never fail because of discovery. The board is offered again after the pause.
        if (memo) seen.delete(memo);
        pausedUntil = clock() + DISCOVERY_PAUSE_MS;
        return count('failed');
      }
    },
    stats: (): DiscoveryStats => ({ ...stats }),
    /** Test seam: forget everything. */
    reset(): void {
      seen.clear();
      pausedUntil = 0;
      for (const k of Object.keys(stats) as Array<keyof DiscoveryStats>) stats[k] = 0;
    },
  };
}

export type BoardDiscovery = ReturnType<typeof createBoardDiscovery>;

/** The process-wide collector the market hook uses. */
export const boardDiscovery: BoardDiscovery = createBoardDiscovery();

export function noteDiscoveredBoard(job: MarketHookJob, ctx?: Pick<MarketHookContext, 'stage'>): Promise<DiscoveryOutcome> {
  return boardDiscovery.note(job, ctx);
}

// -- Validation ---------------------------------------------------------------

export type CandidateVerdict = 'ok' | 'empty_board' | 'name_mismatch' | 'name_unconfirmed';

/** Letters and digits only, lower case ("Astera Labs" -> "asteralabs"). */
export function oneWord(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A name of one word must have at least this many characters to be found inside a longer name. */
const MIN_CONTAINED = 3;

/** Scripts written without spaces between words (Han, kana, hangul): a "word" there is not what a space separates. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Are the words of `short` a run of whole, consecutive words of `long`? */
function wordsWithin(short: readonly string[], long: readonly string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  for (let start = 0; start + short.length <= long.length; start += 1) {
    if (short.every((word, i) => long[start + i] === word)) return true;
  }
  return false;
}

/**
 * Two company names are the same employer: equal once normalised (also when
 * one is written without its spaces: "BoschGroup" / "Bosch Group"), or the
 * words of the shorter one are a run of whole words in the longer one
 * ("Bosch" in "Bosch Group", "Acme Robotics" in "Acme Robotics Taiwan"). A
 * name is never found inside another WORD: "Arc" is not in "Search Party",
 * "Box" not in "Dropbox", "Meta" not in "Metabase". Names in a script without
 * spaces are compared as text instead (the shorter, at least three
 * characters, inside the longer).
 */
export function companyNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return false;
  if (x === y || oneWord(x) === oneWord(y)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (UNSPACED.test(short)) return oneWord(short).length >= MIN_CONTAINED && oneWord(long).includes(oneWord(short));
  const words = short.split(' ');
  if (words.length === 1 && short.length < MIN_CONTAINED) return false;
  return wordsWithin(words, long.split(' '));
}

/** The first label of an employer domain ("careers.acme.com" is not one; pass the registrable domain). */
function firstLabel(domain: string | null | undefined): string {
  const host = (domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
  return oneWord(host.split('.')[0]);
}

/**
 * Does a list-only read confirm the candidate? `listed`: postings the board
 * lists; `boardCompanyName`: the name the board states, when it states one.
 */
export function judgeCandidate(
  candidate: { boardToken: string; companyName: string; domain?: string | null },
  read: { listed: number; boardCompanyName: string | null },
): CandidateVerdict {
  if (read.listed <= 0) return 'empty_board';
  const token = oneWord(candidate.boardToken);
  if (read.boardCompanyName) {
    // A candidate registered without a name carries its board id: the board's own name must then fit the id.
    return companyNamesMatch(read.boardCompanyName, candidate.companyName) ? 'ok' : 'name_mismatch';
  }
  if (!token) return 'name_unconfirmed';
  // The board states no company. A placeholder name IS the board id, so comparing the two confirms nothing.
  const named = !hasPlaceholderName(candidate);
  if (named && (token === oneWord(normalizeCompanyName(candidate.companyName)) || token === oneWord(candidate.companyName))) return 'ok';
  return candidate.domain && token === firstLabel(candidate.domain) ? 'ok' : 'name_unconfirmed';
}
