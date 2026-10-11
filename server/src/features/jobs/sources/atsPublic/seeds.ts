// server/src/features/jobs/sources/atsPublic/seeds.ts — the validated seed lists
// of employer boards (MARKET_STRATEGY 1.1, 1.2, 1.3, 1.4; JI-3, JT-5, JC-4; D3).
//
// Three data files, one per place a board lists postings in:
//   seeds.cn.json    boards with at least one posting located in mainland China;
//   seeds.tw.json    boards with at least one posting located in Taiwan;
//   seeds.intl.json  boards with at least one posting located anywhere else.
// Nothing in them is typed from memory. A board is in a file only because its
// live board answered scripts/board-seeds/validate.mjs with at least one
// posting and passed the name check; scripts/board-seeds/build-seeds.mjs
// writes the files from that report and from nothing else (MKT-4S; the method
// and the counts are in docs/jobright-clone/market/BOARD_SEEDS.md). The name
// is what the board's answer stated; where the system states none (Lever,
// Ashby) it is the employer the board id spells or a document of this
// repository confirms for that id, and a board whose employer nothing confirms
// carries its board id as its name (`hasPlaceholderName`), never a guess. Every
// entry says where it was confirmed (`note`), when it was first confirmed
// (`confirmedOn`) and what the board answered on the day it was last read:
// `verifiedOn`, `verifiedBy`, `postings` (its postings for THAT file's place,
// counted from location fields only) and `postingCountries`. seeds.test.ts
// refuses an entry without them. The boards the research notes confirmed first
// (the 14 Taiwan boards of JOB_SOURCES_TW.md 3.5, the 26 mainland boards of the
// parity wave, stripe and ramp) are still here, re-read, and their notes keep
// that first confirmation. More boards join through bulk import and discovery,
// each validated against its live board.
//
// One board is ONE source, whatever file names it: the files are merged by
// (ats, boardToken). `countries` is what the board is READ for; the lists are
// united, and an empty list (every country) wins. Greenhouse, Lever and Ashby
// list a whole board in one listing: always empty. A SmartRecruiters board is
// asked per country when codes are named: the mainland and the Taiwan file name
// CN / TW (BoschGroup is one row read for exactly CN and TW: MARKET_STRATEGY
// JT-5), and the international file reads a board whole, so a SmartRecruiters
// board it names is read once without a filter, as a Greenhouse board is. The
// measured facts are not routing: the loader writes none of them to the
// database and they are not part of the list's hash, so a refresh of the
// counts alone loads nothing.
//
// A deployment loads the files of the markets it serves (`seedFilesFor`): the
// mainland file for the mainland market, the international and the Taiwan file
// for the international market (Taiwan is part of it), all three where both
// brands are served. So the mainland stack, which serves GoApply alone from
// its own database (deploy/cn: ALLOWED_BRANDS=goapply), reads only the boards
// that listed a mainland posting, a SmartRecruiters board among them for CN
// alone, and never a board whose every posting it would read and then drop. A
// deployment that serves RoboApply alone does not ask a SmartRecruiters board
// for its mainland postings. The markets come from the deployment's brands
// (BRAND_LOCK, else ALLOWED_BRANDS, else both); the hash and the boards ever
// offered are those of the list the deployment loads.
//
// `loadCareerSeeds` runs at the start of a board sync. It does work only when
// the merged list changed since the last load (its hash is kept in AppConfig
// `jobs.careerSeeds.v1`), so a second run writes nothing. A seeded board is a
// source with origin 'seed', switched on. What an admin did later stands:
//   - a seeded board an admin switched off stays off, and its name is kept
//     (one exception, which is no admin's choice: a name that is just the
//     board id is the placeholder a board is registered under when nothing
//     states its name, and the list's name replaces it once the list has one);
//   - a seeded board an admin removed is not added again (the boards ever
//     offered are remembered with the hash), and neither is a board an admin
//     removed before a seed file named it (./removed.ts): adding it again by
//     hand or in an import is the way back;
//   - a board an admin added by hand is left exactly as it is.
// A board that discovery or an import had only proposed (a candidate, never
// switched on) is taken over: the seed is its confirmation.
//
// The first load after the market wave also carries one rule of the parity
// wave forward: a SmartRecruiters board an admin had added on the mainland
// console was listed with the API's `country=cn` filter (one market per board
// then). It has no `countries` yet, which would now mean "list the whole board",
// so it gets ['CN'], exactly what it was read for. Done once.
//
// Rows written by the parity wave's loader (createdBy 'seed:<version>', one
// market per board, country tag CN) are brought to this model once: they get
// origin 'seed' and the merged `countries`, and lose the country tag, which was
// that loader's market marker and would now be a wrong hint for a global board.

