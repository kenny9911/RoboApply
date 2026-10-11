// server/src/features/jobs/ingest/boards.ts — the board sync (MARKET_STRATEGY 1.2
// tier 0, 1.4 tier 1, 1.5 closure; JI-3, JI-4, JC-4). Cron `jobs-boards`, every
// 5 minutes; a platform step: it runs once per invocation, not once per brand,
// because one board feeds both brands.
//
// The employer boards (`RACareerSiteSource`, read through the public posting
// APIs of sources/atsPublic) have their own run, apart from the search
// providers' ingest tick, so a slow board never eats the time of a paid
// provider and the boards are read as often as they change. One run:
//
//   0. kill switch ATS_PUBLIC_SOURCES_DISABLED -> skipped, nothing is read;
//   1. the seed lists are loaded when they changed (sources/atsPublic/seeds.ts);
//   2. sources switched off by three failed reads 48 hours ago have their
//      open postings archived ('source_removed');
//   3. up to ATS_DISCOVERY_VALIDATIONS_PER_RUN candidate sources (discovered
//      from a posting's link, or imported without "enable") get ONE list-only
//      read each, and are switched on only when the board answers and its
//      company matches (`validateCandidates`);
//   4. the loop, until under 20 s of the budget are left or nothing is due:
//      lease up to 2 x concurrency due boards with one statement (`FOR UPDATE
//      SKIP LOCKED`: two overlapping runs never read the same board), read
//      them with ATS_BOARDS_CONCURRENCY requests in flight (default 6, 4 to 8),
//      then write ONE board at a time: its postings per market through
//      `processJobs` (normalize -> hooks -> upsert -> dedupe -> enrich), the
//      postings the board stopped listing archived as 'source_removed', and
//      the stamp on the source (the rules are sources/atsPublic/schedule.ts).
//
// One read feeds both brands (JC-4). `readBoard` routes every posting to the
// market of its own location. `processJobs` is called once per market that has
// postings, as the brand that serves that market, inside `runWithBrand`. A
// market this deployment does not serve, or whose ingest is switched off
// (GoApply under CN_RECRUITMENT_INFO_MODE=off), or whose brand's source list
// is narrowed to exclude the boards (JOB_PROVIDERS_<BRAND> without
// `ats_public`), has its postings dropped and counted (`droppedIntl` /
// `droppedCn`); they are never written to the other market.
//
// A board is read at most once per run. A SmartRecruiters board whose posting
// texts are not all asked for yet (`pendingDetails`) is due again at the next
// run, so a large board finishes over successive runs; boards never read come
// first in the lease. A text that was asked for and could not be read
// (`failedDetails`) brings the board back in an hour instead, and so does a
// run that was refused every text it asked for: a host that limits us is asked
// less often, never more (sources/atsPublic/schedule.ts `nextReadDelayMs`).
//
// What the run did is also kept per market as the source's run status
// (./status.ts, AppConfig `jobs.source.status:<market>:ats_public`), which the
// admin sources console reads: boards read, boards that failed, boards with
// texts still unread, postings received, written, added and closed. A board
// read for both markets counts in both documents (its requests too); postings
// are counted in the market they were written to. Counters only. The same
// counters are added to the day's RAProviderUsage row of the source
// (`ats_public`, `ats_public:cn`), which the admin System panel reads.
//
// The requests say who is asking (the identifying User-Agent, sources/
// userAgent.ts; `signingMarket`): GoApply's for a board that is read for the
// mainland only, the international brand's for every other board where this
// deployment serves that brand, else GoApply's. A mainland-only deployment
// never names RoboApply.

