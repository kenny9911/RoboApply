// server/src/features/jobs/ingest/verifyFeed.ts — proof that a brand's feed holds real jobs
// (GOAPPLY_PARITY_PLAN.md §7 step 5; the closing acceptance of bundle PAR-7).
//
//   npx tsx server/src/features/jobs/ingest/verifyFeed.ts --brand goapply [--json] [--check]
//
// A READ-ONLY report over the job index of the brand's market. It runs four
// SELECT statements against DATABASE_URL (counts, boards, apply hosts per
// board, samples) and reads the stored source statuses;
// it calls no provider, starts no sync and writes nothing. Use the clone's
// database, after `jobs-plan` and `jobs-ingest` have run for the brand.
//
// It prints, for the brand's market:
//   - rows by provider, source board, visibility, state and last-seen bucket;
//   - rows with and without an apply URL, and rows without a provider id;
//   - the employer boards that have open public rows, and how many, each with
//     the hosts its apply links point at (a host that is not the job-board
//     system's own is printed for a person to confirm it is the employer's
//     site);
//   - what each source did in its last run (synced, skipped and held counts;
//     its error when it failed), from the status ingest stored;
//   - five sample rows per source: id, provider, source name, apply HOST and
//     dates. Never a description, a company contact, an owner id or any
//     recruiter-internal field.
// `--check` exits 1 when the GoApply acceptance does not hold (at least 300
// open public employer-board rows across at least 10 boards; no row without a
// provider id; no open public row without an apply URL; no open public
// employer-board row without a source name or without an apply host; no
// JSearch row). A shortfall is reported with the per-board counts; it is never
// padded. An unknown --brand value is an error (exit 1), never a default.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '../../../generated/prisma/client.js';
import { parseBrandId, type BrandId, type Market } from '../../../platform/brand/index.js';
import { PROVIDER_META, type NormalizeProvider } from '../normalize/index.js';
import type { SourceStatusDoc } from './status.js';

/** RAJob.sourceBoard values of the public employer boards. */
export const EMPLOYER_BOARDS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export const SAMPLES_PER_SOURCE = 5;
/** GoApply acceptance (plan §7 step 5). */
export const ACCEPTANCE = { minBoardRows: 300, minBoards: 10 } as const;

const BOARD_PROVIDER: ReadonlyMap<string, NormalizeProvider> = new Map([
  // `activejobs_feed` (the licensed feed, MKT-5A) writes the same board as the `activejobs` search provider;
  // the board resolves to the search provider by rule, not by the order of PROVIDER_META (MKT-1C R4).
  ...(Object.entries(PROVIDER_META) as Array<[NormalizeProvider, { sourceBoard: string }]>)
    .filter(([provider]) => provider !== 'activejobs_feed')
    .map(([provider, meta]) => [meta.sourceBoard, provider] as const),
  ...EMPLOYER_BOARDS.map((board) => [board, 'ats_public'] as const),
]);

/** The provider that writes a source board ('other' for a board no current provider writes: legacy seed rows). */
export function providerOfBoard(sourceBoard: string): NormalizeProvider | 'other' {
  return BOARD_PROVIDER.get(sourceBoard) ?? 'other';
}

// ── The queries (pure; SELECT only) ───────────────────────────────────────

/** Rows of the market by source board, visibility, state and last-seen bucket, with the two honesty counters. */
export function buildCountsSql(market: Market): Prisma.Sql {
  return Prisma.sql`
    SELECT "sourceBoard" AS "sourceBoard", "visibility" AS "visibility",
      CASE WHEN "archivedAt" IS NULL THEN 'open' ELSE COALESCE("closeReason", 'archived') END AS "state",
      CASE WHEN "lastSeenAt" >= now() - interval '1 day' THEN '24h'
           WHEN "lastSeenAt" >= now() - interval '7 days' THEN '7d'
           WHEN "lastSeenAt" >= now() - interval '30 days' THEN '30d'
           ELSE 'older' END AS "seen",
      COUNT(*)::int AS "n",
      (COUNT(*) FILTER (WHERE COALESCE(btrim("applyUrl"), '') = ''))::int AS "noApplyUrl",
      (COUNT(*) FILTER (WHERE COALESCE(btrim("externalId"), '') = ''))::int AS "noProviderId",
      (COUNT(*) FILTER (WHERE COALESCE(btrim("sourceName"), '') = ''))::int AS "noSourceName"
    FROM "RAJob"
    WHERE "market" = ${market}
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4`;
}

