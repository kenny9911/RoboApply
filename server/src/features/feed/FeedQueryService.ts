// server/src/features/feed/FeedQueryService.ts — the feed (WP-32; ARCH §4.8, §4.9, §3.4).
//
//   query        retrieval SQL → the fits of the window (match `getFits`: the stored AI score,
//                else the quick estimate; never a model call) → rank → fit-tier view →
//                company scatter → RAFeedSession (30 min) → page 1; later pages slice
//                the session and refill it from the next older window
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
// GoApply: with 个性化推荐 off or not yet chosen the list is ordered by date
// posted and filters only, and no fit is used or shown (PIPL Art. 24; the mode
// and the `jobs.feed` capability are enforced on the routes). The NL query is the
// only model call here; it goes through `aiAllowed()` and the per-brand LLM layer.

import { createHash } from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import type { ExplainMatchInput } from '../compliance/index.js';
import type { MatchExplanation } from '../compliance/contract.js';
import type { MarketHookContext, MarketHookJob } from '../jobs/marketHooks.js';
import { taxonomyCategories, taxonomyLabel } from '../jobs/taxonomy/index.js';
import { applyMap, isByFilters, skillKey, type Fit, type FitFunctions, type MatchDimension, type MatchService, type MatchUser } from '../match/index.js';
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
import { AFFINITY_DELTAS, EMPTY_AFFINITY, affinityKeys, applyAffinity, decayed, type AffinityEvent, type AffinityState } from './affinity.js';
import {
  FEED_ERROR_CODES,
  FEED_LIMITS,
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
import { publicItem, toFeedItem } from './items.js';
import {
  companyKeyOf,
  fitBadge,
  passesTier,
  rankFitOf,
  recommendedRank,
  scatterByCompany,
  sortCandidates,
  sponsorshipFirst,
  type Candidate,
  type RankContext,
} from './ranking.js';
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
}

export interface FeedQueryInput {
  searchProfileId?: string;
  sort: FeedSort;
  q?: string;
  overrides?: Record<string, unknown>;
  cursor?: string;
  fitTier?: 'all' | 'good' | 'great';
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
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 40);

function parseCursor(cursor: string): { sessionId: string; offset: number } {
  const m = cursor.match(/^([A-Za-z0-9_-]{1,64}):(\d{1,6})$/);
  if (!m) throw new HttpError('invalid_request', 'The cursor is not valid.', { where: 'body', issues: [{ path: ['cursor'], code: 'invalid', message: 'Invalid cursor' }] });
  return { sessionId: m[1]!, offset: Number(m[2]) };
}

