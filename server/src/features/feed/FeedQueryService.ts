// server/src/features/feed/FeedQueryService.ts — the feed (WP-32; ARCH §4.8, §4.9, §3.4).
//
//   query        retrieval (see below) → the fits of the window (match `getFits`: the stored AI
//                score, else the quick estimate; never a model call) → rank → fit-tier view →
//                same-role collapse → company scatter → RAFeedSession (30 min) → page 1;
//                later pages slice the session and refill it from the next older window
//   counts       For you / Saved / Added by you / Applied
//   countForFilters / limitingFilters   "Show N jobs" and "What's limiting your results"
//   hide / unhide / report / impressions / rating / explore / nlQuery / newCount / skillsCheck
//   preview / publicList                Assistant tools (WP-50) and the visitor list (WP-78)
//   sampleForFilters / alertCandidates  job ids for a filter set with the feed's own filter
//                                       semantics, no ranking and no session (WP-77, WP-39a)
//
// Browse: `query` with `overrides.taxonomyIds` and no `searchProfileId` lists a
// category the way the Explore tile counts it — market and visibility rules
// only, public rows, none of the user's saved filters.
//
// GoApply recruitment-info mode (on by default, D5; `off` is the kill switch):
// the routes are gated as a whole by the `jobs.feed` capability. The seams
// other areas call (counts, limiting filters, preview, public list, samples,
// alert candidates) check the mode themselves, so with
// CN_RECRUITMENT_INFO_MODE=off they return nothing.
//
// Source contract (GOAPPLY_PARITY_PLAN §5): every item names its source and
// carries its own apply link (items.ts, sourceLine.ts); on GoApply the query
// response carries `sources { gohire, employerBoards }` for the header, counted
// from the rows the query can reach (`sourcesSql`), and `thin` when the whole
// list (not only the windows read so far) holds fewer than FEED_THIN_BELOW
// results. A public mainland row with no
// usable apply link is never listed (sql.ts `scopePredicates`).
//
// Retrieval (MKT-4F; MARKET_STRATEGY 2.1 point 3). For Recommended and Best
// fit the first window is three legs under the same scope and filter
// predicates, 200 rows each, run together and fused by reciprocal rank
// (k = 60), the union capped at 400:
//   A recency   today's window (14 days, widened to 45 under 60 rows)
//   B lexical   the search document against a query text, best rank first
//   C dense     the job vectors nearest to a vector, exact distance
// The query text of B and C: what the user wrote, the typed `q` and
// `relevance` together (`relevance` is the residual of a natural-language
// search: it only ORDERS, it is never a predicate; `q` alone filters, and it
// filters all three legs, so the list holds what the count counts); with
// neither, for a personalised list, B takes the titles of the person's recent
// roles and their top skills and C the person's own vector (resume, else
// intent). A leg that cannot run (no search document yet, no embedding key, a
// timeout, a failing statement) is left out and the others answer: never an
// error. Ranking is unchanged; the fused position only breaks ties. Later
// windows are recency-keyed below leg A's boundary, and skip what the first
// window already judged (its cards, the postings folded into them and the
// rows its fit-tier view hid). `FEED_HYBRID=off` returns to leg A alone.
// Newest, Deadline, Highest pay, browse lists, counts, samples and alert
// candidates keep their single statement: a list the person asked for by date
// is in date order from its first row to its last, and legs B and C could only
// add rows out of that order.
//
// "New" (JI-10; items.ts): a card is new when we first read its posting after
// the viewer's previous visit to the list. That visit is the stored stamp
// (`RAUserUiState.lastFeedVisitAt`, the instant the new-count badge counts
// from) as it was BEFORE this request stamps it, and it travels in the cursor,
// so every page of one list uses the same instant. A stamp younger than a feed
// session (30 minutes) is this sitting's own (a refresh, another sort): it is
// not a previous visit, and the 48-hour rule applies, as it does for a person
// who never opened the list and for every list without a session (preview,
// the visitor list).
//
// GoApply: with 个性化推荐 off or not yet chosen the list is ordered by date
// posted and filters only, and no fit is used or shown (PIPL Art. 24; the mode
// and the `jobs.feed` capability are enforced on the routes). Such a list
// never reads a profile or a user vector and never asks for a query vector:
// asked for in the default order with a query text it is legs A and B in
// their fused order (`order` 'query_match'); with none, or asked for by date,
// it is one statement by date. A query vector is asked for
// only when `aiAllowed(userId)` holds, so without the AI consent no embedding
// call is made (invariant I8); a GoApply user vector is read only with both
// consents. The NL query is the only chat-model call here; it goes through
// `aiAllowed()` and the per-brand LLM layer.

import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId, Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import type { ExplainMatchInput } from '../compliance/index.js';
import type { MatchExplanation } from '../compliance/contract.js';
import type { MarketHookContext, MarketHookJob } from '../jobs/marketHooks.js';
import { taxonomyCategories, taxonomyLabel } from '../jobs/taxonomy/index.js';
import { applyMap, isByFilters, skillKey, type Fit, type FitFunctions, type MatchDimension, type MatchService, type MatchUser } from '../match/index.js';
import { toTsQuery, vectorLiteral } from '../retrieval/index.js';
import {
  FILTER_FIELDS,
  coerceFilterSet,
  mergeFilterSet,
  normalizeFilterSet,
  parseFilterSet,
  searchErrorToHttpError,
  stableStringify,
  type FilterSet,
  type SearchProfileService,
  type SearchProfileWire,
} from '../search/index.js';
import { AFFINITY_DELTAS, EMPTY_AFFINITY, affinityKeys, applyAffinity, decayed, type AffinityEvent, type AffinityJob, type AffinityState } from './affinity.js';
import {
  FEED_ERROR_CODES,
  FEED_LIMITS,
  FEED_RELEVANCE_MAX_CHARS,
  FEED_THIN_BELOW,
  type ExploreResponse,
  type FeedCountResult,
  type FeedCountsResponse,
  type FeedItem,
  type FeedOrder,
  type FeedQueryResponse,
  type FeedSort,
  type FeedSources,
  type FilterDiffProposal,
  type HideJobResponse,
  type LimitingFilter,
  type NewCountResponse,
  type NlQueryResponse,
  type PublicFeedItem,
  type REPORT_REASONS,
  type HIDE_REASONS,
  type RATING_REASONS,
  type SkillsCheckResponse,
} from './contract.js';
import { hideProposal, planToFilters, relaxations, toDiff, type PlannerPlan } from './filterDiff.js';
import { denseLegSql, lexicalLegSql, profileQueryText, recencyLegSql } from './hybridSql.js';
import { needsSponsorshipFor, publicItem, toFeedItem } from './items.js';
import {
  collapseSameRole,
  companyKeyOf,
  fitBadge,
  fuseByReciprocalRank,
  mentionsSponsorship,
  passesTier,
  placeKey,
  placeOf,
  rankFitOf,
  recommendedRank,
  sameRoleKey,
  scatterByCompany,
  sortCandidates,
  sponsorshipFirst,
  type Candidate,
  type RankContext,
  type SameRoleGroup,
} from './ranking.js';
import { ALSO_IN_MAX, SEEN_SKIPPED } from './rankingText.js';
import type { FeedRepo, FeedSessionRecord } from './repo.js';
import {
  browseTaxonomySql,
  cardExtrasSql,
  cnDate,
  countSql,
  exploreCountsSql,
  filterPredicates,
  jobIdsSql,
  retrievalSql,
  rowsByIdSql,
  sourcesSql,
  type SqlScope,
} from './sql.js';
import { heldBankBoards } from './sourceLine.js';
import { requiredSkills, toMatchRecord, type FeedCtx, type FeedJobRow } from './types.js';
import { normalizeCompanyName, normalizeSkills } from '../jobs/normalize/index.js';

const DAY_MS = 86_400_000;
const L = FEED_LIMITS;

/** How long a request waits for the vector of a query text before it runs without the dense leg (FEED_QUERY_EMBED_TIMEOUT_MS). */
export const FEED_QUERY_EMBED_TIMEOUT_MS = 800;
/** How long the vector of one query text is reused in this process. */
export const QUERY_VECTOR_TTL_MS = 10 * 60_000;
const QUERY_VECTOR_CACHE_MAX = 500;
export { ALSO_IN_MAX };
/** How long one "this saved search came back thin" ingest request is remembered per (profile id, version). */
export const INGEST_REQUEST_TTL_MS = 6 * 3_600_000;

/** Report reasons that count toward closing a job (3 distinct users → closedAt, closeReason 'reported'). */
export const REPORT_CLOSE_REASONS = ['scam', 'expired', 'training_loan', 'pay_to_work', 'fee_required'] as const;
/** Hide reasons that say nothing specific: the affinity −0.1 of "hide with no reason". */
const UNSPECIFIC_HIDE: ReadonlySet<string> = new Set(['not_interested', 'other']);

export interface FeedServiceDeps {
  repo: FeedRepo;
  /**
   * The fits of a window come from `getFits` (match/fit.ts): the same fit job
   * detail, alerts and the Assistant read, never a model call.
   * `calibrationMap` is the market's estimate-to-AI map for the ranking input
   * (absent or null: the blend of ranking.ts `fitForRank`).
   */
  match: Pick<MatchService, 'userContext' | 'config'> & { getFits: FitFunctions['getFits'] } & Partial<Pick<MatchService, 'calibrationMap'>>;
  search: Pick<SearchProfileService, 'getActive' | 'get'> & Partial<Pick<SearchProfileService, 'findById'>>;
  /** RoboApply: always; GoApply: a live `personalized_recommendation` grant (fails closed). */
  personalized: (userId: string, market: Market) => Promise<boolean>;
  /** Feed refresh without a cursor: 20 per 10 min per user. */
  consumeRefresh: (userId: string) => Promise<{ allowed: boolean; retryAfterSec: number }>;
  aiAllowed: (userId: string) => Promise<boolean>;
  /** How long a new-count result is reused for the same user, visit and profile (default 2 min). */
  newCountTtlMs?: number;
  /** The job-search planner (job-search/agent.ts) → validated plan. */
  planner: (text: string, ctx: { userId: string; locale: string }) => Promise<PlannerPlan>;
  now?: () => Date;
  exploreTtlMs?: number;
  /**
   * May this market's third-party postings be shown? Default: always outside
   * `cn`; on `cn` unless CN_RECRUITMENT_INFO_MODE is `off` (on by default, D5).
   */
  postingsAllowed?: (market: Market) => boolean;
  env?: EnvSource;
  /** `marketHooks.cardMeta` (CN / TW card lines). Absent → items carry no `cardMeta`. May load its hooks on first use. */
  cardMeta?: (job: MarketHookJob, ctx: MarketHookContext) => Record<string, Record<string, unknown>> | Promise<Record<string, Record<string, unknown>>>;
  /** `explainMatch` (PIPL Art. 24 "Why this job"). Absent → items carry no `explanation`. */
  explain?: (input: ExplainMatchInput) => MatchExplanation;
  /**
   * The embeddings client (platform/embeddings `embedTexts`), asked for the
   * vector of a typed query or of the text to rank by. Absent, unavailable or
   * too slow → that list runs without the dense leg. Never asked without
   * `aiAllowed(userId)`, and never for a list that is not personalised.
   */
  embeddings?: FeedEmbeddings;
  /**
   * The stored vectors (features/retrieval): the model tag a market's vector
   * comparisons use and the person's own vector. Absent → a list with no
   * query text runs without the dense leg.
   */
  retrieval?: FeedRetrieval;
  /**
   * Queue one targeted ingest for a saved search whose first window came back
   * thin (jobs/ingest `ingestForProfile`, in the background). Called at most
   * once per (profile id, version) in 6 hours; a failure never fails the feed.
   * Absent → nothing is queued.
   */
  requestIngest?: (searchProfileId: string) => Promise<unknown> | unknown;
}

/** `embedTexts` as the feed calls it: one query text, `purpose: 'query'`; `{ unavailable }` means "no vector now". */
export interface FeedEmbeddings {
  embedTexts(
    brand: BrandId,
    texts: readonly string[],
    options: { purpose: 'query'; carriesUserData: boolean; userId?: string | null },
  ): Promise<{ vectors: number[][]; model: string } | { unavailable: string }>;
}