/** Open public rows per employer board (`<boardToken>:<postingId>` → the token). */
export function buildBoardsSql(market: Market): Prisma.Sql {
  return Prisma.sql`
    SELECT "sourceBoard" AS "sourceBoard", split_part("externalId", ':', 1) AS "boardToken", COUNT(*)::int AS "n"
    FROM "RAJob"
    WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL
      AND "sourceBoard" = ANY(${[...EMPLOYER_BOARDS]}::text[])
    GROUP BY 1, 2
    ORDER BY 3 DESC, 1, 2`;
}

/**
 * Where the apply links of each employer board point: open public rows per
 * (board, apply HOST). Only the host is read from the link (never its path or
 * query); '' = the link has no host. The host ends at the first "/", "#", ":"
 * or "?" (chr(63): the statement holds no literal question mark).
 */
export function buildBoardHostsSql(market: Market): Prisma.Sql {
  return Prisma.sql`
    SELECT "sourceBoard" AS "sourceBoard", split_part("externalId", ':', 1) AS "boardToken",
      COALESCE(lower(substring(btrim("applyUrl") from '^[A-Za-z][A-Za-z0-9+.-]*://([^/#:' || chr(63) || ']+)')), '') AS "host",
      COUNT(*)::int AS "n"
    FROM "RAJob"
    WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL
      AND "sourceBoard" = ANY(${[...EMPLOYER_BOARDS]}::text[])
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 4 DESC, 3`;
}

/** Hosts of the four job-board systems (a board's apply link is normally on one of them). */
const ATS_HOST_SUFFIXES = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com'] as const;

/** True for a host of one of the job-board systems themselves. */
export function isAtsHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return ATS_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Sample rows per source board: open public rows only, the columns listed
 * and nothing else (no description, no contact, no owner). The newest seen first.
 */
