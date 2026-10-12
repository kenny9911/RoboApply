// server/src/features/jobs/ingest/pipeline.ts — fetch → normalize → upsert → dedupe → enrich (ARCH §4.4).
//
// `runIngestQuery` runs ONE leased RAIngestQuery:
//   1. metered providers have ONE budget (quota.ts): while the plan's monthly
//      quota is used up, refused or down to its reserve, no call is made and
//      every due query of the provider is parked until the quota stops
//      blocking, at most a day at a time ('quota');
//      otherwise a call is reserved in today's RAProviderUsage row under
//      `usageKey(provider, market)` (atomic; over the effective daily limit →
//      no call, the query waits for the next UTC day). The tick's standing
//      demand stops at INGEST_SCHEDULED_DEMAND_SHARE of that limit, so a
//      person's own search of the day (a targeted run) still finds calls;
//   2. the adapter fetches (never throws);
//   3. `processJobs`: the page's known employer domains → normalizeProviderJob →
//      marketHooks.afterNormalize → RACompany upsert → batched RAJob upsert
//      (xmax = 0 counts new rows) → dedupe → enqueue `job.enrich` for new or
//      materially changed rows;
//   4. the source's own closures are archived, each with its reason
//      ('bank_closed', 'source_removed', 'no_apply_target'), and a source that
//      reports its complete listing has the open rows missing from it archived
//      (the listing diff). A failed fetch closes nothing;
//   5. the query's stats, cursor and next run are written (raw SQL, so the
//      planner's `updatedAt` "last demanded" stamp is not touched);
//   6. with Schema request SR-16b-1 in place (`perQueryTracking`), a search
//      run that returned postings is counted and stamps them (tracking.ts),
//      which the missed-refresh archive in `jobs-maintain` reads. A run whose
//      answer was cut at a page cap (`complete: false`: JSearch) is not counted.

import { Prisma } from '../../../generated/prisma/client.js';
import type { BrandId, EnvSource, Market } from '../../../platform/brand/index.js';
import { enqueueMany as platformEnqueueMany, type EnqueueManyItem } from '../../../platform/queue/index.js';
import { afterNormalize, type MarketHookJob } from '../marketHooks.js';
import { asMarketHookJob, cleanText, hostOf, isJobBoardHost, normalizeCompanyName, normalizeProviderJob, PROVIDER_META, type NormalizedJob, type ProviderJobInput } from '../normalize/index.js';
import { companyKey, upsertCompanies } from '../companies/index.js';
import { adapterEnabledFor } from '../sources/index.js';
import type { IngestOrigin, IngestQueryParams, JobSourceAdapter, SourceClosure, SourceQuery } from '../sources/index.js';
import { effectiveDailyLimit, publicDisplayProviders, scheduledDemandLimit, seedBudgetShare } from './config.js';
import { dayKey, type IngestDb } from './db.js';
import { nextRunDelayMs, REFRESH } from './planner.js';
import { providerCallsToday, quotaAllows, quotaParkUntil, recordProviderUsage, reserveProviderCall } from './quota.js';
import { usageKey } from './quotaContract.js';
import { recordCountedRun } from './tracking.js';
import { applyDedupe, archiveClosedBankJobs, archiveUnlistedJobs, contentHash, existingKey, prefetchExisting, toUpsertRow, upsertJobRows } from './upsert.js';

export const ENRICH_KIND = 'job.enrich';

export type EnqueueManyFn = (items: EnqueueManyItem[]) => Promise<{ inserted: number }>;

export interface PipelineContext {
  db: IngestDb;
  brand: BrandId;
  market: Market;
  now: Date;
  /** Override for tests (default: the platform queue). */
  enqueueMany?: EnqueueManyFn;
  /** Providers whose licence allows public redisplay (default: env PUBLIC_DISPLAY_PROVIDERS, empty). */
  publicDisplayProviders?: readonly string[];
  /** SR-16b-1 columns exist: count runs and stamp seen jobs (default false). */
  perQueryTracking?: boolean;
  signal?: AbortSignal;
  /** Milliseconds left for the query being run (the tick's remaining budget less its reserve); handed to the source. */
  budgetMs?: number;
  /** Env the budgets are read from (default process.env). */
  env?: EnvSource;
  /**
   * The run is a person's own search (targeted ingest of one search profile,
   * or its queued `ingest.query` remainder), not the tick's standing work: a
   * demand query then may use the provider's day up to its limit, where
   * standing demand stops at its share (config.ts `scheduledDemandLimit`).
   */
  targeted?: boolean;
}

