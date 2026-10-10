// server/src/features/jobs/ingest/planner.ts — the demand-driven query planner (ARCH §4.3).
//
// `jobs-plan` (02:00 UTC daily), per brand:
//   1. Demand: (market, primary taxonomy L3 label in English, country, city |
//      remote) from the DEFAULT search profile of every user of the brand
//      active in the last 14 days; demandScore = number of users.
//   2. SEO seeds: the first INGEST_SEED_ROLES taxonomy roles × the first
//      INGEST_SEED_CITIES_PER_COUNTRY cities (city table order = largest
//      first) of each seed country.
//   3. Upsert one RAIngestQuery per (search provider supporting the country ×
//      tuple). Refresh: 6 h at demandScore ≥ 5, 12 h at ≥ 1, 24 h for seeds;
//      consecutiveEmpty ≥ 4 doubles the interval per further empty run, up to
//      7 days (`nextRunDelayMs`, applied by the ingest run).
//   4. Demand queries nobody used for 30 days are disabled (seeds never).
// Bank syncs get one standing query per bank (`ensureBankSyncQueries`).
// The planner never calls a provider.

import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';
import type { ProductBrand, Market, EnvSource } from '../../../platform/brand/index.js';
import { coerceFilterSet, type FilterSet } from '../../search/index.js';
import { CITIES, findCity } from '../geo/index.js';
import { TAXONOMY_NODES, getTaxonomyNode } from '../taxonomy/index.js';
import type { IngestOrigin, IngestQueryParams, IngestProvider, JobSourceAdapter } from '../sources/index.js';
import { ACTIVE_USER_DAYS, DISABLE_UNUSED_DAYS, MAX_LOCATIONS_PER_PROFILE, seedCitiesPerCountry, seedCountries, seedRoleLimit } from './config.js';
import { newId, type IngestDb } from './db.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Refresh intervals (pure) ──────────────────────────────────────────────

export const REFRESH = {
  hotDemandMs: 6 * HOUR,
  demandMs: 12 * HOUR,
  seedMs: 24 * HOUR,
  bankSyncMs: 30 * 60_000,
  errorRetryMs: HOUR,
  maxMs: 7 * DAY,
  /** consecutiveEmpty at which back-off starts. */
  emptyBackoffFrom: 4,
} as const;

export interface RefreshInput {
  origin: IngestOrigin | string;
  demandScore: number;
  consecutiveEmpty: number;
}

/** Base interval before back-off. */
export function baseRefreshMs(q: Pick<RefreshInput, 'origin' | 'demandScore'>): number {
  if (q.origin === 'bank_sync') return REFRESH.bankSyncMs;
  if (q.demandScore >= 5) return REFRESH.hotDemandMs;
  if (q.demandScore >= 1) return REFRESH.demandMs;
  return REFRESH.seedMs;
}

/** Interval until the next run: the base, doubled for each empty run from the 4th on, capped at 7 days. */
export function nextRunDelayMs(q: RefreshInput): number {
  const base = baseRefreshMs(q);
  if (q.origin === 'bank_sync' || q.consecutiveEmpty < REFRESH.emptyBackoffFrom) return base;
  const doublings = q.consecutiveEmpty - REFRESH.emptyBackoffFrom + 1;
  return Math.min(REFRESH.maxMs, base * 2 ** Math.min(doublings, 20));
}

/** Lower runs first. */
export function priorityFor(origin: IngestOrigin, demandScore: number): number {
  if (origin === 'bank_sync') return 5;
  if (origin === 'manual') return 20;
  if (origin === 'demand') return demandScore >= 5 ? 10 : demandScore >= 1 ? 50 : 150;
  return 200;
}

// ── Tuples (pure) ─────────────────────────────────────────────────────────

export interface DemandTuple {
  market: Market;
  /** Taxonomy L3 id, when the role came from the taxonomy. */
  taxonomyId: string | null;
  /** English role text. */
  q: string;
  country: string;
  city?: string;
  remote?: boolean;
  origin: 'demand' | 'seo_seed';
  /** Distinct users behind a demand tuple (0 for seeds). */
  users: number;
}

