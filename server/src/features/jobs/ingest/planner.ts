// server/src/features/jobs/ingest/planner.ts — the demand-driven query planner
// (ARCH §4.3; MARKET_STRATEGY §1.2 tier 2, §1.3, M-3, JI-2, JI-6, JT-3).
//
// `jobs-plan` (02:00 UTC daily), per brand:
//   1. Demand: (market, primary taxonomy role, country, city | remote) from
//      the DEFAULT search profile of every user of the brand active in the
//      last 14 days; demandScore = number of users.
//   2. SEO seeds: the first INGEST_SEED_ROLES taxonomy roles × the first
//      INGEST_SEED_CITIES_PER_COUNTRY cities (city table order = largest
//      first) of each seed country.
//   3. Which sources are planned. Only a search adapter that is ON for the
//      brand's market right now (`adapterEnabledFor`: key present, kill switch
//      off, quota gate open) and whose quota the provider has not declared
//      closed (the quota snapshot, `quotaClosed`). A source that is off gets
//      no new and no refreshed query in the run and is reported in
//      `skippedProviders`; the queries it already has are left as they are.
//      A SEED tuple is never planned on a source billed per request
//      (`adapterCostModel` 'per_request': JSearch): seeds belong to sources
//      that cost nothing per request. Nor on a metered search source whose
//      rows a feed already brings: while the licensed feed (a cursor source
//      that writes the same board, Active Jobs DB) is on for the market, the
//      feed covers the breadth and a seed search would pay per posting for
//      rows it returns anyway (`feedCoversBoard`; MARKET_STRATEGY M-2, JI-7).
//      A user's own demand is planned on every source that is on, with one
//      exception: a search source that serves BOTH markets keeps each posting
//      in the market of its own location (Active Jobs DB: adapters/rapidApi.ts
//      "One posting, one market"), so the international market does not ask
//      it for mainland China (every row would be billed and then dropped),
//      as the mainland market asks any source for mainland China only.
//   4. Which texts. One query per (tuple × query text × source):
//        a typed title        as typed, once. Market cn: never on a metered
//                             source (a mainland request to a provider is a
//                             taxonomy role's own label, never text a person
//                             typed: MARKET_STRATEGY §1.4, JC-6);
//        a taxonomy role      the texts of `providerQueryLabels`: the first
//                             English label; for Taiwan also the Traditional
//                             Chinese label once the role has one (never the
//                             Simplified label); for market cn the first
//                             Simplified label. A label goes only to a source
//                             that reads its language (`adapterQueryLanguages`).
//   5. Window and interval go together (`datePostedFor`, `baseRefreshMs`):
//        hot demand (≥ 5 users)   '3days', every 6 h
//        other demand             'week',  every 24 h
//        Taiwan demand            'month', every 12 h (either score)
//        seeds                    'week',  every 24 h
//      consecutiveEmpty ≥ 4 doubles the interval per further empty run, up to
//      7 days and never beyond the query's own window (`nextRunDelayMs`,
//      applied by the ingest run), so a window always covers a full interval.
//      The window STORED on a query is the one its source really applies
//      (`adapterDateWindow`): a source that asks one fixed frame whatever it
//      is told (Active Jobs DB: seven days) gets that frame on every query,
//      because the missed-refresh rule (tracking.ts) reads the stored value
//      to know which postings the query could still have returned.
//   6. A query's identity (`queryHash`) is market, role (taxonomy id, or the
//      typed text), query language, country, city and remote. The window and
//      the label text are not part of it: the upsert rewrites them in place,
//      so a tuple that turns hot, or a role whose label is corrected, keeps
//      its one row. When that rewrite makes the query return postings it did
//      not return before (a wider window, another text), the query's counted
//      runs start again from 0 (`runCount`), so a posting last stamped under
//      the old window or text is not judged "missed twice" by runs that could
//      not have returned it.
//   7. Retirement. On the sources planned in the run: demand nobody asked
//      for today drops to score 0, is widened from the hot window to the
//      idle one, and is disabled after 30 unused days
//      (`retireUnusedDemand`); a seed today's plan no longer names and a
//      demand query hashed by an earlier recipe are switched off
//      (`retireSuperseded`). Seed queries on a per-request source are
//      switched off whether the source is on or not (`retireSeedsFor`).
//      Queries of a provider the brand does not run at all are switched off
//      (`retireUnrunProviders`). A source that is merely off today keeps
//      every query it has, untouched, and resumes when it is back. That
//      holds for a source behind a plan too (the licensed feed; Active Jobs
//      DB for the mainland): while its gate is closed it is not in the run's
//      adapter list at all (providers.ts), but it is still a source of the
//      brand, so its standing query keeps its cursor and stays switched on,
//      and its demand keeps its score (`knownIngestProvidersForBrand`). A
//      gate that happens to be closed at 02:00 (a month's quota spent)
//      therefore never stops the feed until the next plan.
//   9. A source behind a plan is asked at plan time whether it is on. Its gate
//      reads the quota reading this process holds, and the caller may have
//      listed the brand's adapters before it loaded the stored reading (a new
//      function instance): such a list lacks a feed that is in fact on. The
//      run completes the list it was handed with the brand's sources behind a
//      plan that are on now (`planAdaptersOnNow`), so it never plans as if the
//      feed were off: no SEO seeds bought on the search adapter for a day, and
//      the standing query is there.
//   8. Two plan runs that overlap (a cron delivered twice) are safe: the
//      "planned today" stamp never moves backwards, so neither run takes the
//      other's rows for rows the plan no longer names.
// Standing syncs (banks, feeds, the Taiwan sweep) get one query per cursor
// adapter that is on for the market (`ensureBankSyncQueries`). The employer
// boards get none: their own run reads them (`JobSourceAdapter.ownRun`).
// The planner never calls a provider.

