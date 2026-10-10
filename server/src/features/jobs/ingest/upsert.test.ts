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
  fraudFlagsJson,
  marketTagsJson,
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

  it('revives only rows the source had dropped, the bank had closed, or that had no apply target', () => {
    for (const column of ['archivedAt', 'closedAt', 'closeReason']) {
      expect(recorded.text).toContain(`"${column}" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL`);
    }
    // 'expired', 'reported', 'duplicate' and a user's own removal stand.
    expect(recorded.text).not.toMatch(/IN \([^)]*'(expired|reported|duplicate|removed_by_user)'/);
  });

  it('educationLevel is written and kept when the source now says nothing', () => {
    expect(UPSERT_COLUMNS).toContain('educationLevel');
    expect(recorded.text).toContain(`"educationLevel" = COALESCE(EXCLUDED."educationLevel", "RAJob"."educationLevel")`);
  });

  it('a level read from the posting text never replaces the level of an enriched row; a provider label always does', () => {
    const fromText = normalizeProviderJob(input({ description: '任职要求：本科及以上学历。' }), 'activejobs', { now: NOW });
    expect(fromText.fieldSources.educationLevel).toBe('posting_text');
    expect(toUpsertRow(fromText, null).educationLevel).toBe('bachelor');
    // Sent as NULL, so the statement's COALESCE keeps what enrichment stored.
    expect(toUpsertRow(fromText, null, 'c1', { keepStoredEducation: true }).educationLevel).toBeNull();
    const fromProvider = normalizeProviderJob(input({ educationLevel: '硕士' }), 'activejobs', { now: NOW });
    expect(fromProvider.fieldSources.educationLevel).toBe('provider');
    expect(toUpsertRow(fromProvider, null, 'c1', { keepStoredEducation: true }).educationLevel).toBe('master');
  });

  it('the VALUES column order matches UPSERT_COLUMNS and the row mapping', () => {
    expect(Object.keys(row)).toEqual([...UPSERT_COLUMNS]);
    const insertCols = recorded.text.match(/INSERT INTO "RAJob" \(([^)]*)\)/)![1]!.split(',').map((c) => c.trim().replace(/"/g, ''));
    expect(insertCols.slice(0, UPSERT_COLUMNS.length)).toEqual([...UPSERT_COLUMNS]);
    expect(insertCols.slice(UPSERT_COLUMNS.length)).toEqual(['firstSeenAt', 'lastSeenAt', 'updatedAt']);
  });

  it('SCHEMA-2: originalHost is written on insert and refreshed on update', () => {
    expect(row.originalHost).toBe('boards.greenhouse.io');
    expect(UPSERT_COLUMNS).toContain('originalHost');
    expect(recorded.text).toMatch(/INSERT INTO "RAJob" \([^)]*"originalSourceName", "originalHost", "atsType"/);
    expect(recorded.text).toContain('"originalHost" = EXCLUDED."originalHost"');
    expect(recorded.values[UPSERT_COLUMNS.indexOf('originalHost')]).toBe('boards.greenhouse.io');
  });

  it('R41-2: fraudFlags and marketTags are inserted, and on a re-ingest merged into what other modules stored', () => {
    const updateSet = recorded.text.split('DO UPDATE SET')[1]!;
    // Nothing incoming → the stored value is kept (never blanked by a re-ingest).
    expect(updateSet).toContain(`"fraudFlags" = CASE WHEN EXCLUDED."fraudFlags" IS NULL OR jsonb_typeof(EXCLUDED."fraudFlags") <> 'array' OR jsonb_array_length(EXCLUDED."fraudFlags") = 0 THEN "RAJob"."fraudFlags"`);
    // Nothing stored → the incoming list.
    expect(updateSet).toContain(`WHEN "RAJob"."fraudFlags" IS NULL OR jsonb_typeof("RAJob"."fraudFlags") <> 'array' THEN EXCLUDED."fraudFlags"`);
    // Both → the stored list plus the incoming entries it does not hold yet (same rule and evidence / same tag).
    expect(updateSet).toContain(`ELSE "RAJob"."fraudFlags" || COALESCE((`);
    expect(updateSet).toContain(`WHERE o.e->>'rule' = n.e->>'rule' AND o.e->>'evidence' = n.e->>'evidence'`);
    expect(updateSet).toContain(`"marketTags" = CASE WHEN EXCLUDED."marketTags" IS NULL`);
    expect(updateSet).toContain(`WHERE o.e->>'tag' = n.e->>'tag'`);
    // Never a plain overwrite of either column.
    expect(updateSet).not.toContain('"fraudFlags" = EXCLUDED."fraudFlags"');
    expect(updateSet).not.toContain('"marketTags" = EXCLUDED."marketTags"');
    expect(recorded.text).toMatch(/"publicDisplay", "fraudFlags", "marketTags", "educationLevel", "firstSeenAt"/);
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

  it('R41-2: flags and tags a market hook raised at normalize time are written with the row; the normalizer alone writes none', () => {
    const plain = normalizeProviderJob(input(), 'activejobs', { now: NOW });
    expect(toUpsertRow(plain, null)).toMatchObject({ fraudFlags: null, marketTags: null });

    // What cnAfterNormalize adds to a GoApply posting (hooked jobs keep the NormalizedJob shape).
    const flag = { rule: 'cn_training_loan', evidence: '入职需办理培训贷', at: NOW.toISOString(), method: 'keywords' };
    const tag = { tag: 'class_year:2027', evidenceQuote: '面向2027届毕业生', evidenceUrl: null };
    const hooked = { ...plain, market: 'cn' as const, fraudFlags: [flag], marketTags: [tag] };
    const r = toUpsertRow(hooked, null);
    expect(JSON.parse(r.fraudFlags!)).toEqual([flag]);
    expect(JSON.parse(r.marketTags!)).toEqual([tag]);
    const rec = toRecordedSql('$queryRaw', buildJobUpsertSql([r]), []);
    expect(rec.values[UPSERT_COLUMNS.indexOf('fraudFlags')]).toBe(r.fraudFlags);
    expect(rec.values[UPSERT_COLUMNS.indexOf('marketTags')]).toBe(r.marketTags);
  });

  it('only well-formed entries are written: a flag needs a rule and evidence, a tag needs its quote', () => {
    expect(fraudFlagsJson([{ rule: 'r', evidence: 'e', at: 'x' }, { rule: 'no_evidence' }, null, 'text', { rule: '', evidence: 'e' }])).toBe(JSON.stringify([{ rule: 'r', evidence: 'e', at: 'x' }]));
    expect(fraudFlagsJson([])).toBeNull();
    expect(fraudFlagsJson(null)).toBeNull();
    expect(fraudFlagsJson({ rule: 'r', evidence: 'e' })).toBeNull();
    // A market tag never renders without its quote, so one without a quote is not stored.
    expect(marketTagsJson([{ tag: 'hukou', evidenceQuote: '可落户' }, { tag: 'soe', evidenceQuote: '  ' }, { tag: 'foreign' }, { evidenceQuote: 'q' }])).toBe(JSON.stringify([{ tag: 'hukou', evidenceQuote: '可落户' }]));
    expect(marketTagsJson(undefined)).toBeNull();
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
