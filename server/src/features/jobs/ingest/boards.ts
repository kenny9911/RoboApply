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
//      open postings archived ('source_removed'), and so have the tenants on
//      CN_ATS_TENANT_DENYLIST, at every run (the takedown path, see below);
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
//      postings the board stopped listing archived as 'source_removed', the
//      rows of a board that had nothing to read marked as seen (`lastSeenAt`
//      only: Greenhouse asks which postings are listed and when each was
//      edited before it asks for the texts, so a board that did not change
//      costs one small request and no rewrite), and the stamp on the source
//      (the rules are sources/atsPublic/schedule.ts).
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
// mainland only and for every 北森 tenant board, the international brand's for
// every other board where this deployment serves that brand, else GoApply's.
// A mainland-only deployment never names RoboApply.
//
// Sources that are passed over (MKT-5B; JI-8, JC-8). A leased source is not
// read, and no request is made, when
//   - its tenant is on CN_ATS_TENANT_DENYLIST (the takedown path, below);
//   - its connector is switched off (ATS_WORKABLE_DISABLED for Workable; 北森
//     without CN_ATS_BEISEN_ENABLED), or it is a 北森 board on a deployment
//     that writes no mainland posting: its postings are left as they are.
// The source gets `lastError` = the reason ('tenant_denied',
// 'connector_disabled') and is looked at again in 24 hours. It is not a
// failure: nothing is counted toward switching the source off.
//
// The takedown path (docs/job-search/ATS_BOARDS.md 6). EVERY run, before it
// leases anything, archives the open postings ('source_removed') of every
// tenant on CN_ATS_TENANT_DENYLIST (`archiveDeniedTenants`): by the rows
// themselves, so it does not matter whether the tenant's source is due, is
// switched off, or exists at all, nor whether the 北森 connector is on, nor
// whether this deployment writes board postings. A takedown therefore takes
// effect at the next run, at most 5 minutes after the variable is set.
//
// 北森 tenant boards, when the connector is on (MARKET_STRATEGY 1.4 tier 2):
//   - at most BEISEN_TENANTS_IN_FLIGHT (2) tenants are read at the same time,
//     through a gate of their own that ATS_BOARDS_CONCURRENCY does not widen;
//   - a tenant is never asked twice within 30 minutes, whatever happens to
//     the run that asked it (the rule is spelled out in schedule.ts): the time
//     is written to the source BEFORE the request (`stampTenantAsked`), the
//     lease leaves out a tenant asked under 30 minutes ago and holds a leased
//     tenant for 30 minutes (`tenantFloor`), no stamp sets its next read
//     earlier (`withTenantFloor`), a tenant that was leased and not written
//     is NOT freed for the next run, and a candidate carries the time of its
//     next possible request before its check is sent;
//   - the cap of postings per tenant and run is the connector's
//     (CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN); a capped listing closes nothing;
//   - a tenant board feeds market cn only (sources/atsPublic/sync.ts).
//
// Large boards. A system that answers with the whole board at once
// (Greenhouse, Ashby, Workable, Recruitee, Personio) may send tens of
// megabytes (shared.ts MAX_RESPONSE_BYTES). A board of such a system whose
// last listing held LARGE_BOARD_POSTINGS postings or more, and one that was
// never read (its size is not known yet), is read AND written inside one
// single slot (`largeBoardGate`): the next large answer is asked for only
// after the previous one was written and let go, so a run never holds two of
// them. The other boards of a round are known to be small; their answers are
// collected and written after the round, as before.