import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';
import type { ProductBrand, Market, EnvSource } from '../../../platform/brand/index.js';
import { coerceFilterSet, type FilterSet } from '../../search/index.js';
import { CITIES, citiesNamed, findCity } from '../geo/index.js';
import { TAXONOMY_NODES, getTaxonomyNode, providerQueryLabels, type ProviderQueryLabel, type QueryLanguage } from '../taxonomy/index.js';
import { adapterCostModel, adapterDateWindow, adapterEnabledFor, adapterQueryLanguages } from '../sources/index.js';
import type { IngestOrigin, IngestQueryParams, IngestProvider, JobSourceAdapter } from '../sources/index.js';
import { ACTIVE_USER_DAYS, DISABLE_UNUSED_DAYS, MAX_LOCATIONS_PER_PROFILE, quotaRecheckMs, seedCitiesPerCountry, seedCountries, seedRoleLimit } from './config.js';
import { newId, type IngestDb } from './db.js';
import { PROVIDER_QUOTA_CONFIG_KEY, parseProviderQuota, quotaBlockedUntil, usageKey, type ProviderQuotaSnapshot } from './quotaContract.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Refresh intervals and windows (pure) ──────────────────────────────────

export const REFRESH = {
  hotDemandMs: 6 * HOUR,
  coldDemandMs: 24 * HOUR,
  /** Taiwan demand, whatever its score (MARKET_STRATEGY §1.3). */
  twDemandMs: 12 * HOUR,
  seedMs: 24 * HOUR,
  bankSyncMs: 30 * 60_000,
  errorRetryMs: HOUR,
  maxMs: 7 * DAY,
  /** consecutiveEmpty at which back-off starts. */
  emptyBackoffFrom: 4,
  /** demandScore from which a tuple is hot. */
  hotDemandFrom: 5,
} as const;

/**
 * What decides a query's interval. `country` is the query's own country
 * (`RAIngestQuery.params.country`): 'TW' selects the Taiwan interval; absent,
 * null or anything else keeps the hot / cold rule.
 */
export interface RefreshInput {
  origin: IngestOrigin | string;
  demandScore: number;
  consecutiveEmpty: number;
  country?: string | null;
}

type RefreshClass = 'bank' | 'taiwan' | 'hot' | 'cold' | 'seed';

/** `IngestQueryParams.datePosted` values. */
export type DateWindow = 'all' | 'today' | '3days' | 'week' | 'month';

/** One row per class: how often it runs and how far back it asks. The window is never shorter than the interval. */
const SCHEDULE: Readonly<Record<RefreshClass, { everyMs: number; window: DateWindow }>> = {
  bank: { everyMs: REFRESH.bankSyncMs, window: 'all' },
  taiwan: { everyMs: REFRESH.twDemandMs, window: 'month' },
  hot: { everyMs: REFRESH.hotDemandMs, window: '3days' },
  cold: { everyMs: REFRESH.coldDemandMs, window: 'week' },
  seed: { everyMs: REFRESH.seedMs, window: 'week' },
};

const WINDOW_MS: Readonly<Record<DateWindow, number>> = {
  all: Number.POSITIVE_INFINITY,
  today: DAY,
  '3days': 3 * DAY,
  week: 7 * DAY,
  month: 30 * DAY,
};

function refreshClass(q: Pick<RefreshInput, 'origin' | 'demandScore' | 'country'>): RefreshClass {
  if (q.origin === 'bank_sync') return 'bank';
  if (q.demandScore >= 1 && q.country?.trim().toUpperCase() === 'TW') return 'taiwan';
  if (q.demandScore >= REFRESH.hotDemandFrom) return 'hot';
  if (q.demandScore >= 1) return 'cold';
  return 'seed';
}

/** Base interval before back-off. */
export function baseRefreshMs(q: Pick<RefreshInput, 'origin' | 'demandScore' | 'country'>): number {
  return SCHEDULE[refreshClass(q)].everyMs;
}

/** The posting window a query of this class asks for (`datePosted`). */
export function datePostedFor(q: Pick<RefreshInput, 'origin' | 'demandScore' | 'country'>): DateWindow {
  return SCHEDULE[refreshClass(q)].window;
}

/** How far back a `datePosted` value reaches; an unknown value counts as a week (the adapters' fallback). */
export function windowMs(datePosted: string): number {
  return WINDOW_MS[datePosted as DateWindow] ?? WINDOW_MS.week;
}

/** `WHEN '<window>' THEN <days>` for every bounded window of the table above (constants of this file, never input). */
const WINDOW_DAYS_CASES = Prisma.raw(
  Object.entries(WINDOW_MS)
    .filter(([, ms]) => Number.isFinite(ms))
    .map(([window, ms]) => `WHEN '${window}' THEN ${ms / DAY}`)
    .join(' '),
);

