// @vitest-environment node
// WP-16b: the batch RAJob upsert (SQL snapshot), the row mapping honesty
// rules, and dedupe (lowest sourcePriority wins).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { normalizeProviderJob, type ProviderJobInput } from '../normalize/index.js';
import type { IngestDb } from './db.js';
import { newId } from './db.js';
import {
  UPSERT_COLUMNS,
  applyDedupe,
  buildDedupeSql,
  buildJobUpsertSql,
  compareForCanonical,
  contentHash,
  pickCanonical,
  toUpsertRow,
  upsertJobRows,
} from './upsert.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');

function input(over: Partial<ProviderJobInput> = {}): ProviderJobInput {
  return {
    externalId: 'x1',
    title: 'Senior Backend Engineer',
    company: 'Acme Inc.',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    location: 'Austin, TX, United States',
    description: 'Build services in Go and Postgres.',
    postedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const sqlText = (s: Parameters<typeof toRecordedSql>[1]) => toRecordedSql('$queryRaw', s, []).text;

describe('batch upsert SQL (snapshot)', () => {
  const row = toUpsertRow(normalizeProviderJob(input(), 'activejobs', { now: NOW }), 'co1', 'cjobid000000000000000000');
  const recorded = toRecordedSql('$queryRaw', buildJobUpsertSql([row, { ...row, id: 'c2', externalId: 'x2' }]), []);

  it('is one INSERT … ON CONFLICT … RETURNING (xmax = 0) for the whole batch', () => {
    expect(recorded.text).toMatchSnapshot();
    expect(recorded.text).toMatch(/^INSERT INTO "RAJob" \("id", "externalId", "sourceBoard"/);
    expect(recorded.text).toContain('ON CONFLICT ("externalId", "sourceBoard") DO UPDATE SET "lastSeenAt" = now()');
    expect(recorded.text).toContain('RETURNING "id", "externalId", "sourceBoard", (xmax = 0) AS "inserted"');
    expect(recorded.text.match(/INSERT INTO/g)).toHaveLength(1);
    expect(recorded.values).toHaveLength(UPSERT_COLUMNS.length * 2);
  });

  it('never touches a private row, never moves firstSeenAt or visibility, and keeps enrichment-filled fields', () => {
    expect(recorded.text).toContain(`WHERE "RAJob"."visibility" = 'public'`);
    const updateSet = recorded.text.split('DO UPDATE SET')[1]!.split(' WHERE "RAJob"."visibility"')[0]!;
    expect(updateSet).not.toContain('"firstSeenAt" =');
    expect(updateSet).not.toContain('"visibility" =');
    expect(updateSet).toContain(`"taxonomyIds" = CASE WHEN cardinality(EXCLUDED."taxonomyIds") > 0`);
    expect(updateSet).toContain(`"seniority" = COALESCE(EXCLUDED."seniority", "RAJob"."seniority")`);
  });

  it('revives only rows the source had dropped or the bank had closed', () => {
    expect(recorded.text).toContain(`"archivedAt" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed') THEN NULL`);
  });

  it('the VALUES column order matches UPSERT_COLUMNS and the row mapping', () => {
    expect(Object.keys(row)).toEqual([...UPSERT_COLUMNS]);
    const insertCols = recorded.text.match(/INSERT INTO "RAJob" \(([^)]*)\)/)![1]!.split(',').map((c) => c.trim().replace(/"/g, ''));
    expect(insertCols.slice(0, UPSERT_COLUMNS.length)).toEqual([...UPSERT_COLUMNS]);
    expect(insertCols.slice(UPSERT_COLUMNS.length)).toEqual(['firstSeenAt', 'lastSeenAt', 'updatedAt']);
  });

  it('writes in batches of 100', async () => {
    const db = createFakePrisma({ sql: { respond: () => [] } });
    const rows = Array.from({ length: 230 }, (_, i) => ({ ...row, id: `c${i}`, externalId: `x${i}` }));
    await upsertJobRows(db as unknown as IngestDb, rows);
    expect(db.$sql.calls).toHaveLength(3);
    expect(db.$sql.calls.map((c) => c.values.length / UPSERT_COLUMNS.length)).toEqual([100, 100, 30]);
  });
});

describe('row mapping honesty', () => {
  it('never writes an applicant count from linkedin or jsearch', () => {
    for (const provider of ['linkedin', 'jsearch'] as const) {
      const job = normalizeProviderJob(input({ applicantCount: 120, applicantCountSource: 'Some board' }), provider, { now: NOW });
      // Belt and braces: even a job object carrying a count is written without it.
      const r = toUpsertRow({ ...job, applicantCount: 120, applicantCountSource: 'x', applicantCountAt: NOW }, null);
      expect([r.applicantCount, r.applicantCountSource, r.applicantCountAt]).toEqual([null, null, null]);
    }
    const ok = toUpsertRow(normalizeProviderJob(input({ applicantCount: 7, applicantCountSource: 'Acme careers' }), 'activejobs', { now: NOW }), null);
    expect(ok.applicantCount).toBe(7);
  });

  it('employerVerified only for bank rows; no estimated salary; workModel stays null unless stated', () => {
    const j = normalizeProviderJob(input({ employerVerified: true }), 'activejobs', { now: NOW });
    const r = toUpsertRow(j, null);
    expect(r.employerVerified).toBe(false);
    expect(r.workModel).toBeNull();
    expect(r.salarySource).toBeNull();
    expect(r.salaryMin).toBeNull();
    expect(r.salaryCurrency).toBeNull();
    expect(r.publicDisplay).toBe(false);
  });

  it('ids are cuid-shaped with no hyphen (public URLs are <id>-<slug>)', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^c[0-9a-z]{24}$/);
  });

  it('content hash matches Postgres md5(title || "|" || descriptionPlain)', () => {
    // SELECT md5('a' || '|' || 'b') = d0726241020676b14aa6298ce6a18b21
    expect(contentHash('a', 'b')).toBe('d0726241020676b14aa6298ce6a18b21');
    expect(contentHash('a', 'b')).not.toBe(contentHash('a', 'c'));
  });
});

describe('dedupe', () => {
  const d = (id: string, sourcePriority: number, postedAt: string | null) => ({ id, sourcePriority, postedAt: postedAt ? new Date(postedAt) : null });

  it('picks the lowest sourcePriority, then the most recent postedAt', () => {
    const rows = [d('js', 30, '2026-10-09'), d('li', 20, '2026-10-01'), d('aj', 10, '2026-09-01'), d('bank', 15, '2026-10-10')];
    expect(pickCanonical(rows)!.id).toBe('aj');
    expect(pickCanonical([d('a', 20, '2026-10-01'), d('b', 20, '2026-10-05'), d('c', 20, null)])!.id).toBe('b');
    expect(pickCanonical([d('z', 20, null), d('y', 20, null)])!.id).toBe('y');
    expect(pickCanonical([])).toBeNull();
    expect(compareForCanonical(d('a', 10, null), d('b', 10, '2026-01-01'))).toBeGreaterThan(0);
  });

  it('SQL ranks live public rows per key in the same order and only writes changed flags', async () => {
    const text = sqlText(buildDedupeSql('intl', ['k1']));
    expect(text).toMatchSnapshot();
    expect(text).toContain('PARTITION BY "dedupeKey" ORDER BY "sourcePriority" ASC, "postedAt" DESC NULLS LAST, "firstSeenAt" ASC, "id" ASC');
    expect(text).toContain(`"visibility" = 'public' AND "archivedAt" IS NULL`);
    expect(text).toContain('IS DISTINCT FROM');
    expect(sqlText(buildDedupeSql('cn', null))).toContain(`"updatedAt" > now() - interval '2 days'`);
    const db = createFakePrisma();
    expect(await applyDedupe(db as unknown as IngestDb, 'intl', [])).toBe(0);
    expect(db.$sql.calls).toHaveLength(0);
  });
});