import { createHash } from 'node:crypto';
import type prisma from '../../../../lib/prisma.js';
import { allowedBrands, getBrand, type EnvSource, type Market } from '../../../../platform/brand/index.js';
import { PUBLIC_ATS, type PublicAts } from './contract.js';
import { hasPlaceholderName } from './connectors.js';
import { readRemovedBoards, removedBoardKey } from './removed.js';
import { isBoardToken, isPublicAts, mergeCountries, normalizeCountries } from './shared.js';
import seedsCn from './seeds.cn.json' with { type: 'json' };
import seedsIntl from './seeds.intl.json' with { type: 'json' };
import seedsTw from './seeds.tw.json' with { type: 'json' };

export interface SeedBoard {
  ats: PublicAts;
  boardToken: string;
  companyName: string;
  /** ISO codes the board is read for; empty = every country. */
  countries: string[];
  /** Where the board was confirmed: the research note and section, or the handoff. */
  note: string;
  /** The day it was first confirmed (YYYY-MM-DD). */
  confirmedOn: string;
  /**
   * What the live board answered when it was last read (MKT-4S). In a file: the
   * board's postings located in that file's place on `verifiedOn`. Merged: the
   * sum over the files that name the board. Counts of that day, never live.
   */
  postings?: number;
  /** ISO codes the counted postings were located in (from location fields only). */
  postingCountries?: string[];
  /** The day the live board last answered (YYYY-MM-DD). */
  verifiedOn?: string;
  /** How it was verified: 'live board API'. */
  verifiedBy?: string;
}

/** The facts a validation adds to an entry. They come together or not at all. */
export const SEED_FACT_FIELDS = ['postings', 'postingCountries', 'verifiedOn', 'verifiedBy'] as const;

export interface SeedFile {
  about: string;
  boards: SeedBoard[];
}

export const SEED_FILE_NAMES = ['cn', 'intl', 'tw'] as const;
export type SeedFileName = (typeof SEED_FILE_NAMES)[number];

/** The market whose site a file's postings are listed on. Taiwan is part of the international market. */
export const SEED_FILE_MARKET: Readonly<Record<SeedFileName, Market>> = { cn: 'cn', intl: 'intl', tw: 'intl' };

const EVERY_MARKET: readonly Market[] = ['intl', 'cn'];

/** The seed files a deployment loads: those of the markets it serves (see the header). */
export function seedFilesFor(markets: readonly Market[]): SeedFileName[] {
  return SEED_FILE_NAMES.filter((name) => markets.includes(SEED_FILE_MARKET[name]));
}

/** The markets this deployment serves: those of its brands (BRAND_LOCK, else ALLOWED_BRANDS, else both). */
export function servedSeedMarkets(env: EnvSource = process.env): Market[] {
  return [...new Set(allowedBrands(env).map((id) => getBrand(id).market))];
}