export interface FeedRetrieval {
  /** The model tag vector comparisons of the market filter on; null when it has none. */
  currentModelTag(market: string): Promise<string | null>;
  /** The person's resume vector, else intent vector, else null; of `modelTag` only. */
  userVector(userId: string, market: string, modelTag: string): Promise<number[] | null>;
  /**
   * The tag a new query vector of this brand will carry, or null when the
   * brand has no embedding key (then no call is made). Optional: without it
   * the call is made and its own answer says so.
   */
  queryModelTag?(brandId: string): string | null;
}

export interface FeedQueryInput {
  searchProfileId?: string;
  sort: FeedSort;
  q?: string;
  overrides?: Record<string, unknown>;
  cursor?: string;
  fitTier?: 'all' | 'good' | 'great';
  /**
   * Free text the list may be ordered by (never a filter): part of the query
   * text of the lexical and dense legs, beside a typed `q` when there is one.
   * Part of the session hash.
   */
  relevance?: string;
  /**
   * The UI language of the request, when the caller knows it: the skill labels
   * of a card's fit ("what lines up", "what is missing") are written in it
   * (match `GetFitsOptions.locale`). Absent: the posting's language, else the
   * market's. Never part of the session hash: it changes no row and no order.
   */
  locale?: string;
}

/** The input of `preview` (the Assistant's tools, precompute, the job-search index read). */
export interface FeedPreviewInput {
  q?: string;
  filters?: Partial<FilterSet>;
  sort?: FeedSort;
  limit: number;
  /** As `FeedQueryInput.relevance`. */
  relevance?: string;
  /** As `FeedQueryInput.locale`. */
  locale?: string;
}

/** `relevance` as the service keeps it: trimmed, empty → null. Longer than the contract allows is refused, never cut. */
function relevanceOf(value: string | undefined | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > FEED_RELEVANCE_MAX_CHARS) {
    throw new HttpError('invalid_request', `The text to rank by is too long (at most ${FEED_RELEVANCE_MAX_CHARS} characters).`, { reason: 'relevance_too_long' });
  }
  return text;
}

/** Options of the unranked id seams. */
export interface SampleOptions {
  /** The only order: newest first (no ranking, no fit). */
  order?: 'newest';
  /** At most 400 (FEED_LIMITS.retrievalLimit). */
  limit: number;
  /** Public rows only (never the user's own imported jobs). Default true. */
  publicOnly?: boolean;
}

export interface AlertCandidateOptions {
  /** Jobs first seen after this moment. */
  since: Date;
  limit: number;
  /** Also require `postedAt` on or after this (instant alerts skip old postings we only just found). */
  postedSince?: Date | null;
  /**
   * `sourceBoard` values left out of the candidates: the caller cannot show
   * their rows (job alerts pass `CREDIT_LINE_BOARDS` until an alert carries
   * the open-data credit line). A count that links to the feed passes none.
   */
  excludeBoards?: readonly string[];
}

export interface AlertCandidates {
  /** Newest first by when we first saw the job; hidden jobs of the profile's owner are left out. */
  ids: string[];
  /** More than `limit` jobs matched: a count built from `ids` is a floor, not a total (D3). */
  truncated: boolean;
}

type HideReason = (typeof HIDE_REASONS)[number];
type ReportReason = (typeof REPORT_REASONS)[number];
type RatingReason = (typeof RATING_REASONS)[number];

interface ScoreEntry {
  badge: Candidate['badge'];
  /** The ranking input (ranking.ts `fitForRank`). */
  fit: number | null;
  /** The components and the skill split of the same fit the badge shows ("Why this job"). */
  dimensions?: MatchDimension[] | null;
  skills?: { aligned: string[]; missing: string[] } | null;
}

interface Scored {
  user: MatchUser | null;
  byId: Map<string, ScoreEntry>;
}

/** The id and version a browse session is hashed under (it reads no search profile). */
const BROWSE_PROFILE = { id: 'browse', version: 0 } as const;

interface Window {
  rows: FeedJobRow[];
  /** Keyset of the next older refill: `(postedAt, id) < (windowEndsAt, windowEndsId)`, or `postedAt < windowEndsAt` when the id is null. */
  windowEndsAt: Date;
  windowEndsId: string | null;
  /** Hybrid retrieval only: job id → 0-based position in the fused order (`rows` is in that order). */
  retrievalRank?: Map<string, number>;
  /**
   * Hybrid retrieval only: the request's `relevance` was part of the query text of a leg (lexical or dense)
   * that returned rows, so it took part in choosing and ordering this window.
   */
  relevanceApplied?: boolean;
}

type FeedMatchContext = Awaited<ReturnType<FeedServiceDeps['match']['userContext']>>;

/** What hybrid retrieval needs to know about the request besides its filters. */
interface HybridInput {
  personalized: boolean;
  /** The text to rank by, when the request carries one. */
  relevance: string | null;
  /** The person's side (match `userContext`), loaded at most once per request. Only asked for a personalised list. */
  context: () => Promise<FeedMatchContext>;
}

/** One entry of `RAFeedSession.ranks` (contract `FeedSessionRanksSchema`). */
interface SessionRank {
  jobId: string;
  fit: number | null;
  kind: 'pre' | 'ai';
  rank: number;
  /** Same-role collapse: the card's group. */
  g?: string;
  /** Same-role collapse: ids of the postings folded into this card. */
  also?: string[];
  /**
   * Not a card: a row of the hybrid first window that the fit-tier view hid and that lies at or below the
   * refill boundary. It is in `ranks` only (never in `jobIds`), so a later window does not read, judge and
   * count it a second time ("Hiding N weaker fits").
   */
  h?: true;
}

/**
 * What the user wrote, as the query text of the lexical and dense legs: the
 * typed query and the text to rank by, together. Never a profile. Only `q` is
 * ever a predicate (sql.ts `wideQPredicateSql`); the text to rank by only
 * orders.
 */
function typedText(filters: FilterSet, relevance: string | null): string | null {
  return [filters.q?.trim(), relevance].filter(Boolean).join(' ') || null;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 40);

/**
 * A cursor is `<sessionId>:<offset>`, with `:<since>` after it when the list
 * was opened with a known previous visit: that instant in base 36
 * milliseconds, so every page of the list judges "New" against the same
 * moment (the stored stamp moves when the first page is served). It decides a
 * badge on the reader's own list and nothing else.
 */
function parseCursor(cursor: string): { sessionId: string; offset: number; newSince: Date | null } {
  const m = cursor.match(/^([A-Za-z0-9_-]{1,64}):(\d{1,6})(?::([0-9a-z]{1,11}))?$/);
  if (!m) throw new HttpError('invalid_request', 'The cursor is not valid.', { where: 'body', issues: [{ path: ['cursor'], code: 'invalid', message: 'Invalid cursor' }] });
  const ms = m[3] ? Number.parseInt(m[3], 36) : Number.NaN;
  return { sessionId: m[1]!, offset: Number(m[2]), newSince: Number.isFinite(ms) && ms > 0 ? new Date(ms) : null };
}

function cursorOf(sessionId: string, offset: number, newSince: Date | null): string {
  return newSince ? `${sessionId}:${offset}:${newSince.getTime().toString(36)}` : `${sessionId}:${offset}`;
}

/**
 * The stored visit stamp as a PREVIOUS visit: null when there is none, when it
 * lies in the future, or when it is younger than a feed session (this
 * sitting's own stamp: a refresh or another sort is not a new visit).
 */
export function previousVisit(stamp: Date | null | undefined, now: Date): Date | null {
  if (!(stamp instanceof Date) || !Number.isFinite(stamp.getTime())) return null;
  const age = now.getTime() - stamp.getTime();
  return age >= L.sessionTtlMin * 60_000 ? stamp : null;
}

/**
 * `RAJob.sponsorshipSource` of a page's rows, for the provider-reading badge
 * (items.ts). The list projection (sql.ts FEED_COLUMNS) does not select the
 * column; `items` runs this only for the rows that could carry such a badge
 * and only until the projection carries the column itself.
 */
export function sponsorshipSourceSql(ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`SELECT j."id", j."sponsorshipSource" FROM "RAJob" j WHERE j."id" = ANY(${[...ids]}::text[])`;
}

function sessionExpired(): HttpError {
  return new HttpError('conflict', 'This list has changed. Load it again from the top.', { reason: FEED_ERROR_CODES.sessionExpired });
}

/**
 * The unmatched phrases of a natural-language search that are not already
 * named as a topic the list is ranked by: what stays plainly unchecked (a pay,
 * visa or schedule wish that became no filter). A phrase a ranking term was
 * taken from is not repeated.
 */
export function uncheckedPhrases(rankedBy: readonly string[], unmatched: readonly string[]): string[] {
  const fold = (t: string) => t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const terms = rankedBy.map(fold).filter(Boolean);
  return unmatched.filter((phrase) => {
    const p = fold(phrase);
    return !!p && !terms.some((t) => p.includes(t) || t.includes(p));
  });
}

export { profileQueryText } from './hybridSql.js';