export interface ProcessResult {
  received: number;
  written: number;
  inserted: number;
  updated: number;
  skipped: number;
  enrichQueued: number;
  /** RAJob ids written by this page (inserted or updated). */
  jobIds: string[];
  notes: Record<string, number>;
}

function bump(notes: Record<string, number>, key: string): void {
  notes[key] = (notes[key] ?? 0) + 1;
}

/** The RAJob.sourceBoard an input will be written under (mirrors normalize/source.ts). */
function boardFor(input: ProviderJobInput, adapter: Pick<JobSourceAdapter, 'provider'>): string {
  const own = typeof input.sourceBoard === 'string' ? input.sourceBoard.trim().toLowerCase() : '';
  return own || PROVIDER_META[adapter.provider].sourceBoard;
}

/** The key a company's domain is known under: the normalizer's own `companyNameNormalized`. */
function companyNameKey(company: unknown): string {
  const name = cleanText(typeof company === 'string' ? company : '').slice(0, 200).trimEnd();
  return normalizeCompanyName(name) || name.toLowerCase();
}

/**
 * The domain an input itself states for its employer: the stated domain, else
 * the host of the stated website. A company page on a job board (Active Jobs
 * DB often states `linkedin.com/company/…` as the organisation's URL) is not
 * the employer's domain: the name then falls to the RACompany lookup.
 */
function statedDomain(input: ProviderJobInput): string | null {
  const facts = input.companyFacts;
  if (!facts) return null;
  const domain = typeof facts.domain === 'string' ? facts.domain.trim().toLowerCase().replace(/^www\./, '') : '';
  const host = domain || hostOf(typeof facts.website === 'string' ? facts.website : null);
  return host && !isJobBoardHost(host) ? host : null;
}

/**
 * Known employer domains of one page, by normalised company name
 * (MARKET_STRATEGY §1.5 K3): the normalizer's dedupe key uses the domain in
 * place of the name. First what the page's own inputs state, then ONE read of
 * RACompany for the names still unknown. Hosts are handed on as stated or
 * stored (only a job-board host stated as a company's website is skipped, see
 * statedDomain); the key logic reduces them to a registrable domain and
 * refuses job boards and ATS hosts. Reads only, never writes.
 */
export async function companyDomainsForPage(db: IngestDb, market: Market, inputs: Iterable<ProviderJobInput>): Promise<Map<string, string>> {
  const domains = new Map<string, string>();
  const names = new Set<string>();
  for (const input of inputs) {
    const key = companyNameKey(input.company);
    if (!key) continue;
    names.add(key);
    if (domains.has(key)) continue;
    const domain = statedDomain(input);
    if (domain) domains.set(key, domain);
  }
  const unknown = [...names].filter((n) => !domains.has(n));
  if (unknown.length === 0) return domains;
  const rows = await db.$queryRaw<Array<{ nameNormalized: string; domain: string | null }>>`
    SELECT "nameNormalized", "domain" FROM "RACompany"
    WHERE "market" = ${market} AND "nameNormalized" = ANY(${unknown}::text[]) AND "domain" IS NOT NULL`;
  for (const row of Array.isArray(rows) ? rows : []) {
    const domain = typeof row?.domain === 'string' ? row.domain.trim() : '';
    if (domain && typeof row.nameNormalized === 'string' && !domains.has(row.nameNormalized)) domains.set(row.nameNormalized, domain);
  }
  return domains;
}