export function tupleKey(t: Pick<DemandTuple, 'market' | 'taxonomyId' | 'q' | 'country' | 'city' | 'remote'>): string {
  return [t.market, t.taxonomyId ?? `q:${t.q.toLowerCase()}`, t.country, t.city?.toLowerCase() ?? '', t.remote ? 'remote' : ''].join('|');
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

/** SEO seed tuples (none for GoApply: its inventory is the GoHire bank). */
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

// ── Planned queries (pure) ────────────────────────────────────────────────

export interface PlannedQuery {
  provider: IngestProvider;
  market: Market;
  params: IngestQueryParams;
  paramsHash: string;
  origin: IngestOrigin;
  demandScore: number;
  priority: number;
}

/**
 * sha1 of the market and the params with sorted keys, without the cursor.
 * The market is part of a query's identity: RoboApply and GoApply may plan
 * the same params for the same provider (e.g. JSearch, country CN) and each
 * brand must lease its own row (RAIngestQuery is unique on provider + hash).
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

export function paramsForTuple(t: DemandTuple): IngestQueryParams {
  const params: IngestQueryParams = { q: t.q, country: t.country, datePosted: 'week' };
  if (t.taxonomyId) params.taxonomyId = t.taxonomyId;
  if (t.city) params.city = t.city;
  if (t.remote) params.remote = true;
  return params;
}

/** One query per (search adapter that supports the tuple's country) × tuple. */
export function planQueries(tuples: DemandTuple[], adapters: readonly JobSourceAdapter[]): PlannedQuery[] {
  const search = adapters.filter((a) => a.kind === 'search');
  const out: PlannedQuery[] = [];
  for (const t of tuples) {
    const params = paramsForTuple(t);
    const hash = paramsHash(t.market, params);
    for (const a of search) {
      if (!a.markets.includes(t.market)) continue;
      if (t.market === 'cn' && t.country !== 'CN') continue; // a market-cn search adapter (none today) may search mainland China only
      let ok = false;
      try {
        ok = a.supportsCountry(t.country);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      out.push({ provider: a.provider, market: t.market, params, paramsHash: hash, origin: t.origin, demandScore: t.users, priority: priorityFor(t.origin, t.users) });
    }
  }
  return out;
}

/** The standing bank-sync query params (the cursor lives beside them). */
export const BANK_SYNC_PARAMS: IngestQueryParams = { q: '', country: '*', datePosted: 'all' };

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
 * Bulk upsert of planned queries (chunks of 200). Returns rows written.
 *
 * The daily plan (`targeted` false) is authoritative: it sets demandScore and
 * priority from today's user counts. A targeted ingest (one onboarding
 * profile, `targeted` true) only ADDS demand: an existing query keeps the
 * higher demandScore and the more urgent (lower) priority, so a popular query
 * is never demoted until the next plan recounts it.
 */
export async function upsertPlannedQueries(db: IngestDb, planned: PlannedQuery[], now: Date, options: { targeted?: boolean } = {}): Promise<number> {
  const demandScore = options.targeted
    ? Prisma.sql`GREATEST("RAIngestQuery"."demandScore", EXCLUDED."demandScore")`
    : Prisma.sql`EXCLUDED."demandScore"`;
  const priority = options.targeted ? Prisma.sql`LEAST("RAIngestQuery"."priority", EXCLUDED."priority")` : Prisma.sql`EXCLUDED."priority"`;
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
        "nextRunAt" = CASE WHEN "RAIngestQuery"."enabled" THEN "RAIngestQuery"."nextRunAt" ELSE EXCLUDED."nextRunAt" END,
        "enabled" = true,
        "updatedAt" = EXCLUDED."updatedAt"`);
  }
  return written;
}

/**
 * Demand queries absent from today's plan drop to demandScore 0 (this stamps
 * updatedAt once); those still at 0 after 30 days are disabled. Seeds,
 * manual queries and bank syncs are never disabled here.
 */
export async function retireUnusedDemand(db: IngestDb, market: Market, runStartedAt: Date): Promise<{ zeroed: number; disabled: number }> {
  const zeroed = await db.$executeRaw`
    UPDATE "RAIngestQuery" SET "demandScore" = 0, "priority" = ${priorityFor('demand', 0)}::int, "updatedAt" = now()
    WHERE "market" = ${market} AND "origin" = 'demand' AND "demandScore" > 0 AND "updatedAt" < ${runStartedAt}::timestamp(3)`;
  const disabled = await db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = false
    WHERE "market" = ${market} AND "origin" = 'demand' AND "enabled" = true AND "demandScore" = 0
      AND "updatedAt" < now() - make_interval(days => ${DISABLE_UNUSED_DAYS}::int)`;
  return { zeroed, disabled };
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
 * standing bank and board queries).
 */
export async function retireUnrunProviders(db: IngestDb, market: Market, adapters: readonly JobSourceAdapter[]): Promise<number> {
  const providers = [...new Set(adapters.filter((a) => a.markets.includes(market)).map((a) => a.provider))];
  return db.$executeRaw`
    UPDATE "RAIngestQuery" SET "enabled" = false
    WHERE "market" = ${market} AND "enabled" = true AND NOT ("provider" = ANY(${providers}::text[]))`;
}

/**
 * One standing bank-sync query per cursor adapter (never resets an existing
 * cursor). A standing query that was switched off while its provider was not
 * run (`retireUnrunProviders`) is switched on again and made due.
 */
export async function ensureBankSyncQueries(db: IngestDb, market: Market, adapters: readonly JobSourceAdapter[]): Promise<number> {
  const banks = adapters.filter((a) => a.kind === 'cursor' && a.markets.includes(market));
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
  bankQueries: number;
}

/** The whole `jobs-plan` run for one brand. */
export async function runPlanner(
  db: IngestDb,
  brand: ProductBrand,
  adapters: readonly JobSourceAdapter[],
  options: { now?: Date; env?: EnvSource } = {},
): Promise<PlannerResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const demand = await collectDemand(db, brand, now);
  const seeds = seedTuples(brand, env);
  const planned = planQueries(mergeTuples(demand, seeds), adapters);
  const written = await upsertPlannedQueries(db, planned, now);
  const { zeroed, disabled } = await retireUnusedDemand(db, brand.market, now);
  const retired = await retireUnrunProviders(db, brand.market, adapters);
  const bankQueries = await ensureBankSyncQueries(db, brand.market, adapters);
  return { demandTuples: demand.length, seedTuples: seeds.length, planned: planned.length, written, zeroed, disabled, retired, bankQueries };
}