export function buildSamplesSql(market: Market, perSource: number = SAMPLES_PER_SOURCE): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "sourceBoard", "sourceName", "applyUrl", "postedAt", "lastSeenAt"
    FROM (
      SELECT "id", "sourceBoard", "sourceName", "applyUrl", "postedAt", "lastSeenAt",
             row_number() OVER (PARTITION BY "sourceBoard" ORDER BY "lastSeenAt" DESC, "id" ASC) AS rn
      FROM "RAJob"
      WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL
    ) t
    WHERE rn <= ${perSource}::int
    ORDER BY "sourceBoard", rn`;
}

// ── Assembly (pure) ───────────────────────────────────────────────────────

export interface CountRow {
  sourceBoard: string;
  visibility: string;
  state: string;
  seen: string;
  n: number | bigint;
  noApplyUrl: number | bigint;
  noProviderId: number | bigint;
  noSourceName?: number | bigint;
}
export interface BoardRow {
  sourceBoard: string;
  boardToken: string;
  n: number | bigint;
}
export interface BoardHostRow {
  sourceBoard: string;
  boardToken: string;
  /** The apply link's host, lower case; '' when the link has none. */
  host: string;
  n: number | bigint;
}
export interface SampleRow {
  id: string;
  sourceBoard: string;
  sourceName: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface FeedReport {
  brand: string;
  market: Market;
  generatedAt: string;
  totals: {
    rows: number;
    openPublic: number;
    /** Rows with no provider id (externalId): must be 0 (nothing fabricated). */
    noProviderId: number;
    /** Open public rows with no apply URL: must be 0. */
    openPublicNoApplyUrl: number;
    withApplyUrl: number;
    withoutApplyUrl: number;
  };
  byProvider: Array<{ provider: string; rows: number; openPublic: number; held: number }>;
  counts: Array<{ provider: string; sourceBoard: string; visibility: string; state: string; seen: string; rows: number }>;
  employerBoards: {
    boards: number;
    rows: number;
    /** Open public board rows with no source name: must be 0 (every card names its source). */
    noSourceName: number;
    /** Open public board rows whose apply link has no host: must be 0. */
    noApplyHost: number;
    /** Open public board rows whose apply link is on a host that is not the job-board system's (printed for review, not a failure). */
    offAtsHost: number;
    perBoard: Array<{ ats: string; boardToken: string; rows: number; hosts: Array<{ host: string; rows: number; ats: boolean }> }>;
  };
  sources: Array<{ provider: string; lastRunAt: string | null; ok: boolean | null; error: string | null; transport: string | null; written: number | null; notes: Record<string, number>; countedAt: string | null }>;
  samples: Array<{ id: string; provider: string; sourceBoard: string; sourceName: string | null; applyHost: string | null; postedAt: string | null; lastSeenAt: string | null }>;
  /** GoApply only: the plan's numeric acceptance; null for a market it does not apply to. */
  acceptance: { pass: boolean; checks: Array<{ check: string; pass: boolean; value: number; need: string }> } | null;
}

const num = (v: number | bigint | null | undefined): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

/** The host of an apply URL (never the path or query: a link can carry an id). */
export function applyHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function assembleFeedReport(
  input: { brand: string; market: Market; now: Date; counts: CountRow[]; boards: BoardRow[]; hosts?: BoardHostRow[]; samples: SampleRow[]; statuses: ReadonlyMap<string, SourceStatusDoc> },
): FeedReport {
  const counts = input.counts.map((r) => ({ provider: providerOfBoard(r.sourceBoard), sourceBoard: r.sourceBoard, visibility: r.visibility, state: r.state, seen: r.seen, rows: num(r.n) }));
  const isOpenPublic = (r: { visibility: string; state: string }) => r.visibility === 'public' && r.state === 'open';
  const rows = input.counts.reduce((s, r) => s + num(r.n), 0);
  const withoutApplyUrl = input.counts.reduce((s, r) => s + num(r.noApplyUrl), 0);
  const totals = {
    rows,
    openPublic: input.counts.filter(isOpenPublic).reduce((s, r) => s + num(r.n), 0),
    noProviderId: input.counts.reduce((s, r) => s + num(r.noProviderId), 0),
    openPublicNoApplyUrl: input.counts.filter(isOpenPublic).reduce((s, r) => s + num(r.noApplyUrl), 0),
    withApplyUrl: rows - withoutApplyUrl,
    withoutApplyUrl,
  };

  const byProviderMap = new Map<string, { provider: string; rows: number; openPublic: number; held: number }>();
  for (const r of counts) {
    const entry = byProviderMap.get(r.provider) ?? { provider: r.provider, rows: 0, openPublic: 0, held: 0 };
    entry.rows += r.rows;
    if (isOpenPublic(r)) entry.openPublic += r.rows;
    if (r.state === 'no_apply_target') entry.held += r.rows;
    byProviderMap.set(r.provider, entry);
  }
  const byProvider = [...byProviderMap.values()].sort((a, b) => b.rows - a.rows || a.provider.localeCompare(b.provider));

  const hostRows = (input.hosts ?? []).map((h) => ({ ats: h.sourceBoard, boardToken: h.boardToken, host: (h.host ?? '').trim().toLowerCase(), rows: num(h.n) })).filter((h) => h.rows > 0);
  const perBoard = input.boards
    .map((b) => ({
      ats: b.sourceBoard,
      boardToken: b.boardToken,
      rows: num(b.n),
      hosts: hostRows.filter((h) => h.ats === b.sourceBoard && h.boardToken === b.boardToken).map((h) => ({ host: h.host, rows: h.rows, ats: isAtsHost(h.host) })),
    }))
    .filter((b) => b.rows > 0);
  const isBoard = (sourceBoard: string) => (EMPLOYER_BOARDS as readonly string[]).includes(sourceBoard);
  const employerBoards = {
    boards: perBoard.length,
    rows: perBoard.reduce((s, b) => s + b.rows, 0),
    noSourceName: input.counts.filter((r) => isBoard(r.sourceBoard) && isOpenPublic(r)).reduce((s, r) => s + num(r.noSourceName), 0),
    noApplyHost: hostRows.filter((h) => h.host === '').reduce((s, h) => s + h.rows, 0),
    offAtsHost: hostRows.filter((h) => h.host !== '' && !isAtsHost(h.host)).reduce((s, h) => s + h.rows, 0),
    perBoard,
  };

  const providers = [...new Set([...byProvider.map((p) => p.provider), ...input.statuses.keys()])].filter((p) => p !== 'other');
  const sources = providers.map((provider) => {
    const doc = input.statuses.get(provider) ?? null;
    const counted = doc?.counted ?? doc?.last ?? null;
    return {
      provider,
      lastRunAt: doc?.last.at ?? null,
      ok: doc ? doc.last.ok : null,
      error: doc?.last.error ?? null,
      transport: doc?.last.transport ?? null,
      written: doc ? doc.last.written : null,
      notes: { ...(counted?.notes ?? {}) },
      countedAt: counted?.at ?? null,
    };
  });

  const samples = input.samples.map((s) => ({
    id: s.id,
    provider: providerOfBoard(s.sourceBoard),
    sourceBoard: s.sourceBoard,
    sourceName: s.sourceName,
    applyHost: applyHost(s.applyUrl),
    postedAt: s.postedAt instanceof Date ? s.postedAt.toISOString() : null,
    lastSeenAt: s.lastSeenAt instanceof Date ? s.lastSeenAt.toISOString() : null,
  }));

  const jsearchRows = byProviderMap.get('jsearch')?.rows ?? 0;
  const acceptance =
    input.market === 'cn'
      ? (() => {
          const checks = [
            { check: 'open public employer-board rows', pass: employerBoards.rows >= ACCEPTANCE.minBoardRows, value: employerBoards.rows, need: `>= ${ACCEPTANCE.minBoardRows}` },
            { check: 'employer boards with open public rows', pass: employerBoards.boards >= ACCEPTANCE.minBoards, value: employerBoards.boards, need: `>= ${ACCEPTANCE.minBoards}` },
            { check: 'rows without a provider id', pass: totals.noProviderId === 0, value: totals.noProviderId, need: '= 0' },
            { check: 'open public rows without an apply URL', pass: totals.openPublicNoApplyUrl === 0, value: totals.openPublicNoApplyUrl, need: '= 0' },
            { check: 'open public employer-board rows without a source name', pass: employerBoards.noSourceName === 0, value: employerBoards.noSourceName, need: '= 0' },
            { check: 'open public employer-board rows without an apply host', pass: employerBoards.noApplyHost === 0, value: employerBoards.noApplyHost, need: '= 0' },
            { check: 'rows from jsearch', pass: jsearchRows === 0, value: jsearchRows, need: '= 0' },
          ];
          return { pass: checks.every((c) => c.pass), checks };
        })()
      : null;

  return { brand: input.brand, market: input.market, generatedAt: input.now.toISOString(), totals, byProvider, counts, employerBoards, sources, samples, acceptance };
}

/** The report as plain lines. */
export function formatFeedReport(r: FeedReport): string {
  const lines: string[] = [];
  lines.push(`Job index report for ${r.brand} (market ${r.market}) at ${r.generatedAt}`);
  lines.push(`rows ${r.totals.rows} · open public ${r.totals.openPublic} · with apply URL ${r.totals.withApplyUrl} · without ${r.totals.withoutApplyUrl} · without provider id ${r.totals.noProviderId}`);
  lines.push('', 'By provider:');
  for (const p of r.byProvider) lines.push(`  ${p.provider}: ${p.rows} rows, ${p.openPublic} open public${p.held ? `, ${p.held} held (no public job page)` : ''}`);
  lines.push('', 'By source board, visibility, state, last seen:');
  for (const c of r.counts) lines.push(`  ${c.provider} / ${c.sourceBoard} / ${c.visibility} / ${c.state} / ${c.seen}: ${c.rows}`);
  lines.push('', `Employer boards with open public rows: ${r.employerBoards.boards} boards, ${r.employerBoards.rows} rows`);
  for (const b of r.employerBoards.perBoard) {
    const hosts = b.hosts.map((h) => `${h.host || '(no host)'} ${h.rows}${h.host && !h.ats ? ' (not a job-board host)' : ''}`).join(', ');
    lines.push(`  ${b.ats} ${b.boardToken}: ${b.rows}${hosts ? ` · apply hosts: ${hosts}` : ''}`);
  }
  if (r.employerBoards.offAtsHost > 0) {
    lines.push(`  ${r.employerBoards.offAtsHost} rows link to a host that is not the job-board system's own: check each is the employer's own site.`);
  }
  lines.push('', 'Sources (last ingest run):');
  if (r.sources.length === 0) lines.push('  no source has run yet');
  for (const s of r.sources) {
    const notes = Object.entries(s.notes).map(([k, v]) => `${k}=${v}`).join(' ');
    const state = s.lastRunAt === null ? 'never ran' : s.ok ? `ok at ${s.lastRunAt}` : `ERROR at ${s.lastRunAt}: ${s.error ?? 'error'}`;
    lines.push(`  ${s.provider}${s.transport ? ` (${s.transport})` : ''}: ${state}${s.written !== null ? `, wrote ${s.written}` : ''}${notes ? ` · counted ${s.countedAt}: ${notes}` : ''}`);
  }
  lines.push('', `Samples (${SAMPLES_PER_SOURCE} per source):`);
  for (const s of r.samples) lines.push(`  ${s.id} · ${s.provider} · ${s.sourceName ?? '(no source name)'} · ${s.applyHost ?? '(no apply host)'} · posted ${s.postedAt ?? 'unknown'} · last seen ${s.lastSeenAt ?? 'unknown'}`);
  if (r.acceptance) {
    lines.push('', `Acceptance: ${r.acceptance.pass ? 'PASS' : 'FAIL'}`);
    for (const c of r.acceptance.checks) lines.push(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.check}: ${c.value} (need ${c.need})`);
  }
  return lines.join('\n');
}