export function createFeedQueryService(deps: FeedServiceDeps) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const exploreTtl = deps.exploreTtlMs ?? 10 * 60_000;
  const exploreCache = new Map<string, { at: number; counts: Map<string, number>; asOf: Date }>();
  const newCountTtl = deps.newCountTtlMs ?? 2 * 60_000;
  const newCountCache = new Map<string, { at: number; res: NewCountResponse }>();

  /** Third-party postings may be shown in this market (GoApply recruitment-info mode: on unless set to `off`). */
  function postingsAllowed(market: Market): boolean {
    if (deps.postingsAllowed) return deps.postingsAllowed(market);
    // The platform's one resolver of the mode (R-04); cn/jobs `cnJobCapabilities().postings` is this same test.
    return market !== 'cn' || cnRecruitmentInfoMode(deps.env ?? process.env) !== 'off';
  }

  /** GoApply: a live 个性化推荐 grant (fails closed); RoboApply: always. */
  function isPersonalized(userId: string, market: Market): Promise<boolean> {
    return deps.personalized(userId, market).catch(() => market !== 'cn');
  }

  // ── Profiles and filters ──────────────────────────────────────────────

  async function loadProfile(userId: string, id?: string): Promise<SearchProfileWire> {
    try {
      return id ? await deps.search.get(userId, id) : await deps.search.getActive(userId);
    } catch (err) {
      const mapped = searchErrorToHttpError(err);
      throw mapped ?? err;
    }
  }

  function effectiveFilters(market: Market, base: FilterSet, input: Pick<FeedQueryInput, 'overrides' | 'q' | 'fitTier'>): FilterSet {
    const merged: Record<string, unknown> = { ...base, ...(input.overrides ?? {}) };
    if (input.q !== undefined) merged.q = input.q || undefined;
    if (input.fitTier !== undefined) merged.fitTier = input.fitTier;
    const parsed = parseFilterSet(merged, { market });
    if (!parsed.ok) throw new HttpError('invalid_request', 'The filters are not valid.', { reason: 'invalid_filters', issues: parsed.issues });
    return normalizeFilterSet(parsed.value);
  }

  /** The recruiter banks with no posting page right now: their rows are held out of every statement (sourceLine.ts). */
  function heldBanks(): string[] {
    return heldBankBoards((deps.env ?? process.env) as Record<string, string | undefined>);
  }

  function scopeOf(ctx: Pick<FeedCtx, 'market' | 'userId' | 'now'>, browse = false): SqlScope {
    return { market: ctx.market, userId: ctx.userId, now: ctx.now, heldBanks: heldBanks(), ...(browse ? { publicOnly: true } : {}) };
  }

  /**
   * Browse = a category list from Explore: `overrides.taxonomyIds` with no
   * `searchProfileId`. It reads none of the user's saved filters.
   */
  function isBrowse(input: Pick<FeedQueryInput, 'searchProfileId' | 'overrides'>): boolean {
    const ids = input.overrides?.taxonomyIds;
    return !input.searchProfileId && Array.isArray(ids) && ids.length > 0;
  }

  // ── Retrieval ─────────────────────────────────────────────────────────

  /**
   * The list's age floor (120 days, or the search's "posted within"). It cuts
   * the rows whose only life is their posting date (aggregator rows, own
   * imports, 台灣就業通: sql.ts `AGE_FLOOR_BOARDS`); a row of any other source is
   * listed for as long as its source lists it (`ageFloorSql`). A "posted
   * within" filter stays a hard bound for every row (its own filter predicate).
   */
  function floorOf(filters: FilterSet, from: Date): Date {
    return new Date(from.getTime() - (filters.postedWithinDays ?? L.maxAgeDays) * DAY_MS);
  }

  /**
   * One window, newest first. A full window (LIMIT reached) ends at its last
   * row's (postedAt, id), so rows tied on that postedAt past the LIMIT come in
   * the next refill; a short window covered everything down to `from`, or,
   * for the window that runs to the end of the list (`ageFloor`, no `from`),
   * everything: it ends at the floor.
   */
  async function retrieve(
    ctx: FeedCtx,
    filters: FilterSet,
    range: { from: Date | null; to: Date | null; toId?: string | null; ageFloor?: Date | null; orderBy?: 'posted' | 'deadline' },
    browse = false,
  ): Promise<Window> {
    const rows = await repo.queryRows(
      retrievalSql({
        scope: scopeOf(ctx, browse),
        filters,
        // A browse matches the category the way the Explore tile counts it (browseTaxonomySql).
        fields: browse ? FILTER_FIELDS.filter((f) => f !== 'taxonomyIds' && f !== 'titles') : FILTER_FIELDS,
        extra: browse ? [browseTaxonomySql(filters.taxonomyIds ?? [])] : undefined,
        from: range.from,
        ageFloor: range.ageFloor ?? null,
        to: range.to,
        toId: range.toId ?? null,
        orderBy: range.orderBy,
        limit: L.retrievalLimit,
      }),
    );
    const last = rows.length >= L.retrievalLimit ? rows[rows.length - 1] : undefined;
    if (last?.postedAt) return { rows, windowEndsAt: last.postedAt, windowEndsId: last.id };
    return { rows, windowEndsAt: range.from ?? range.ageFloor ?? floorOf(filters, ctx.now), windowEndsId: null };
  }

  /**
   * Older rows remain: the session's boundary is above the age floor, or its
   * last window was full (a full window can end below the floor: board and
   * bank rows are listed at any age, and more of them may follow).
   */
  function olderRemain(s: Pick<FeedSessionRecord, 'windowEndsAt' | 'windowEndsId'>, floor: Date): boolean {
    return s.windowEndsAt.getTime() > floor.getTime() || !!s.windowEndsId;
  }

  // ── Hybrid retrieval ──────────────────────────────────────────────────

  /** `FEED_HYBRID=off` returns every list to the recency leg alone. */
  function hybridOn(): boolean {
    return (((deps.env ?? process.env) as Record<string, string | undefined>).FEED_HYBRID ?? '').trim().toLowerCase() !== 'off';
  }

  /**
   * How a list is built from the sort the request asked for.
   *   · `sort`: the sort applied. Recommended and Best fit need the person's
   *     profile; a list that is not personalised falls back to Newest.
   *   · `hybrid`: the first window is the fused legs. A personalised
   *     Recommended or Best fit list always; and a list that is `fused`.
   *   · `fused`: not personalised, the default order asked for, and a query
   *     text: legs A and B in their fused order (`order` 'query_match'; no
   *     profile, no vector, no fit).
   * An explicit Newest is one statement in date order, with or without a query
   * text: its rows must follow one another by date across every window, which
   * a union with the lexical and dense legs cannot keep (their rows may be
   * older than the recency window's last row). Deadline, Highest pay and
   * browse lists keep their single statement too.
   */
  function listPlan(requested: FeedSort, personalized: boolean, filters: FilterSet, relevance: string | null, browse: boolean): { sort: FeedSort; hybrid: boolean; fused: boolean } {
    const wantsRanked = requested === 'recommended' || requested === 'best_fit';
    const sort: FeedSort = personalized || !wantsRanked ? requested : 'newest';
    const legs = wantsRanked && !browse && hybridOn();
    const fused = legs && !personalized && !!typedText(filters, relevance);
    return { sort, hybrid: legs && (personalized || fused), fused };
  }

  function embedTimeoutMs(): number {
    const raw = Number(((deps.env ?? process.env) as Record<string, string | undefined>).FEED_QUERY_EMBED_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : FEED_QUERY_EMBED_TIMEOUT_MS;
  }

  const queryVectors = new Map<string, { at: number; pending: Promise<{ literal: string; modelTag: string } | null> }>();

  /**
   * The vector of a query text, for the dense leg: asked once per (brand,
   * text, model tag) in 10 minutes, and waited for at most
   * FEED_QUERY_EMBED_TIMEOUT_MS. No client, no key, a refusal, a failed call
   * or a slow one all answer null: the list then runs without the dense leg.
   * A call that outlives the wait still fills the cache for the next request.
   * The caller has checked `aiAllowed` and that the list is personalised.
   */
  async function queryVector(ctx: FeedCtx, text: string): Promise<{ literal: string; modelTag: string } | null> {
    const client = deps.embeddings;
    if (!client) return null;
    const expected = deps.retrieval?.queryModelTag ? deps.retrieval.queryModelTag(ctx.brandId) : undefined;
    // No embedding key for this brand: the dense leg is off, and nothing is asked.
    if (expected === null) return null;
    const key = createHash('sha1').update(`${ctx.brandId}\n${expected ?? ''}\n${text}`).digest('hex');
    const at = now().getTime();
    let entry = queryVectors.get(key);
    if (!entry || at - entry.at > QUERY_VECTOR_TTL_MS) {
      const pending = (async () => {
        try {
          const res = await client.embedTexts(ctx.brandId as BrandId, [text], { purpose: 'query', carriesUserData: true, userId: ctx.userId });
          if ('unavailable' in res) {
            logger.info('FEED', 'no query vector; the list runs without the dense leg', { reason: res.unavailable });
            return null;
          }
          const vector = res.vectors[0];
          return vector ? { literal: vectorLiteral(vector), modelTag: res.model } : null;
        } catch (err) {
          logger.info('FEED', 'the query vector could not be read; the list runs without the dense leg', { error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      })();
      entry = { at, pending };
      if (queryVectors.size >= QUERY_VECTOR_CACHE_MAX) queryVectors.clear();
      queryVectors.set(key, entry);
      // "No vector now" is not remembered: the next request asks again.
      const mine = entry;
      void pending.then((v) => {
        if (!v && queryVectors.get(key) === mine) queryVectors.delete(key);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        logger.info('FEED', 'the query vector took too long; the list runs without the dense leg', { waitedMs: embedTimeoutMs() });
        resolve(null);
      }, embedTimeoutMs());
    });
    try {
      return await Promise.race([entry.pending, waited]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The person's own vector as a literal with its model tag; null when there is none to use. */
  async function personVector(ctx: FeedCtx): Promise<{ literal: string; modelTag: string } | null> {
    if (!deps.retrieval) return null;
    try {
      const modelTag = await deps.retrieval.currentModelTag(ctx.market);
      if (!modelTag) return null;
      const vector = await deps.retrieval.userVector(ctx.userId, ctx.market, modelTag);
      return vector ? { literal: vectorLiteral(vector), modelTag } : null;
    } catch (err) {
      logger.info('FEED', 'the user vector could not be read; the list runs without the dense leg', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** Does any posting the list can hold carry one of the words to rank by? One row of the lexical leg, asked with those words alone. */
  async function relevanceMatches(leg: { scope: SqlScope; filters: FilterSet; limit: number }, floor: Date, relevance: string): Promise<boolean> {
    try {
      const tsQuery = toTsQuery(relevance);
      if (!tsQuery) return false;
      return (await repo.queryRows(lexicalLegSql({ ...leg, limit: 1, ageFloor: floor }, tsQuery))).length > 0;
    } catch (err) {
      // No claim from a read that failed.
      logger.warn('FEED', 'the ranking words could not be checked against the list; the order is not reported as ranked by them', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * The first window of a hybrid list: legs A, B and C run together, fused by
   * reciprocal rank and cut at 400 (see the header). `rows` is in the fused
   * order. The refill boundary is leg A's: its last row when the leg was full,
   * else its window start; when the cut dropped rows of leg A (always its
   * oldest ones, which no other leg returned), the boundary moves up to the
   * last row before the first dropped one, so a later window reads them again
   * and no row is lost.
   */
  async function retrieveHybrid(ctx: FeedCtx, filters: FilterSet, h: HybridInput): Promise<Window> {
    const scope = scopeOf(ctx);
    const floor = floorOf(filters, ctx.now);
    const typed = typedText(filters, h.relevance);
    const leg = { scope, filters, limit: L.legLimit };

    const legA = async (): Promise<{ rows: FeedJobRow[]; from: Date }> => {
      const run = (from: Date) => repo.queryRows(recencyLegSql({ ...leg, from }));
      if (filters.postedWithinDays) return { rows: await run(floor), from: floor };
      let from = new Date(ctx.now.getTime() - L.firstWindowDays * DAY_MS);
      let rows = await run(from);
      if (rows.length < L.widenBelowRows) {
        from = new Date(ctx.now.getTime() - L.widenWindowDays * DAY_MS);
        rows = await run(from);
      }
      return { rows, from };
    };

    const legB = async (): Promise<FeedJobRow[]> => {
      try {
        // What the user wrote; else, for a personalised list only, their recent titles and top skills.
        const text = typed ?? (h.personalized ? profileQueryText((await h.context()).user, ctx.market) : null);
        const tsQuery = toTsQuery(text);
        if (!tsQuery) return [];
        return await repo.queryRows(lexicalLegSql({ ...leg, ageFloor: floor }, tsQuery));
      } catch (err) {
        logger.warn('FEED', 'the lexical leg failed; the list is built without it', { error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    };

    const legC = async (): Promise<FeedJobRow[]> => {
      // No profile vector and no query vector for a list that is not personalised (GoApply without 个性化推荐).
      if (!h.personalized) return [];
      try {
        const aiOk = () => deps.aiAllowed(ctx.userId).catch(() => false);
        let vector: { literal: string; modelTag: string } | null = null;
        // A query text is embedded at request time: a model call, so only with the AI consent.
        if (typed) vector = (await aiOk()) ? await queryVector(ctx, typed) : null;
        // A stored vector is read, not computed; on GoApply it exists only under both consents, and is only read under both.
        else if (ctx.market !== 'cn' || (await aiOk())) vector = await personVector(ctx);
        if (!vector) return [];
        return await repo.queryRows(denseLegSql({ ...leg, ageFloor: floor }, vector.literal, vector.modelTag));
      } catch (err) {
        logger.warn('FEED', 'the dense leg failed; the list is built without it', { error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    };

    const [a, b, c] = await Promise.all([legA(), legB(), legC()]);
    const byId = new Map<string, FeedJobRow>();
    for (const r of [...a.rows, ...b, ...c]) if (!byId.has(r.id)) byId.set(r.id, r);
    const posted = (id: string) => byId.get(id)?.postedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const fused = fuseByReciprocalRank([a.rows.map((r) => r.id), b.map((r) => r.id), c.map((r) => r.id)], {
      k: L.rrfK,
      cap: L.retrievalLimit,
      newer: (x, y) => posted(y) - posted(x),
    });
    const kept = new Set(fused.map((f) => f.id));
    const rows = fused.map((f) => byId.get(f.id)!);
    const retrievalRank = new Map(fused.map((f, i) => [f.id, i]));

    // Did the text to rank by take part in the order? Only when a leg ordered by it and found something for it:
    //   - the dense leg orders by the vector of a text that holds the words, so its rows are enough;
    //   - the lexical leg's query is the OR of `q` and the words together. With no typed `q` its rows matched the
    //     words. With one, it returns rows for the q words alone, so the words are asked on their own (one row,
    //     the same predicates): a search whose topics no posting mentions must not be reported as ranked by them
    //     (the job-search API names `agent.rankedBy` from this; D3).
    let relevanceApplied = false;
    if (h.relevance) {
      if (c.length > 0) relevanceApplied = true;
      else if (b.length > 0) relevanceApplied = filters.q?.trim() ? await relevanceMatches(leg, floor, h.relevance) : true;
    }

    const firstDropped = a.rows.findIndex((r) => !kept.has(r.id));
    const boundary = firstDropped > 0 ? a.rows[firstDropped - 1] : firstDropped === -1 && a.rows.length >= L.legLimit ? a.rows[a.rows.length - 1] : undefined;
    if (boundary?.postedAt) return { rows, windowEndsAt: boundary.postedAt, windowEndsId: boundary.id, retrievalRank, relevanceApplied };
    return { rows, windowEndsAt: a.from, windowEndsId: null, retrievalRank, relevanceApplied };
  }

  /**
   * First window. Hybrid (`hybrid` given: `listPlan` said so): the fused legs.
   * Otherwise one statement: 14 days, widened to 45 under 60 rows; a
   * posted-within filter is one window; the deadline sort one window over the
   * whole list.
   */
  async function firstWindow(ctx: FeedCtx, filters: FilterSet, sort: FeedSort, browse = false, hybrid: HybridInput | null = null): Promise<Window> {
    if (hybrid) return retrieveHybrid(ctx, filters, hybrid);
    if (sort === 'deadline') {
      // One window over the whole list (the age floor cuts aggregator rows only): stated close dates first, then the rest newest first (no refill).
      const w = await retrieve(ctx, filters, { from: null, to: null, ageFloor: floorOf(filters, ctx.now), orderBy: 'deadline' }, browse);
      return { rows: w.rows, windowEndsAt: floorOf(filters, ctx.now), windowEndsId: null };
    }
    if (filters.postedWithinDays) return retrieve(ctx, filters, { from: floorOf(filters, ctx.now), to: null }, browse);
    let w = await retrieve(ctx, filters, { from: new Date(ctx.now.getTime() - L.firstWindowDays * DAY_MS), to: null }, browse);
    if (w.rows.length < L.widenBelowRows) w = await retrieve(ctx, filters, { from: new Date(ctx.now.getTime() - L.widenWindowDays * DAY_MS), to: null }, browse);
    return w;
  }

  // ── Scoring and ranking ───────────────────────────────────────────────

  /**
   * The fits of a window: one `getFits` call (the stored AI score where it can
   * be shown, else the quick estimate; never a model call). The badge, the
   * ranking input and the "Why this job" lines of a row all come from that one
   * fit. A failing read never drops a row: it is listed without a fit.
   *
   * The window's rows and the person's side are handed over, so `getFits`
   * reads neither again and loads no description: what it adds to a window is
   * the one stored-score query the feed always made.
   */
  async function score(ctx: FeedCtx, rows: FeedJobRow[], personalized: boolean, loaded?: () => Promise<FeedMatchContext>, locale?: string): Promise<Scored> {
    const byId = new Map<string, ScoreEntry>();
    if (!personalized) {
      for (const r of rows) byId.set(r.id, { badge: null, fit: null });
      return { user: null, byId };
    }
    // The person's side is read once per request: hybrid retrieval may have loaded it already.
    const context = loaded ? await loaded() : await deps.match.userContext(ctx.userId);
    let fits = new Map<string, Fit>();
    let mapFn: ((estimate: number) => number) | null = null;
    if (rows.length) {
      try {
        const [read, map] = await Promise.all([
          deps.match.getFits(ctx.userId, rows.map((r) => r.id), { context, rows: rows.map(toMatchRecord), ...(locale ? { locale } : {}) }),
          deps.match.calibrationMap ? deps.match.calibrationMap().catch(() => null) : null,
        ]);
        fits = read;
        if (map) mapFn = (estimate) => applyMap(map, estimate);
      } catch (err) {
        logger.warn('FEED', 'fits unavailable for a window; the rows are listed without a fit', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const r of rows) {
      const fit = fits.get(r.id) ?? null;
      byId.set(r.id, {
        badge: fitBadge(fit),
        fit: rankFitOf(fit, mapFn),
        dimensions: fit?.dimensions ?? null,
        skills: fit ? { aligned: fit.skills.aligned, missing: fit.skills.missing } : null,
      });
    }
    return { user: context.user, byId };
  }

  /** Chosen skills when skills is the only filter that narrows the SQL (ORDERING_RULES skills_boost). */
  function skillsBoostKeys(ctx: Pick<FeedCtx, 'market' | 'now'>, filters: FilterSet): Set<string> | null {
    if (!filters.skills?.length) return null;
    const others = filterPredicates(filters, { market: ctx.market, now: ctx.now }, FILTER_FIELDS.filter((f) => f !== 'skills'));
    return others.length ? null : new Set(normalizeSkills(filters.skills));
  }

  async function rankContext(ctx: FeedCtx, filters: FilterSet, personalized: boolean): Promise<RankContext> {
    const skillsBoost = skillsBoostKeys(ctx, filters);
    if (!personalized) return { now: ctx.now, affinity: EMPTY_AFFINITY, preferredCompanyKeys: new Set(), goal: { goal: null, filters }, skillsBoost };
    const [aff, goal] = await Promise.all([repo.getAffinity(ctx.userId).catch(() => null), repo.careerGoal(ctx.userId).catch(() => null)]);
    return {
      now: ctx.now,
      affinity: decayed(aff ?? EMPTY_AFFINITY, ctx.now),
      preferredCompanyKeys: new Set((filters.preferredCompanies ?? []).map((c) => normalizeCompanyName(c)).filter(Boolean)),
      goal: { goal, filters },
      skillsBoost,
    };
  }

  /** The person's side, read at most once however often it is asked for in one request. */
  function contextOnce(ctx: Pick<FeedCtx, 'userId'>): () => Promise<FeedMatchContext> {
    let pending: Promise<FeedMatchContext> | null = null;
    return () => (pending ??= deps.match.userContext(ctx.userId));
  }

  /**
   * Impressions of the jobs of a window the person was shown on three or more
   * visits and never opened (ORDERING_RULES `seen_skipped`; one impression per
   * job and feed session, repo `recordImpressions`). Read for the
   * Recommended order of a personalised list only; a failing read takes
   * nothing away.
   */
  async function seenSkippedOf(ctx: FeedCtx, rows: FeedJobRow[], sort: FeedSort, personalized: boolean): Promise<Map<string, number> | null> {
    if (!personalized || sort !== 'recommended' || !rows.length) return null;
    try {
      const states = await repo.impressionStates(ctx.userId, rows.map((r) => r.id));
      const out = new Map<string, number>();
      for (const [id, st] of states) if (!st.viewedAt && st.impressions >= SEEN_SKIPPED.fromImpressions) out.set(id, st.impressions);
      return out.size ? out : null;
    } catch (err) {
      logger.warn('FEED', 'impressions unavailable; the seen-and-skipped rule is not applied to this window', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  interface RankOptions {
    /** The tail of the list already shown (a refill continues the company scatter across the seam). */
    head?: Candidate[];
    /** Fused positions of a hybrid window. */
    retrievalRank?: Map<string, number> | null;
    /** Order by the fused position alone (a list that is not personalised and has a query text). */
    fused?: boolean;
    seenSkipped?: Map<string, number> | null;
    /** Same-role groups that already have a card the session has not sent yet (a refill folds into them). */
    taken?: Map<string, TakenGroup>;
  }

  /** A same-role group with a card (ranking.ts `SameRoleGroup`), and whether that card's posting mentions sponsorship. */
  type TakenGroup = SameRoleGroup & { sponsors?: boolean };

  /**
   * Rank rows for a sort; returns the cards (after the tier view and the
   * same-role collapse), the rows the view hid, and the postings folded into
   * each card. With "I need visa sponsorship" (RoboApply), jobs that mention
   * sponsorship lead the window under every sort; the collapse and the
   * company scatter run inside each group, so neither pulls a job ahead of
   * that rule, and a posting that mentions sponsorship is never folded into
   * one that does not: not inside a window, and not into a card an earlier
   * window made (`taken`).
   */
  function rankRows(rows: FeedJobRow[], scored: Scored, sort: FeedSort, rc: RankContext, filters: FilterSet, personalized: boolean, opts: RankOptions = {}) {
    const tiers = deps.match.config().tiers;
    const head = opts.head ?? [];
    const rankCtx: RankContext = opts.seenSkipped ? { ...rc, seenSkipped: opts.seenSkipped } : rc;
    const cands: Candidate[] = rows.map((row) => {
      const s = scored.byId.get(row.id) ?? { badge: null, fit: null };
      const retrievalRank = opts.retrievalRank?.get(row.id);
      return {
        row,
        badge: s.badge,
        fit: s.fit,
        rank: sort === 'recommended' ? recommendedRank(row, s.fit, rankCtx) : 0,
        ...(retrievalRank === undefined ? {} : { retrievalRank }),
      };
    });
    const view = personalized ? filters.fitTier : 'all';
    const kept: Candidate[] = [];
    const hiddenRows: FeedJobRow[] = [];
    for (const c of cands) {
      if (passesTier(c.badge, view, tiers)) kept.push(c);
      else hiddenRows.push(c.row);
    }
    const market = rowsMarket(rows);
    if (opts.fused) kept.sort((a, b) => (a.retrievalRank ?? Number.POSITIVE_INFINITY) - (b.retrievalRank ?? Number.POSITIVE_INFINITY));
    else sortCandidates(kept, sort, { currency: filters.salaryMin?.currency ?? (market === 'cn' ? 'CNY' : null), today: cnDate(rc.now) });
    const sponsorshipLeads = sponsorshipLeadsFor(market, filters);
    const { first, rest } = sponsorshipFirst(kept, sponsorshipLeads);
    const taken = opts.taken ?? new Map<string, TakenGroup>();
    const also = new Map<string, Candidate[]>();
    const collapse = (group: Candidate[], into: Map<string, TakenGroup>) => {
      const out = collapseSameRole(group, into, ALSO_IN_MAX);
      for (const [cardId, list] of out.also) also.set(cardId, [...(also.get(cardId) ?? []), ...list]);
      return out.cards;
    };
    // The leading group may only join cards that mention sponsorship themselves. A card an earlier window made
    // for a posting that does not is left out here; the card this group makes instead then stands for the role.
    const takenByFirst = sponsorshipLeads ? new Map([...taken].filter(([, g]) => g.sponsors !== false)) : taken;
    const firstCards = collapse(first, takenByFirst);
    if (takenByFirst !== taken) for (const [key, g] of takenByFirst) taken.set(key, g);
    const restCards = collapse(rest, taken);
    const scatter = sort === 'recommended' || sort === 'best_fit';
    const firstOrdered = scatter ? scatterByCompany(firstCards, companyKeyOf, { head }) : firstCards;
    const restOrdered = scatter ? scatterByCompany(restCards, companyKeyOf, { head: [...head, ...firstOrdered] }) : restCards;
    return { kept: [...firstOrdered, ...restOrdered], hidden: hiddenRows.length, hiddenRows, also };
  }

  /** "I need visa sponsorship" (RoboApply): jobs whose posting mentions sponsorship lead (ORDERING_RULES `sponsorship_first`). */
  function sponsorshipLeadsFor(market: string | null, filters: FilterSet): boolean {
    return market === 'intl' && filters.needsSponsorship === true;
  }

  function rowsMarket(rows: FeedJobRow[]): string | null {
    return rows[0]?.market ?? null;
  }

  /**
   * "Why this job" for one card (PIPL Art. 24). Not personalised (GoApply
   * without 个性化推荐): the recency explanation, no reasons (none at all when
   * the list is ordered by its query text instead of by date). Personalised: the
   * components and the skill split of the fit behind the badge (the AI's for
   * an AI score, the estimate's otherwise). No badge → no explanation.
   */
  function explanationFor(ctx: FeedCtx, c: CardCandidate, personalized: boolean, fused = false): MatchExplanation | undefined {
    if (!deps.explain) return undefined;
    const market = ctx.market === 'cn' ? 'cn' : 'intl';
    try {
      // A list in the fused order of its query is not "sorted by date": the card carries no line that says so
      // (the response's `order` 'query_match' tells the page how the list is ordered).
      if (!personalized) return fused ? undefined : deps.explain({ market, personalized: false });
      if (!c.badge || !c.dimensions) return undefined;
      // A logistics part met only through the person's own filters says nothing about the job: it is neither a reason nor a gap.
      const dimensions = c.dimensions.filter((d) => !isByFilters(d));
      // The badge's own tier: the headline never names another tier than the card.
      return deps.explain({ market, personalized: true, score: c.badge.score, tier: c.badge.tier, kind: c.badge.kind, dimensions, skills: c.skills ?? { aligned: [], missing: [] } });
    } catch (err) {
      logger.warn('FEED', 'explanation failed for a job', { jobId: c.row.id, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  /** `marketHooks.cardMeta` for the cards of one page (CN / TW lines); a card without market lines carries none. */
  async function cardMetaFor(ctx: Pick<FeedCtx, 'market' | 'brandId'>, rows: FeedJobRow[]): Promise<Map<string, Record<string, Record<string, unknown>>>> {
    const out = new Map<string, Record<string, Record<string, unknown>>>();
    if (!deps.cardMeta || !rows.length) return out;
    let extras = new Map<string, Record<string, unknown>>();
    try {
      extras = new Map((await repo.queryCardExtras(cardExtrasSql(rows.map((r) => r.id)))).map((e) => [e.id, e]));
    } catch (err) {
      logger.warn('FEED', 'card extras unavailable; market lines use the card fields only', { error: err instanceof Error ? err.message : String(err) });
    }
    const hookCtx: MarketHookContext = { brand: ctx.brandId as MarketHookContext['brand'], market: ctx.market, stage: 'card' };
    for (const row of rows) {
      const meta = await deps.cardMeta({ ...row, ...(extras.get(row.id) ?? {}), market: ctx.market } as MarketHookJob, hookCtx);
      if (meta && Object.keys(meta).length) out.set(row.id, meta);
    }
    return out;
  }

  type CardCandidate = Pick<Candidate, 'row' | 'badge'> & Pick<ScoreEntry, 'dimensions' | 'skills'>;

  /**
   * `FeedItem.alsoIn` of a card from the postings folded into it: one entry
   * per posting (each names a place of its own), by name and id. A card holds
   * at most ALSO_IN_MAX of them (the collapse stops there), so `count` is what
   * is listed; the cut below only guards a session written under another limit.
   */
  function alsoInOf(rows: FeedJobRow[]): NonNullable<FeedItem['alsoIn']> | undefined {
    const named = rows.map((row) => ({ id: row.id, place: placeOf(row) })).filter((x): x is { id: string; place: string } => !!x.place);
    if (!named.length) return undefined;
    const listed = named.slice(0, ALSO_IN_MAX);
    return { count: named.length, locations: listed.map((x) => x.place), jobIds: listed.map((x) => x.id) };
  }

  /** A list row once the page knows its `RAJob.sponsorshipSource` (the list projection does not select it yet). */
  type SourcedRow = FeedJobRow & { sponsorshipSource?: string | null };

  /**
   * The rows of a page with their `sponsorshipSource`, for the provider-reading
   * badge (items.ts `badgesFor`). One small read, and only for rows that could
   * carry that badge: an international row whose stored value is 'offered'
   * with no quote, shown to a person who needs sponsorship there. Rows that
   * already carry the column (once the list projection selects it) are never
   * read again. A failing read shows no such badge: nothing is guessed.
   */
  async function withSponsorshipSource(rows: FeedJobRow[], user: MatchUser | null): Promise<Map<string, SourcedRow>> {
    const out = new Map<string, SourcedRow>(rows.map((r) => [r.id, r]));
    const ask = rows.filter(
      (r) =>
        (r as SourcedRow).sponsorshipSource === undefined &&
        r.market === 'intl' &&
        r.sponsorship === 'offered' &&
        !r.sponsorshipEvidence?.trim() &&
        needsSponsorshipFor(user, r.locationCountry),
    );
    if (!ask.length) return out;
    try {
      const read = await repo.queryCardExtras(sponsorshipSourceSql(ask.map((r) => r.id)));
      for (const e of read) {
        const row = out.get(e.id);
        if (row && typeof e.sponsorshipSource === 'string') out.set(e.id, { ...row, sponsorshipSource: e.sponsorshipSource });
      }
    } catch (err) {
      logger.warn('FEED', 'sponsorship sources unavailable; no provider-reading badge on this page', { error: err instanceof Error ? err.message : String(err) });
    }
    return out;
  }

  async function items(
    ctx: FeedCtx,
    cands: CardCandidate[],
    user: MatchUser | null,
    offset: number | null,
    personalized: boolean,
    also: ReadonlyMap<string, FeedJobRow[]> = new Map(),
    fused = false,
    newSince: Date | null = null,
  ): Promise<FeedItem[]> {
    const [tracker, meta, sourced] = await Promise.all([
      repo.trackerStates(ctx.userId, cands.map((c) => c.row.id)),
      cardMetaFor(ctx, cands.map((c) => c.row)),
      withSponsorshipSource(cands.map((c) => c.row), user),
    ]);
    return cands.map((c, i) => {
      const item = toFeedItem(sourced.get(c.row.id) ?? c.row, {
        user,
        fit: c.badge,
        tracker: tracker.has(c.row.id) ? { status: tracker.get(c.row.id)! } : null,
        position: offset === null ? null : offset + i,
        now: ctx.now,
        // The viewer's previous visit: "New" = first seen by us after it (null: the 48-hour rule).
        newSince,
        cardMeta: meta.get(c.row.id),
        explanation: explanationFor(ctx, c, personalized, fused),
      });
      // The same role in other places, folded into this card (set here: items.ts builds the card itself).
      const alsoIn = alsoInOf(also.get(c.row.id) ?? []);
      if (alsoIn) item.alsoIn = alsoIn;
      return item;
    });
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  function queryHash(input: { profile: Pick<SearchProfileWire, 'id' | 'version'>; filters: FilterSet; sort: FeedSort; order: FeedOrder; market: Market; relevance?: string | null }): string {
    // `r` is added only when a relevance text is given, so a query without one keeps the hash it always had.
    return sha(stableStringify({ p: input.profile.id, v: input.profile.version, f: input.filters, s: input.sort, o: input.order, m: input.market, ...(input.relevance ? { r: input.relevance } : {}) }));
  }

  /** The short key a session stores for a card's same-role group. */
  const groupKey = (row: FeedJobRow): string | null => {
    const key = sameRoleKey(row);
    return key ? sha(key).slice(0, 16) : null;
  };

  /** Session rank entries for the cards of a window, each with its group and the postings folded into it. */
  function ranksOf(cands: Candidate[], also: ReadonlyMap<string, Candidate[]> = new Map()): SessionRank[] {
    return cands.map((c) => {
      const g = groupKey(c.row);
      const folded = also.get(c.row.id)?.map((x) => x.row.id) ?? [];
      return { jobId: c.row.id, fit: c.badge?.score ?? null, kind: c.badge?.kind ?? 'pre', rank: c.rank, ...(g ? { g } : {}), ...(folded.length ? { also: folded } : {}) };
    });
  }

  function sessionRanks(s: Pick<FeedSessionRecord, 'ranks'>): SessionRank[] {
    return Array.isArray(s.ranks) ? (s.ranks as SessionRank[]).filter((r) => !!r && typeof r.jobId === 'string') : [];
  }

  interface QueryState {
    ctx: FeedCtx;
    filters: FilterSet;
    sort: FeedSort;
    personalized: boolean;
    rc: RankContext;
    /** Rows and scores already in memory (page 1 avoids a second fetch). */
    rowCache: Map<string, FeedJobRow>;
    scoreCache: Map<string, ScoreEntry>;
    user: MatchUser | null;
    /** A category list from Explore: public rows, no saved filters. */
    browse: boolean;
    /** The text to rank by, when the query carries one: part of the query text of the lexical and dense legs (beside a typed `q`). */
    relevance: string | null;
    /** The list is in the fused order of its legs (not personalised, with a query text): `order` 'query_match'. */
    fused: boolean;
    /** The person's side, read at most once in this request. */
    context: () => Promise<FeedMatchContext>;
    /** The viewer's previous visit to the list, for "New" (null: none known, the 48-hour rule). The same instant on every page of the list. */
    newSince: Date | null;
    /** The request's UI language, for the skill labels of the fits (absent: the posting's language). */
    locale?: string;
  }

  /**
   * The same-role groups a refill may fold into: group → the card and the
   * places it already covers (its own and those folded into it). Only cards
   * the session has NOT sent yet count (index ≥ `offset`, the page being
   * built): a posting folded into a card the client already holds would be
   * named by nothing and listed nowhere, so the role then gets a new card and
   * the posting stays reachable. Only the groups `fresh` belongs to are read.
   */
  async function takenGroups(state: QueryState, s: Pick<FeedSessionRecord, 'jobIds'>, ranks: SessionRank[], fresh: FeedJobRow[], offset: number): Promise<Map<string, TakenGroup>> {
    const wanted = new Set(fresh.map(groupKey).filter((g): g is string => !!g));
    const position = new Map(s.jobIds.map((id, i) => [id, i]));
    const cards = ranks.filter((r) => !r.h && r.g && wanted.has(r.g) && (position.get(r.jobId) ?? -1) >= offset);
    const taken = new Map<string, TakenGroup>();
    if (!cards.length) return taken;
    const rows = new Map((await rowsFor(state, cards.flatMap((r) => [r.jobId, ...(r.also ?? [])]))).map((r) => [r.id, r]));
    for (const card of cards) {
      const row = rows.get(card.jobId);
      const key = row ? sameRoleKey(row) : null;
      // The first card of a group that is still to be sent is the one later rows fold into.
      if (!row || !key || taken.has(key)) continue;
      const places = [row, ...(card.also ?? []).map((id) => rows.get(id))].map((r) => placeKey(r ? placeOf(r) : null)).filter(Boolean);
      taken.set(key, { cardId: card.jobId, places: new Set(places), folded: (card.also ?? []).length, sponsors: mentionsSponsorship(row) });
    }
    return taken;
  }

  /**
   * Append the next older window(s) until `need` ids exist or the age floor is
   * reached (≤3 windows a request). Windows are recency-keyed below the
   * session's boundary (leg A's, for a hybrid first window) and skip every job
   * the session has already judged: its cards, the postings folded into them,
   * and the rows of the first window its fit-tier view hid (so "Hiding N
   * weaker fits" counts each of those once). `offset` is the page being built:
   * a fresh posting joins a same-role card only when that card is on this page
   * or a later one, so every folded posting is named by a card the client
   * still receives.
   */
  async function ensureFilled(state: QueryState, session: FeedSessionRecord, need: number, offset: number): Promise<FeedSessionRecord> {
    const floor = floorOf(state.filters, session.createdAt);
    let s = session;
    let changed = false;
    for (let i = 0; i < 3 && s.jobIds.length < need && olderRemain(s, floor) && state.sort !== 'deadline'; i++) {
      const to = s.windowEndsAt;
      const start = to.getTime() - L.widenWindowDays * DAY_MS;
      // The window that reaches the age floor runs to the end of the list: rows of the age-floor boards stop
      // at the floor, rows of every other source are listed at any age (`ageFloorSql`).
      const w = await retrieve(
        state.ctx,
        state.filters,
        start <= floor.getTime() ? { from: null, ageFloor: floor, to, toId: s.windowEndsId } : { from: new Date(start), to, toId: s.windowEndsId },
        state.browse,
      );
      const prevRanks = sessionRanks(s);
      // Cards, postings folded into a card, and first-window rows the tier view hid (rank entries flagged `h`).
      const known = new Set([...s.jobIds, ...prevRanks.flatMap((r) => [r.jobId, ...(r.also ?? [])])]);
      const fresh = w.rows.filter((r) => !known.has(r.id));
      const scored = await score(state.ctx, fresh, state.personalized, state.context, state.locale);
      state.user = state.user ?? scored.user;
      const tailIds = s.jobIds.slice(-(L.companyWindow - 1));
      const tailRows = await rowsFor(state, tailIds);
      const head: Candidate[] = tailRows.map((row) => ({ row, badge: null, fit: null, rank: 0 }));
      const [seenSkipped, taken] = await Promise.all([seenSkippedOf(state.ctx, fresh, state.sort, state.personalized), takenGroups(state, s, prevRanks, fresh, offset)]);
      const ranked = rankRows(fresh, scored, state.sort, state.rc, state.filters, state.personalized, { head, fused: state.fused, seenSkipped, taken });
      for (const c of [...ranked.kept, ...[...ranked.also.values()].flat()]) {
        state.rowCache.set(c.row.id, c.row);
        state.scoreCache.set(c.row.id, scored.byId.get(c.row.id) ?? { badge: c.badge, fit: c.fit });
      }
      // A fresh row that names another place of a role whose card is still to be sent joins that card.
      const freshCards = new Set(ranked.kept.map((c) => c.row.id));
      const ranks = prevRanks.map((r) => {
        const more = r.h || freshCards.has(r.jobId) ? undefined : ranked.also.get(r.jobId);
        return more?.length ? { ...r, also: [...(r.also ?? []), ...more.map((c) => c.row.id)] } : r;
      });
      s = {
        ...s,
        jobIds: [...s.jobIds, ...ranked.kept.map((c) => c.row.id)],
        ranks: [...ranks, ...ranksOf(ranked.kept, ranked.also)],
        // Cards plus what the tier view hid: a posting folded into a card is neither.
        totalEstimate: s.totalEstimate + ranked.kept.length + ranked.hidden,
        windowEndsAt: w.windowEndsAt,
        windowEndsId: w.windowEndsId,
      };
      changed = true;
    }
    if (changed) {
      await repo.updateSession(s.id, { jobIds: s.jobIds, ranks: s.ranks, totalEstimate: s.totalEstimate, windowEndsAt: s.windowEndsAt, windowEndsId: s.windowEndsId });
    }
    return s;
  }

  async function rowsFor(state: QueryState, ids: string[]): Promise<FeedJobRow[]> {
    const missing = ids.filter((id) => !state.rowCache.has(id));
    if (missing.length) {
      const rows = await repo.queryRows(rowsByIdSql(scopeOf(state.ctx, state.browse), missing));
      for (const r of rows) state.rowCache.set(r.id, r);
    }
    return ids.map((id) => state.rowCache.get(id)).filter((r): r is FeedJobRow => !!r);
  }

  /**
   * The feed header facts for the rows this query can reach (mainland display
   * rule: the header says where postings come from and never implies full
   * coverage). Counted, never guessed: when the count cannot be read the field
   * is left off and the list still answers.
   */
  async function sourcesFor(state: QueryState, since: Date): Promise<{ sources: FeedSources; listed: number } | undefined> {
    if (state.ctx.market !== 'cn') return undefined;
    try {
      const { listed, ...sources } = await repo.querySources(
        sourcesSql({
          scope: scopeOf(state.ctx, state.browse),
          filters: state.filters,
          fields: state.browse ? FILTER_FIELDS.filter((f) => f !== 'taxonomyIds' && f !== 'titles') : FILTER_FIELDS,
          extra: state.browse ? [browseTaxonomySql(state.filters.taxonomyIds ?? [])] : undefined,
          from: floorOf(state.filters, since),
        }),
      );
      return { sources, listed };
    } catch (err) {
      logger.warn('FEED', 'feed source header could not be counted; sent without it', { error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  async function page(state: QueryState, session: FeedSessionRecord, offset: number, order: FeedOrder): Promise<FeedQueryResponse> {
    const s = await ensureFilled(state, session, offset + L.pageSize + 1, offset);
    const ids = s.jobIds.slice(offset, offset + L.pageSize);
    // The postings folded into this page's cards (the same role in other places), from the session.
    const onPage = new Set(ids);
    const folded = new Map(sessionRanks(s).filter((r) => !r.h && onPage.has(r.jobId) && r.also?.length).map((r) => [r.jobId, r.also!]));
    // Rows hidden or closed since the session started drop out of the page (and out of a card's other places).
    const fetched = new Map((await rowsFor(state, [...ids, ...[...folded.values()].flat()])).map((r) => [r.id, r]));
    const rows = ids.map((id) => fetched.get(id)).filter((r): r is FeedJobRow => !!r);
    const also = new Map([...folded].map(([cardId, list]) => [cardId, list.map((id) => fetched.get(id)).filter((r): r is FeedJobRow => !!r)]));
    const needScore = rows.filter((r) => !state.scoreCache.has(r.id));
    if (needScore.length) {
      const scored = await score(state.ctx, needScore, state.personalized, state.context, state.locale);
      state.user = state.user ?? scored.user;
      for (const [id, v] of scored.byId) state.scoreCache.set(id, v);
    }
    const cands: CardCandidate[] = rows.map((row) => ({ row, ...(state.scoreCache.get(row.id) ?? { badge: null, fit: null }) }));
    const floor = floorOf(state.filters, s.createdAt);
    const exhausted = state.sort === 'deadline' || !olderRemain(s, floor);
    const nextOffset = offset + L.pageSize;
    const more = nextOffset < s.jobIds.length || !exhausted;
    const [cards, header] = await Promise.all([items(state.ctx, cands, state.user, offset, state.personalized, also, state.fused, state.newSince), sourcesFor(state, s.createdAt)]);
    const sources = header?.sources;
    // Thin means the WHOLE list is short, not the part read so far: `jobIds` holds the windows fetched up to
    // now (the first one reaches back 14 or 45 days, the list 120). So it is said only when that is known:
    // the list has reached its age floor, or (GoApply) fewer public rows than the threshold match the query
    // at all. While older rows may still come and nothing counts them, the answer is "not thin".
    const thin = s.jobIds.length < FEED_THIN_BELOW && (exhausted || (header !== undefined && header.listed < FEED_THIN_BELOW));
    return {
      items: cards,
      cursor: more ? cursorOf(s.id, nextOffset, state.newSince) : null,
      endOfFeed: !more,
      hiddenByTier: Math.max(0, s.totalEstimate - s.jobIds.length),
      sessionId: s.id,
      order,
      sort: state.sort,
      ...(sources ? { sources } : {}),
      thin,
    };
  }

  // ── A thin saved search asks for one targeted ingest ──────────────────

  const ingestAsked = new Map<string, number>();

  /**
   * The first window of a saved search held fewer than 60 rows: queue one
   * targeted ingest for it (MATCH 4.10 point 4: what it finds is ingested and
   * then listed through this same pipeline, never ranked apart). Once per
   * (profile id, version) in 6 hours, in the background: the response is not
   * delayed, promises nothing, and a failing request never fails the feed.
   */
  function requestIngestOnce(profile: Pick<SearchProfileWire, 'id' | 'version'>, at: Date): void {
    const ask = deps.requestIngest;
    if (!ask) return;
    const key = `${profile.id}:${profile.version}`;
    const last = ingestAsked.get(key);
    if (last !== undefined && at.getTime() - last < INGEST_REQUEST_TTL_MS) return;
    if (ingestAsked.size >= 5000) ingestAsked.clear();
    ingestAsked.set(key, at.getTime());
    void Promise.resolve()
      .then(() => ask(profile.id))
      .catch((err) => logger.warn('FEED', 'the targeted ingest for a thin search could not be queued', { searchProfileId: profile.id, error: err instanceof Error ? err.message : String(err) }));
  }

  async function query(ctx: FeedCtx, input: FeedQueryInput): Promise<FeedQueryResponse> {
    if (input.sort === 'deadline' && ctx.market !== 'cn') {
      throw new HttpError('invalid_request', 'This sort is not available here.', { reason: FEED_ERROR_CODES.deadlineSortCnOnly });
    }
    const cursor = input.cursor ? parseCursor(input.cursor) : null;
    if (!cursor) {
      const gate = await deps.consumeRefresh(ctx.userId);
      if (!gate.allowed) {
        throw new HttpError(
          'rate_limited',
          'You refreshed the list many times in a few minutes. Try again shortly.',
          { reason: FEED_ERROR_CODES.refreshLimited, retryAfterSec: gate.retryAfterSec },
          { 'Retry-After': String(gate.retryAfterSec) },
        );
      }
    }
    const browse = isBrowse(input);
    // A browse reads no search profile: the category, the market and the visibility rules only.
    const profile: Pick<SearchProfileWire, 'id' | 'version' | 'filters'> = browse ? { ...BROWSE_PROFILE, filters: {} } : await loadProfile(ctx.userId, input.searchProfileId);
    const filters = effectiveFilters(ctx.market, profile.filters, input);
    const personalized = await isPersonalized(ctx.userId, ctx.market);
    const relevance = relevanceOf(input.relevance);
    // Not personalised, the default order asked for, and a query text: the list is in the fused order of the
    // recency and lexical legs (no profile, no vector, no fit). An explicit Newest is one statement by date.
    const { sort, hybrid, fused } = listPlan(input.sort, personalized, filters, relevance, browse);
    const order: FeedOrder = personalized ? 'personalized' : fused ? 'query_match' : 'recency';
    const hash = queryHash({ profile, filters, sort, order, market: ctx.market, relevance });
    const rc = await rankContext(ctx, filters, personalized);
    // The previous visit: a later page reads it from its cursor; the first page reads the stored stamp now,
    // before this request stamps the visit itself (below). A failing read is "no known visit".
    const newSince = cursor ? cursor.newSince : previousVisit(await repo.lastFeedVisit(ctx.userId).catch(() => null), ctx.now);
    const state: QueryState = { ctx, filters, sort, personalized, rc, rowCache: new Map(), scoreCache: new Map(), user: null, browse, relevance, fused, context: contextOnce(ctx), newSince, ...(input.locale ? { locale: input.locale } : {}) };

    if (cursor) {
      const session = await repo.getSession(cursor.sessionId, ctx.userId);
      if (!session || session.expiresAt.getTime() <= ctx.now.getTime() || session.queryHash !== hash) throw sessionExpired();
      return page(state, session, cursor.offset, order);
    }

    const w = await firstWindow(ctx, filters, sort, browse, hybrid ? { personalized, relevance, context: state.context } : null);
    const [scored, seenSkipped] = await Promise.all([score(ctx, w.rows, personalized, state.context, state.locale), seenSkippedOf(ctx, w.rows, sort, personalized)]);
    state.user = scored.user;
    const ranked = rankRows(w.rows, scored, sort, rc, filters, personalized, { retrievalRank: w.retrievalRank, fused, seenSkipped });
    for (const c of [...ranked.kept, ...[...ranked.also.values()].flat()]) {
      state.rowCache.set(c.row.id, c.row);
      state.scoreCache.set(c.row.id, scored.byId.get(c.row.id) ?? { badge: c.badge, fit: c.fit });
    }
    // A hybrid window holds rows of the lexical and dense legs from below the recency boundary, and the later
    // (recency) windows reach them again. The ones the tier view hid are in no card, so they are remembered
    // here; without that a refill would judge and count them a second time.
    const hiddenBelow = w.retrievalRank ? ranked.hiddenRows.filter((r) => !!r.postedAt && r.postedAt.getTime() <= w.windowEndsAt.getTime()) : [];
    const hiddenRanks: SessionRank[] = hiddenBelow.map((r) => ({ jobId: r.id, fit: null, kind: 'pre', rank: 0, h: true }));
    const session = await repo.createSession({
      userId: ctx.userId,
      searchProfileId: browse ? null : profile.id,
      profileVersion: browse ? null : profile.version,
      sort,
      queryHash: hash,
      jobIds: ranked.kept.map((c) => c.row.id),
      ranks: [...ranksOf(ranked.kept, ranked.also), ...hiddenRanks],
      // Cards plus what the tier view hid ("Hiding N weaker fits"): a posting folded into a card is neither.
      totalEstimate: ranked.kept.length + ranked.hidden,
      windowEndsAt: w.windowEndsAt,
      windowEndsId: w.windowEndsId,
      expiresAt: new Date(ctx.now.getTime() + L.sessionTtlMin * 60_000),
    });
    // Opening the list is a visit: the Jobs badge counts from here (a category browse is not).
    if (!browse) await repo.stampFeedVisit(ctx.userId, ctx.now).catch((err) => logger.warn('FEED', 'could not stamp the feed visit', { error: String(err) }));
    // The saved search as it is (no one-off override, no typed query) came back thin: one targeted ingest.
    const asSaved = !browse && input.q === undefined && !Object.keys(input.overrides ?? {}).length;
    if (asSaved && w.rows.length < L.widenBelowRows) requestIngestOnce(profile, ctx.now);
    const first = await page(state, session, 0, order);
    // With a text to rank by: say whether it took part in this list (a leg asked with it returned rows), so a
    // reader can leave "Ranked by …" out when no posting matched the words. Only the first page knows.
    return relevance ? { ...first, relevanceApplied: w.relevanceApplied === true } : first;
  }

  // ── Counts ────────────────────────────────────────────────────────────

  async function countFor(ctx: Pick<FeedCtx, 'market' | 'userId' | 'now'>, filters: FilterSet): Promise<FeedCountResult> {
    // Counts are of third-party postings only (public rows): none may be shown → none are counted.
    if (!postingsAllowed(ctx.market)) return { count: 0, capped: false };
    const n = await repo.queryCount(countSql({ scope: scopeOf(ctx), filters, fields: FILTER_FIELDS, cap: L.countCap }));
    return { count: Math.min(n, L.countCap), capped: n > L.countCap };
  }

  async function counts(ctx: FeedCtx): Promise<FeedCountsResponse> {
    const profile = await loadProfile(ctx.userId);
    const [forYou, tracker, external] = await Promise.all([countFor(ctx, profile.filters), repo.trackerCounts(ctx.userId), repo.importedCount(ctx.userId, ctx.market)]);
    return { forYou: forYou.count ?? 0, saved: tracker.saved, external, applied: tracker.applied };
  }

  /** One count query per candidate relaxation; the gain is how many jobs that filter removes. */
  async function limitingFilters(ctx: FeedCtx, searchProfileId: string): Promise<LimitingFilter[]> {
    const profile = await loadProfile(ctx.userId, searchProfileId);
    if (!postingsAllowed(ctx.market)) return [];
    const base = await countFor(ctx, profile.filters);
    const cands = relaxations(profile.filters);
    const out: LimitingFilter[] = [];
    for (let i = 0; i < cands.length; i += 4) {
      const chunk = cands.slice(i, i + 4);
      const results = await Promise.all(chunk.map((c) => countFor(ctx, c.relaxed)));
      chunk.forEach((c, j) => {
        const gain = (results[j]!.count ?? 0) - (base.count ?? 0);
        if (gain > 0) out.push({ field: c.field, value: c.value, removalGain: gain });
      });
    }
    return out.sort((a, b) => b.removalGain - a.removalGain || a.field.localeCompare(b.field));
  }

  async function proposal(ctx: FeedCtx, profile: SearchProfileWire, after: FilterSet): Promise<FilterDiffProposal> {
    const { ops, patch } = toDiff(profile.filters, after);
    let countAfter: number | null = null;
    try {
      countAfter = (await countFor(ctx, after)).count;
    } catch (err) {
      logger.warn('FEED', 'count after a filter change failed', { error: err instanceof Error ? err.message : String(err) });
    }
    return { searchProfileId: profile.id, baseVersion: profile.version, ops, patch, countAfter };
  }

  // ── Actions ───────────────────────────────────────────────────────────

  async function visibleJob(ctx: FeedCtx, jobId: string) {
    const job = await repo.actionJob(jobId);
    if (!job || job.market !== ctx.market || (job.visibility !== 'public' && job.ownerUserId !== ctx.userId)) {
      throw new HttpError('not_found', 'Job not found.', { reason: FEED_ERROR_CODES.jobNotFound });
    }
    return job;
  }

  /**
   * Learn from an action. Only for personalised users: a GoApply user who
   * declined or has not chosen 个性化推荐 gets no preference profile stored
   * (PIPL Art. 24), not merely an unused one.
   */
  async function bumpAffinity(ctx: Pick<FeedCtx, 'userId' | 'market'>, job: AffinityJob, event: AffinityEvent, at: Date) {
    const userId = ctx.userId;
    if (!(await isPersonalized(userId, ctx.market))) return;
    try {
      const current = (await repo.getAffinity(userId)) ?? EMPTY_AFFINITY;
      await repo.saveAffinity(userId, applyAffinity(current, affinityKeys(job), AFFINITY_DELTAS[event], at, event));
    } catch (err) {
      logger.warn('FEED', 'affinity update failed', { userId, event, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function hide(ctx: FeedCtx, jobId: string, body: { reasonCode: HideReason; detail?: string }): Promise<HideJobResponse> {
    const job = await visibleJob(ctx, jobId);
    await repo.setHidden(ctx.userId, jobId, { at: ctx.now, reason: body.reasonCode });
    await repo.logInteractions([{ userId: ctx.userId, jobId, kind: 'hide', reasonCode: body.reasonCode, detail: body.detail ? { note: body.detail } : null }]);
    if (UNSPECIFIC_HIDE.has(body.reasonCode)) await bumpAffinity(ctx, job, 'hide', ctx.now);
    // "Wrong title" is a title-level negative: this role and this title count lower in Recommended from now
    // on (ORDERING_RULES `wrong_title`), besides the filter change proposed below, which the person may decline.
    else if (body.reasonCode === 'wrong_title') await bumpAffinity(ctx, job, 'wrong_title', ctx.now);
    let profile: SearchProfileWire;
    try {
      profile = await loadProfile(ctx.userId);
    } catch {
      return { proposedFilterDiff: null, editor: null };
    }
    const { after, editor } = hideProposal(body.reasonCode, job, profile.filters);
    if (!after) return { proposedFilterDiff: null, editor };
    const diff = await proposal(ctx, profile, after);
    return { proposedFilterDiff: diff.ops.length ? diff : null, editor };
  }

  async function unhide(ctx: FeedCtx, jobId: string): Promise<void> {
    await visibleJob(ctx, jobId);
    await repo.setHidden(ctx.userId, jobId, null);
    await repo.logInteractions([{ userId: ctx.userId, jobId, kind: 'unhide' }]);
  }

  async function report(ctx: FeedCtx, jobId: string, body: { reason: ReportReason; note?: string }): Promise<{ closed: boolean }> {
    const job = await visibleJob(ctx, jobId);
    await repo.setHidden(ctx.userId, jobId, { at: ctx.now, reason: `report:${body.reason}` });
    await repo.logInteractions([{ userId: ctx.userId, jobId, kind: 'report', reasonCode: body.reason, detail: body.note ? { note: body.note } : null }]);
    if (job.visibility !== 'public' || !(REPORT_CLOSE_REASONS as readonly string[]).includes(body.reason) || job.closedAt) return { closed: false };
    const reporters = await repo.distinctReporters(jobId, REPORT_CLOSE_REASONS);
    if (reporters < L.reportCloseThreshold) return { closed: false };
    const closed = await repo.closeAsReported(jobId, ctx.now);
    if (closed) logger.info('FEED', 'job closed after reports; queued for admin review', { jobId, reporters });
    return { closed };
  }

  async function impressions(ctx: FeedCtx, body: { sessionId: string; positions: Array<{ jobId: string; position: number; ms: number }> }): Promise<void> {
    const session = await repo.getSession(body.sessionId, ctx.userId);
    if (!session) throw new HttpError('not_found', 'Feed session not found.');
    const inSession = new Set(session.jobIds);
    const ids = [...new Set(body.positions.map((p) => p.jobId).filter((id) => inSession.has(id)))];
    // One impression per job and feed session, however many batches name it: the "seen and skipped" rule
    // counts the visits on which a job was in the list, not the times a card scrolled past.
    await repo.recordImpressions(ctx.userId, ids, ctx.now, session.createdAt);
  }

  async function rating(ctx: FeedCtx, body: { score: number; reasons: RatingReason[]; note?: string }): Promise<void> {
    const dayKey = ctx.now.toISOString().slice(0, 10);
    const created = await repo.createRating({
      userId: ctx.userId,
      dayKey,
      score: body.score,
      reasons: body.score < 8 ? [...new Set(body.reasons)] : [],
      note: body.note?.trim() || null,
      feedSessionId: null,
    });
    if (!created) throw new HttpError('conflict', 'You already rated your list today.', { reason: FEED_ERROR_CODES.ratingAlreadyToday });
  }

  // ── Explore ───────────────────────────────────────────────────────────

  async function explore(ctx: Pick<FeedCtx, 'market' | 'now'>, locale: string): Promise<ExploreResponse> {
    const cats = taxonomyCategories();
    let hit = exploreCache.get(ctx.market);
    if (!hit || ctx.now.getTime() - hit.at > exploreTtl) {
      // The same age floor as the lists, so a tile's count is what its browse list can reach.
      const rows = await repo.queryCategoryCounts(exploreCountsSql(ctx.market, cats.map((c) => c.id), floorOf({}, ctx.now), heldBanks()));
      hit = { at: ctx.now.getTime(), counts: new Map(rows.map((r) => [r.taxonomyId, r.count])), asOf: ctx.now };
      exploreCache.set(ctx.market, hit);
    }
    const asOf = hit.asOf.toISOString();
    return {
      asOf,
      categories: cats.map((c) => {
        const count = hit!.counts.get(c.id) ?? 0;
        return {
          taxonomyId: c.id,
          label: taxonomyLabel(c.id, locale) ?? c.en,
          count,
          sourced: { value: count, source: 'aggregate' as const, asOf, method: 'live_public_postings_in_market' },
        };
      }),
    };
  }

  // ── NL query (F-FEED-17) ──────────────────────────────────────────────

  /**
   * What became of the parts of a request that are not filters, in the user's
   * own words: the topics the list is ranked by, then the phrases that were
   * left unchecked. Nothing is claimed to be verified (D3).
   */
  function nlExplanation(rankedBy: string[], unmatched: string[]): string {
    const lines: string[] = [];
    if (rankedBy.length) lines.push(`Ranked by closeness to: ${rankedBy.join(', ')}.`);
    const unchecked = uncheckedPhrases(rankedBy, unmatched);
    if (unchecked.length) lines.push(`Not checked as requirements: ${unchecked.join('; ')}.`);
    return lines.join(' ');
  }

  async function nlQuery(ctx: FeedCtx, body: { text: string; searchProfileId?: string }, locale: string): Promise<NlQueryResponse> {
    if (!(await deps.aiAllowed(ctx.userId))) throw new HttpError('ai_unavailable', undefined, { reason: 'ai_off' });
    const profile = await loadProfile(ctx.userId, body.searchProfileId);
    let plan: PlannerPlan;
    try {
      plan = await deps.planner(body.text, { userId: ctx.userId, locale });
    } catch (err) {
      const e = err as { name?: string; code?: string } | null;
      if (e?.name === 'JobSearchValidationError') throw new HttpError('invalid_request', 'Name a role or kind of job to search for.', { reason: FEED_ERROR_CODES.noRole });
      if (e?.code === 'ai_unavailable' || e?.code === 'content_blocked') throw err;
      logger.warn('FEED', 'NL query planner failed', { error: err instanceof Error ? err.message : String(err) });
      throw new HttpError('ai_unavailable', undefined, { reason: 'planner_failed' });
    }
    const { patch, unmatched, rankedBy } = planToFilters(plan, body.text, ctx.market);
    const after = mergeFilterSet(profile.filters, patch);
    return { diff: await proposal(ctx, profile, after), explanation: nlExplanation(rankedBy, unmatched), unmatched, rankedBy };
  }

  // ── Badge count and skills check ──────────────────────────────────────

  /**
   * Jobs first seen since the last visit. Personalised: those at Good or
   * better by the same rule as the "Good or better" view (the fit of each of
   * the newest 400; a quick estimate with low confidence does not count;
   * `capped` past that).
   * Not personalised (GoApply without 个性化推荐): a plain capped count, no
   * scoring. Reused for 2 minutes per (user, market, visit, profile version)
   * so a polling badge stays cheap; `markVisited` stamps the visit and drops
   * the cached value.
   */
  async function newCount(ctx: FeedCtx, input: { since?: string; markVisited?: boolean }): Promise<NewCountResponse> {
    const lastVisit = input.since ? null : await repo.lastFeedVisit(ctx.userId);
    const since = input.since ? new Date(input.since) : (lastVisit ?? new Date(ctx.now.getTime() - 7 * DAY_MS));
    const profile = await loadProfile(ctx.userId);
    const personalized = await isPersonalized(ctx.userId, ctx.market);
    const key = `${ctx.userId}:${ctx.market}:${input.since ?? lastVisit?.toISOString() ?? 'none'}:${profile.id}:${profile.version}:${personalized ? 'p' : 'r'}`;
    const hit = newCountCache.get(key);
    const cached = hit && ctx.now.getTime() - hit.at < newCountTtl ? hit.res : null;
    let res: NewCountResponse;
    if (cached) {
      res = cached;
    } else if (!personalized) {
      const n = await repo.queryCount(countSql({ scope: scopeOf(ctx), filters: profile.filters, fields: FILTER_FIELDS, cap: L.countCap, firstSeenAfter: since }));
      res = { count: Math.min(n, L.countCap), since: since.toISOString(), capped: n > L.countCap };
    } else {
      const rows = await repo.queryRows(
        retrievalSql({ scope: scopeOf(ctx), filters: profile.filters, fields: FILTER_FIELDS, from: null, to: null, firstSeenAfter: since, limit: L.retrievalLimit }),
      );
      const tiers = deps.match.config().tiers;
      const scored = rows.length ? await score(ctx, rows, true) : { byId: new Map<string, { badge: Candidate['badge'] }>() };
      const count = [...scored.byId.values()].filter((s) => s.badge && passesTier(s.badge, 'good', tiers)).length;
      res = { count, since: since.toISOString(), capped: rows.length >= L.retrievalLimit };
    }
    if (!cached) {
      if (newCountCache.size >= 5000) newCountCache.clear();
      newCountCache.set(key, { at: ctx.now.getTime(), res });
    }
    if (input.markVisited) {
      await repo.stampFeedVisit(ctx.userId, ctx.now);
      for (const k of newCountCache.keys()) if (k.startsWith(`${ctx.userId}:`)) newCountCache.delete(k);
    }
    return res;
  }

  /**
   * The top of the ranked list without a session (skills check, Assistant
   * preview, the fit-score precompute): the same first window as the list's
   * own, so with hybrid retrieval its candidates are the fused union.
   */
  async function topRanked(ctx: FeedCtx, filters: FilterSet, sort: FeedSort, limit: number, relevance: string | null = null, locale?: string) {
    const personalized = await isPersonalized(ctx.userId, ctx.market);
    const { sort: eff, hybrid, fused } = listPlan(sort, personalized, filters, relevance, false);
    const context = contextOnce(ctx);
    let w = await firstWindow(ctx, filters, eff, false, hybrid ? { personalized, relevance, context } : null);
    // No session, so no refill: when the first window (45 days at most for its recency leg) cannot fill the
    // request, read the whole list once. Board and bank postings stay open for months and are listed at any age.
    if (w.rows.length < limit && eff !== 'deadline' && !filters.postedWithinDays) {
      const whole = await retrieve(ctx, filters, { from: null, to: null, ageFloor: floorOf(filters, ctx.now) });
      // The fused rows keep their positions; rows only the whole list holds follow, newest first.
      const have = new Set(w.rows.map((r) => r.id));
      w = { ...whole, rows: [...w.rows, ...whole.rows.filter((r) => !have.has(r.id))], retrievalRank: w.retrievalRank, relevanceApplied: w.relevanceApplied };
    }
    const [scored, seenSkipped] = await Promise.all([score(ctx, w.rows, personalized, context, locale), seenSkippedOf(ctx, w.rows, eff, personalized)]);
    const rc = await rankContext(ctx, filters, personalized);
    const ranked = rankRows(w.rows, scored, eff, rc, filters, personalized, { retrievalRank: w.retrievalRank, fused, seenSkipped });
    const cands: CardCandidate[] = ranked.kept.slice(0, limit).map((c) => {
      const entry = scored.byId.get(c.row.id);
      return { row: c.row, badge: c.badge, dimensions: entry?.dimensions ?? null, skills: entry?.skills ?? null };
    });
    const also = new Map([...ranked.also].map(([cardId, list]) => [cardId, list.map((c) => c.row)]));
    return { cands, user: scored.user, personalized, also, fused, relevanceApplied: w.relevanceApplied === true };
  }

  async function skillsCheck(ctx: FeedCtx): Promise<SkillsCheckResponse> {
    const profile = await loadProfile(ctx.userId);
    const [{ cands }, mine] = await Promise.all([topRanked(ctx, profile.filters, 'recommended', L.skillsCheckList), repo.profileSkills(ctx.userId)]);
    const known = new Set([...mine, ...(profile.filters.excludedSkills ?? [])].map(skillKey));
    const tally = new Map<string, { skill: string; n: number }>();
    for (const c of cands) {
      const seen = new Set<string>();
      for (const s of requiredSkills(c.row)) {
        const key = skillKey(s);
        if (!key || seen.has(key) || known.has(key)) continue;
        seen.add(key);
        const t = tally.get(key) ?? { skill: s, n: 0 };
        t.n += 1;
        tally.set(key, t);
      }
    }
    const skills = [...tally.values()]
      .filter((t) => t.n >= 2)
      .sort((a, b) => b.n - a.n || a.skill.localeCompare(b.skill))
      .slice(0, L.skillsCheckTop)
      .map((t) => ({ skill: t.skill, askedIn: t.n, outOf: cands.length }));
    return { skills };
  }

  // ── Seams for other areas ─────────────────────────────────────────────

  /**
   * The top of the ranked list for another area (no session), and whether
   * `input.relevance` took part in the order of the rows returned: true only
   * for a hybrid list whose lexical or dense leg was asked with the text and
   * returned rows. False with no text, with `FEED_HYBRID=off`, for a list that
   * is not hybrid (Newest, Highest pay, Deadline, a list that is not
   * personalised and was asked for by date) and when neither leg answered.
   * For a personalised list the text chooses candidates and breaks ties
   * (ranking is unchanged): "took part" is all `true` says. A caller that names
   * an order to its own reader (the job-search API's `agent.rankedBy`) reads
   * this and never assumes it.
   */
  async function previewOrdered(ctx: FeedCtx, input: FeedPreviewInput): Promise<{ items: FeedItem[]; relevanceApplied: boolean }> {
    // Validated like the query's (longer than the contract allows is refused, never cut).
    const relevance = relevanceOf(input.relevance);
    if (!postingsAllowed(ctx.market)) return { items: [], relevanceApplied: false };
    const profile = await loadProfile(ctx.userId);
    const filters = effectiveFilters(ctx.market, profile.filters, { overrides: input.filters as Record<string, unknown> | undefined, q: input.q });
    const sort = input.sort === 'deadline' && ctx.market !== 'cn' ? 'recommended' : (input.sort ?? 'recommended');
    const { cands, user, personalized, also, fused, relevanceApplied } = await topRanked(ctx, filters, sort, Math.max(1, Math.min(50, input.limit)), relevance, input.locale);
    return { items: await items(ctx, cands, user, null, personalized, also, fused), relevanceApplied };
  }

  async function preview(ctx: FeedCtx, input: FeedPreviewInput): Promise<FeedItem[]> {
    return (await previewOrdered(ctx, input)).items;
  }

  /**
   * Job ids for a filter set, newest first: the feed's own filter semantics
   * (radius, posted-within, GoApply fields, market, lifecycle, fraud and
   * hidden-state rules), with no ranking, no fit and no session. `publicOnly`
   * (the default) leaves the user's own imported jobs out in the query itself,
   * so an aggregate over the sample counts public rows only (TASK_PLAN §2.2).
   */
  async function sampleForFilters(ctx: Pick<FeedCtx, 'market' | 'userId' | 'now'>, filters: FilterSet, opts: SampleOptions): Promise<string[]> {
    if (!postingsAllowed(ctx.market)) return [];
    const limit = Math.max(1, Math.min(L.retrievalLimit, Math.floor(opts.limit)));
    const scope: SqlScope = { ...scopeOf(ctx), publicOnly: opts.publicOnly !== false };
    const { fitTier: _view, ...rest } = filters;
    return repo.queryIds(jobIdsSql({ scope, filters: rest, fields: FILTER_FIELDS, from: null, ageFloor: floorOf(rest, ctx.now), limit, orderBy: 'posted' }));
  }

  /**
   * Candidate jobs for a saved search's alert: public rows first seen after
   * `since` that pass the search's filters exactly as the feed applies them.
   * No ranking and no feed session; the alert sender picks and scores.
   * Runs for the profile's owner (their hidden jobs are left out).
   */
  async function alertCandidates(ctx: Pick<FeedCtx, 'market' | 'now'>, searchProfileId: string, opts: AlertCandidateOptions): Promise<AlertCandidates> {
    if (!postingsAllowed(ctx.market)) return { ids: [], truncated: false };
    const profile = deps.search.findById ? await deps.search.findById(searchProfileId) : null;
    if (!profile) return { ids: [], truncated: false };
    const limit = Math.max(1, Math.min(L.retrievalLimit, Math.floor(opts.limit)));
    const parsed = parseFilterSet(profile.filters, { market: ctx.market });
    const { fitTier: _view, ...filters } = normalizeFilterSet(parsed.ok ? parsed.value : coerceFilterSet(profile.filters, { market: ctx.market }).value);
    const scope: SqlScope = { market: ctx.market, userId: profile.userId, now: ctx.now, publicOnly: true, heldBanks: heldBanks(), ...(opts.excludeBoards?.length ? { heldBoards: opts.excludeBoards } : {}) };
    const ids = await repo.queryIds(
      jobIdsSql({
        scope,
        filters,
        fields: FILTER_FIELDS,
        // Instant alerts pass their own posted floor (an undated posting still counts);
        // otherwise the feed's age floor (120 days for aggregator rows, or the search's "posted within").
        from: opts.postedSince ?? null,
        allowUndated: !!opts.postedSince,
        ageFloor: opts.postedSince ? null : floorOf(filters, ctx.now),
        firstSeenAfter: opts.since,
        limit: limit + 1,
        orderBy: 'first_seen',
      }),
    );
    return { ids: ids.slice(0, limit), truncated: ids.length > limit };
  }

  /**
   * The visitor list. Every row passes the public-page rules the SEO pages use
   * (seo `basePublicWhere`: public, canonical, open, not expired, no fraud
   * flag, `publicDisplay`, and a source still allowed to be redisplayed), so a
   * removed, closed or private job is never listed — nor named by the visitor
   * assistant, which reads this list. The rules are part of the statement, so
   * its LIMIT counts listable rows (newer rows that fail a rule do not push
   * valid older ones out); `publicPageIds` then checks every row once more
   * with the SEO predicate itself.
   *
   * Age (JI-10): the list has the signed-in feed's age floor, not a window of
   * its own. An aggregator's row is listed for 120 days from its posting date;
   * an employer board's or a recruiter bank's row is listed for as long as its
   * source lists it (`ageFloorSql`), so a board posting published months ago
   * and still open is not cut out of the visitor list by its age. Newest
   * first, so older rows show only where newer ones do not fill the list.
   */
  async function publicList(ctx: { market: Market; now: Date }, input: { role?: string; city?: string; country?: string; limit: number }): Promise<PublicFeedItem[]> {
    if (!postingsAllowed(ctx.market)) return [];
    const raw: Record<string, unknown> = {};
    if (input.role?.trim()) raw.q = input.role.trim();
    if (input.country) raw.country = input.country;
    if (input.city?.trim()) raw.locations = [{ label: input.city.trim(), city: input.city.trim(), ...(input.country ? { country: input.country } : {}), radiusKm: 0 }];
    const parsed = parseFilterSet(raw, { market: ctx.market });
    const filters = parsed.ok ? parsed.value : {};
    const publicBoards = await repo.publicBoards();
    const rows = await repo.queryRows(
      retrievalSql({
        scope: { market: ctx.market, userId: null, now: ctx.now, publicOnly: true, publicDisplayOnly: true, publicBoards, ignoreHidden: true, heldBanks: heldBanks() },
        filters,
        fields: FILTER_FIELDS,
        from: null,
        ageFloor: floorOf(filters, ctx.now),
        to: null,
        limit: Math.max(1, Math.min(50, input.limit)),
      }),
    );
    if (!rows.length) return [];
    const allowed = await repo.publicPageIds(rows.map((r) => r.id), ctx.market, ctx.now);
    return rows.filter((r) => allowed.has(r.id)).map((r) => publicItem(r, null, ctx.now));
  }

  async function countForFilters(ctx: Pick<FeedCtx, 'market' | 'userId' | 'now'>, filters: FilterSet): Promise<FeedCountResult> {
    return countFor(ctx, filters);
  }

  /** Affinity from actions in other areas (save +0.1, apply click +0.15, applied +0.25). */
  async function recordInteraction(ctx: FeedCtx, jobId: string, kind: 'save' | 'apply_click' | 'applied'): Promise<void> {
    const job = await repo.actionJob(jobId);
    if (!job || job.market !== ctx.market) return;
    await bumpAffinity(ctx, job, kind, ctx.now);
  }

  return {
    query,
    counts,
    countForFilters,
    limitingFilters,
    hide,
    unhide,
    report,
    impressions,
    rating,
    explore,
    nlQuery,
    newCount,
    skillsCheck,
    preview,
    previewOrdered,
    publicList,
    sampleForFilters,
    alertCandidates,
    recordInteraction,
    now,
    /** Test helper: drop the Explore cache. */
    clearExploreCache: () => exploreCache.clear(),
  };
}

export type FeedQueryService = ReturnType<typeof createFeedQueryService>;

/** Affinity state type re-export for tests. */
export type { AffinityState };