/** SQL: the days a stored `params` value reaches back; 'all', a missing or an unknown value has no bound. */
function windowDaysSql(params: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE ${params}->>'datePosted' ${WINDOW_DAYS_CASES} ELSE 100000 END)`;
}

/**
 * Interval until the next run: the base, doubled for each empty run from the
 * 4th on, capped at 7 days and at the class's own window (a query is never
 * asked less often than its window reaches back).
 */
export function nextRunDelayMs(q: RefreshInput): number {
  const { everyMs, window } = SCHEDULE[refreshClass(q)];
  if (q.origin === 'bank_sync' || q.consecutiveEmpty < REFRESH.emptyBackoffFrom) return everyMs;
  const doublings = q.consecutiveEmpty - REFRESH.emptyBackoffFrom + 1;
  return Math.min(REFRESH.maxMs, WINDOW_MS[window], everyMs * 2 ** Math.min(doublings, 20));
}

/** Lower runs first. */
export function priorityFor(origin: IngestOrigin, demandScore: number): number {
  if (origin === 'bank_sync') return 5;
  if (origin === 'manual') return 20;
  if (origin === 'demand') return demandScore >= REFRESH.hotDemandFrom ? 10 : demandScore >= 1 ? 50 : 150;
  return 200;
}

// ── Tuples (pure) ─────────────────────────────────────────────────────────

/** One unit of demand: a role in a place. Its query texts are derived when it is planned (`queryVariants`). */
export interface DemandTuple {
  market: Market;
  /** Taxonomy L3 id, when the role came from the taxonomy. */
  taxonomyId: string | null;
  /** The title a user typed, or the role's English label (for logs; a role is searched with `queryVariants`). */
  q: string;
  country: string;
  city?: string;
  remote?: boolean;
  origin: 'demand' | 'seo_seed';
  /** Distinct users behind a demand tuple (0 for seeds). */
  users: number;
}

type TuplePlace = Pick<DemandTuple, 'country' | 'city'>;
type TupleIdentity = Pick<DemandTuple, 'market' | 'taxonomyId' | 'q' | 'country' | 'city' | 'remote'>;

export function tupleKey(t: TupleIdentity): string {
  return [t.market, t.taxonomyId ?? `q:${t.q.toLowerCase()}`, t.country, t.city?.toLowerCase() ?? '', t.remote ? 'remote' : ''].join('|');
}

/**
 * The country a tuple is searched in: its own, or TW when its city is a
 * Taiwanese city and no city of that name lies in the stated country (the
 * rule the RapidAPI adapter applies to the request).
 */
export function searchCountry(t: TuplePlace): string {
  const country = t.country.trim().toUpperCase();
  if (country === 'TW' || !t.city) return country;
  const named = citiesNamed(t.city);
  if (named.length === 0 || named.some((c) => c.country === country)) return country;
  return named.every((c) => c.country === 'TW') ? 'TW' : country;
}

/** The profile's primary role: the first taxonomy L3 id, else its first typed title. */
export function primaryRole(filters: FilterSet): { taxonomyId: string | null; q: string } | null {
  for (const id of filters.taxonomyIds ?? []) {
    const node = getTaxonomyNode(id);
    if (node?.level === 3) return { taxonomyId: node.id, q: node.en };
  }
  const title = filters.titles?.find((t) => t.trim().length >= 2);
  return title ? { taxonomyId: null, q: title.trim().slice(0, 80) } : null;
}

/**
 * Demand tuples for one user's default profile (deduplicated). A location
 * whose country cannot be resolved from the profile or the city table is
 * skipped rather than guessed (D3).
 */
export function tuplesFromFilters(raw: unknown, brand: Pick<ProductBrand, 'market' | 'defaultCountry'>): Omit<DemandTuple, 'users'>[] {
  const filters = coerceFilterSet(raw, { market: brand.market }).value;
  const role = primaryRole(filters);
  if (!role) return [];
  const base = { market: brand.market, taxonomyId: role.taxonomyId, q: role.q, origin: 'demand' as const };
  const out: Omit<DemandTuple, 'users'>[] = [];
  for (const loc of (filters.locations ?? []).slice(0, MAX_LOCATIONS_PER_PROFILE)) {
    const city = loc.city ? findCity(loc.city, { country: loc.country ?? filters.country ?? null }) : null;
    const country = loc.country ?? city?.country ?? null;
    if (!country) continue;
    if (city && city.country === country) out.push({ ...base, country, city: city.name });
    else if (!loc.city) out.push({ ...base, country });
  }
  if (filters.workModels?.includes('remote')) {
    out.push({ ...base, country: filters.country ?? out[0]?.country ?? brand.defaultCountry, remote: true });
  }
  if (out.length === 0) out.push({ ...base, country: filters.country ?? brand.defaultCountry });
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = tupleKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** SEO seed tuples (none for GoApply: its inventory is the GoHire bank and the employer boards). */
export function seedTuples(brand: Pick<ProductBrand, 'market' | 'defaultCountry'>, env: EnvSource = process.env): DemandTuple[] {
  if (brand.market !== 'intl') return [];
  const roles = TAXONOMY_NODES.filter((n) => n.level === 3).slice(0, seedRoleLimit(env));
  const perCountry = seedCitiesPerCountry(env);
  const out: DemandTuple[] = [];
  for (const country of seedCountries(brand.defaultCountry, env)) {
    const cities = CITIES.filter((c) => c.country === country).slice(0, perCountry);
    for (const role of roles) {
      for (const city of cities) {
        out.push({ market: brand.market, taxonomyId: role.id, q: role.en, country, city: city.name, origin: 'seo_seed', users: 0 });
      }
    }
  }
  return out;
}

/** Merge demand and seeds; demand wins a shared tuple. */
export function mergeTuples(demand: DemandTuple[], seeds: DemandTuple[]): DemandTuple[] {
  const byKey = new Map<string, DemandTuple>();
  for (const t of seeds) byKey.set(tupleKey(t), t);
  for (const t of demand) byKey.set(tupleKey(t), t);
  return [...byKey.values()];
}

// ── Query texts (pure) ────────────────────────────────────────────────────

/** One text a tuple is searched with. `language` is null for a title a user typed (sent as typed). */
export interface QueryVariant {
  text: string;
  language: QueryLanguage | null;
}

/** Where the texts of a role come from (default: the taxonomy's `providerQueryLabels`; tests pass a fixture). */
export type QueryLabelSource = (roleId: string, options: { market: Market; country?: string | null }) => ProviderQueryLabel[];

/**
 * The texts one tuple is searched with, in the order they are planned.
 *   a typed title    the title, once, in whichever script it was typed;
 *   intl             the role's first English text;
 *   intl, Taiwan     the Traditional Chinese text (only when the taxonomy has
 *                    one: never the Simplified label, never a conversion) and
 *                    the first English text: the two return different
 *                    employers;
 *   cn               the role's first Simplified Chinese text.
 * The planner reads no node label itself: one function owns the per-market
 * query labels. A language the labels do not have gives no variant.
 */
export function queryVariants(t: Pick<DemandTuple, 'market' | 'taxonomyId' | 'q' | 'country' | 'city'>, labels: QueryLabelSource = providerQueryLabels): QueryVariant[] {
  if (!t.taxonomyId) return t.q.trim() ? [{ text: t.q.trim(), language: null }] : [];
  const country = searchCountry(t);
  const all = labels(t.taxonomyId, { market: t.market, country });
  const wanted: QueryLanguage[] = t.market === 'cn' ? ['zh-CN'] : country === 'TW' ? ['zh-TW', 'en'] : ['en'];
  const out: QueryVariant[] = [];
  for (const language of wanted) {
    const label = all.find((l) => l.language === language && l.text.trim());
    if (label) out.push({ text: label.text.trim(), language });
  }
  return out;
}

// ── Planned queries (pure) ────────────────────────────────────────────────

export interface PlannedQuery {
  provider: IngestProvider;
  market: Market;
  params: IngestQueryParams;
  paramsHash: string;
  origin: IngestOrigin;
  demandScore: number;
  priority: number;
  /** The language of `params.q`; null for a typed title. Not stored: the text's script says it. */
  language: QueryLanguage | null;
}

/**
 * sha1 of the market and the params with sorted keys, without the cursor: the
 * identity of a STANDING query (one per cursor adapter and market; its params
 * never change). The market is part of it: both brands may hold a standing
 * query for the same provider (the employer boards) and each brand leases its
 * own row (RAIngestQuery is unique on provider + hash). A planned search
 * query is identified by `queryHash`, not by this.
 */
export function paramsHash(market: Market, params: IngestQueryParams): string {
  const { cursor: _cursor, ...rest } = params;
  const sorted = Object.fromEntries(
    Object.entries({ ...rest, market })
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Marks a hash made by `queryHash`. A stored demand or seed query whose hash
 * lacks it was planned by the earlier recipe (the hash of all params, the
 * window and the label text included) and is superseded the day its provider
 * is planned again (`retireSuperseded`).
 */
export const QUERY_HASH_PREFIX = 'q2:';

/**
 * The identity of a planned search query (stored in `RAIngestQuery.paramsHash`):
 * market, role, query language, country, city, remote. The role is the
 * taxonomy id, or the typed text (lower case) when the user typed one. NOT in
 * it: the window (`datePosted` follows the demand behind the query) and the
 * label text of a taxonomy role (a corrected label keeps its row); both are
 * rewritten in place by the upsert. Two languages of one role are two queries.
 */
export function queryHash(t: TupleIdentity, language: QueryLanguage | null): string {
  const identity = {
    market: t.market,
    role: t.taxonomyId ? `id:${t.taxonomyId}` : `q:${t.q.trim().toLowerCase()}`,
    language: t.taxonomyId ? language : null,
    country: searchCountry(t),
    city: t.city?.trim().toLowerCase() || null,
    remote: t.remote === true,
  };
  return QUERY_HASH_PREFIX + createHash('sha1').update(JSON.stringify(identity)).digest('hex');
}

/**
 * The params of one query of a tuple (default text: the tuple's own, i.e. the
 * typed title), with the window the tuple's demand calls for. `planQueries`
 * then stores, per source, the window that source really applies.
 */
export function paramsForTuple(t: DemandTuple, variant?: Pick<QueryVariant, 'text'>): IngestQueryParams {
  const country = searchCountry(t);
  const params: IngestQueryParams = { q: variant?.text ?? t.q, country, datePosted: datePostedFor({ origin: t.origin, demandScore: t.users, country }) };
  if (t.taxonomyId) params.taxonomyId = t.taxonomyId;
  if (t.city) params.city = t.city;
  if (t.remote) params.remote = true;
  return params;
}

export interface PlanOptions {
  /** Where role texts come from (default `providerQueryLabels`). */
  queryLabels?: QueryLabelSource;
}

/**
 * Does a feed that is on for the market already bring the rows of this search
 * source? A cursor source that writes one of the search source's boards (the
 * licensed Active Jobs DB window feed and its on-demand search adapter both
 * write 'activejobs'). The banks and the employer boards write their own
 * boards and cover no search source.
 */
export function feedCoversBoard(source: Pick<JobSourceAdapter, 'provider' | 'sourceBoards'>, adapters: readonly JobSourceAdapter[], market: Market): boolean {
  return adapters.some(
    (a) => a.kind === 'cursor' && a.provider !== source.provider && a.markets.includes(market) && a.sourceBoards.some((b) => source.sourceBoards.includes(b)) && adapterEnabledFor(a, market),
  );
}

/**
 * One query per (tuple × query text × search adapter). An adapter gets a
 * tuple only when it serves the tuple's market, is on for it right now, can
 * search the country and, for a role label, reads the label's language. A
 * seed tuple is never planned on an adapter billed per request, nor on a
 * metered adapter whose board a feed that is on already fills. For market cn a
 * title a person typed is never planned on a metered adapter. An adapter that
 * serves both markets is never asked by the international one for mainland
 * China (its mainland rows belong to the mainland index). Each query
 * carries the window its own adapter applies (`adapterDateWindow`): the one
 * the demand calls for when the adapter honours it, else the adapter's fixed
 * frame. The result holds each (provider, `queryHash`) once.
 */
export function planQueries(tuples: DemandTuple[], adapters: readonly JobSourceAdapter[], options: PlanOptions = {}): PlannedQuery[] {
  const search = adapters.filter((a) => a.kind === 'search');
  if (search.length === 0) return [];
  // Asked once per (source, market): the answer reads the feed's gate.
  const covered = new Map<string, boolean>();
  const seedsCovered = (a: JobSourceAdapter, market: Market): boolean => {
    const key = `${a.provider}|${market}`;
    let answer = covered.get(key);
    if (answer === undefined) {
      answer = adapterCostModel(a) !== 'free' && feedCoversBoard(a, adapters, market);
      covered.set(key, answer);
    }
    return answer;
  };
  // Asked once per market, not once per tuple (an adapter reads env and its breaker to answer).
  const on = new Map<string, boolean>();
  const isOn = (a: JobSourceAdapter, market: Market): boolean => {
    const key = `${a.provider}|${market}`;
    let answer = on.get(key);
    if (answer === undefined) {
      answer = a.markets.includes(market) && adapterEnabledFor(a, market);
      on.set(key, answer);
    }
    return answer;
  };
  // One row per (provider, identity): two tuples that resolve to the same search (a city given under
  // two countries) are one query, with the larger demand. A statement must not name a row twice.
  const out = new Map<string, PlannedQuery>();
  for (const t of tuples) {
    const country = searchCountry(t);
    const usable = search.filter((a) => {
      if (!isOn(a, t.market)) return false;
      // SEO seeds only where a request costs nothing (MARKET_STRATEGY M-3), and never where a feed already brings the rows (M-2).
      if (t.origin === 'seo_seed' && (adapterCostModel(a) === 'per_request' || seedsCovered(a, t.market))) return false;
      // A search for market cn asks for mainland postings only: any other row would be dropped as wrong_market.
      if (t.market === 'cn' && country !== MAINLAND_COUNTRY) return false;
      // And the mirror: a source that serves both markets writes a mainland posting for the mainland only (one
      // posting, one market), so every row an international query for mainland China returned would be dropped.
      if (t.market !== 'cn' && country === MAINLAND_COUNTRY && a.markets.includes('cn')) return false;
      try {
        return a.supportsCountry(country) === true;
      } catch {
        return false;
      }
    });
    if (usable.length === 0) continue;
    for (const variant of queryVariants(t, options.queryLabels)) {
      const takers =
        variant.language === null
          ? // A typed title goes to every source as typed; on the mainland only to a source that is not a metered provider.
            usable.filter((a) => t.market !== 'cn' || adapterCostModel(a) === 'free')
          : usable.filter((a) => adapterQueryLanguages(a).includes(variant.language!));
      if (takers.length === 0) continue;
      const params = paramsForTuple(t, variant);
      const hash = queryHash(t, variant.language);
      for (const a of takers) {
        const key = `${a.provider}|${hash}`;
        const prior = out.get(key);
        if (prior && (prior.demandScore > t.users || (prior.demandScore === t.users && prior.origin === 'demand'))) continue;
        // What is stored is what the source is asked: never a window it would ignore.
        const window = adapterDateWindow(a, params.datePosted);
        out.set(key, {
          provider: a.provider,
          market: t.market,
          params: window === params.datePosted ? params : { ...params, datePosted: window },
          paramsHash: hash,
          origin: t.origin,
          demandScore: t.users,
          priority: priorityFor(t.origin, t.users),
          language: variant.language,
        });
      }
    }
  }
  return [...out.values()];
}

/** The country whose postings belong to the mainland market (normalize `marketOfPosting`). */
const MAINLAND_COUNTRY = 'CN';

/** The standing bank-sync query params (the cursor lives beside them). */
export const BANK_SYNC_PARAMS: IngestQueryParams = { q: '', country: '*', datePosted: 'all' };

// ── Which adapters a run plans (pure) ─────────────────────────────────────

const CLOSED_QUOTA_STATES: ReadonlySet<string> = new Set(['exhausted', 'not_subscribed', 'unauthorized']);

/**
 * The provider itself said its quota is closed (state exhausted, not
 * subscribed or unauthorized) and that reading still blocks calls. For how
 * long a reading blocks is ingest's own rule (`quotaBlockedUntil`), so the
 * planner and the tick agree: a used-up plan until its stated reset; a refused
 * key or a missing subscription for an hour after the answer, whatever reset
 * its headers carry (ingest asks again hourly, and the planner must not keep
 * the provider out of the plan for the rest of the month); either cut short
 * by INGEST_QUOTA_RECHECK_HOURS. Past that, the adapter's own answer decides.
 */
export function quotaClosed(snapshot: Pick<ProviderQuotaSnapshot, 'state' | 'resetAt' | 'observedAt'> | null | undefined, now: Date, env: EnvSource = process.env): boolean {
  if (!snapshot || !CLOSED_QUOTA_STATES.has(snapshot.state)) return false;
  return quotaBlockedUntil(snapshot, now, quotaRecheckMs(env)) !== null;
}

export interface PlannableAdapters {
  /** The market's adapters that are planned in this run. */
  open: JobSourceAdapter[];
  /** Providers of the market left out of the run: off, or (a metered search source) quota closed. */
  skipped: IngestProvider[];
}

/**
 * Splits a brand's adapters for one plan run. An adapter of another market is
 * in neither list. A metered search adapter is also left out while the quota
 * snapshot says its provider is closed (the market's own counter key first,
 * then the provider's).
 */
export function plannableAdapters(
  adapters: readonly JobSourceAdapter[],
  market: Market,
  quota: ReadonlyMap<string, ProviderQuotaSnapshot> = new Map(),
  now: Date = new Date(),
  env: EnvSource = process.env,
): PlannableAdapters {
  const open: JobSourceAdapter[] = [];
  const skipped: IngestProvider[] = [];
  for (const a of adapters) {
    if (!a.markets.includes(market)) continue;
    const metered = a.kind === 'search' && adapterCostModel(a) !== 'free';
    const closed = metered && [usageKey(a.provider, market), a.provider].some((key) => quotaClosed(quota.get(key), now, env));
    if (!closed && adapterEnabledFor(a, market)) open.push(a);
    else if (!skipped.includes(a.provider)) skipped.push(a.provider);
  }
  return { open, skipped };
}

/** Search providers of the market that are billed per request, on or off. */
export function perRequestProviders(adapters: readonly JobSourceAdapter[], market: Market): IngestProvider[] {
  return [...new Set(adapters.filter((a) => a.kind === 'search' && a.markets.includes(market) && adapterCostModel(a) === 'per_request').map((a) => a.provider))];
}

// ── Database steps ────────────────────────────────────────────────────────

/** Demand tuples from active users' default profiles, aggregated by distinct users. */
export async function collectDemand(db: IngestDb, brand: ProductBrand, now: Date): Promise<DemandTuple[]> {
  const since = new Date(now.getTime() - ACTIVE_USER_DAYS * DAY);
  const counts = new Map<string, { tuple: Omit<DemandTuple, 'users'>; users: Set<string> }>();
  let cursor: string | undefined;
  for (;;) {
    const users = await db.user.findMany({
      where: { brand: brand.id, lastActiveAt: { gte: since } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (users.length === 0) break;
    const profiles = await db.rASearchProfile.findMany({
      where: { userId: { in: users.map((u) => u.id) }, isDefault: true },
      select: { userId: true, filters: true },
    });
    for (const p of profiles) {
      for (const tuple of tuplesFromFilters(p.filters, brand)) {
        const k = tupleKey(tuple);
        const entry = counts.get(k) ?? { tuple, users: new Set<string>() };
        entry.users.add(p.userId);
        counts.set(k, entry);
      }
    }
    if (users.length < 1000) break;
    cursor = users[users.length - 1]!.id;
  }
  return [...counts.values()].map(({ tuple, users }) => ({ ...tuple, users: users.size }));
}

/**
 * The stored quota snapshots by provider key (AppConfig, written by the
 * ingest run from the providers' own response headers). Nothing stored, an
 * unreadable row or a failed read gives an empty map: the planner then knows
 * nothing about any quota, which is the truth, and plans by the adapters'
 * own answers.
 */
export async function readQuotaSnapshots(db: IngestDb): Promise<Map<string, ProviderQuotaSnapshot>> {
  try {
    const row = await db.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY }, select: { value: true } });
    return parseProviderQuota(row?.value);
  } catch {
    return new Map();
  }
}

/**
 * Bulk upsert of planned queries (chunks of 200). Returns rows written.
 *
 * The daily plan (`targeted` false) is authoritative: it sets demandScore and
 * priority from today's user counts and rewrites the params (the window that
 * goes with today's score, the current label text), keeping a stored cursor.
 * A targeted ingest (one onboarding profile, `targeted` true) only ADDS
 * demand: an existing query keeps the higher demandScore, the more urgent
 * (lower) priority and its stored params, so a popular query is never
 * demoted, and never given the window of a one-user query, until the next
 * plan recounts it.
 *
 * When the daily rewrite WIDENS a query's window or changes its text, the
 * query can return postings its earlier runs could not: its counted runs
 * (`runCount`, the clock of the missed-refresh rule in tracking.ts) start
 * again from 0. A posting stamped before the change then needs two counted
 * runs of the query AS IT IS NOW without being returned before it can be
 * archived as removed; until then it is left to expiresAt and the 45-day
 * rule. A narrower window keeps the count: the rule's own window guard
 * already protects what dropped out of it.
 *
 * `updatedAt` is the "planned today" stamp the retirement statements compare
 * with the run's start. It never moves backwards, so when two plan runs
 * overlap, the earlier one writing last does not make the later one's
 * `retireSuperseded` take today's rows for rows the plan no longer names.
 */
export async function upsertPlannedQueries(db: IngestDb, planned: PlannedQuery[], now: Date, options: { targeted?: boolean } = {}): Promise<number> {
  const demandScore = options.targeted
    ? Prisma.sql`GREATEST("RAIngestQuery"."demandScore", EXCLUDED."demandScore")`
    : Prisma.sql`EXCLUDED."demandScore"`;
  const priority = options.targeted ? Prisma.sql`LEAST("RAIngestQuery"."priority", EXCLUDED."priority")` : Prisma.sql`EXCLUDED."priority"`;
  const params = options.targeted
    ? Prisma.sql`"RAIngestQuery"."params"`
    : Prisma.sql`EXCLUDED."params" || jsonb_strip_nulls(jsonb_build_object('cursor', "RAIngestQuery"."params"->'cursor'))`;
  // Only the daily plan rewrites params, so only it can change what a query returns.
  const runCount = options.targeted
    ? Prisma.empty
    : Prisma.sql`"runCount" = CASE WHEN "RAIngestQuery"."origin" NOT IN ('manual', 'bank_sync')
          AND ("RAIngestQuery"."params"->>'q' IS DISTINCT FROM EXCLUDED."params"->>'q'
            OR ${windowDaysSql(Prisma.sql`EXCLUDED."params"`)} > ${windowDaysSql(Prisma.sql`"RAIngestQuery"."params"`)})
          THEN 0 ELSE "RAIngestQuery"."runCount" END,`;
  let written = 0;
  for (let i = 0; i < planned.length; i += 200) {
    const chunk = planned.slice(i, i + 200);
    const values = chunk.map(
      (p) =>
        Prisma.sql`(${newId()}, ${p.market}, ${p.provider}, ${p.paramsHash}, ${JSON.stringify(p.params)}::jsonb, ${p.origin}, ${p.demandScore}::int, ${p.priority}::int, true, ${now}::timestamp(3), ${now}::timestamp(3), ${now}::timestamp(3))`,
    );
    written += await db.$executeRaw(Prisma.sql`
      INSERT INTO "RAIngestQuery" ("id", "market", "provider", "paramsHash", "params", "origin", "demandScore", "priority", "enabled", "nextRunAt", "createdAt", "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("provider", "paramsHash") DO UPDATE SET
        "demandScore" = ${demandScore},
        "priority" = CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync') THEN "RAIngestQuery"."priority" ELSE ${priority} END,
        "origin" = CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync') THEN "RAIngestQuery"."origin" ELSE EXCLUDED."origin" END,
        "params" = CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync') THEN "RAIngestQuery"."params" ELSE ${params} END,
        "nextRunAt" = CASE WHEN "RAIngestQuery"."enabled" THEN "RAIngestQuery"."nextRunAt" ELSE EXCLUDED."nextRunAt" END,
        ${runCount}
        "enabled" = true,
        "updatedAt" = GREATEST("RAIngestQuery"."updatedAt", EXCLUDED."updatedAt")`);
  }
  return written;
}

/**
 * Demand queries absent from today's plan drop to demandScore 0 (this stamps
 * updatedAt once); those still at 0 after 30 days are disabled.
 *
 * A demand query at score 0 runs at the seed interval, so it never keeps the
 * hot three-day window: the second statement widens it to the seed window (a
 * window never ends up shorter than the interval) and starts the query's
 * counted runs again from 0, for the reason given at `upsertPlannedQueries`:
 * postings that only aged out of the three-day window were last stamped
 * several runs ago, and must not be judged against the week the query asks
 * for from now on. The statement looks at every score-0 demand row, not only
 * the ones zeroed in this run, so a row whose old window was written back by
 * an ingest run that was in flight during an earlier plan is put right by
 * the next one. It does not stamp updatedAt (the 30-day clock is not its
 * business).
 *
 * Seeds, manual queries and bank syncs are never touched here, and neither
 * are the queries of a provider that was left out of the run
 * (`skippedProviders`): nothing was planned for it today, so "absent from the
 * plan" says nothing about its demand. They keep their score and resume as
 * they are when the provider is back.
 */
export async function retireUnusedDemand(
  db: IngestDb,
  market: Market,
  runStartedAt: Date,
  skippedProviders: readonly string[] = [],
): Promise<{ zeroed: number; disabled: number; widened: number }> {
  const hotWindow: DateWindow = SCHEDULE.hot.window;
  const idleWindow = JSON.stringify(SCHEDULE.seed.window);
  const skipped = [...skippedProviders];
  const zeroed = await db.$executeRaw`
    UPDATE "RAIngestQuery" SET "demandScore" = 0, "priority" = ${priorityFor('demand', 0)}::int, "updatedAt" = now()
    WHERE "market" = ${market} AND "origin" = 'demand' AND "demandScore" > 0 AND "updatedAt" < ${runStartedAt}::timestamp(3)
      AND NOT ("provider" = ANY(${skipped}::text[]))`;
  const widened = await db.$executeRaw`
    UPDATE "RAIngestQuery" SET "params" = jsonb_set("params", '{datePosted}', ${idleWindow}::jsonb), "runCount" = 0
    WHERE "market" = ${market} AND "origin" = 'demand' AND "demandScore" = 0 AND "params"->>'datePosted' = ${hotWindow}
      AND NOT ("provider" = ANY(${skipped}::text[]))`;
  const disabled = await db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = false
    WHERE "market" = ${market} AND "origin" = 'demand' AND "enabled" = true AND "demandScore" = 0
      AND "updatedAt" < now() - make_interval(days => ${DISABLE_UNUSED_DAYS}::int)
      AND NOT ("provider" = ANY(${skipped}::text[]))`;
  return { zeroed, disabled, widened };
}