import { Prisma } from '../../../generated/prisma/client.js';
import { runWithBrand } from '../../../lib/requestContext.js';
import { allowedBrands, getBrand, type BrandId, type EnvSource, type Market } from '../../../platform/brand/index.js';
import { kickDrain, type Budget, type CronResult } from '../../../platform/queue/index.js';
import { logger } from '../../../services/LoggerService.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { jobProvidersNarrowedTo } from '../sources/index.js';
import {
  CAREER_SOURCE_COLUMNS,
  DISABLED_ARCHIVE_AFTER_MS,
  PUBLIC_ATS,
  VALIDATION_ERROR_PREFIX,
  asBoardSource,
  atsPublicEnabled,
  boardErrorText,
  boardsConcurrency,
  candidateRetry,
  classifyBoardError,
  connectorFor,
  discoveryValidationsPerRun,
  externalIdPrefix,
  failureStamp,
  hasPlaceholderName,
  judgeCandidate,
  loadCareerSeeds,
  readBoard,
  smartRecruitersDetailsPerRun,
  sourceFeedsMarket,
  successStamp,
  toCareerSourceRow,
  type BoardReadOutcome,
  type CareerSourceRow,
  type FetchLike,
  type SeedLoadResult,
} from '../sources/atsPublic/index.js';
import { ingestAllowed } from './cron.js';
import { dayKey, type IngestDb } from './db.js';
import { ENRICH_KIND, processJobs, type EnqueueManyFn, type ProcessResult } from './pipeline.js';
import { recordProviderUsage } from './quota.js';
import { usageKey } from './quotaContract.js';
import { emptyRunStatus, isSourceStatusNote, writeSourceStatus, type SourceRunStatus } from './status.js';
import { archiveClosedBankJobs } from './upsert.js';

const TAG = 'JOBS_BOARDS';

/** The loop stops once less than this is left of the run's budget. */
export const BOARD_SYNC_RESERVE_MS = 20_000;
/** A leased board is not offered to another run for this long: the interval in `buildBoardLeaseSql` (a run that dies frees its boards after it). */
export const BOARD_LEASE_MINUTES = 15;
/** Sources whose postings are archived per run (step 2). */
const ARCHIVE_DISABLED_PER_RUN = 50;

/** The provider the board rows are normalized as. */
const BOARDS_ADAPTER = { provider: 'ats_public' } as const;

/**
 * The lease statement (exported for the test). Due = switched on and never
 * scheduled, or its time has come. Never-scheduled boards first, then the
 * longest overdue. `exclude`: boards this run has already read.
 */
export function buildBoardLeaseSql(limit: number, exclude: readonly string[] = []): Prisma.Sql {
  const columns = Prisma.raw(CAREER_SOURCE_COLUMNS.map((c) => `"${c}"`).join(', '));
  const notThese = exclude.length > 0 ? Prisma.sql`AND NOT ("id" = ANY(${[...exclude]}::text[]))` : Prisma.empty;
  return Prisma.sql`
    UPDATE "RACareerSiteSource" SET "nextSyncAt" = now() + interval '15 minutes'
    WHERE "id" IN (
      SELECT "id" FROM "RACareerSiteSource"
      WHERE "enabled" = true AND ("nextSyncAt" IS NULL OR "nextSyncAt" <= now()) ${notThese}
      ORDER BY "nextSyncAt" ASC NULLS FIRST, "lastSyncedAt" ASC NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING ${columns}`;
}

export interface BoardSyncDeps {
  db: IngestDb;
  budget: Pick<Budget, 'remainingMs' | 'exhausted'>;
  /** The clock (default: the system's). Read once per board for its stamp. */
  now?: () => Date;
  env?: EnvSource;
  fetch?: FetchLike;
  /** Brands this deployment serves (default: ALLOWED_BRANDS). */
  brands?: readonly BrandId[];
  enqueueMany?: EnqueueManyFn;
  kick?: (kinds: string[]) => unknown;
  /** Test seam for the write step (default: the ingest pipeline's `processJobs`). */
  process?: typeof processJobs;
  /** Test seam: the seed loader (default: the validated seed files). */
  loadSeeds?: (db: IngestDb) => Promise<SeedLoadResult | null>;
}

export interface BoardSyncTally {
  /** Boards leased and read (each at most once per run). */
  boards: number;
  boardErrors: number;
  /** Sources switched off by this run (the third hard failure in a row). */
  disabled: number;
  /** HTTP requests made. */
  calls: number;
  /** Postings handed to the normalizer. */
  received: number;
  written: number;
  inserted: number;
  updated: number;
  /** Postings the normalizer did not write (no apply link, no title or company …). */
  skippedPostings: number;
  /** Postings a board stopped listing, archived as 'source_removed'. */
  closed: number;
  enrichQueued: number;
  /** Postings not written because this deployment does not serve the market, or its ingest is off. */
  droppedIntl: number;
  droppedCn: number;
  /** Copies left out because their country is not one the board is read for. */
  countryNotSelected: number;
  /** Boards with posting texts still unread: not asked for yet (due again at the next run), or asked for and not read (due again in an hour). */
  pending: number;
  /** Open postings archived of sources switched off 48 hours ago. */
  archivedDisabled: number;
  candidatesChecked: number;
  candidatesEnabled: number;
  seedBoardsAdded: number;
  /** 'idle': nothing was due any more; 'budget': the run's time was used up. */
  stoppedBy: 'idle' | 'budget';
}