function sessionExpired(): HttpError {
  return new HttpError('conflict', 'This list has changed. Load it again from the top.', { reason: FEED_ERROR_CODES.sessionExpired });
}

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
   * aggregator rows only: a recruiter-bank or employer-board row is listed at
   * any age (sql.ts `ageFloorSql`; plan §3.9 "no posting-age cut-off for board
   * or bank rows"). A "posted within" filter stays a hard bound for every row
   * (its own filter predicate).
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

  /** First window: 14 days, widened to 45 under 60 rows; a posted-within filter is one window. */
  async function firstWindow(ctx: FeedCtx, filters: FilterSet, sort: FeedSort, browse = false): Promise<Window> {
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
  async function score(ctx: FeedCtx, rows: FeedJobRow[], personalized: boolean): Promise<Scored> {
    const byId = new Map<string, ScoreEntry>();
    if (!personalized) {
      for (const r of rows) byId.set(r.id, { badge: null, fit: null });
      return { user: null, byId };
    }
    const context = await deps.match.userContext(ctx.userId);
    let fits = new Map<string, Fit>();
    let mapFn: ((estimate: number) => number) | null = null;
    if (rows.length) {
      try {
        const [read, map] = await Promise.all([
          deps.match.getFits(ctx.userId, rows.map((r) => r.id), { context, rows: rows.map(toMatchRecord) }),
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

  /**
   * Rank rows for a sort; returns the kept list (after the tier view) and how
   * many the view hid. With "I need visa sponsorship" (RoboApply), jobs that
   * mention sponsorship lead the window under every sort; company scatter runs
   * inside each group so it never pulls a job ahead of that rule.
   */
  function rankRows(rows: FeedJobRow[], scored: Scored, sort: FeedSort, rc: RankContext, filters: FilterSet, personalized: boolean, head: Candidate[] = []) {
    const tiers = deps.match.config().tiers;
    const cands: Candidate[] = rows.map((row) => {
      const s = scored.byId.get(row.id) ?? { badge: null, fit: null };
      return { row, badge: s.badge, fit: s.fit, rank: sort === 'recommended' ? recommendedRank(row, s.fit, rc) : 0 };
    });
    const view = personalized ? filters.fitTier : 'all';
    const kept = cands.filter((c) => passesTier(c.badge, view, tiers));
    const market = rowsMarket(rows);
    sortCandidates(kept, sort, { currency: filters.salaryMin?.currency ?? (market === 'cn' ? 'CNY' : null), today: cnDate(rc.now) });
    const { first, rest } = sponsorshipFirst(kept, market === 'intl' && filters.needsSponsorship === true);
    const scatter = sort === 'recommended' || sort === 'best_fit';
    const firstOrdered = scatter ? scatterByCompany(first, companyKeyOf, { head }) : first;
    const restOrdered = scatter ? scatterByCompany(rest, companyKeyOf, { head: [...head, ...firstOrdered] }) : rest;
    return { kept: [...firstOrdered, ...restOrdered], hidden: cands.length - kept.length };
  }

  function rowsMarket(rows: FeedJobRow[]): string | null {
    return rows[0]?.market ?? null;
  }

  /**
   * "Why this job" for one card (PIPL Art. 24). Not personalised (GoApply
   * without 个性化推荐): the recency explanation, no reasons. Personalised: the
   * components and the skill split of the fit behind the badge (the AI's for
   * an AI score, the estimate's otherwise). No badge → no explanation.
   */
  function explanationFor(ctx: FeedCtx, c: CardCandidate, personalized: boolean): MatchExplanation | undefined {
    if (!deps.explain) return undefined;
    const market = ctx.market === 'cn' ? 'cn' : 'intl';
    try {
      if (!personalized) return deps.explain({ market, personalized: false });
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

  async function items(ctx: FeedCtx, cands: CardCandidate[], user: MatchUser | null, offset: number | null, personalized: boolean): Promise<FeedItem[]> {
    const [tracker, meta] = await Promise.all([repo.trackerStates(ctx.userId, cands.map((c) => c.row.id)), cardMetaFor(ctx, cands.map((c) => c.row))]);
    return cands.map((c, i) => {
      const item = toFeedItem(c.row, {
        user,
        fit: c.badge,
        tracker: tracker.has(c.row.id) ? { status: tracker.get(c.row.id)! } : null,
        position: offset === null ? null : offset + i,
        now: ctx.now,
        cardMeta: meta.get(c.row.id),
        explanation: explanationFor(ctx, c, personalized),
      });
      return item;
    });
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  function queryHash(input: { profile: Pick<SearchProfileWire, 'id' | 'version'>; filters: FilterSet; sort: FeedSort; order: FeedOrder; market: Market }): string {
    return sha(stableStringify({ p: input.profile.id, v: input.profile.version, f: input.filters, s: input.sort, o: input.order, m: input.market }));
  }

  function ranksOf(cands: Candidate[]) {
    return cands.map((c) => ({ jobId: c.row.id, fit: c.badge?.score ?? null, kind: c.badge?.kind ?? 'pre', rank: c.rank }));
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
  }

  /** Append the next older window(s) until `need` ids exist or the age floor is reached (≤3 windows a request). */
  async function ensureFilled(state: QueryState, session: FeedSessionRecord, need: number): Promise<FeedSessionRecord> {
    const floor = floorOf(state.filters, session.createdAt);
    let s = session;
    let changed = false;
    for (let i = 0; i < 3 && s.jobIds.length < need && olderRemain(s, floor) && state.sort !== 'deadline'; i++) {
      const to = s.windowEndsAt;
      const start = to.getTime() - L.widenWindowDays * DAY_MS;
      // The window that reaches the age floor runs to the end of the list: aggregator rows stop at the
      // floor, board and bank rows are listed at any age (`ageFloorSql`).
      const w = await retrieve(
        state.ctx,
        state.filters,
        start <= floor.getTime() ? { from: null, ageFloor: floor, to, toId: s.windowEndsId } : { from: new Date(start), to, toId: s.windowEndsId },
        state.browse,
      );
      const known = new Set(s.jobIds);
      const fresh = w.rows.filter((r) => !known.has(r.id));
      const scored = await score(state.ctx, fresh, state.personalized);
      state.user = state.user ?? scored.user;
      const tailIds = s.jobIds.slice(-(L.companyWindow - 1));
      const tailRows = await rowsFor(state, tailIds);
      const head: Candidate[] = tailRows.map((row) => ({ row, badge: null, fit: null, rank: 0 }));
      const ranked = rankRows(fresh, scored, state.sort, state.rc, state.filters, state.personalized, head);
      for (const c of ranked.kept) {
        state.rowCache.set(c.row.id, c.row);
        state.scoreCache.set(c.row.id, scored.byId.get(c.row.id) ?? { badge: c.badge, fit: c.fit });
      }
      const prevRanks = Array.isArray(s.ranks) ? s.ranks : [];
      s = {
        ...s,
        jobIds: [...s.jobIds, ...ranked.kept.map((c) => c.row.id)],
        ranks: [...prevRanks, ...ranksOf(ranked.kept)],
        totalEstimate: s.totalEstimate + fresh.length,
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
    const s = await ensureFilled(state, session, offset + L.pageSize + 1);
    const ids = s.jobIds.slice(offset, offset + L.pageSize);
    // Rows hidden or closed since the session started drop out of the page.
    const rows = await rowsFor(state, ids);
    const needScore = rows.filter((r) => !state.scoreCache.has(r.id));
    if (needScore.length) {
      const scored = await score(state.ctx, needScore, state.personalized);
      state.user = state.user ?? scored.user;
      for (const [id, v] of scored.byId) state.scoreCache.set(id, v);
    }
    const cands: CardCandidate[] = rows.map((row) => ({ row, ...(state.scoreCache.get(row.id) ?? { badge: null, fit: null }) }));
    const floor = floorOf(state.filters, s.createdAt);
    const exhausted = state.sort === 'deadline' || !olderRemain(s, floor);
    const nextOffset = offset + L.pageSize;
    const more = nextOffset < s.jobIds.length || !exhausted;
    const [cards, header] = await Promise.all([items(state.ctx, cands, state.user, offset, state.personalized), sourcesFor(state, s.createdAt)]);
    const sources = header?.sources;
    // Thin means the WHOLE list is short, not the part read so far: `jobIds` holds the windows fetched up to
    // now (the first one reaches back 14 or 45 days, the list 120). So it is said only when that is known:
    // the list has reached its age floor, or (GoApply) fewer public rows than the threshold match the query
    // at all. While older rows may still come and nothing counts them, the answer is "not thin".
    const thin = s.jobIds.length < FEED_THIN_BELOW && (exhausted || (header !== undefined && header.listed < FEED_THIN_BELOW));
    return {
      items: cards,
      cursor: more ? `${s.id}:${nextOffset}` : null,
      endOfFeed: !more,
      hiddenByTier: Math.max(0, s.totalEstimate - s.jobIds.length),
      sessionId: s.id,
      order,
      sort: state.sort,
      ...(sources ? { sources } : {}),
      thin,
    };
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
    const order: FeedOrder = personalized ? 'personalized' : 'recency';
    const sort: FeedSort = personalized || (input.sort !== 'recommended' && input.sort !== 'best_fit') ? input.sort : 'newest';
    const hash = queryHash({ profile, filters, sort, order, market: ctx.market });
    const rc = await rankContext(ctx, filters, personalized);
    const state: QueryState = { ctx, filters, sort, personalized, rc, rowCache: new Map(), scoreCache: new Map(), user: null, browse };

    if (cursor) {
      const session = await repo.getSession(cursor.sessionId, ctx.userId);
      if (!session || session.expiresAt.getTime() <= ctx.now.getTime() || session.queryHash !== hash) throw sessionExpired();
      return page(state, session, cursor.offset, order);
    }

    const w = await firstWindow(ctx, filters, sort, browse);
    const scored = await score(ctx, w.rows, personalized);
    state.user = scored.user;
    const ranked = rankRows(w.rows, scored, sort, rc, filters, personalized);
    for (const c of ranked.kept) {
      state.rowCache.set(c.row.id, c.row);
      state.scoreCache.set(c.row.id, scored.byId.get(c.row.id) ?? { badge: c.badge, fit: c.fit });
    }
    const session = await repo.createSession({
      userId: ctx.userId,
      searchProfileId: browse ? null : profile.id,
      profileVersion: browse ? null : profile.version,
      sort,
      queryHash: hash,
      jobIds: ranked.kept.map((c) => c.row.id),
      ranks: ranksOf(ranked.kept),
      totalEstimate: w.rows.length,
      windowEndsAt: w.windowEndsAt,
      windowEndsId: w.windowEndsId,
      expiresAt: new Date(ctx.now.getTime() + L.sessionTtlMin * 60_000),
    });
    // Opening the list is a visit: the Jobs badge counts from here (a category browse is not).
    if (!browse) await repo.stampFeedVisit(ctx.userId, ctx.now).catch((err) => logger.warn('FEED', 'could not stamp the feed visit', { error: String(err) }));
    return page(state, session, 0, order);
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
  async function bumpAffinity(
    ctx: Pick<FeedCtx, 'userId' | 'market'>,
    job: { primaryTaxonomyId: string | null; taxonomyIds: string[]; companyNameNormalized: string; skills: string[] },
    event: AffinityEvent,
    at: Date,
  ) {
    const userId = ctx.userId;
    if (!(await isPersonalized(userId, ctx.market))) return;
    try {
      const current = (await repo.getAffinity(userId)) ?? EMPTY_AFFINITY;
      await repo.saveAffinity(userId, applyAffinity(current, affinityKeys(job), AFFINITY_DELTAS[event], at));
    } catch (err) {
      logger.warn('FEED', 'affinity update failed', { userId, event, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function hide(ctx: FeedCtx, jobId: string, body: { reasonCode: HideReason; detail?: string }): Promise<HideJobResponse> {
    const job = await visibleJob(ctx, jobId);
    await repo.setHidden(ctx.userId, jobId, { at: ctx.now, reason: body.reasonCode });
    await repo.logInteractions([{ userId: ctx.userId, jobId, kind: 'hide', reasonCode: body.reasonCode, detail: body.detail ? { note: body.detail } : null }]);
    if (UNSPECIFIC_HIDE.has(body.reasonCode)) await bumpAffinity(ctx, job, 'hide', ctx.now);
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
    await repo.recordImpressions(ctx.userId, ids, ctx.now);
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
    const { patch, unmatched } = planToFilters(plan, body.text, ctx.market);
    const after = mergeFilterSet(profile.filters, patch);
    return { diff: await proposal(ctx, profile, after), explanation: unmatched.join('; '), unmatched };
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

  /** The top of the ranked list without a session (skills check, Assistant preview). */
  async function topRanked(ctx: FeedCtx, filters: FilterSet, sort: FeedSort, limit: number) {
    const personalized = await isPersonalized(ctx.userId, ctx.market);
    const eff: FeedSort = personalized || (sort !== 'recommended' && sort !== 'best_fit') ? sort : 'newest';
    let w = await firstWindow(ctx, filters, eff);
    // No session, so no refill: when the first window (45 days at most) cannot fill the request, read the
    // whole list once. Board and bank postings stay open for months and are listed at any age.
    if (w.rows.length < limit && eff !== 'deadline' && !filters.postedWithinDays) {
      w = await retrieve(ctx, filters, { from: null, to: null, ageFloor: floorOf(filters, ctx.now) });
    }
    const scored = await score(ctx, w.rows, personalized);
    const rc = await rankContext(ctx, filters, personalized);
    const ranked = rankRows(w.rows, scored, eff, rc, filters, personalized);
    const cands: CardCandidate[] = ranked.kept.slice(0, limit).map((c) => {
      const entry = scored.byId.get(c.row.id);
      return { row: c.row, badge: c.badge, dimensions: entry?.dimensions ?? null, skills: entry?.skills ?? null };
    });
    return { cands, user: scored.user, personalized };
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

  async function preview(ctx: FeedCtx, input: { q?: string; filters?: Partial<FilterSet>; sort?: FeedSort; limit: number }): Promise<FeedItem[]> {
    if (!postingsAllowed(ctx.market)) return [];
    const profile = await loadProfile(ctx.userId);
    const filters = effectiveFilters(ctx.market, profile.filters, { overrides: input.filters as Record<string, unknown> | undefined, q: input.q });
    const sort = input.sort === 'deadline' && ctx.market !== 'cn' ? 'recommended' : (input.sort ?? 'recommended');
    const { cands, user, personalized } = await topRanked(ctx, filters, sort, Math.max(1, Math.min(50, input.limit)));
    return items(ctx, cands, user, null, personalized);
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
    const scope: SqlScope = { market: ctx.market, userId: profile.userId, now: ctx.now, publicOnly: true, heldBanks: heldBanks() };
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
        from: new Date(ctx.now.getTime() - L.widenWindowDays * DAY_MS),
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
