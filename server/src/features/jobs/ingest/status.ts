// server/src/features/jobs/ingest/status.ts — what each job source did in its last run
// (GOAPPLY_PARITY_PLAN.md §3.9; the admin sources panel reads it).
//
// One small JSON document per (market, provider), kept in `AppConfig` under
// `jobs.source.status:<market>:<provider>` (no schema change):
//   last      the latest ingest run that leased a query of the source;
//   counted   the latest run that actually read something from the source
//             (an incremental run with nothing new must not erase the tallies
//             of the run that counted the bank's rows).
// Counters and reason codes only: never a posting field, a URL or a key.
// Only the reasons of SOURCE_STATUS_NOTES are kept: what a source counted and
// why a posting was left out. The normalizer's informational notes (a dropped
// logo, a currency taken from the search country …) are not skips; they stay
// in the run's log tally and never reach the panel, which has a plain sentence
// for every reason in the list and prints no raw code.
// Writing the status never fails an ingest run.

import type { Market } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import type { IngestDb } from './db.js';

export interface SourceRunStatus {
  /** ISO time the run finished. */
  at: string;
  ok: boolean;
  /** The source's last error text in this run (a short code or message), else null. */
  error: string | null;
  /** How the source was reached ('db', 'api', 'syndication', 'board_api', 'rapidapi'). */
  transport: string | null;
  queries: number;
  calls: number;
  /** Postings the source returned. */
  received: number;
  /** Rows written (inserted + updated). */
  written: number;
  inserted: number;
  /** Rows archived by the source's own closures and the listing diff. */
  closed: number;
  /** Postings dropped before the write (no apply link, wrong market, private row …). */
  skipped: number;
  /** Skip tallies and counters by reason. */
  notes: Record<string, number>;
}

/**
 * The tallies a source status keeps (the admin sources panel has one sentence
 * for each). Adding a reason here means adding its `admin.console.sources.skips.*`
 * line in every locale.
 */
export const SOURCE_STATUS_NOTES = [
  // A recruiter bank's own counts.
  'bank_synced',
  'bank_no_public_page',
  'bank_unpublished',
  'bank_no_company',
  'bank_test_posting',
  'bank_closed',
  'bank_page_cap',
  'bank_pass_cut_short',
  // Employer boards.
  'boards_read',
  'board_errors',
  'board_backlog',
  // Why the pipeline left a posting out.
  'wrong_market',
  'no_apply_url',
  'missing_title_or_company',
  'private_row',
  'normalize_failed',
  'no_external_id',
] as const;
export type SourceStatusNote = (typeof SOURCE_STATUS_NOTES)[number];

export function isSourceStatusNote(key: string): key is SourceStatusNote {
  return (SOURCE_STATUS_NOTES as readonly string[]).includes(key);
}

export interface SourceStatusDoc {
  last: SourceRunStatus;
  counted: SourceRunStatus | null;
}

export type SourceStatusDb = Pick<IngestDb, 'appConfig'>;

export function sourceStatusKey(market: Market, provider: string): string {
  return `jobs.source.status:${market}:${provider}`;
}

export function emptyRunStatus(at: Date, transport: string | null): SourceRunStatus {
  return { at: at.toISOString(), ok: true, error: null, transport, queries: 0, calls: 0, received: 0, written: 0, inserted: 0, closed: 0, skipped: 0, notes: {} };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** A stored status, validated field by field (a damaged document reads as null, never throws). */
export function parseRunStatus(v: unknown): SourceRunStatus | null {
  if (!isRecord(v) || typeof v.at !== 'string' || Number.isNaN(new Date(v.at).getTime())) return null;
  const notes: Record<string, number> = {};
  // A document written before the list existed may hold other codes: they are dropped on read.
  if (isRecord(v.notes)) for (const [k, n] of Object.entries(v.notes)) if (isSourceStatusNote(k) && count(n) > 0) notes[k] = count(n);
  return {
    at: v.at,
    ok: v.ok !== false,
    error: typeof v.error === 'string' && v.error ? v.error.slice(0, 300) : null,
    transport: typeof v.transport === 'string' && v.transport ? v.transport.slice(0, 40) : null,
    queries: count(v.queries),
    calls: count(v.calls),
    received: count(v.received),
    written: count(v.written),
    inserted: count(v.inserted),
    closed: count(v.closed),
    skipped: count(v.skipped),
    notes,
  };
}

export function parseStatusDoc(value: string | null | undefined): SourceStatusDoc | null {
  if (!value) return null;
  try {
    const raw: unknown = JSON.parse(value);
    if (!isRecord(raw)) return null;
    const last = parseRunStatus(raw.last);
    return last ? { last, counted: parseRunStatus(raw.counted) } : null;
  } catch {
    return null;
  }
}

/** True when the run read something worth keeping as the source's counted state. */
export function runCounted(run: SourceRunStatus): boolean {
  return run.ok && (run.received > 0 || Object.keys(run.notes).length > 0);
}

/** Stores a run's status. Never throws (a failed status write must not fail ingest). */
export async function writeSourceStatus(db: SourceStatusDb, market: Market, provider: string, run: SourceRunStatus): Promise<void> {
  const key = sourceStatusKey(market, provider);
  try {
    const prior = parseStatusDoc((await db.appConfig.findUnique({ where: { key }, select: { value: true } }))?.value);
    const doc: SourceStatusDoc = { last: run, counted: runCounted(run) ? run : (prior?.counted ?? null) };
    const value = JSON.stringify(doc);
    await db.appConfig.upsert({ where: { key }, create: { key, value, updatedBy: 'jobs-ingest' }, update: { value, updatedBy: 'jobs-ingest' } });
  } catch (err) {
    logger.warn('JOBS_INGEST', 'source status not stored', { market, provider, error: err instanceof Error ? err.message.slice(0, 160) : 'error' });
  }
}

/** The stored status of each provider in a market (absent = the source never ran). */
export async function readSourceStatuses(db: SourceStatusDb, market: Market, providers: readonly string[]): Promise<Map<string, SourceStatusDoc>> {
  const out = new Map<string, SourceStatusDoc>();
  if (providers.length === 0) return out;
  const keys = providers.map((p) => sourceStatusKey(market, p));
  const rows = await db.appConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  for (const row of rows) {
    const provider = providers.find((p) => sourceStatusKey(market, p) === row.key);
    const doc = parseStatusDoc(row.value);
    if (provider && doc) out.set(provider, doc);
  }
  return out;
}