function emptyTally(): BoardSyncTally {
  return {
    boards: 0,
    boardErrors: 0,
    disabled: 0,
    calls: 0,
    received: 0,
    written: 0,
    inserted: 0,
    updated: 0,
    skippedPostings: 0,
    closed: 0,
    enrichQueued: 0,
    droppedIntl: 0,
    droppedCn: 0,
    countryNotSelected: 0,
    pending: 0,
    archivedDisabled: 0,
    candidatesChecked: 0,
    candidatesEnabled: 0,
    seedBoardsAdded: 0,
    stoppedBy: 'idle',
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * The brand that writes each market on this deployment. Absent: the market is
 * not served, its ingest is off, or JOB_PROVIDERS_<BRAND> narrows the brand's
 * sources to a list without the employer boards (the variable switched them
 * off while they were read through the ingest tick, and still does).
 */
export function writingBrands(brands: readonly BrandId[], env: EnvSource): Partial<Record<Market, BrandId>> {
  const out: Partial<Record<Market, BrandId>> = {};
  for (const id of brands) {
    const brand = getBrand(id);
    const narrowed = jobProvidersNarrowedTo(id, env);
    const runsBoards = narrowed === null || narrowed.includes(BOARDS_ADAPTER.provider);
    if (!out[brand.market] && ingestAllowed(brand, env) && runsBoards) out[brand.market] = id;
  }
  return out;
}

/**
 * The market whose brand signs a board's requests. A board read for the
 * mainland only is asked as the mainland brand; any other board as the
 * international brand where this deployment serves it, else as the mainland
 * brand. So GoApply's requests never name RoboApply, and the reverse.
 */
export function signingMarket(source: { countries?: readonly string[] | null }, brands: readonly BrandId[]): Market {
  const markets = brands.map((id) => getBrand(id).market);
  if (markets.length === 0) return 'intl';
  if (!markets.includes('intl')) return 'cn';
  return markets.includes('cn') && !sourceFeedsMarket(source, 'intl') ? 'cn' : 'intl';
}

/** Leases up to `limit` due boards (SKIP LOCKED: concurrent runs never share one). */
export async function leaseDueBoards(db: IngestDb, limit: number, exclude: readonly string[] = []): Promise<CareerSourceRow[]> {
  if (limit <= 0) return [];
  const rows = await db.$queryRaw<Record<string, unknown>[]>(buildBoardLeaseSql(limit, exclude));
  return (rows ?? []).map(toCareerSourceRow);
}

// -- Step 2: sources switched off by failures -------------------------------

/**
 * Archives the open postings of sources that three failed reads switched off
 * at least 48 hours ago. A switched-off source carries the time its postings
 * go in `nextSyncAt` (schedule.ts); once archived the mark is cleared, so each
 * source is handled once. Switching the source back on brings the rows back
 * through the upsert.
 */
export async function archiveDisabledSources(db: IngestDb, now: Date): Promise<number> {
  const due = await db.rACareerSiteSource.findMany({
    where: { enabled: false, disabledAt: { not: null, lte: new Date(now.getTime() - DISABLED_ARCHIVE_AFTER_MS) }, nextSyncAt: { not: null, lte: now } },
    select: { id: true, ats: true, boardToken: true },
    orderBy: { nextSyncAt: 'asc' },
    take: ARCHIVE_DISABLED_PER_RUN,
  });
  let archived = 0;
  for (const source of due) {
    const res = await db.rAJob.updateMany({
      where: { sourceBoard: source.ats, externalId: { startsWith: externalIdPrefix(source.boardToken) }, archivedAt: null, visibility: 'public' },
      data: { archivedAt: now, closedAt: now, closeReason: 'source_removed' },
    });
    archived += res.count;
    await db.rACareerSiteSource.update({ where: { id: source.id }, data: { nextSyncAt: null } });
  }
  return archived;
}

// -- Step 3: candidates -------------------------------------------------------

export interface ValidationTally {
  checked: number;
  enabled: number;
  /** Per outcome: 'ok', 'empty_board', 'name_mismatch', 'name_unconfirmed', or the read's error code. */
  outcomes: Record<string, number>;
  calls: number;
}

export interface ValidateDeps {
  now?: () => Date;
  env?: EnvSource;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Brands this deployment serves: they decide who signs each request (`signingMarket`). Default: the international brand. */
  brands?: readonly BrandId[];
  concurrency?: number;
}

/**
 * One list-only read per candidate, oldest first: a discovered or imported
 * source that was never switched on and never checked. The read asks for as
 * little as the check needs: the listing without its texts and, where the
 * listing is paged, its first page (`firstPage`). It passes when the board
 * lists at least one posting AND its company matches (sources/atsPublic/
 * discovery.ts `judgeCandidate`). Pass -> switched on and due at once; a
 * discovered source then takes the name the board itself states. Fail -> stays
 * off with `lastError 'validation:<reason>'` and the time of the check, so it
 * is not tried again; an admin can still switch it on by hand. A read that
 * failed for a passing reason (a timeout, a 5xx, a 429) is tried again 1 h x
 * the attempt later, and the third such failure is final too
 * (`candidateRetry`): no candidate is asked without end. A candidate on a
 * job-board system we cannot read yet is left untouched.
 */
export async function validateCandidates(db: IngestDb, limit: number, deps: ValidateDeps = {}): Promise<ValidationTally> {
  const tally: ValidationTally = { checked: 0, enabled: 0, outcomes: {}, calls: 0 };
  if (limit <= 0) return tally;
  const clock = () => (deps.now ? deps.now() : new Date());
  const rows = await db.rACareerSiteSource.findMany({
    where: {
      enabled: false,
      origin: { in: ['discovered', 'import'] },
      lastSyncedAt: null,
      disabledAt: null,
      ats: { in: [...PUBLIC_ATS] },
      // A candidate whose read failed in passing waits for its retry time.
      OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: clock() } }],
    },
    orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  await mapLimit(rows, deps.concurrency ?? 4, async (raw) => {
    if (deps.signal?.aborted) return;
    const source = toCareerSourceRow(raw as unknown as Record<string, unknown>);
    const board = asBoardSource(source);
    if (!board) return;
    tally.checked += 1;
    const now = clock();
    let outcome: string;
    let stated: string | null = null;
    try {
      const market = signingMarket(source, deps.brands ?? []);
      const read = await connectorFor(board.ats).read(board, { now, fetch: deps.fetch, signal: deps.signal, env: deps.env, market }, { listOnly: true, firstPage: true, boardCompany: true });
      tally.calls += read.calls;
      stated = read.boardCompanyName;
      let domain: string | null = null;
      if (!stated) {
        // Lever and Ashby state no company: the board id may also be the first label of the employer's own domain.
        const company = await db.rACompany.findFirst({ where: { nameNormalized: normalizeCompanyName(source.companyName), domain: { not: null } }, select: { domain: true } });
        domain = company?.domain ?? null;
      }
      outcome = judgeCandidate({ boardToken: source.boardToken, companyName: source.companyName, domain }, { listed: read.listedCount, boardCompanyName: stated });
    } catch (err) {
      tally.calls += 1;
      // The run's own time ran out mid-read: that says nothing about the board. It is checked at the next run.
      if (deps.signal?.aborted) return;
      outcome = boardErrorText(err);
    }
    tally.outcomes[outcome] = (tally.outcomes[outcome] ?? 0) + 1;
    if (outcome === 'ok') {
      tally.enabled += 1;
      // The board's own name: always for a source registered without one, and for a discovered source, whose
      // name came from the posting that linked to the board (an aggregator's spelling, or a parent company's).
      const takeStated = stated && (hasPlaceholderName(source) || source.origin === 'discovered');
      await db.rACareerSiteSource.update({
        where: { id: source.id },
        data: { enabled: true, nextSyncAt: null, lastError: null, failCount: 0, ...(takeStated ? { companyName: stated!.slice(0, 200) } : {}) },
      });
      return;
    }
    const lastError = `${VALIDATION_ERROR_PREFIX}${outcome}`.slice(0, 300);
    const verdict = outcome === 'empty_board' || outcome === 'name_mismatch' || outcome === 'name_unconfirmed';
    // A verdict, or a board that is not there or refuses us, is final.
    if (verdict || classifyBoardError(outcome) === 'hard') {
      await db.rACareerSiteSource.update({ where: { id: source.id }, data: { lastError, lastSyncedAt: now, nextSyncAt: null } });
      return;
    }
    // Anything else may pass: tried again later, a bounded number of times.
    const retry = candidateRetry(source.failCount, now);
    await db.rACareerSiteSource.update({
      where: { id: source.id },
      data: retry.final ? { lastError, failCount: retry.failCount, lastSyncedAt: now, nextSyncAt: null } : { lastError, failCount: retry.failCount, nextSyncAt: retry.nextSyncAt },
    });
  });
  return tally;
}

// -- Step 4: one board ------------------------------------------------------

interface WriteContext {
  db: IngestDb;
  now: Date;
  writers: Partial<Record<Market, BrandId>>;
  enqueueMany?: EnqueueManyFn;
  process: typeof processJobs;
}

interface BoardWrite {
  /** The pipeline's result per market written. */
  processed: Partial<Record<Market, ProcessResult>>;
  closed: number;
  /** Rows archived, by the market they were in. */
  closedByMarket: Record<Market, number>;
  dropped: Record<Market, number>;
  disabled: boolean;
}

const MARKETS = ['intl', 'cn'] as const;

/** How many of the rows about to be closed are in each market (for the per-market run status). */
async function marketsOfClosures(db: IngestDb, sourceBoard: string, externalIds: readonly string[]): Promise<Record<Market, number>> {
  const out: Record<Market, number> = { intl: 0, cn: 0 };
  for (let i = 0; i < externalIds.length; i += 1000) {
    const rows = await db.rAJob.findMany({
      where: { sourceBoard, externalId: { in: externalIds.slice(i, i + 1000) }, archivedAt: null, visibility: 'public' },
      select: { market: true },
    });
    for (const row of rows) out[row.market === 'cn' ? 'cn' : 'intl'] += 1;
  }
  return out;
}

/** Writes one board's read: its postings per market, its closures and the stamp on the source. */
export async function writeBoard(ctx: WriteContext, outcome: BoardReadOutcome): Promise<BoardWrite> {
  const { db, now } = ctx;
  const source = outcome.source;
  const result: BoardWrite = { processed: {}, closed: 0, closedByMarket: { intl: 0, cn: 0 }, dropped: { intl: 0, cn: 0 }, disabled: false };
  if (!outcome.read || !outcome.routed) {
    const stamp = failureStamp(source, { now, error: outcome.error ?? 'unexpected' });
    result.disabled = stamp.enabled === false;
    await db.rACareerSiteSource.update({ where: { id: source.id }, data: stamp });
    return result;
  }
  for (const market of MARKETS) {
    const inputs = outcome.routed.byMarket[market];
    if (inputs.length === 0) continue;
    const brand = ctx.writers[market];
    if (!brand) {
      // Not served here, or its ingest is off: never written to the other market.
      result.dropped[market] += inputs.length;
      continue;
    }
    result.processed[market] = await runWithBrand(brand, () => ctx.process({ db, brand, market, now, enqueueMany: ctx.enqueueMany }, BOARDS_ADAPTER, inputs));
  }
  if (outcome.closedExternalIds.length > 0) {
    result.closedByMarket = await marketsOfClosures(db, source.ats, outcome.closedExternalIds);
    result.closed = await archiveClosedBankJobs(db, source.ats, outcome.closedExternalIds, now, 'source_removed');
  }
  const inserted = MARKETS.reduce((n, m) => n + (result.processed[m]?.inserted ?? 0), 0);
  // A board's FIRST successful read inserts every posting it lists. That is the load, not news about the board:
  // counted as a change it put every newly seeded board on the 2-hour interval for 48 hours (512 boards and about
  // 48,500 postings downloaded and rewritten in full every pass; M4 cross-review). A new board is still read at
  // once; after that it is read every 24 hours until a posting really opens or closes (strategy 1.2: "diff ids to
  // open and close"). `lastJobCount` is written by a successful read only, so it is null exactly until the first one
  // (a board whose first attempts failed in passing has a `lastSyncedAt` and still no successful read).
  const firstRead = source.lastJobCount === null;
  const stamp = successStamp(source, {
    now,
    listed: outcome.read.listing.length,
    changed: (inserted > 0 && !firstRead) || result.closed > 0,
    pendingDetails: outcome.read.pendingDetails,
    failedDetails: outcome.read.failedDetails,
    readDetails: outcome.read.inputs.length,
  });
  // A source registered without a name carries its board id until the board states its own.
  const learned = outcome.read.boardCompanyName && hasPlaceholderName(source) ? { companyName: outcome.read.boardCompanyName.slice(0, 200) } : {};
  await db.rACareerSiteSource.update({ where: { id: source.id }, data: { ...stamp, ...learned } });
  return result;
}

/** One board-sync run (see the header). Never throws for a board; a database failure propagates to the cron. */
export async function runBoardSync(deps: BoardSyncDeps): Promise<BoardSyncTally | { skipped: 'kill_switch' }> {
  const env = deps.env ?? process.env;
  if (!atsPublicEnabled(env)) return { skipped: 'kill_switch' };
  const { db, budget } = deps;
  const clock = () => (deps.now ? deps.now() : new Date());
  const brands = deps.brands ?? allowedBrands(env);
  const writers = writingBrands(brands, env);
  const markets = (Object.keys(writers) as Market[]).filter((m) => !!writers[m]);
  const concurrency = boardsConcurrency(env);
  const tally = emptyTally();
  // What this run did for each market it writes (the admin console's "last run" of the employer boards).
  const status: Record<Market, SourceRunStatus> = { intl: emptyRunStatus(clock(), 'board_api'), cn: emptyRunStatus(clock(), 'board_api') };
  const note = (market: Market, key: string, by = 1) => {
    if (by > 0 && isSourceStatusNote(key)) status[market].notes[key] = (status[market].notes[key] ?? 0) + by;
  };

  // 1. Seeds. A bad seed never stops the sync: the boards already in the list are still read.
  try {
    const seed = await (deps.loadSeeds ?? ((store: IngestDb) => loadCareerSeeds(store)))(db);
    tally.seedBoardsAdded = seed?.added ?? 0;
  } catch (err) {
    logger.warn(TAG, 'seed boards not loaded', { error: err instanceof Error ? err.message.slice(0, 160) : 'error' });
  }

  // 2. Postings of sources switched off 48 hours ago.
  tally.archivedDisabled = await archiveDisabledSources(db, clock());

  // No brand of this deployment writes board postings (the mainland stack with CN_RECRUITMENT_INFO_MODE=off, or
  // every brand narrowed by JOB_PROVIDERS_<BRAND> to a list without `ats_public`): nothing a read returned could
  // be stored, so nothing is read. No board is leased, no candidate is checked and no request is made; before this
  // every due board was downloaded once a day and its postings dropped (the 512 seeded boards are about 48,500
  // postings and half a gigabyte a pass). The seed load and the archive step above still ran.
  if (markets.length === 0) return tally;

  // Every read stops when the run's time is nearly used up (a real timer: reads are real waits).
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.max(0, budget.remainingMs() - BOARD_SYNC_RESERVE_MS));
  try {
    // 3. Candidates.
    if (!budget.exhausted(BOARD_SYNC_RESERVE_MS)) {
      const checked = await validateCandidates(db, discoveryValidationsPerRun(env), { now: clock, env, fetch: deps.fetch, signal: stop.signal, brands });
      tally.candidatesChecked = checked.checked;
      tally.candidatesEnabled = checked.enabled;
      tally.calls += checked.calls;
    }

    // 4. The loop.
    const done: string[] = [];
    const detailsBudget = smartRecruitersDetailsPerRun(env);
    const write: WriteContext = { db, now: clock(), writers, enqueueMany: deps.enqueueMany, process: deps.process ?? processJobs };
    for (;;) {
      if (budget.exhausted(BOARD_SYNC_RESERVE_MS)) {
        tally.stoppedBy = 'budget';
        break;
      }
      const leased = await leaseDueBoards(db, concurrency * 2, done);
      if (leased.length === 0) break;
      for (const s of leased) done.push(s.id);
      const outcomes = await mapLimit(leased, concurrency, (source) =>
        readBoard(db, source, { now: clock(), fetch: deps.fetch, signal: stop.signal, env, market: signingMarket(source, brands) }, { markets, detailsBudget }),
      );
      const unwritten: string[] = [];
      for (const outcome of outcomes) {
        // Out of time before this board's write: it was not stamped, so free its lease (due at the next run).
        if (budget.exhausted(BOARD_SYNC_RESERVE_MS / 2) || (stop.signal.aborted && !outcome.read)) {
          unwritten.push(outcome.source.id);
          continue;
        }
        const written = await writeBoard({ ...write, now: clock() }, outcome);
        tally.boards += 1;
        tally.calls += outcome.calls;
        if (outcome.error) tally.boardErrors += 1;
        if (written.disabled) tally.disabled += 1;
        tally.closed += written.closed;
        tally.droppedIntl += written.dropped.intl;
        tally.droppedCn += written.dropped.cn;
        tally.countryNotSelected += outcome.routed?.countryNotSelected ?? 0;
        const unread = (outcome.read?.pendingDetails ?? 0) + (outcome.read?.failedDetails ?? 0);
        if (unread > 0) tally.pending += 1;
        for (const m of markets) {
          // A board counts in the status of every market it feeds here.
          if (sourceFeedsMarket(outcome.source, m)) {
            note(m, 'boards_read');
            status[m].calls += outcome.calls;
            if (outcome.error) {
              note(m, 'board_errors');
              status[m].error = outcome.error.slice(0, 300);
            }
            if (unread > 0) note(m, 'board_backlog');
          }
          status[m].closed += written.closedByMarket[m];
          const p = written.processed[m];
          if (!p) continue;
          tally.received += p.received;
          tally.written += p.written;
          tally.inserted += p.inserted;
          tally.updated += p.updated;
          tally.skippedPostings += p.skipped;
          tally.enrichQueued += p.enrichQueued;
          status[m].received += p.received;
          status[m].written += p.written;
          status[m].inserted += p.inserted;
          status[m].skipped += p.skipped;
          for (const [key, n] of Object.entries(p.notes)) note(m, key, n);
        }
      }
      if (unwritten.length > 0) {
        await db.rACareerSiteSource.updateMany({ where: { id: { in: unwritten } }, data: { nextSyncAt: clock() } });
        tally.stoppedBy = 'budget';
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // One status document per market that had a board read (never fails the run). A run that read
  // nothing leaves the last one standing.
  const finishedAt = clock().toISOString();
  for (const m of markets) {
    const read = status[m].notes.boards_read ?? 0;
    if (read === 0) continue;
    const failed = status[m].notes.board_errors ?? 0;
    await writeSourceStatus(db, m, BOARDS_ADAPTER.provider, { ...status[m], at: finishedAt, ok: failed < read, error: failed > 0 ? status[m].error : null });
    // The day's counters of the source (RAProviderUsage), which the admin System panel and the daily
    // health e-mail print per provider: requests made, postings handed to the normalizer, postings
    // added, boards that failed. The same numbers as the status document, under the market's usage key
    // (`ats_public` / `ats_public:cn`). The boards are not metered, so nothing reads this as a budget.
    try {
      await recordProviderUsage(db, usageKey(BOARDS_ADAPTER.provider, m), dayKey(new Date(finishedAt)), { calls: status[m].calls, returned: status[m].received, inserted: status[m].inserted, errors: failed });
    } catch (err) {
      logger.warn(TAG, 'board usage not recorded', { market: m, error: err instanceof Error ? err.message.slice(0, 160) : 'error' });
    }
  }
  if (tally.enrichQueued > 0) {
    Promise.resolve()
      .then(() => (deps.kick ?? kickDrain)([ENRICH_KIND]))
      .catch(() => undefined);
  }
  return tally;
}

/** The `jobs-boards` cron step (server/src/cron/handlers.ts): one board sync inside the cron's budget. */
export async function runJobsBoards(budget: Pick<Budget, 'remainingMs' | 'exhausted'>, deps: Partial<Omit<BoardSyncDeps, 'budget'>> = {}): Promise<CronResult> {
  const db = deps.db ?? ((await import('../../../lib/prisma.js')).default as unknown as IngestDb);
  const result = await runBoardSync({ ...deps, db, budget });
  if ('skipped' in result) return { skipped: result.skipped };
  logger.info(TAG, 'jobs-boards', { ...result });
  const work = result.boards + result.candidatesChecked + result.seedBoardsAdded + result.archivedDisabled;
  if (work === 0) return { skipped: 'no_work' };
  return { processed: result.boards, ...result };
}