/**
 * Switches off the market's queries of a provider the brand does not run: a
 * provider that left the registry (the `linkedin` RapidAPI source), one that
 * never serves this market (a `jsearch` query created for market cn under the
 * old CN_EXTERNAL_PROVIDERS switch) or one narrowed away by
 * JOB_PROVIDERS_<BRAND>. No tick ever leases such a row, so left enabled it
 * would stay due for good and the System panel would report a backlog that is
 * not one. A provider that comes back is switched on again by the plan itself
 * (`upsertPlannedQueries` for search queries, `ensureBankSyncQueries` for the
 * standing bank and board queries). A provider the brand runs but that is OFF
 * right now (no key, quota closed) is not retired: its queries wait. Neither
 * is a source of the brand that is not in `adapters` because it stands behind
 * a plan whose gate is closed right now (`waiting`): its standing query keeps
 * its cursor and runs again on the first tick that finds the gate open.
 */
export async function retireUnrunProviders(db: IngestDb, market: Market, adapters: readonly JobSourceAdapter[], waiting: readonly string[] = []): Promise<number> {
  const providers = [...new Set<string>([...adapters.filter((a) => a.markets.includes(market)).map((a) => a.provider), ...waiting])];
  return db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = false
    WHERE "market" = ${market} AND "enabled" = true AND NOT ("provider" = ANY(${providers}::text[]))`;
}

/**
 * Switches off the market's SEO seed queries of these providers: the search
 * sources billed per request (`perRequestProviders`), on which earlier plans
 * created one seed query per role and city. Whether the source is on right
 * now does not matter: such a query is never wanted. Idempotent: a second run
 * finds nothing enabled. A seed tuple a user then asks for is planned as
 * demand, under the same identity, and the upsert switches its row on again.
 */
export async function retireSeedsFor(db: IngestDb, market: Market, providers: readonly string[]): Promise<number> {
  if (providers.length === 0) return 0;
  return db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = false
    WHERE "market" = ${market} AND "origin" = 'seo_seed' AND "enabled" = true AND "provider" = ANY(${[...providers]}::text[])`;
}