/** Normalize → hooks → company → upsert → dedupe → enrich, for one fetched page. */
export async function processJobs(
  ctx: PipelineContext,
  adapter: Pick<JobSourceAdapter, 'provider'>,
  inputs: ProviderJobInput[],
  options: { countryHint?: string | null } = {},
): Promise<ProcessResult> {
  const notes: Record<string, number> = {};
  const result: ProcessResult = { received: inputs.length, written: 0, inserted: 0, updated: 0, skipped: 0, enrichQueued: 0, jobIds: [], notes };
  if (inputs.length === 0) return result;

  // One posting per (board, externalId) per page.
  const unique = new Map<string, ProviderJobInput>();
  for (const input of inputs) {
    const ext = typeof input.externalId === 'string' ? input.externalId.trim() : '';
    if (!ext) {
      result.skipped += 1;
      bump(notes, 'no_external_id');
      continue;
    }
    unique.set(existingKey(boardFor(input, adapter), ext), input);
  }
  const keys = [...unique.keys()].map((k) => {
    const [sourceBoard, externalId] = k.split('\u0000') as [string, string];
    return { sourceBoard, externalId };
  });
  const existing = await prefetchExisting(ctx.db, keys);
  const display = ctx.publicDisplayProviders ?? publicDisplayProviders();
  const country = options.countryHint && options.countryHint !== '*' ? options.countryHint : null;
  // One read per page, before the first row is normalized (JI-5: the employer's domain in the dedupe key).
  const companyDomains = await companyDomainsForPage(ctx.db, ctx.market, unique.values());

  const jobs: NormalizedJob[] = [];
  for (const [key, input] of unique) {
    const prior = existing.get(key);
    if (prior && prior.visibility !== 'public') {
      result.skipped += 1;
      bump(notes, 'private_row');
      continue;
    }
    let job: NormalizedJob;
    try {
      job = normalizeProviderJob(input, adapter.provider, {
        market: ctx.market,
        now: ctx.now,
        publicDisplayProviders: display,
        countryHint: country,
        firstSeenAt: prior?.firstSeenAt ?? null,
        companyDomains,
      });
      const hooked: MarketHookJob = await afterNormalize(asMarketHookJob(job), { brand: ctx.brand, market: ctx.market, stage: 'ingest' });
      job = hooked as NormalizedJob;
    } catch {
      result.skipped += 1;
      bump(notes, 'normalize_failed');
      continue;
    }
    for (const n of job.notes) bump(notes, n.split(':')[0]!);
    // Every market: a posting with no usable apply URL is never written (counted as 'no_apply_url').
    if (!job.applyUrl) {
      result.skipped += 1;
      continue;
    }
    // An employer-board posting belongs to the market of its own location (the normalizer decides);
    // a run writes only the rows of its own market.
    if (!job.title || !job.companyName || job.market !== ctx.market) {
      result.skipped += 1;
      bump(notes, job.market !== ctx.market ? 'wrong_market' : 'missing_title_or_company');
      continue;
    }
    jobs.push(job);
  }
  if (jobs.length === 0) return result;

  const companyIds = await upsertCompanies(ctx.db, jobs.map((j) => j.company));
  const rows = jobs.map((j) =>
    toUpsertRow(j, companyIds.get(companyKey(j.company.market, j.company.nameNormalized)) ?? null, undefined, {
      // Enrichment read the whole posting: a level the normalizer's text rule finds never replaces it.
      keepStoredEducation: existing.get(existingKey(j.sourceBoard, j.externalId))?.enrichedEducation === true,
    }),
  );
  const upserted = await upsertJobRows(ctx.db, rows);
  result.written = upserted.length;
  result.jobIds = upserted.map((u) => u.id);

  const byKey = new Map(jobs.map((j) => [existingKey(j.sourceBoard, j.externalId), j]));
  const enrich: EnqueueManyItem[] = [];
  for (const u of upserted) {
    const job = byKey.get(existingKey(u.sourceBoard, u.externalId));
    if (!job) continue;
    const hash = contentHash(job.title, job.descriptionPlain);
    const prior = existing.get(existingKey(u.sourceBoard, u.externalId));
    if (u.inserted) result.inserted += 1;
    else result.updated += 1;
    if (u.inserted || !prior || prior.contentHash !== hash) {
      // A materially changed posting (an existing row whose title/description
      // hash moved) is re-enriched with `force`: WP-17's enrichJob otherwise
      // answers `already_enriched` for a row at ENRICH_VERSION and would keep
      // quotes, tags and the summary from text the posting no longer has (D3).
      const changed = !u.inserted && !!prior;
      enrich.push({
        kind: ENRICH_KIND,
        payload: changed ? { jobId: u.id, force: true } : { jobId: u.id },
        options: { dedupeKey: `${ENRICH_KIND}:${u.id}:v${hash.slice(0, 12)}`, brand: ctx.brand },
      });
    }
  }
  await applyDedupe(ctx.db, ctx.market, jobs.map((j) => j.dedupeKey));
  if (enrich.length) {
    const enqueue = ctx.enqueueMany ?? ((items: EnqueueManyItem[]) => platformEnqueueMany(items));
    result.enrichQueued = (await enqueue(enrich)).inserted;
  }
  return result;
}