/** A board of the merged list, with the files that name it. */
export interface MergedSeedBoard extends SeedBoard {
  files: SeedFileName[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates one seed file. Throws on a bad file, naming the entry. */
export function parseSeedFile(raw: unknown, name = 'seed file'): SeedFile {
  const f = raw as { about?: unknown; boards?: unknown } | null;
  if (!f || typeof f !== 'object') throw new Error(`${name}: not an object`);
  if (typeof f.about !== 'string' || !f.about.trim()) throw new Error(`${name}: "about" must say where the list comes from`);
  if (!Array.isArray(f.boards)) throw new Error(`${name}: boards must be a list`);
  const seen = new Set<string>();
  const boards = f.boards.map((b, i): SeedBoard => {
    const board = (b ?? {}) as Partial<Record<keyof SeedBoard, unknown>>;
    const at = `${name}: board ${i}`;
    if (!isPublicAts(board.ats)) throw new Error(`${at} has an unknown job-board system (allowed: ${PUBLIC_ATS.join(', ')})`);
    if (!isBoardToken(board.boardToken)) throw new Error(`${at} has an invalid board id`);
    if (typeof board.companyName !== 'string' || !board.companyName.trim() || board.companyName.trim().length > 200) throw new Error(`${at} has no company name`);
    if (!Array.isArray(board.countries) || board.countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) {
      throw new Error(`${at} must list its countries as ISO alpha-2 codes (an empty list means every country)`);
    }
    if (new Set(board.countries).size !== board.countries.length) throw new Error(`${at} lists a country twice`);
    if (typeof board.note !== 'string' || board.note.trim().length < 10) throw new Error(`${at} must say where it was confirmed (note)`);
    if (typeof board.confirmedOn !== 'string' || !DATE_RE.test(board.confirmedOn) || Number.isNaN(Date.parse(board.confirmedOn))) {
      throw new Error(`${at} must say when it was confirmed (confirmedOn, YYYY-MM-DD)`);
    }
    const key = `${board.ats}:${board.boardToken.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`${name}: board ${board.ats}/${board.boardToken} is listed twice`);
    seen.add(key);
    return {
      ats: board.ats,
      boardToken: board.boardToken,
      companyName: board.companyName.trim(),
      countries: normalizeCountries(board.countries as string[]),
      note: board.note.trim(),
      confirmedOn: board.confirmedOn,
      ...seedFacts(board, at),
    };
  });
  return { about: f.about.trim(), boards };
}

/** The measured facts of an entry, validated. An entry carries all four or none. */
function seedFacts(board: Partial<Record<keyof SeedBoard, unknown>>, at: string): Pick<SeedBoard, (typeof SEED_FACT_FIELDS)[number]> | Record<string, never> {
  const given = SEED_FACT_FIELDS.filter((f) => board[f] !== undefined);
  if (given.length === 0) return {};
  if (given.length !== SEED_FACT_FIELDS.length) throw new Error(`${at} carries some measured facts and not others (${SEED_FACT_FIELDS.join(', ')} come together)`);
  if (typeof board.postings !== 'number' || !Number.isInteger(board.postings) || board.postings < 1) throw new Error(`${at} must state a measured posting count (postings, a whole number of at least 1)`);
  const codes = board.postingCountries;
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) || new Set(codes).size !== codes.length) {
    throw new Error(`${at} must list postingCountries as ISO alpha-2 codes, each once`);
  }
  if (typeof board.verifiedOn !== 'string' || !DATE_RE.test(board.verifiedOn) || Number.isNaN(Date.parse(board.verifiedOn))) throw new Error(`${at} must say when the live board answered (verifiedOn, YYYY-MM-DD)`);
  if (typeof board.verifiedBy !== 'string' || !board.verifiedBy.trim()) throw new Error(`${at} must say how it was verified (verifiedBy)`);
  return { postings: board.postings, postingCountries: [...(codes as string[])].sort(), verifiedOn: board.verifiedOn, verifiedBy: board.verifiedBy.trim() };
}

const RAW_FILES: Readonly<Record<SeedFileName, unknown>> = { cn: seedsCn, intl: seedsIntl, tw: seedsTw };

/** One validated seed file. */
export function seedFile(name: SeedFileName): SeedFile {
  return parseSeedFile(RAW_FILES[name], `seeds.${name}.json`);
}

export function seedKey(board: { ats: string; boardToken: string }): string {
  return `${board.ats}:${board.boardToken}`;
}

/**
 * The files as one list: one entry per (ats, boardToken). Countries are
 * united and an empty list wins; the name is the first one that is not just
 * the board id; the note joins the files' notes. The measured facts are put
 * together: postings add up (each file counts its own place), the countries
 * with a posting are united, and the latest day the board answered stands.
 */
export function mergeSeedFiles(files: Partial<Record<SeedFileName, SeedFile>>): MergedSeedBoard[] {
  const merged = new Map<string, MergedSeedBoard>();
  for (const name of SEED_FILE_NAMES) {
    for (const board of files[name]?.boards ?? []) {
      const key = seedKey(board);
      const prior = merged.get(key);
      if (!prior) {
        merged.set(key, { ...board, countries: [...board.countries], ...(board.postingCountries ? { postingCountries: [...board.postingCountries] } : {}), files: [name] });
        continue;
      }
      prior.countries = mergeCountries(prior.countries, board.countries);
      if (hasPlaceholderName(prior) && !hasPlaceholderName(board)) prior.companyName = board.companyName;
      prior.note = `${prior.note}; ${board.note}`;
      if (board.confirmedOn > prior.confirmedOn) prior.confirmedOn = board.confirmedOn;
      if (board.postings !== undefined) {
        prior.postings = (prior.postings ?? 0) + board.postings;
        prior.postingCountries = [...new Set([...(prior.postingCountries ?? []), ...(board.postingCountries ?? [])])].sort();
        if (!prior.verifiedOn || (board.verifiedOn ?? '') > prior.verifiedOn) prior.verifiedOn = board.verifiedOn;
        prior.verifiedBy ??= board.verifiedBy;
      }
      prior.files.push(name);
    }
  }
  return [...merged.values()];
}

/**
 * The seeded boards of a deployment that serves `markets`: the files of those
 * markets, merged (default: both markets, so all three files). Throws when a
 * file is malformed.
 */
export function careerSeedBoards(markets: readonly Market[] = EVERY_MARKET): MergedSeedBoard[] {
  const files: Partial<Record<SeedFileName, SeedFile>> = {};
  for (const name of seedFilesFor(markets)) files[name] = seedFile(name);
  return mergeSeedFiles(files);
}

/** Changes when a board is added or removed, or its name or countries change. */
export function seedHash(boards: readonly Pick<SeedBoard, 'ats' | 'boardToken' | 'companyName' | 'countries'>[]): string {
  const canonical = boards
    .map((b) => [b.ats, b.boardToken, b.companyName, normalizeCountries(b.countries).join(',')].join('\u0000'))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export type SeedDb = Pick<typeof prisma, 'rACareerSiteSource' | 'appConfig'>;

/** AppConfig key of the loader's state: the hash of the list last loaded and the boards ever offered. */
export const CAREER_SEEDS_CONFIG_KEY = 'jobs.careerSeeds.v1';
/** The parity wave's key for market cn (read once, so a board removed back then is not added again). */
export const LEGACY_SEED_STATE_KEY = 'jobs.atsPublic.seed:cn';

interface SeedState {
  hash: string;
  /** `<ats>:<boardToken>` of every board this loader has offered (added or found present). */
  offered: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []);

function parseSeedState(value: string | null | undefined): SeedState | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as { hash?: unknown; offered?: unknown } | null;
    if (!raw || typeof raw.hash !== 'string') return null;
    return { hash: raw.hash, offered: strings(raw.offered) };
  } catch {
    return null;
  }
}

function legacyOffered(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return strings((JSON.parse(value) as { offered?: unknown } | null)?.offered);
  } catch {
    return [];
  }
}

export interface SeedLoadResult {
  /** 'loaded': the list changed and was applied; 'up_to_date': nothing to do, nothing written. */
  status: 'loaded' | 'up_to_date';
  hash: string;
  /** Boards in the merged list. */
  boards: number;
  /** New sources created. */
  added: number;
  /** Sources the seed owns that were brought to the list (countries, origin, a name in place of a board id). */
  updated: number;
  /** Boards an admin already has: left exactly as they are. */
  alreadyPresent: number;
  /** Boards an admin removed earlier: not added again. */
  removedByAdmin: number;
  /** Mainland SmartRecruiters boards given the country they were read for before the market wave (first load only). */
  carriedOver: number;
}

type ExistingSource = {
  id: string;
  ats: string;
  boardToken: string;
  companyName: string | null;
  enabled: boolean;
  origin: string | null;
  countries: string[] | null;
  countryCode: string | null;
  createdBy: string | null;
  disabledAt: Date | null;
};

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The console a seeded board is shown under (display only): GoApply's when only the mainland file names it. */
function displayMarket(board: MergedSeedBoard): Market {
  return board.files.length === 1 && board.files[0] === 'cn' ? 'cn' : 'intl';
}

export interface SeedLoadOptions {
  /** The list to load (tests). Default: the files of `markets`, merged. */
  boards?: readonly MergedSeedBoard[];
  /** The markets this deployment serves. Default: those of its brands (`servedSeedMarkets(env)`). */
  markets?: readonly Market[];
  /** Where the deployment's brands are read from (default: process.env). */
  env?: EnvSource;
}

/**
 * Brings the sources in line with the seed files of the markets this
 * deployment serves (see the header). Idempotent; safe to call at the start of
 * every board sync.
 */
export async function loadCareerSeeds(db: SeedDb, options: SeedLoadOptions = {}): Promise<SeedLoadResult> {
  const boards = options.boards ?? careerSeedBoards(options.markets ?? servedSeedMarkets(options.env));
  const hash = seedHash(boards);
  const stored = await db.appConfig.findUnique({ where: { key: CAREER_SEEDS_CONFIG_KEY }, select: { value: true } });
  const state = parseSeedState(stored?.value);
  const base = { hash, boards: boards.length, added: 0, updated: 0, alreadyPresent: 0, removedByAdmin: 0, carriedOver: 0 };
  if (state?.hash === hash) return { status: 'up_to_date', ...base };

  const offered = new Set(state?.offered ?? []);
  if (!state) {
    const legacy = await db.appConfig.findUnique({ where: { key: LEGACY_SEED_STATE_KEY }, select: { value: true } });
    for (const key of legacyOffered(legacy?.value)) offered.add(key);
  }
  const existing = new Map<string, ExistingSource>();
  if (boards.length > 0) {
    const rows = await db.rACareerSiteSource.findMany({
      where: { ats: { in: [...new Set(boards.map((b) => b.ats))] }, boardToken: { in: boards.map((b) => b.boardToken) } },
      select: { id: true, ats: true, boardToken: true, companyName: true, enabled: true, origin: true, countries: true, countryCode: true, createdBy: true, disabledAt: true },
    });
    for (const row of rows) existing.set(seedKey(row as ExistingSource), row as ExistingSource);
  }

  // Boards an admin removed, whatever added them (./removed.ts): a seed list never brings one back.
  const removed = new Set(await readRemovedBoards(db));
  const result = { ...base };
  if (!state) {
    // First load of this model (see the header): keep reading these boards for the country they were read for.
    const seeded = new Set(boards.map(seedKey));
    const legacy = await db.rACareerSiteSource.findMany({ where: { market: 'cn', ats: 'smartrecruiters', origin: 'admin' }, select: { id: true, ats: true, boardToken: true, countries: true, createdBy: true } });
    for (const row of legacy) {
      const bySeed = seeded.has(seedKey(row)) && typeof row.createdBy === 'string' && row.createdBy.startsWith('seed:');
      if (bySeed || normalizeCountries(row.countries).length > 0) continue;
      await db.rACareerSiteSource.update({ where: { id: row.id }, data: { countries: ['CN'] } });
      result.carriedOver += 1;
    }
  }
  const create: MergedSeedBoard[] = [];
  for (const board of boards) {
    const key = seedKey(board);
    const row = existing.get(key);
    if (row) {
      const legacySeed = row.origin !== 'seed' && typeof row.createdBy === 'string' && row.createdBy.startsWith('seed:');
      const candidate = !row.enabled && !row.disabledAt && (row.origin === 'discovered' || row.origin === 'import');
      if (row.origin === 'seed' || legacySeed) {
        // Ours: the list decides its countries. `enabled` and the name are the admin's.
        const data: Record<string, unknown> = {};
        if (!sameList(normalizeCountries(row.countries), board.countries)) data.countries = board.countries;
        // A name that is just the board id is no admin's choice: it is what the board was registered under
        // while nothing stated its name. The list's name replaces it once the list has one.
        if (typeof row.companyName === 'string' && hasPlaceholderName({ companyName: row.companyName, boardToken: row.boardToken }) && !hasPlaceholderName(board)) {
          data.companyName = board.companyName;
        }
        if (legacySeed) {
          data.origin = 'seed';
          data.countries = board.countries;
          if (row.countryCode) data.countryCode = null;
        }
        if (Object.keys(data).length > 0) {
          await db.rACareerSiteSource.update({ where: { id: row.id }, data });
          result.updated += 1;
        }
      } else if (candidate) {
        // Only proposed so far: the seed confirms it.
        await db.rACareerSiteSource.update({
          where: { id: row.id },
          data: { origin: 'seed', enabled: true, countries: board.countries, companyName: board.companyName, lastError: null, failCount: 0, nextSyncAt: null },
        });
        result.updated += 1;
      } else {
        result.alreadyPresent += 1;
      }
    } else if (offered.has(key) || removed.has(removedBoardKey(board))) {
      result.removedByAdmin += 1;
    } else {
      create.push(board);
    }
    offered.add(key);
  }
  for (let i = 0; i < create.length; i += 500) {
    const res = await db.rACareerSiteSource.createMany({
      data: create.slice(i, i + 500).map((b) => ({
        market: displayMarket(b),
        ats: b.ats,
        boardToken: b.boardToken,
        companyName: b.companyName,
        countries: b.countries,
        origin: 'seed',
        enabled: true,
        createdBy: 'seed',
      })),
      skipDuplicates: true,
    });
    result.added += res.count;
  }
  const value = JSON.stringify({ hash, offered: [...offered].sort() } satisfies SeedState);
  await db.appConfig.upsert({ where: { key: CAREER_SEEDS_CONFIG_KEY }, create: { key: CAREER_SEEDS_CONFIG_KEY, value, updatedBy: 'jobs-boards' }, update: { value, updatedBy: 'jobs-boards' } });
  return { status: 'loaded', ...result };
}

/** The answer `jobs-plan` reads (kept from the parity wave's loader). */
export interface SeedResult {
  status: 'registered' | 'up_to_date' | 'no_seed';
  /** The hash of the merged seed list. */
  version: string | null;
  added: number;
  alreadyPresent: number;
}

/**
 * The entry `jobs-plan` calls (ingest/cron.ts). A board is no longer tied to
 * one market, so the market of the brand the plan runs for is not used: this
 * loads the list of the deployment (the files of every market it serves), the
 * same as the board sync does, and answers in the earlier shape.
 */
export async function ensureSeedCareerSources(db: SeedDb, _market?: Market): Promise<SeedResult> {
  const res = await loadCareerSeeds(db);
  return { status: res.status === 'loaded' ? 'registered' : 'up_to_date', version: res.hash, added: res.added, alreadyPresent: res.alreadyPresent };
}