/**
 * Switches off, for the providers PLANNED in this run, the queries today's
 * plan replaced:
 *   - a seed query the plan no longer names (fewer seed roles, cities or
 *     countries; a role the source stopped getting seeds for; a seed hashed
 *     by the earlier recipe). The upsert stamped every planned row with the
 *     run's start time, so an older stamp means "not named today";
 *   - a demand query hashed by the earlier recipe: today's plan wrote its
 *     twin under `queryHash`, and two rows would ask the provider twice.
 * A provider that was skipped in the run is not in `providers`: its queries
 * are left alone until the run that plans it again. The next plan that names
 * a retired seed switches it on again. The stamp never moves backwards
 * (`upsertPlannedQueries`), so a second plan run overlapping this one cannot
 * make today's seeds look unnamed.
 */
export async function retireSuperseded(db: IngestDb, market: Market, providers: readonly string[], runStartedAt: Date): Promise<number> {
  if (providers.length === 0) return 0;
  return db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = false
    WHERE "market" = ${market} AND "enabled" = true AND "provider" = ANY(${[...providers]}::text[])
      AND (("origin" = 'seo_seed' AND "updatedAt" < ${runStartedAt}::timestamp(3))
        OR ("origin" = 'demand' AND "paramsHash" NOT LIKE ${`${QUERY_HASH_PREFIX}%`}))`;
}

/**
 * One standing sync query per cursor adapter that is on for the market
 * (never resets an existing cursor). An adapter that is off gets no new
 * query and its existing one is left alone. A standing query that was
 * switched off while its provider was not run (`retireUnrunProviders`) is
 * switched on again and made due.
 *
 * A source read by a run of its own (`ownRun`: the employer boards, cron
 * `jobs-boards`) gets none, and one planned for it earlier is switched off:
 * the tick would lease it every 30 minutes, read nothing, and write an empty
 * "last run" over the status the source's own run stores.
 */
export async function ensureBankSyncQueries(db: IngestDb, market: Market, adapters: readonly JobSourceAdapter[]): Promise<number> {
  const ownRun = adapters.filter((a) => a.kind === 'cursor' && a.ownRun === true && a.markets.includes(market)).map((a) => a.provider as string);
  if (ownRun.length > 0) {
    await db.$executeRaw`
      UPDATE "RAIngestQuery" SET "enabled" = false
      WHERE "market" = ${market} AND "origin" = 'bank_sync' AND "enabled" = true AND "provider" = ANY(${ownRun}::text[])`;
  }
  const banks = adapters.filter((a) => a.kind === 'cursor' && a.ownRun !== true && a.markets.includes(market) && adapterEnabledFor(a, market));
  if (banks.length === 0) return 0;
  const hash = paramsHash(market, BANK_SYNC_PARAMS);
  const { count } = await db.rAIngestQuery.createMany({
    data: banks.map((a) => ({
      market,
      provider: a.provider,
      paramsHash: hash,
      params: { ...BANK_SYNC_PARAMS },
      origin: 'bank_sync',
      priority: priorityFor('bank_sync', 0),
    })),
    skipDuplicates: true,
  });
  await db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = true, "nextRunAt" = now()
    WHERE "market" = ${market} AND "origin" = 'bank_sync' AND "enabled" = false AND "provider" = ANY(${banks.map((a) => a.provider)}::text[])`;
  return count;
}

