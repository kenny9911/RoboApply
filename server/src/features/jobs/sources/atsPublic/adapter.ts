// server/src/features/jobs/sources/atsPublic/adapter.ts — the `ats_public`
// ingest source (WP-42), registered with WP-16b's adapter registry.
//
// A 'cursor' adapter: ingest keeps ONE standing query for it per market
// (`ensureBankSyncQueries`, re-run every 30 minutes). Each leased run reads up
// to BOARDS_PER_FETCH due career sources (never read, or read more than
// SYNC_INTERVAL_MS ago) and answers `exhausted: false` while more are due, so
// the same tick keeps going. Postings go through ingest's normalize → hooks →
// upsert → dedupe → enrich; postings a board stopped listing come back as
// `closedExternalIds` and ingest archives them.
//
// RoboApply only (`markets: ['intl']`): GoApply's sources are the GoHire bank,
// user imports and the campus calendar (CN plan L-5). Unmetered (public APIs);
// kill switch ATS_PUBLIC_SOURCES_DISABLED=true.

import type { EnvSource } from '../../../../platform/brand/index.js';
import { parseBoolEnv } from '../../../../platform/brand/index.js';
import type { JobSourceAdapter, SourceFetchResult } from '../index.js';
import type { ProviderJobInput } from '../../normalize/index.js';
import { PUBLIC_ATS } from './contract.js';
import type { FetchLike } from './http.js';
import { BOARDS_PER_FETCH } from './shared.js';
import { dueCareerSources, readCareerSource, type CareerSourceDb } from './sync.js';

export const ATS_PUBLIC_KILL_SWITCH = 'ATS_PUBLIC_SOURCES_DISABLED';

export interface AtsPublicAdapterDeps {
  /** Database (default: the app Prisma client, loaded lazily). */
  db?: () => Promise<CareerSourceDb> | CareerSourceDb;
  fetch?: FetchLike;
  env?: EnvSource;
}

async function defaultDb(): Promise<CareerSourceDb> {
  return (await import('../../../../lib/prisma.js')).default;
}

export function atsPublicEnabled(env: EnvSource = process.env): boolean {
  return !parseBoolEnv(env[ATS_PUBLIC_KILL_SWITCH]);
}

export function createAtsPublicAdapter(deps: AtsPublicAdapterDeps = {}): JobSourceAdapter {
  return {
    provider: 'ats_public',
    kind: 'cursor',
    markets: ['intl'],
    sourceBoards: [...PUBLIC_ATS],
    isEnabled: () => {
      try {
        return atsPublicEnabled(deps.env ?? process.env);
      } catch {
        return false;
      }
    },
    // Boards are curated per company, not searched per country.
    supportsCountry: () => false,
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      if (query.market !== 'intl') return { jobs: [], calls: 0, exhausted: true };
      try {
        const db = await (deps.db ?? defaultDb)();
        const due = await dueCareerSources(db, 'intl', ctx.now, BOARDS_PER_FETCH + 1);
        const jobs: ProviderJobInput[] = [];
        const closed: string[] = [];
        let calls = 0;
        for (const source of due.slice(0, BOARDS_PER_FETCH)) {
          if (ctx.signal?.aborted) break;
          const result = await readCareerSource(db, source, { now: ctx.now, fetch: deps.fetch, signal: ctx.signal });
          calls += result.calls;
          if (result.read) jobs.push(...result.read.inputs);
          closed.push(...result.closedExternalIds);
        }
        return { jobs, calls, closedExternalIds: closed, exhausted: due.length <= BOARDS_PER_FETCH, cursor: null };
      } catch (err) {
        return { jobs: [], calls: 0, error: err instanceof Error ? `career_sources:${err.message.slice(0, 160)}` : 'career_sources_failed' };
      }
    },
  };
}