// ── Leasing, budgets and query bookkeeping ───────────────────────────────

export interface LeasedQueryRow {
  id: string;
  market: string;
  provider: string;
  params: unknown;
  origin: string;
  demandScore: number;
  priority: number;
  consecutiveEmpty: number;
}

/** The lease statement (exported for the SQL snapshot test). */
export function buildLeaseSql(market: Market, providers: string[], limit: number, ids: string[] | null = null): Prisma.Sql {
  const idFilter = ids ? Prisma.sql`AND "id" = ANY(${ids}::text[])` : Prisma.empty;
  return Prisma.sql`
    UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval '15 minutes'
    WHERE "id" IN (
      SELECT "id" FROM "RAIngestQuery"
      WHERE "enabled" = true AND "market" = ${market} AND "provider" = ANY(${providers}::text[]) AND "nextRunAt" <= now() ${idFilter}
      ORDER BY "priority" ASC, "nextRunAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "market", "provider", "params", "origin", "demandScore", "priority", "consecutiveEmpty"`;
}

/** Leases up to `limit` due queries of the given providers (SKIP LOCKED: concurrent ticks never share one). */
export async function leaseDueQueries(db: IngestDb, market: Market, providers: string[], limit: number, ids: string[] | null = null): Promise<LeasedQueryRow[]> {
  if (providers.length === 0 || limit <= 0 || (ids && ids.length === 0)) return [];
  return db.$queryRaw<LeasedQueryRow[]>(buildLeaseSql(market, providers, limit, ids));
}

// The usage counters live with the quota (one budget per provider); re-exported for callers of this module.
export { recordProviderUsage, reserveProviderCall } from './quota.js';

/** Next UTC midnight + 5 minutes (a provider's budget resets with the day key). */
export function nextBudgetDay(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
  return d;
}

/** Sets when one query runs next (also hands a leased query back: `until` = now makes it due again). */
export async function deferQuery(db: IngestDb, id: string, until: Date): Promise<void> {
  await db.$executeRaw`UPDATE "RAIngestQuery" SET "nextRunAt" = ${until}::timestamp(3) WHERE "id" = ${id}`;
}

/**
 * Pushes every due query of a provider (optionally of one origin) to `until`
 * in one statement, so later ticks do not lease them only to find the budget
 * spent. Includes the query just leased (its nextRunAt is in the future).
 */
export function buildDeferProviderSql(market: Market, provider: string, until: Date, origin: IngestOrigin | null): Prisma.Sql {
  const originFilter = origin ? Prisma.sql`AND "origin" = ${origin}` : Prisma.empty;
  return Prisma.sql`
    UPDATE "RAIngestQuery" SET "nextRunAt" = ${until}::timestamp(3)
    WHERE "market" = ${market} AND "provider" = ${provider} AND "enabled" = true
      AND "nextRunAt" < ${until}::timestamp(3) ${originFilter}`;
}

/**
 * Stamps a finished run. Of `params` only the cursor of a cursor source is
 * written, into the row as it is NOW: the planner rewrites a query's window
 * and text in place (`upsertPlannedQueries`, `retireUnusedDemand`), and
 * `jobs-plan` can run between this query's lease and its finish, so writing
 * the params read at lease time back would undo that plan for a day.
 */
async function finishQuery(
  db: IngestDb,
  id: string,
  data: { now: Date; next: Date; seen: number; inserted: number; consecutiveEmpty: number; error: string | null; cursor: string | null },
): Promise<void> {
  await db.$executeRaw`
    UPDATE "RAIngestQuery" SET
      "lastRunAt" = ${data.now}::timestamp(3),
      "nextRunAt" = ${data.next}::timestamp(3),
      "lastSeenCount" = ${data.seen}::int,
      "lastNewCount" = ${data.inserted}::int,
      "consecutiveEmpty" = ${data.consecutiveEmpty}::int,
      "lastError" = ${data.error}::text,
      "params" = CASE WHEN ${data.cursor}::text IS NULL THEN "params" ELSE jsonb_set("params", '{cursor}', to_jsonb(${data.cursor}::text)) END
    WHERE "id" = ${id}`;
}