import { Prisma } from '../../../generated/prisma/client.js';
import { runWithBrand } from '../../../lib/requestContext.js';
import { allowedBrands, getBrand, type BrandId, type EnvSource, type Market } from '../../../platform/brand/index.js';
import { kickDrain, type Budget, type CronResult } from '../../../platform/queue/index.js';
import { logger } from '../../../services/LoggerService.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { jobProvidersNarrowedTo } from '../sources/index.js';
import {
  BEISEN_TENANTS_IN_FLIGHT,
  BEISEN_TENANT_FLOOR_MS,
  CAREER_SOURCE_COLUMNS,
  CONNECTOR_DISABLED,
  DISABLED_ARCHIVE_AFTER_MS,
  LARGE_BOARD_POSTINGS,
  MAINLAND_ONLY_ATS,
  TENANT_DENIED,
  VALIDATION_ERROR_PREFIX,
  asBoardSource,
  atsPublicEnabled,
  beisenEnabled,
  boardErrorText,
  boardsConcurrency,
  candidateRetry,
  classifyBoardError,
  connectorEnabled,
  connectorFor,
  createHostGate,
  discoveryValidationsPerRun,
  enabledAts,
  externalIdPrefix,
  failureStamp,
  hasPlaceholderName,
  isMainlandOnlyAts,
  isPublicAts,
  isSkippedBoardError,
  judgeCandidate,
  loadCareerSeeds,
  readBoard,
  skippedStamp,
  smartRecruitersDetailsPerRun,
  sourceFeedsMarket,
  successStamp,
  tenantDenied,
  tenantDenylist,
  toCareerSourceRow,
  withTenantFloor,
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
/** Open postings of denylisted tenants archived per run (the rest at the next run, 5 minutes later). */
export const TAKEDOWN_ROWS_PER_RUN = 5_000;

/** The provider the board rows are normalized as. */
const BOARDS_ADAPTER = { provider: 'ats_public' } as const;

/** The 30-minute floor of a 北森 tenant, as the lease statement writes it (a test holds it equal to BEISEN_TENANT_FLOOR_MS). */
export const TENANT_FLOOR_MINUTES = 30;

export interface LeaseOptions {
  /**
   * The 北森 floor: leave out a tenant that was asked under 30 minutes ago,
   * whatever its `nextSyncAt` says ("Check now" marks a source due at once),
   * and hold a leased tenant for 30 minutes instead of 15, so a tenant whose
   * run died after asking it is not offered again inside the floor. Set while
   * the 北森 connector is switched on; without it the statement is the one
   * every deployment has always run.
   */
  tenantFloor?: boolean;
}

/**
 * The lease statement (exported for the test). Due = switched on and never
 * scheduled, or its time has come. Never-scheduled boards first, then the
 * longest overdue. `exclude`: boards this run has already read.
 */
export function buildBoardLeaseSql(limit: number, exclude: readonly string[] = [], opts: LeaseOptions = {}): Prisma.Sql {
  const columns = Prisma.raw(CAREER_SOURCE_COLUMNS.map((c) => `"${c}"`).join(', '));
  const notThese = exclude.length > 0 ? Prisma.sql`AND NOT ("id" = ANY(${[...exclude]}::text[]))` : Prisma.empty;
  const floor = opts.tenantFloor ? Prisma.sql`AND NOT ("ats" = 'beisen' AND "lastSyncedAt" IS NOT NULL AND "lastSyncedAt" > now() - interval '30 minutes')` : Prisma.empty;
  const hold = opts.tenantFloor ? Prisma.sql`now() + CASE WHEN "ats" = 'beisen' THEN interval '30 minutes' ELSE interval '15 minutes' END` : Prisma.sql`now() + interval '15 minutes'`;
  return Prisma.sql`
    UPDATE "RACareerSiteSource" SET "nextSyncAt" = ${hold}
    WHERE "id" IN (
      SELECT "id" FROM "RACareerSiteSource"
      WHERE "enabled" = true AND ("nextSyncAt" IS NULL OR "nextSyncAt" <= now()) ${notThese} ${floor}
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
  /** Stored postings a board still lists unchanged: marked as seen, not downloaded again and not rewritten. */
  seenUnchanged: number;
  enrichQueued: number;
  /** Postings not written because this deployment does not serve the market, or its ingest is off. */
  droppedIntl: number;
  droppedCn: number;
  /** Copies left out because their country is not one the board is read for. */
  countryNotSelected: number;
  /** Boards with posting texts still unread: not asked for yet (due again at the next run), or asked for and not read (due again in an hour). */
  pending: number;
  /** Sources leased and not read: their connector is switched off, or their tenant is on the denylist (see the header). No request was made. */
  passedOver: number;
  /** Open postings archived because their tenant is on the denylist (the takedown path). */
  takenDown: number;
  /** Postings a connector left out by its own rule (a 北森 posting outside mainland China). */
  droppedByConnector: number;
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
    seenUnchanged: 0,
    enrichQueued: 0,
    droppedIntl: 0,
    droppedCn: 0,
    countryNotSelected: 0,
    pending: 0,
    passedOver: 0,
    takenDown: 0,
    droppedByConnector: 0,
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
export function signingMarket(source: { countries?: readonly string[] | null; ats?: string | null }, brands: readonly BrandId[]): Market {
  // A tenant board of the mainland is only ever asked as the mainland brand.
  if (isMainlandOnlyAts(source.ats)) return 'cn';
  const markets = brands.map((id) => getBrand(id).market);
  if (markets.length === 0) return 'intl';
  if (!markets.includes('intl')) return 'cn';
  return markets.includes('cn') && !sourceFeedsMarket(source, 'intl') ? 'cn' : 'intl';
}

/** Leases up to `limit` due boards (SKIP LOCKED: concurrent runs never share one). */
export async function leaseDueBoards(db: IngestDb, limit: number, exclude: readonly string[] = [], opts: LeaseOptions = {}): Promise<CareerSourceRow[]> {
  if (limit <= 0) return [];
  const rows = await db.$queryRaw<Record<string, unknown>[]>(buildBoardLeaseSql(limit, exclude, opts));
  return (rows ?? []).map(toCareerSourceRow);
}

// -- Who may be read, and how many at once ------------------------------------

/** 北森 tenants in flight in this process: two, whatever ATS_BOARDS_CONCURRENCY allows the other boards. */
const beisenGate = createHostGate(BEISEN_TENANTS_IN_FLIGHT);
/** Large one-answer boards in flight in this process: one (see the header). */
const largeBoardGate = createHostGate(1);
/** Systems whose listing is paged: no single answer of theirs holds a whole large board. */
const PAGED_ATS: readonly string[] = ['lever', 'lever_eu', 'smartrecruiters', 'beisen'];

const ungated = <T>(fn: () => Promise<T>): Promise<T> => fn();

/**
 * Is this a board whose one answer may be large? A one-answer system, and
 * either its last listing held LARGE_BOARD_POSTINGS postings or more, or it
 * was never read: a board's size is not known until its first read, and the
 * boards the answer limit was raised for arrive as new seeds, all due at once.
 */
export function isLargeBoard(source: Pick<CareerSourceRow, 'ats' | 'lastJobCount'>): boolean {
  if (PAGED_ATS.includes(source.ats)) return false;
  return source.lastJobCount === null || source.lastJobCount >= LARGE_BOARD_POSTINGS;
}

/** The gate a read of this source passes: 北森's two, the single slot of a large one-answer board, or none. */
export function readGateFor(source: Pick<CareerSourceRow, 'ats' | 'lastJobCount'>): <T>(fn: () => Promise<T>) => Promise<T> {
  if (isMainlandOnlyAts(source.ats)) return beisenGate;
  if (isLargeBoard(source)) return largeBoardGate;
  return ungated;
}

/**
 * Why a source is passed over without a request, or null when it may be read
 * (see the header). The denylist comes first: a takedown holds whatever the
 * connector flags say.
 */
export function passOverReason(source: Pick<CareerSourceRow, 'ats' | 'boardToken'>, env: EnvSource, writers: Partial<Record<Market, BrandId>>): string | null {
  if (tenantDenied(source, env)) return TENANT_DENIED;
  // A system we do not know is reported by the read itself ('unsupported_job_board').
  if (!isPublicAts(source.ats)) return null;
  if (!connectorEnabled(source.ats, env)) return CONNECTOR_DISABLED;
  // 北森 lists mainland postings only: where no brand writes them, a read could store nothing.
  if (isMainlandOnlyAts(source.ats) && !writers.cn) return CONNECTOR_DISABLED;
  return null;
}

/**
 * A 北森 tenant is about to be asked: the time is written to the source
 * BEFORE the request, so the 30-minute floor holds whatever happens to this
 * run afterwards (it is cut off, runs out of time before the write, or dies).
 * The row in hand keeps the earlier time: the stamp after the read still
 * needs it (schedule.ts `transientAttempt`). Other systems: nothing.
 */
export async function stampTenantAsked(db: IngestDb, source: Pick<CareerSourceRow, 'id' | 'ats'>, at: Date): Promise<void> {
  if (!isMainlandOnlyAts(source.ats)) return;
  await db.rACareerSiteSource.update({ where: { id: source.id }, data: { lastSyncedAt: at } });
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

/**
 * The takedown path (see the header): archives the open public postings of
 * every tenant on CN_ATS_TENANT_DENYLIST, in every market, and returns how
 * many per market. Found by the rows themselves (the tenant boards' system
 * and the `<tenant>:` prefix of their externalId), so the state of the
 * tenant's source row plays no part. One query when nothing is open, which is
 * every run but the first after a tenant was listed.
 */
export async function archiveDeniedTenants(db: IngestDb, env: EnvSource, now: Date): Promise<Record<Market, number>> {
  const archived: Record<Market, number> = { intl: 0, cn: 0 };
  const tenants = tenantDenylist(env);
  if (tenants.length === 0) return archived;
  const open = await db.rAJob.findMany({
    where: { sourceBoard: { in: [...MAINLAND_ONLY_ATS] }, OR: tenants.map((tenant) => ({ externalId: { startsWith: externalIdPrefix(tenant) } })), archivedAt: null, visibility: 'public' },
    select: { id: true, market: true },
    take: TAKEDOWN_ROWS_PER_RUN,
  });
  for (const market of MARKETS) {
    const ids = open.filter((row) => (row.market === 'cn' ? 'cn' : 'intl') === market).map((row) => row.id);
    for (let i = 0; i < ids.length; i += 1000) {
      const res = await db.rAJob.updateMany({ where: { id: { in: ids.slice(i, i + 1000) }, archivedAt: null }, data: { archivedAt: now, closedAt: now, closeReason: 'source_removed' } });
      archived[market] += res.count;
    }
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
  /** The brand that writes each market here (`writingBrands`). Default: derived from `brands`. */
  writers?: Partial<Record<Market, BrandId>>;
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
 * job-board system we cannot read (an unknown system, or one whose connector
 * is switched off) is left untouched, and so is one whose tenant is on the
 * denylist. A 北森 candidate passes the same two-tenant gate as a full read
 * and the same 30-minute floor: before its check is sent, the time of its
 * next possible request is written to the row (so a check that is cut off, or
 * a run that dies, still leaves it), and one that is switched on carries the
 * time of the check as its last request, so its first read is 30 minutes
 * later whoever asks for it.
 */
export async function validateCandidates(db: IngestDb, limit: number, deps: ValidateDeps = {}): Promise<ValidationTally> {
  const tally: ValidationTally = { checked: 0, enabled: 0, outcomes: {}, calls: 0 };
  if (limit <= 0) return tally;
  const clock = () => (deps.now ? deps.now() : new Date());
  const env = deps.env ?? process.env;
  const writers = deps.writers ?? writingBrands(deps.brands ?? [], env);
  const rows = await db.rACareerSiteSource.findMany({
    where: {
      enabled: false,
      origin: { in: ['discovered', 'import'] },
      lastSyncedAt: null,
      disabledAt: null,
      // Only systems whose connector is switched on: the others wait, untouched.
      ats: { in: enabledAts(env) },
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
    // Not ours to read right now (the denylist; 北森 where no mainland posting is written): left as it is.
    if (!board || passOverReason(source, env, writers)) return;
    tally.checked += 1;
    let now = clock();
    let outcome: string;
    let stated: string | null = null;
    const tenantBoard = isMainlandOnlyAts(source.ats);
    try {
      const market = signingMarket(source, deps.brands ?? []);
      const read = await readGateFor(source)(async () => {
        if (tenantBoard) {
          // Asked from here on: not again for 30 minutes, whatever becomes of this check (see the header).
          now = clock();
          await db.rACareerSiteSource.update({ where: { id: source.id }, data: { nextSyncAt: new Date(now.getTime() + BEISEN_TENANT_FLOOR_MS) } });
        }
        return connectorFor(board.ats, env).read(board, { now, fetch: deps.fetch, signal: deps.signal, env, market }, { listOnly: true, firstPage: true, boardCompany: true });
      });
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
      // Due at once; a 北森 tenant only once 30 minutes have passed since this check asked it. The check is
      // its last request, so the time is kept where the lease and "Check now" read it.
      const floor = tenantBoard ? { nextSyncAt: new Date(now.getTime() + BEISEN_TENANT_FLOOR_MS), lastSyncedAt: now } : { nextSyncAt: null };
      await db.rACareerSiteSource.update({
        where: { id: source.id },
        data: { enabled: true, ...floor, lastError: null, failCount: 0, ...(takeStated ? { companyName: stated!.slice(0, 200) } : {}) },
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
  /** The source was passed over (no request): its connector is off or its tenant is on the denylist. */
  passedOver: boolean;
  /** Rows marked as seen without a rewrite. */
  seen: number;
}

const MARKETS = ['intl', 'cn'] as const;

/**
 * One leased board of a round. `settled`: the board was already dealt with
 * inside its own slot (a large one-answer board), and `written` is what its
 * write did, or null when the run was out of time before it. Not settled: the
 * loop writes it after the round.
 */
type RoundEntry = { outcome: BoardReadOutcome; settled: false } | { outcome: BoardReadOutcome; settled: true; written: BoardWrite | null };

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

/**
 * The statement that marks rows as seen (exported for the test): `lastSeenAt`
 * only, by the database's clock like the upsert's own. Open public rows of one
 * board, named by externalId.
 */
export function buildMarkSeenSql(sourceBoard: string, externalIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" SET "lastSeenAt" = now()
    WHERE "sourceBoard" = ${sourceBoard} AND "externalId" = ANY(${[...externalIds]}::text[]) AND "archivedAt" IS NULL AND "visibility" = 'public'`;
}

/** Marks the board's rows as seen, 1,000 at a time; returns how many rows the statements changed. */
export async function markBoardRowsSeen(db: IngestDb, sourceBoard: string, externalIds: readonly string[]): Promise<number> {
  let count = 0;
  for (let i = 0; i < externalIds.length; i += 1000) {
    const n = await db.$executeRaw(buildMarkSeenSql(sourceBoard, externalIds.slice(i, i + 1000)));
    count += typeof n === 'number' ? n : 0;
  }
  return count;
}

/** Writes one board's read: its postings per market, its closures and the stamp on the source. */
export async function writeBoard(ctx: WriteContext, outcome: BoardReadOutcome): Promise<BoardWrite> {
  const { db, now } = ctx;
  const source = outcome.source;
  const result: BoardWrite = { processed: {}, closed: 0, closedByMarket: { intl: 0, cn: 0 }, dropped: { intl: 0, cn: 0 }, disabled: false, passedOver: false, seen: 0 };
  if (isSkippedBoardError(outcome.error)) {
    // Passed over: no request was made, so this is neither a read nor a failure (schedule.ts `skippedStamp`).
    // A denylisted tenant's postings were archived before anything was leased (`archiveDeniedTenants`).
    result.passedOver = true;
    await db.rACareerSiteSource.update({ where: { id: source.id }, data: skippedStamp(now, outcome.error!) });
    return result;
  }
  if (!outcome.read || !outcome.routed) {
    const stamp = withTenantFloor(source, failureStamp(source, { now, error: outcome.error ?? 'unexpected' }), now);
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
  // A board that had nothing to read handed on no posting: the rows of the postings it still lists are marked
  // as seen, so "Last checked" and the feed's freshness keep moving although nothing was downloaded or rewritten.
  if (outcome.seenExternalIds?.length) result.seen = await markBoardRowsSeen(db, source.ats, outcome.seenExternalIds);
  const inserted = MARKETS.reduce((n, m) => n + (result.processed[m]?.inserted ?? 0), 0);
  // A board's FIRST successful read inserts every posting it lists. That is the load, not news about the board:
  // counted as a change it put every newly seeded board on the 2-hour interval for 48 hours (512 boards and about
  // 48,500 postings downloaded and rewritten in full every pass; M4 cross-review). A new board is still read at
  // once; after that it is read every 24 hours until a posting really opens or closes (strategy 1.2: "diff ids to
  // open and close"). `lastJobCount` is written by a successful read only, so it is null exactly until the first one
  // (a board whose first attempts failed in passing has a `lastSyncedAt` and still no successful read).
  const firstRead = source.lastJobCount === null;
  const stamp = withTenantFloor(
    source,
    successStamp(source, {
      now,
      listed: outcome.read.listing.length,
      changed: (inserted > 0 && !firstRead) || result.closed > 0,
      pendingDetails: outcome.read.pendingDetails,
      failedDetails: outcome.read.failedDetails,
      readDetails: outcome.read.inputs.length,
    }),
    now,
  );
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
  //    The seed files offered are those of the markets of the brands THIS run serves (`brands`), the same
  //    reading as the rest of the run.
  try {
    const seedMarkets = [...new Set(brands.map((id) => getBrand(id).market))];
    const seed = await (deps.loadSeeds ?? ((store: IngestDb) => loadCareerSeeds(store, { markets: seedMarkets, env })))(db);
    tally.seedBoardsAdded = seed?.added ?? 0;
  } catch (err) {
    logger.warn(TAG, 'seed boards not loaded', { error: err instanceof Error ? err.message.slice(0, 160) : 'error' });
  }

  // 2. Postings of sources switched off 48 hours ago, and of tenants on the denylist (the takedown path: every
  //    run, whatever state the tenant's source is in and whether or not anything is read below).
  tally.archivedDisabled = await archiveDisabledSources(db, clock());
  const takenDown = await archiveDeniedTenants(db, env, clock());
  tally.takenDown = takenDown.intl + takenDown.cn;
  for (const m of MARKETS) status[m].closed += takenDown[m];

  // No brand of this deployment writes board postings (the mainland stack with CN_RECRUITMENT_INFO_MODE=off, or
  // every brand narrowed by JOB_PROVIDERS_<BRAND> to a list without `ats_public`): nothing a read returned could
  // be stored, so nothing is read. No board is leased, no candidate is checked and no request is made; before this
  // every due board was downloaded once a day and its postings dropped (the 512 seeded boards are about 48,500
  // postings and half a gigabyte a pass). The seed load and the two archive steps above still ran.
  if (markets.length === 0) return tally;

  // Every read stops when the run's time is nearly used up (a real timer: reads are real waits).
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.max(0, budget.remainingMs() - BOARD_SYNC_RESERVE_MS));
  try {
    // 3. Candidates.
    if (!budget.exhausted(BOARD_SYNC_RESERVE_MS)) {
      const checked = await validateCandidates(db, discoveryValidationsPerRun(env), { now: clock, env, fetch: deps.fetch, signal: stop.signal, brands, writers });
      tally.candidatesChecked = checked.checked;
      tally.candidatesEnabled = checked.enabled;
      tally.calls += checked.calls;
    }

    // 4. The loop.
    const done: string[] = [];
    const detailsBudget = smartRecruitersDetailsPerRun(env);
    const write: WriteContext = { db, now: clock(), writers, enqueueMany: deps.enqueueMany, process: deps.process ?? processJobs };
    // Out of time before a board's write: it is not stamped (see `unwritten` below).
    const outOfTime = (outcome: BoardReadOutcome): boolean => budget.exhausted(BOARD_SYNC_RESERVE_MS / 2) || (stop.signal.aborted && !outcome.read);
    /** What one board's read and write add to the run's counters and to the status of each market. */
    const count = (outcome: BoardReadOutcome, written: BoardWrite): void => {
      if (written.passedOver) {
        // Not a read: counted apart, and never as a failed board.
        tally.passedOver += 1;
        return;
      }
      tally.boards += 1;
      tally.calls += outcome.calls;
      tally.droppedByConnector += outcome.read?.droppedPostings ?? 0;
      if (outcome.error) tally.boardErrors += 1;
      if (written.disabled) tally.disabled += 1;
      tally.closed += written.closed;
      tally.seenUnchanged += written.seen;
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
        // Copies left out because their country is not one the board is read for (shown once ingest/status.ts lists the reason).
        note(m, 'country_not_selected', outcome.routed?.countryNotSelectedByMarket[m] ?? 0);
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
    };
    for (;;) {
      if (budget.exhausted(BOARD_SYNC_RESERVE_MS)) {
        tally.stoppedBy = 'budget';
        break;
      }
      const leased = await leaseDueBoards(db, concurrency * 2, done, { tenantFloor: beisenEnabled(env) });
      if (leased.length === 0) break;
      for (const s of leased) done.push(s.id);
      const round = await mapLimit(leased, concurrency, async (source): Promise<RoundEntry> => {
        // Passed over without a request: the denylist, or a connector that is switched off (see the header).
        const reason = passOverReason(source, env, writers);
        if (reason) return { outcome: { source, read: null, routed: null, closedExternalIds: [], calls: 0, error: reason }, settled: false };
        const read = async (): Promise<BoardReadOutcome> => {
          try {
            // A 北森 tenant: the time it is asked is on the row before the request leaves (the 30-minute floor).
            if (!stop.signal.aborted) await stampTenantAsked(db, source, clock());
          } catch (err) {
            // The time could not be written, so the tenant is not asked: the floor could not be kept otherwise.
            return { source, read: null, routed: null, closedExternalIds: [], calls: 0, error: boardErrorText(err) };
          }
          return readBoard(db, source, { now: clock(), fetch: deps.fetch, signal: stop.signal, env, market: signingMarket(source, brands) }, { markets, detailsBudget });
        };
        if (!isLargeBoard(source)) return { outcome: await readGateFor(source)(read), settled: false };
        // A board whose one answer may be large is read AND written inside its single slot, and its answer is let
        // go before the next one is asked for: a run never holds two such answers (see the header).
        return largeBoardGate(async (): Promise<RoundEntry> => {
          const outcome = await read();
          // A write that fails (the database) fails the run, as it does after the round: the reads still waiting are cut off.
          const written = outOfTime(outcome)
            ? null
            : await writeBoard({ ...write, now: clock() }, outcome).catch((err: unknown) => {
                stop.abort();
                throw err;
              });
          if (outcome.read) Object.assign(outcome.read, { inputs: [], listing: [] });
          if (outcome.routed) outcome.routed.byMarket = { intl: [], cn: [] };
          return { outcome, settled: true, written };
        });
      });
      const unwritten: string[] = [];
      for (const entry of round) {
        const { outcome } = entry;
        // A board of the round's small ones is written here, one at a time; a large one was written in its slot.
        const written = entry.settled ? entry.written : outOfTime(outcome) ? null : await writeBoard({ ...write, now: clock() }, outcome);
        if (written) count(outcome, written);
        else unwritten.push(outcome.source.id);
      }
      if (unwritten.length > 0) {
        // Not stamped: free the lease, so the next run takes these boards first. Never a 北森 tenant: it may
        // have been asked, so it keeps its 30-minute lease and the time written before its request.
        const free = unwritten.filter((id) => !isMainlandOnlyAts(leased.find((s) => s.id === id)?.ats));
        if (free.length > 0) await db.rACareerSiteSource.updateMany({ where: { id: { in: free } }, data: { nextSyncAt: clock() } });
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
  const work = result.boards + result.candidatesChecked + result.seedBoardsAdded + result.archivedDisabled + result.takenDown;
  if (work === 0) return { skipped: 'no_work' };
  return { processed: result.boards, ...result };
}
