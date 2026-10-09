// server/src/features/jobs/ingest/testkit.ts — test helpers for the ingest pipeline (no vitest imports;
// used only by *.test.ts files in this folder).
//
// `createIngestFake()` is a fakePrisma whose raw-SQL responder plays the
// parts of Postgres the pipeline relies on: the prefetch SELECT, the batched
// RAJob upsert (returning `inserted` = xmax = 0), the RAProviderUsage budget
// reservation, and the RAIngestQuery lease.

import { createFakePrisma } from '../../../test/fakePrisma.js';
import type { RecordedSql } from '../../../test/sqlSnapshot.js';
import type { IngestDb } from './db.js';
import { UPSERT_COLUMNS, type ExistingJobRow, type JobUpsertRow } from './upsert.js';
import type { LeasedQueryRow } from './pipeline.js';

/** Decodes the VALUES of a recorded RAJob upsert back into rows. */
export function decodeUpsert(call: RecordedSql): JobUpsertRow[] {
  const width = UPSERT_COLUMNS.length;
  const rows: JobUpsertRow[] = [];
  for (let i = 0; i + width <= call.values.length; i += width) {
    const row: Record<string, unknown> = {};
    UPSERT_COLUMNS.forEach((c, j) => (row[c] = call.values[i + j]));
    rows.push(row as unknown as JobUpsertRow);
  }
  return rows;
}

export interface IngestFakeOptions {
  /** Existing RAJob rows for the prefetch. */
  existing?: ExistingJobRow[];
  /** Calls each provider may still make today (absent = unlimited). */
  budget?: Record<string, number>;
  /** Due queries handed out by the lease (each leased once). */
  due?: LeasedQueryRow[];
  seed?: Record<string, Record<string, unknown>[]>;
}

export function createIngestFake(options: IngestFakeOptions = {}) {
  const existing = options.existing ?? [];
  const budget = { ...(options.budget ?? {}) };
  const due = [...(options.due ?? [])];
  const written: JobUpsertRow[] = [];
  const reserved: string[] = [];
  const fake = createFakePrisma({
    seed: options.seed,
    uniqueFields: { rACompany: ['slug'] },
    sql: {
      respond(call) {
        const t = call.text;
        if (t.startsWith('SELECT "id", "externalId", "sourceBoard", "firstSeenAt"')) return existing;
        if (t.includes('INSERT INTO "RAJob"')) {
          const rows = decodeUpsert(call);
          written.push(...rows);
          return rows.map((r) => {
            const prior = existing.find((e) => e.externalId === r.externalId && e.sourceBoard === r.sourceBoard);
            return { id: prior?.id ?? r.id, externalId: r.externalId, sourceBoard: r.sourceBoard, inserted: !prior };
          });
        }
        if (t.includes('INSERT INTO "RAProviderUsage"') && t.includes('RETURNING "calls"')) {
          const provider = String(call.values[0]);
          reserved.push(provider);
          if (!(provider in budget)) return [{ calls: 1 }];
          if (budget[provider]! <= 0) return [];
          budget[provider]! -= 1;
          return [{ calls: 1 }];
        }
        // SR-16b-1 counted run: the query had 7 counted runs before this one.
        if (t.startsWith('UPDATE "RAIngestQuery" SET "runCount"')) return [{ runCount: 8 }];
        if (t.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval')) {
          const limit = Number(call.values.find((v) => typeof v === 'number') ?? 1);
          return due.splice(0, limit);
        }
        return undefined;
      },
    },
  });
  return { fake, db: fake as unknown as IngestDb, written, reserved };
}