export interface PlannerResult {
  demandTuples: number;
  seedTuples: number;
  planned: number;
  written: number;
  zeroed: number;
  disabled: number;
  /** Queries switched off because the brand does not run their provider. */
  retired: number;
  /** Seed queries switched off on the sources billed per request. */
  seedsRetired: number;
  /** Queries of the planned sources that today's plan replaced (seeds it no longer names, demand hashed by the earlier recipe). */
  superseded: number;
  bankQueries: number;
  /** Sources of this market left out of the run because they are off or their quota is closed. Their queries were not touched. */
  skippedProviders: string[];
}

export interface RunPlannerOptions {
  now?: Date;
  env?: EnvSource;
  queryLabels?: QueryLabelSource;
  /**
   * Every ingest source the brand has, on or off (default: the job source
   * registry's list for the brand, `knownIngestProvidersForBrand`). One of
   * them that is missing from `adapters` stands behind a plan whose gate is
   * closed right now: nothing is planned for it and nothing of it is retired.
   */
  knownProviders?: readonly string[];
}

/**
 * The whole `jobs-plan` run for one brand. `given` is the brand's adapter
 * list as the caller made it (providers.ts `adaptersForBrand`); the caller
 * has loaded the stored quota reading before this runs (cron.ts).
 */
export async function runPlanner(db: IngestDb, brand: ProductBrand, given: readonly JobSourceAdapter[], options: RunPlannerOptions = {}): Promise<PlannerResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const market = brand.market;
  // The brand's source lists live with the adapters (providers.ts), whose imports reach back into this area:
  // loaded on demand, so this module stays free of that cycle at load time.
  const { knownIngestProvidersForBrand, planAdaptersOnNow } = await import('./providers.js');
  // Sources behind a plan are asked now (header, point 9): one that is on and missing from the list joins the run.
  const late = planAdaptersOnNow(brand, env).filter((a) => !given.some((g) => g.provider === a.provider));
  const adapters: readonly JobSourceAdapter[] = late.length > 0 ? [...given, ...late] : given;
  const { open, skipped } = plannableAdapters(adapters, market, await readQuotaSnapshots(db), now, env);
  // Sources of the brand the run was not given: behind a plan, gate closed at this hour. Their queries wait.
  const known: readonly string[] = options.knownProviders ?? knownIngestProvidersForBrand(brand, env);
  const waiting = known.filter((provider) => !adapters.some((a) => a.provider === provider && a.markets.includes(market)));
  const demand = await collectDemand(db, brand, now);
  const seeds = seedTuples(brand, env);
  const planned = planQueries(mergeTuples(demand, seeds), open, { queryLabels: options.queryLabels });
  const written = await upsertPlannedQueries(db, planned, now);
  const { zeroed, disabled } = await retireUnusedDemand(db, market, now, [...skipped, ...waiting]);
  const retired = await retireUnrunProviders(db, market, adapters, waiting);
  const seedsRetired = await retireSeedsFor(db, market, perRequestProviders(adapters, market));
  const plannedSearch = open.filter((a) => a.kind === 'search').map((a) => a.provider);
  const superseded = await retireSuperseded(db, market, plannedSearch, now);
  const bankQueries = await ensureBankSyncQueries(db, market, open);
  return {
    demandTuples: demand.length,
    seedTuples: seeds.length,
    planned: planned.length,
    written,
    zeroed,
    disabled,
    retired,
    seedsRetired,
    superseded,
    bankQueries,
    skippedProviders: skipped,
  };
}