function toSourceQuery(row: LeasedQueryRow): SourceQuery {
  const p = (row.params && typeof row.params === 'object' ? row.params : {}) as Partial<IngestQueryParams>;
  return {
    id: row.id,
    provider: row.provider as SourceQuery['provider'],
    market: row.market as Market,
    origin: row.origin as IngestOrigin,
    params: { q: p.q ?? '', country: p.country ?? '*', datePosted: p.datePosted ?? 'week', ...p },
  };
}

export interface QueryRunResult {
  queryId: string;
  provider: string;
  /**
   * 'quota': the provider's plan is used up, refused or down to its reserve (its due queries are parked, see quotaParkUntil);
   * 'budget': the provider's day is spent; 'seed_budget': only the seeds' share is.
   */
  status: 'ok' | 'error' | 'quota' | 'budget' | 'seed_budget' | 'disabled';
  calls: number;
  process?: ProcessResult;
  closed?: number;
  /** Cursor sources with more rows waiting. */
  more?: boolean;
  /** Skip tallies of the run: the adapter's own (bank_unpublished, bank_no_public_page …) plus the pipeline's (wrong_market, no_apply_url …). */
  notes?: Record<string, number>;
  /** The source's error text when status is 'error'. */
  error?: string | null;
}

function mergeNotes(...lists: Array<Record<string, number> | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const list of lists) for (const [k, v] of Object.entries(list ?? {})) if (Number.isFinite(v) && v > 0) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Runs one leased query end to end. Never throws for provider failures (DB errors propagate). */
export async function runIngestQuery(ctx: PipelineContext, adapter: JobSourceAdapter, row: LeasedQueryRow): Promise<QueryRunResult> {
  const query = toSourceQuery(row);
  const day = dayKey(ctx.now);
  const env = ctx.env ?? process.env;
  // Mainland calls are counted apart (`<provider>:cn`), so one market's day never eats the other's.
  const usage = usageKey(adapter.provider, ctx.market);
  const base: QueryRunResult = { queryId: query.id, provider: adapter.provider, status: 'ok', calls: 0 };
  const configured = adapter.dailyCallLimit();
  const metered = configured !== null;
  // The plan's own quota first (asked before the enabled check: a provider whose plan is used up
  // reports itself off, and its queries must be parked together, not retried one by one every hour).
  if (metered && !quotaAllows(adapter.provider, 'ingest', ctx.now, env)) {
    // Parked until the quota stops blocking, at most a day at a time: the queries are looked at once a
    // day (no provider call) and run within a day of the plan reopening, whoever learns of it.
    const until = quotaParkUntil(adapter.provider, ctx.now, env);
    await ctx.db.$executeRaw(buildDeferProviderSql(ctx.market, adapter.provider, until, null));
    return { ...base, status: 'quota' };
  }
  if (!adapterEnabledFor(adapter, ctx.market)) {
    await deferQuery(ctx.db, query.id, new Date(ctx.now.getTime() + REFRESH.errorRetryMs));
    return { ...base, status: 'disabled' };
  }
  if (metered) {
    // One limit per provider and market: the operator's bound under what is left of the plan
    // (an adapter this module knows no budget for keeps the bound it declares itself).
    const limit = effectiveDailyLimit(adapter.provider, ctx.market, env, ctx.now) ?? configured;
    // Three shares of one day, so the query a person is waiting for always finds calls left:
    // SEO seeds use part of the day; the tick's standing demand stops at its own share; a person's
    // own search (a targeted run: onboarding and its queued remainder) may use the day to its limit.
    const isSeed = query.origin === 'seo_seed';
    const effective = isSeed ? Math.floor(limit * seedBudgetShare(env)) : ctx.targeted ? limit : scheduledDemandLimit(limit, env);
    if (!(await reserveProviderCall(ctx.db, usage, day, effective))) {
      // Standing demand at its share while the day still has calls (one read tells): nothing is
      // parked, because the provider's other queries include the ones a person's own search of today
      // will ask for by id (a parked query is not due and would wait for tomorrow). This query keeps
      // its 15-minute lease and the tick drops the provider ('budget'). Once the whole day is spent
      // (or the read says nothing) the provider's queries are parked to the next day, as before.
      if (!isSeed && effective < limit) {
        const calls = await providerCallsToday(ctx.db, usage, day);
        if (calls !== null && calls < limit) return { ...base, status: 'budget' };
      }
      await ctx.db.$executeRaw(buildDeferProviderSql(ctx.market, adapter.provider, nextBudgetDay(ctx.now), isSeed ? 'seo_seed' : null));
      return { ...base, status: isSeed ? 'seed_budget' : 'budget' };
    }
  }

  const fetched = await adapter.fetch(query, { now: ctx.now, signal: ctx.signal, ...(ctx.budgetMs !== undefined ? { budgetMs: ctx.budgetMs } : {}) });
  const extraCalls = metered ? Math.max(0, fetched.calls - 1) : fetched.calls;
  if (fetched.error) {
    await recordProviderUsage(ctx.db, usage, day, { calls: extraCalls, errors: 1 });
    await finishQuery(ctx.db, query.id, {
      now: ctx.now,
      next: new Date(ctx.now.getTime() + REFRESH.errorRetryMs),
      seen: 0,
      inserted: 0,
      consecutiveEmpty: row.consecutiveEmpty,
      error: fetched.error.slice(0, 300),
      cursor: null,
    });
    return { ...base, status: 'error', calls: fetched.calls, error: fetched.error.slice(0, 300), notes: mergeNotes(fetched.notes) };
  }

  const processed = await processJobs(ctx, adapter, fetched.jobs, { countryHint: query.params.country });
  let closed = 0;
  // The source says why each group closed (a bank closed the job / a board stopped listing it /
  // the posting has no page a candidate can open); the default reason is a bank's.
  const groups: SourceClosure[] = [
    ...(fetched.closedExternalIds?.length ? [{ externalIds: fetched.closedExternalIds, reason: fetched.closeReason ?? ('bank_closed' as const) }] : []),
    ...(fetched.closures ?? []),
  ];
  for (const group of groups) {
    for (const board of adapter.sourceBoards) closed += await archiveClosedBankJobs(ctx.db, board, group.externalIds, ctx.now, group.reason);
  }
  // The listing diff: the source read its listing to the end, so an open row of this market that is
  // not in it is gone. Runs after the explicit closures, which keep their own reason.
  if (fetched.listing) {
    const reason = fetched.listing.reason ?? 'bank_closed';
    for (const board of adapter.sourceBoards) closed += await archiveUnlistedJobs(ctx.db, ctx.market, board, fetched.listing.externalIds, ctx.now, reason);
  }
  await recordProviderUsage(ctx.db, usage, day, { calls: extraCalls, returned: fetched.jobs.length, inserted: processed.inserted });
  // SR-16b-1: only a search run that returned postings counts (an empty page is inconclusive), and
  // only when the answer was everything the query can return: a posting outside a page-capped answer
  // is still listed by its source, so its absence is no "missed refresh" (MARKET_STRATEGY §1.5).
  if (ctx.perQueryTracking && adapter.kind === 'search' && fetched.jobs.length > 0 && fetched.complete !== false) {
    await recordCountedRun(ctx.db, query.id, processed.jobIds);
  }

  const seen = fetched.jobs.length;
  const isCursor = adapter.kind === 'cursor';
  const more = isCursor && fetched.exhausted === false;
  const consecutiveEmpty = isCursor ? 0 : seen === 0 ? row.consecutiveEmpty + 1 : 0;
  const cursor = isCursor && fetched.cursor ? fetched.cursor : null;
  // A variable, not a literal: the planner's RefreshInput takes the country as an optional field
  // (Taiwan demand every 12 h, other cold demand every 24 h, hot 6 h: MARKET_STRATEGY §1.2, §1.3).
  const refreshInput = { origin: query.origin, demandScore: row.demandScore, consecutiveEmpty, country: query.params.country ?? null };
  const next = more ? ctx.now : new Date(ctx.now.getTime() + nextRunDelayMs(refreshInput));
  await finishQuery(ctx.db, query.id, { now: ctx.now, next, seen, inserted: processed.inserted, consecutiveEmpty, error: null, cursor });
  return { ...base, calls: fetched.calls, process: processed, closed, more, notes: mergeNotes(processed.notes, fetched.notes) };
}