// ── The script ────────────────────────────────────────────────────────────

/** The database surface the report reads (raw SELECTs and the stored statuses). */
export interface VerifyFeedDb {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  appConfig: { findMany(args: { where: { key: { in: string[] } }; select: { key: true; value: true } }): Promise<Array<{ key: string; value: string }>> };
}

/** Runs the report's reads for one market. Read-only. */
export async function readFeedReport(db: VerifyFeedDb, brand: string, market: Market, now: Date = new Date()): Promise<FeedReport> {
  const { readSourceStatuses } = await import('./status.js');
  const counts = await db.$queryRaw<CountRow[]>(buildCountsSql(market));
  const boards = await db.$queryRaw<BoardRow[]>(buildBoardsSql(market));
  const hosts = await db.$queryRaw<BoardHostRow[]>(buildBoardHostsSql(market));
  const samples = await db.$queryRaw<SampleRow[]>(buildSamplesSql(market));
  const providers = [...new Set([...counts.map((c) => providerOfBoard(c.sourceBoard)), 'ats_public', 'bank_gohire', 'bank_robohire', 'activejobs', 'jsearch'])].filter((p) => p !== 'other');
  const statuses = await readSourceStatuses(db as never, market, providers);
  return assembleFeedReport({ brand, market, now, counts, boards, hosts, samples, statuses });
}

/**
 * The brand a `--brand` value names ('goapply' when the flag is absent). An
 * unknown value is an error: the report never falls back to another brand.
 */
export function reportBrand(value: string | null): { brand: BrandId } | { error: string } {
  if (value === null) return { brand: 'goapply' };
  const brand = parseBrandId(value);
  return brand ? { brand } : { error: `Unknown --brand "${value.slice(0, 40)}". Use goapply or roboapply.` };
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(here, '../../../../../.env'), override: false });
  dotenv.config({ path: path.resolve(here, '../../../../../.env.local'), override: false });
  const picked = reportBrand(arg('brand'));
  if ('error' in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const { getBrand } = await import('../../../platform/brand/index.js');
  const brand = getBrand(picked.brand);
  const { default: prisma } = await import('../../../lib/prisma.js');
  try {
    const report = await readFeedReport(prisma as unknown as VerifyFeedDb, brand.id, brand.market);
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatFeedReport(report));
    if (process.argv.includes('--check') && report.acceptance && !report.acceptance.pass) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a script (`tsx …/verifyFeed.ts`), never on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
