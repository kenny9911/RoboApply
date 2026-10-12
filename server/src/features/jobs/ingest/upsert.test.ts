// @vitest-environment node
// WP-16b: the batch RAJob upsert (SQL snapshot), the row mapping honesty
// rules, and dedupe (lowest sourcePriority wins).
// MKT-3C (JI-5, JC-7, JI-7, JT-7): the posting key and the carry-through
// columns in the upsert, the sponsorship rule, and dedupe in two steps (exact
// twins first, then one canonical row per key) inside one market. The two
// dedupe statements cannot run here (no database): their text is pinned by
// snapshot and by string assertions, and `dedupeTable` below plays them over
// an in-memory table with the same rules, built from the exported mirrors
// (`alignPostingKeys`, `compareForCanonical`).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { AGE_EXPIRY_BOARDS, normalizeProviderJob, type NormalizeProvider, type ProviderJobInput } from '../normalize/index.js';
import { TITLE_MATCH_TRUSTED } from '../taxonomy/index.js';
import type { IngestDb } from './db.js';
import { newId } from './db.js';
import {
  EXPIRED_CLOSE_REASON,
  PROVIDER_SPONSORSHIP_PREFIX,
  REVIVED_CLOSE_REASONS,
  SPONSORSHIP_SOURCE_QUOTE,
  UPSERT_COLUMNS,
  alignPostingKeyGroups,
  alignPostingKeys,
  applyDedupe,
  fraudFlagsJson,
  marketTagsJson,
  buildDedupeSql,
  buildJobUpsertSql,
  buildPostingKeyAlignSql,
  compareForCanonical,
  contentHash,
  pickCanonical,
  revivesOnRelist,
  toUpsertRow,
  upsertJobRows,
  type DedupeCandidate,
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
    // An empty incoming role never blanks the stored one.
    expect(updateSet).toContain(`"taxonomyIds" = CASE WHEN cardinality(EXCLUDED."taxonomyIds") = 0 THEN "RAJob"."taxonomyIds"`);
    expect(updateSet).toContain(`"primaryTaxonomyId" = CASE WHEN EXCLUDED."primaryTaxonomyId" IS NULL THEN "RAJob"."primaryTaxonomyId"`);
    expect(updateSet).toContain(`"seniority" = COALESCE(EXCLUDED."seniority", "RAJob"."seniority")`);
  });

  it('MKT-1E request 1: a refresh replaces the role of an enriched row only on a decisive title or a changed title; the score is always written', () => {
    const updateSet = recorded.text.split('DO UPDATE SET')[1]!.split(' WHERE "RAJob"."visibility"')[0]!;
    // One rule for both role columns: never enriched, no stored role, a decisive title (a 4-byte float, so ::real), or another title.
    const rule =
      `"RAJob"."enrichedAt" IS NULL OR cardinality("RAJob"."taxonomyIds") = 0` +
      ` OR EXCLUDED."titleMatchScore" >= ${TITLE_MATCH_TRUSTED}::real` +
      ` OR "RAJob"."titleNormalized" IS DISTINCT FROM EXCLUDED."titleNormalized"`;
    expect(TITLE_MATCH_TRUSTED).toBe(0.9);
    expect(updateSet).toContain(`WHEN ${rule} THEN EXCLUDED."taxonomyIds" ELSE "RAJob"."taxonomyIds" END`);
    expect(updateSet).toContain(`WHEN ${rule} THEN EXCLUDED."primaryTaxonomyId" ELSE "RAJob"."primaryTaxonomyId" END`);
    expect(updateSet).not.toMatch(/"titleMatchScore" >= 0\.9(?!::real)/);
    expect(updateSet).toContain(`"titleMatchScore" = EXCLUDED."titleMatchScore"`);
    // The score is the title's, cast for a NULL: an exact role phrase is decisive, an unknown title has none.
    expect(UPSERT_COLUMNS).toContain('titleMatchScore');
    expect(recorded.text).toContain('::real');
    expect(row.titleMatchScore).toBeGreaterThanOrEqual(TITLE_MATCH_TRUSTED);
    const unknown = toUpsertRow(normalizeProviderJob(input({ title: 'Zzyzx Qwfp' }), 'activejobs', { now: NOW }), 'co1', 'cjobid000000000000000001');
    expect(unknown).toMatchObject({ taxonomyIds: [], primaryTaxonomyId: null, titleMatchScore: null });
  });

  it('revives the rows the source had dropped, the bank had closed, or that had no apply target, whatever the listing says', () => {
    for (const column of ['archivedAt', 'closedAt', 'closeReason']) {
      expect(recorded.text).toContain(`"${column}" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL`);
    }
    expect(REVIVED_CLOSE_REASONS).toEqual(['source_removed', 'bank_closed', 'no_apply_target']);
    // 'reported', 'duplicate' and a user's own removal always stand; 'expired' is never in the unconditional list.
    expect(recorded.text).not.toMatch(/IN \([^)]*'(expired|reported|duplicate|removed_by_user)'/);
    expect(recorded.text).not.toMatch(/'(reported|duplicate|removed_by_user)'/);
  });

  // Review finding 3 (JI-10 "a posting still listed by its board is ingested"): every source may state a deadline
  // now, so a row of any board can be closed as 'expired'. A listing that says the posting is open again reopens it.
  describe('a row closed as expired is reopened only by a listing that says it is open again', () => {
    const expiredBranch =
      `WHEN "RAJob"."closeReason" = 'expired' AND (EXCLUDED."expiresAt" > now()` +
      ` OR (EXCLUDED."expiresAt" IS NULL AND EXCLUDED."sourceBoard" <> ALL(ARRAY['activejobs', 'linkedin', 'jsearch']::text[]))) THEN NULL`;

    it('the statement: one rule for the three lifecycle columns, the age boards read from AGE_EXPIRY_BOARDS', () => {
      expect(AGE_EXPIRY_BOARDS).toEqual(['activejobs', 'linkedin', 'jsearch']);
      expect(EXPIRED_CLOSE_REASON).toBe('expired');
      for (const column of ['archivedAt', 'closedAt', 'closeReason']) {
        expect(recorded.text).toContain(
          `"${column}" = CASE WHEN "RAJob"."closeReason" IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL ${expiredBranch} ELSE "RAJob"."${column}" END`,
        );
      }
      // Inlined constants: the rule adds no parameter to the batch.
      expect(recorded.values).toHaveLength(UPSERT_COLUMNS.length * 2);
    });

    const future = new Date(NOW.getTime() + 20 * 86_400_000);
    const past = new Date(NOW.getTime() - 86_400_000);
    it.each([
      // [stored reason, board, incoming expiresAt, reopened, why]
      ['expired', 'tw_open_data', future, true, 'a 台灣就業通 posting renewed with a later STOP_DATE'],
      ['expired', 'greenhouse', future, true, 'an employer board extended its application deadline'],
      ['expired', 'greenhouse', null, true, 'an employer board removed the deadline'],
      ['expired', 'gohire', null, true, 'a bank row whose deadline was removed'],
      ['expired', 'usajobs', future, true, 'a government posting reopened with a later closing date'],
      ['expired', 'tw_open_data', past, false, 'the same passed deadline is listed again'],
      ['expired', 'greenhouse', NOW, false, 'a deadline of this very instant has passed'],
      ['expired', 'jsearch', past, false, 'an aggregator row that ran out by age keeps postedAt + 45 or 21 days, in the past'],
      ['expired', 'activejobs', past, false, 'the same for the licensed feed'],
      ['expired', 'jsearch', null, false, 'an aggregator row with no posting date never has a life to renew'],
      ['expired', 'linkedin', null, false, 'the same for the other age boards'],
      ['expired', 'jsearch', future, true, 'an aggregator states a later date (a repost, or a stated valid-through)'],
      ['source_removed', 'jsearch', past, true, 'the source dropped it and lists it again'],
      ['bank_closed', 'gohire', null, true, 'the bank reopened it'],
      ['no_apply_target', 'gohire', null, true, 'the bank has a posting page now'],
      ['reported', 'greenhouse', future, false, 'a reported posting stays closed'],
      ['duplicate', 'greenhouse', null, false, 'a duplicate stays closed'],
      ['removed_by_user', 'greenhouse', null, false, 'never a reason this statement undoes'],
      [null, 'greenhouse', future, false, 'an open row has nothing to reopen'],
    ] as Array<[string | null, string, Date | null, boolean, string]>)('%s on %s, listed with expiresAt %s: reopened %s (%s)', (reason, sourceBoard, expiresAt, reopened) => {
      expect(revivesOnRelist(reason, { sourceBoard, expiresAt }, NOW)).toBe(reopened);
    });

    it('end to end through the normalizer: what each source now sends decides', () => {
      const relist = (provider: NormalizeProvider, over: Partial<ProviderJobInput>) => {
        const job = normalizeProviderJob(input(over), provider, { now: NOW });
        const r = toUpsertRow(job, null, 'cjobid000000000000000009');
        return revivesOnRelist('expired', { sourceBoard: r.sourceBoard, expiresAt: r.expiresAt }, NOW);
      };
      // An employer board: no deadline (however old), or a later one, reopens; a passed one does not.
      expect(relist('ats_public', { sourceBoard: 'greenhouse', postedAt: '2026-01-01T00:00:00Z' })).toBe(true);
      expect(relist('ats_public', { sourceBoard: 'greenhouse', expiresAt: '2026-11-30' })).toBe(true);
      expect(relist('ats_public', { sourceBoard: 'greenhouse', expiresAt: '2026-10-01' })).toBe(false);
      // 台灣就業通: STOP_DATE renewed, or the same passed day.
      expect(relist('tw_open_data', { expiresAt: '2026/11/15' })).toBe(true);
      expect(relist('tw_open_data', { expiresAt: '2026/10/01' })).toBe(false);
      // JSearch: the same posting date gives the same past expiry; a row old enough to have run out stays closed.
      expect(relist('jsearch', { applyUrl: 'https://www.totaljobs.com/job/9', postedAt: '2026-08-01T00:00:00Z' })).toBe(false);
      expect(relist('jsearch', { postedAt: '2026-08-01T00:00:00Z' })).toBe(false);
      expect(relist('activejobs', { postedAt: '2026-08-01T00:00:00Z' })).toBe(false);
    });
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
    expect(recorded.text).toMatch(/"publicDisplay", "fraudFlags", "marketTags", "educationLevel", "atsPostingKey"/);
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

describe('MKT-3C: the posting key and the carry-through columns in the upsert', () => {
  const job = (over: Partial<ProviderJobInput> = {}, provider: NormalizeProvider = 'activejobs_feed') => normalizeProviderJob(input(over), provider, { now: NOW });
  const sqlOf = (rows: ReturnType<typeof toUpsertRow>[]) => toRecordedSql('$queryRaw', buildJobUpsertSql(rows), []);
  const updateSetOf = (text: string) => text.split('DO UPDATE SET')[1]!.split(' WHERE "RAJob"."visibility"')[0]!;
  const base = sqlOf([toUpsertRow(job(), 'co1', 'cjobid000000000000000000')]);
  const updateSet = updateSetOf(base.text);

  it('exactly six columns are new, after educationLevel and before the three timestamps', () => {
    const at = UPSERT_COLUMNS.indexOf('educationLevel');
    expect(UPSERT_COLUMNS.slice(at + 1)).toEqual(['atsPostingKey', 'locationDistrict', 'workShift', 'headcount', 'sponsorship', 'sponsorshipSource']);
    expect(base.text).toMatch(/"educationLevel", "atsPostingKey", "locationDistrict", "workShift", "headcount", "sponsorship", "sponsorshipSource", "firstSeenAt", "lastSeenAt", "updatedAt"\)/);
    // Each is cast, so a NULL in the first row of a batch still has a type.
    expect(base.text).toMatch(/\$\d+::text, \$\d+::text, \$\d+::text, \$\d+::int, \$\d+::text, \$\d+::text, now\(\), now\(\), now\(\)\)/);
  });

  it('JI-5 ACCEPT: the key is written on insert and an existing row gets it on the next ingest', () => {
    const row = toUpsertRow(job(), null, 'c1');
    expect(row.atsPostingKey).toBe('greenhouse:acme:1');
    expect(sqlOf([row]).values[UPSERT_COLUMNS.indexOf('atsPostingKey')]).toBe('greenhouse:acme:1');
    expect(updateSet).toContain('"atsPostingKey" = EXCLUDED."atsPostingKey"');
    // No key in the links: NULL, and a refresh clears a key the posting no longer names.
    expect(toUpsertRow(job({ applyUrl: 'https://careers.acme.example/jobs/1' }), null, 'c1').atsPostingKey).toBeNull();
    expect(updateSet).not.toContain('COALESCE(EXCLUDED."atsPostingKey"');
  });

  it('JT-7 ACCEPT: district and shift round-trip and follow the source on a refresh; headcount is written (SCHEMA-8)', () => {
    const row = toUpsertRow(job({ locationDistrict: ' 竹北市 ', workShift: 'rotating', headcount: 3 }, 'tw_open_data'), null, 'c1');
    expect(row).toMatchObject({ locationDistrict: '竹北市', workShift: 'rotating', headcount: 3 });
    const values = sqlOf([row]).values;
    expect(values[UPSERT_COLUMNS.indexOf('locationDistrict')]).toBe('竹北市');
    expect(values[UPSERT_COLUMNS.indexOf('workShift')]).toBe('rotating');
    expect(values[UPSERT_COLUMNS.indexOf('headcount')]).toBe(3);
    for (const column of ['locationDistrict', 'workShift', 'headcount']) expect(updateSet).toContain(`"${column}" = EXCLUDED."${column}"`);
    // Not stated, an unknown shift, a headcount that is no count: NULL.
    expect(toUpsertRow(job({ workShift: '日班', headcount: 0 }), null, 'c1')).toMatchObject({ locationDistrict: null, workShift: null, headcount: null });
  });

  describe('sponsorship: a provider\'s reading is stored as a reading, and never over the posting\'s own words (D3)', () => {
    it("ACCEPT: 'offered' from activejobs_feed is written as sponsorship 'offered' with sponsorshipSource 'provider:activejobs_feed'", () => {
      const row = toUpsertRow(job({ sponsorshipProvider: 'offered' }), null, 'c1');
      expect(row).toMatchObject({ sponsorship: 'offered', sponsorshipSource: 'provider:activejobs_feed' });
      expect(PROVIDER_SPONSORSHIP_PREFIX).toBe('provider:');
      expect(SPONSORSHIP_SOURCE_QUOTE).toBe('posting_quote');
      const values = sqlOf([row]).values;
      expect(values[UPSERT_COLUMNS.indexOf('sponsorship')]).toBe('offered');
      expect(values[UPSERT_COLUMNS.indexOf('sponsorshipSource')]).toBe('provider:activejobs_feed');
      expect(toUpsertRow(job({ sponsorshipProvider: 'not_offered' }, 'activejobs'), null, 'c1')).toMatchObject({ sponsorship: 'not_offered', sponsorshipSource: 'provider:activejobs' });
    });

    it('no reading: both values are NULL, never a default; the two are always set together', () => {
      for (const provider of ['activejobs_feed', 'jsearch', 'ats_public', 'bank_gohire', 'tw_open_data'] as NormalizeProvider[]) {
        expect(toUpsertRow(job({}, provider), null, 'c1')).toMatchObject({ sponsorship: null, sponsorshipSource: null });
        const row = toUpsertRow(job({ sponsorshipProvider: 'offered' }, provider), null, 'c1');
        expect(row.sponsorshipSource).toBe(`provider:${provider}`);
        expect(row.sponsorship).toBe('offered');
      }
      // A value that is not a reading, and a user's own import (no provider stands behind it).
      expect(toUpsertRow({ ...job(), sponsorshipProvider: 'yes' as never }, null, 'c1')).toMatchObject({ sponsorship: null, sponsorshipSource: null });
      expect(toUpsertRow(normalizeProviderJob(input({ sponsorshipProvider: 'offered' }), 'user_import', { now: NOW, ownerUserId: 'u1' }), null, 'c1')).toMatchObject({ sponsorship: null, sponsorshipSource: null });
    });

    it('ACCEPT: on a conflict a quoted row is left unchanged, an unquoted row takes the reading, a withdrawn reading is cleared, anything else stands', () => {
      for (const column of ['sponsorship', 'sponsorshipSource']) {
        expect(updateSet).toContain(
          `"${column}" = CASE` +
            // 1. The posting's own words (enrichment's quote; from MKT-4D on also the source value): never overwritten.
            ` WHEN "RAJob"."sponsorshipSource" = 'posting_quote' OR "RAJob"."sponsorshipEvidence" IS NOT NULL THEN "RAJob"."${column}"` +
            // 2. The provider states a reading now: it is stored with its source.
            ` WHEN EXCLUDED."sponsorshipSource" IS NOT NULL THEN EXCLUDED."${column}"` +
            // 3. The provider no longer states one: its old reading goes, with its source.
            ` WHEN "RAJob"."sponsorshipSource" LIKE 'provider:%' THEN NULL` +
            // 4. Whatever else is stored (a value another writer put there) is left alone.
            ` ELSE "RAJob"."${column}" END`,
        );
        // Never a plain overwrite, and never a COALESCE (which could not clear a withdrawn reading).
        expect(updateSet).not.toContain(`"${column}" = EXCLUDED."${column}"`);
        expect(updateSet).not.toContain(`"${column}" = COALESCE(`);
      }
      // The quote itself is enrichment's column: the upsert never writes it.
      expect(base.text).not.toContain('"sponsorshipEvidence" =');
      expect(UPSERT_COLUMNS as readonly string[]).not.toContain('sponsorshipEvidence');
    });
  });
});

/**
 * An in-memory RAJob table that plays the two dedupe statements. The market,
 * the keys and the extra keys are read from the statements' own parameters, so
 * a statement built for one market can only ever touch that market's rows here
 * as in Postgres.
 */
interface TableRow extends DedupeCandidate {
  market: 'intl' | 'cn';
  visibility: string;
  archivedAt: Date | null;
  closeReason: string | null;
  dedupeKey: string | null;
  atsPostingKey: string | null;
  locationCity: string | null;
  updatedAt: Date;
  isCanonical: boolean;
  canonicalJobId: string | null;
}

const RECENT = new Date('2026-10-09T12:00:00Z');
const LONG_AGO = new Date('2026-09-01T00:00:00Z');

function tableRow(over: Partial<TableRow> & { id: string }): TableRow {
  return {
    market: 'intl',
    visibility: 'public',
    archivedAt: null,
    closeReason: null,
    dedupeKey: `k:${over.id}`,
    atsPostingKey: null,
    sourcePriority: 30,
    postedAt: new Date('2026-10-01T00:00:00Z'),
    firstSeenAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: RECENT,
    locationCountry: 'US',
    locationCity: 'Austin',
    salaryDisclosed: false,
    atsType: null,
    // A new row is canonical until dedupe says otherwise (the column default).
    isCanonical: true,
    canonicalJobId: null,
    ...over,
  };
}

function dedupeTable(rows: TableRow[]) {
  const twoDaysBefore = NOW.getTime() - 2 * 86_400_000;
  const live = (market: string) => rows.filter((r) => r.market === market && r.visibility === 'public' && r.archivedAt === null);
  const db = createFakePrisma({
    sql: {
      respond(call) {
        const market = String(call.values[0]);
        const lists = call.values.filter((v): v is string[] => Array.isArray(v));
        if (call.text.startsWith('WITH touched AS')) {
          const keys = call.text.includes('"dedupeKey" = ANY(') ? lists[0]! : null;
          const touched = new Set(
            live(market)
              .filter((r) => r.atsPostingKey && (keys ? !!r.dedupeKey && keys.includes(r.dedupeKey) : r.updatedAt.getTime() > twoDaysBefore))
              .map((r) => r.atsPostingKey!),
          );
          const group = live(market).filter((r) => r.atsPostingKey && touched.has(r.atsPostingKey));
          const moved = alignPostingKeys(group);
          const out: Array<{ fromKey: string | null; toKey: string | null }> = [];
          for (const r of group) {
            const m = moved.get(r.id);
            if (!m) continue;
            r.dedupeKey = m.toKey;
            out.push(m);
          }
          return out;
        }
        if (call.text.startsWith('WITH ranked AS')) {
          const recent = call.text.includes(`"updatedAt" > now() - interval '2 days'`);
          const named = new Set(lists.flat());
          const inScope = (r: TableRow) =>
            !!r.dedupeKey && (named.has(r.dedupeKey) || (recent && rows.some((o) => o.market === market && o.dedupeKey === r.dedupeKey && o.updatedAt.getTime() > twoDaysBefore)));
          const groups = new Map<string, TableRow[]>();
          for (const r of live(market).filter(inScope)) groups.set(r.dedupeKey!, [...(groups.get(r.dedupeKey!) ?? []), r]);
          let changed = 0;
          for (const group of groups.values()) {
            const canon = pickCanonical(group)!;
            for (const r of group) {
              const isCanonical = r.id === canon.id;
              const canonicalJobId = isCanonical ? null : canon.id;
              if (r.isCanonical === isCanonical && r.canonicalJobId === canonicalJobId) continue;
              r.isCanonical = isCanonical;
              r.canonicalJobId = canonicalJobId;
              changed += 1;
            }
          }
          return changed;
        }
        return undefined;
      },
    },
  });
  return { db: db as unknown as IngestDb, sql: db.$sql, row: (id: string) => rows.find((r) => r.id === id)! };
}

describe('dedupe', () => {
  const d = (id: string, sourcePriority: number, postedAt: string | null, over: Partial<DedupeCandidate> = {}): DedupeCandidate => ({ id, sourcePriority, postedAt: postedAt ? new Date(postedAt) : null, ...over });

  it('picks the lowest sourcePriority, then the most recent postedAt', () => {
    const rows = [d('js', 30, '2026-10-09'), d('li', 20, '2026-10-01'), d('aj', 10, '2026-09-01'), d('bank', 15, '2026-10-10')];
    expect(pickCanonical(rows)!.id).toBe('aj');
    expect(pickCanonical([d('a', 20, '2026-10-01'), d('b', 20, '2026-10-05'), d('c', 20, null)])!.id).toBe('b');
    expect(pickCanonical([d('z', 20, null), d('y', 20, null)])!.id).toBe('y');
    expect(pickCanonical([])).toBeNull();
    expect(compareForCanonical(d('a', 10, null), d('b', 10, '2026-01-01'))).toBeGreaterThan(0);
  });

  describe('MKT-3C: the canonical order (JI-5, JC-7; MARKET_STRATEGY §1.5 "Canonical row")', () => {
    const order = (rows: DedupeCandidate[]) => [...rows].sort(compareForCanonical).map((r) => r.id);

    it('priority: GoHire bank 3, employer board 5, licensed feed 10, RoboHire bank 15, JSearch 30', () => {
      // The newest row is the aggregator's: priority decides before recency.
      expect(order([d('jsearch', 30, '2026-10-09'), d('robohire', 15, '2026-10-08'), d('feed', 10, '2026-10-07'), d('board', 5, '2026-09-01'), d('gohire', 3, '2026-08-01')])).toEqual(['gohire', 'board', 'feed', 'robohire', 'jsearch']);
      // The employer's own board no longer ties with the feed that copied it.
      expect(pickCanonical([d('feed', 10, '2026-10-09'), d('board', 5, '2026-09-01')])!.id).toBe('board');
    });

    it('Taiwan twins: the row with disclosed pay comes first, before priority', () => {
      const openData = d('open_data', 12, '2026-09-20', { locationCountry: 'TW', salaryDisclosed: true, atsType: null });
      const board = d('board', 5, '2026-10-01', { locationCountry: 'TW', salaryDisclosed: false, atsType: 'greenhouse' });
      const jsearch = d('jsearch_104', 30, '2026-10-05', { locationCountry: 'TW', salaryDisclosed: false, atsType: null });
      expect(order([jsearch, board, openData])).toEqual(['open_data', 'board', 'jsearch_104']);
      // ACCEPT: a Taiwan open-data row with pay beats a JSearch twin without pay (it would also win on priority).
      expect(pickCanonical([jsearch, openData])!.id).toBe('open_data');
      // And the reverse: a JSearch row (104 through Google's index) that states pay beats the open-data row that does not.
      expect(pickCanonical([{ ...jsearch, salaryDisclosed: true }, { ...openData, salaryDisclosed: false }])!.id).toBe('jsearch_104');
      // Both state pay, or neither: priority decides, as everywhere.
      expect(pickCanonical([{ ...jsearch, salaryDisclosed: true }, openData])!.id).toBe('open_data');
      expect(pickCanonical([jsearch, { ...openData, salaryDisclosed: false }])!.id).toBe('open_data');
    });

    it('the pay rule is Taiwan\'s only: elsewhere disclosed pay does not outrank a better source', () => {
      for (const country of ['US', 'CN', 'JP', null, undefined]) {
        const paid = d('jsearch_paid', 30, '2026-10-05', { locationCountry: country, salaryDisclosed: true });
        const board = d('board', 5, '2026-09-01', { locationCountry: country, salaryDisclosed: false });
        expect(pickCanonical([paid, board])!.id, String(country)).toBe('board');
      }
      // salaryDisclosed must be exactly true.
      expect(pickCanonical([d('a', 30, null, { locationCountry: 'TW', salaryDisclosed: null }), d('b', 5, null, { locationCountry: 'TW', salaryDisclosed: false })])!.id).toBe('b');
    });

    it('same priority: an apply link on the employer\'s site or an ATS comes before a job board\'s, before recency', () => {
      const onBoard = d('feed_on_job_board', 10, '2026-10-09', { atsType: null });
      const onAts = d('feed_on_ats', 10, '2026-09-01', { atsType: 'workday' });
      const onEmployer = d('feed_on_employer_site', 10, '2026-08-01', { atsType: 'other' });
      expect(order([onBoard, onAts, onEmployer])).toEqual(['feed_on_ats', 'feed_on_employer_site', 'feed_on_job_board']);
      // The tie-break never overrides priority.
      expect(pickCanonical([d('jsearch_direct', 30, '2026-10-09', { atsType: 'lever' }), d('feed_board_link', 10, '2026-09-01', { atsType: null })])!.id).toBe('feed_board_link');
      // Then recency (nulls last), first seen, id: today's tail, unchanged.
      expect(order([d('old', 10, '2026-09-01', { atsType: 'lever' }), d('new', 10, '2026-10-01', { atsType: 'lever' }), d('undated', 10, null, { atsType: 'lever' })])).toEqual(['new', 'old', 'undated']);
      const seen = (id: string, firstSeenAt: string) => d(id, 10, '2026-10-01', { firstSeenAt: new Date(firstSeenAt) });
      expect(order([seen('later', '2026-10-03'), seen('earlier', '2026-10-02')])).toEqual(['earlier', 'later']);
      expect(order([d('b', 10, '2026-10-01'), d('a', 10, '2026-10-01')])).toEqual(['a', 'b']);
    });

    it('the SQL window orders by the same columns in the same order', () => {
      const text = sqlText(buildDedupeSql('intl', ['k1']));
      expect(text).toContain(
        `PARTITION BY "dedupeKey" ORDER BY (CASE WHEN "locationCountry" = 'TW' AND "salaryDisclosed" THEN 0 ELSE 1 END) ASC, "sourcePriority" ASC,` +
          ` (CASE WHEN "atsType" IS NOT NULL THEN 0 ELSE 1 END) ASC, "postedAt" DESC NULLS LAST, "firstSeenAt" ASC, "id" ASC`,
      );
    });
  });

  it('SQL ranks live public rows per key in the same order and only writes changed flags', async () => {
    const text = sqlText(buildDedupeSql('intl', ['k1']));
    expect(text).toMatchSnapshot();
    expect(text).toContain('"postedAt" DESC NULLS LAST, "firstSeenAt" ASC, "id" ASC');
    expect(text).toContain(`"visibility" = 'public' AND "archivedAt" IS NULL`);
    expect(text).toContain('IS DISTINCT FROM');
    expect(sqlText(buildDedupeSql('cn', null))).toContain(`"updatedAt" > now() - interval '2 days'`);
    // Alternates stay live: dedupe writes the two canonical columns and nothing else (no archive, no close reason).
    expect(text.split(' SET ')[1]!.split(' FROM ranked')[0]).toBe('"isCanonical" = (r.rn = 1), "canonicalJobId" = CASE WHEN r.rn = 1 THEN NULL ELSE r.canon END');
    for (const column of ['archivedAt', 'closedAt', 'closeReason']) expect(text).not.toContain(`"${column}" =`);
    const db = createFakePrisma();
    expect(await applyDedupe(db as unknown as IngestDb, 'intl', [])).toBe(0);
    expect(db.$sql.calls).toHaveLength(0);
  });

  describe('MKT-3C step 1: exact twins share one dedupe key (K2 before K3)', () => {
    it('the statement (snapshot): one UPDATE … RETURNING, every read and the write scoped to the market', () => {
      const forPage = toRecordedSql('$queryRaw', buildPostingKeyAlignSql('intl', ['k1', 'k2']), []);
      expect(forPage.text).toMatchSnapshot();
      expect(forPage.values).toEqual(['intl', ['k1', 'k2'], 'intl', 'intl', 'intl']);
      // touched, best, moved and the UPDATE itself: four market predicates, one per place a row is read or written.
      expect(forPage.text.match(/"market" = \$\d+/g)).toHaveLength(4);
      expect(forPage.text).toContain('"dedupeKey" = ANY($2::text[])');
      // Only live public rows are grouped; a group is one posting key at one primary place (country and city,
      // the city compared without case, "not stated" equal to "not stated"); the best row is the lowest
      // priority, then first seen, then id.
      expect(forPage.text.match(/"visibility" = 'public' AND (?:j\.)?"archivedAt" IS NULL/g)).toHaveLength(3);
      const country = `coalesce(j."locationCountry", '')`;
      const city = `lower(coalesce(j."locationCity", ''))`;
      expect(forPage.text).toContain(`SELECT DISTINCT ON (j."atsPostingKey", ${country}, ${city}) j."atsPostingKey", ${country} AS "country", ${city} AS "city", j."dedupeKey"`);
      expect(forPage.text).toContain(`ORDER BY j."atsPostingKey", ${country}, ${city}, j."sourcePriority" ASC, j."firstSeenAt" ASC, j."id" ASC`);
      expect(forPage.text).toContain(`JOIN best b ON b."atsPostingKey" = j."atsPostingKey" AND b."country" = ${country} AND b."city" = ${city}`);
      expect(forPage.text).toContain('SET "dedupeKey" = m."toKey"');
      expect(forPage.text).toContain('RETURNING m."fromKey" AS "fromKey", m."toKey" AS "toKey"');
      // Raw SQL on RAJob names its columns: never a star, never the search vector.
      expect(forPage.text).not.toMatch(/SELECT \*|RETURNING \*|j\.\*|searchTsv/);
      expect(forPage.text.match(/UPDATE "RAJob"/g)).toHaveLength(1);

      const repair = toRecordedSql('$queryRaw', buildPostingKeyAlignSql('cn', null), []);
      expect(repair.text).toMatchSnapshot();
      expect(repair.values).toEqual(['cn', 'cn', 'cn', 'cn']);
      expect(repair.text).toContain(`"updatedAt" > now() - interval '2 days'`);
      expect(repair.text).not.toContain('ANY(');
    });

    it('alignPostingKeys: every row of a posting-key group takes the key of the group\'s best row', () => {
      const at = (iso: string) => new Date(iso);
      const moved = alignPostingKeys([
        { id: 'board', atsPostingKey: 'greenhouse:stripe:123', dedupeKey: 'K_board', sourcePriority: 5, firstSeenAt: at('2026-10-05') },
        { id: 'jsearch', atsPostingKey: 'greenhouse:stripe:123', dedupeKey: 'K_jsearch', sourcePriority: 30, firstSeenAt: at('2026-10-01') },
        { id: 'feed', atsPostingKey: 'greenhouse:stripe:123', dedupeKey: 'K_board', sourcePriority: 10, firstSeenAt: at('2026-10-02') },
        { id: 'other_posting', atsPostingKey: 'greenhouse:stripe:999', dedupeKey: 'K_other', sourcePriority: 30, firstSeenAt: at('2026-10-01') },
        { id: 'no_key', atsPostingKey: null, dedupeKey: 'K_jsearch', sourcePriority: 30, firstSeenAt: at('2026-10-01') },
      ]);
      expect([...moved]).toEqual([['jsearch', { fromKey: 'K_jsearch', toKey: 'K_board' }]]);
      // Same priority: first seen, then id.
      expect([...alignPostingKeys([
        { id: 'b', atsPostingKey: 'x', dedupeKey: 'Kb', sourcePriority: 10, firstSeenAt: at('2026-10-02') },
        { id: 'a', atsPostingKey: 'x', dedupeKey: 'Ka', sourcePriority: 10, firstSeenAt: at('2026-10-02') },
        { id: 'c', atsPostingKey: 'x', dedupeKey: 'Kc', sourcePriority: 10, firstSeenAt: at('2026-10-01') },
      ]).entries()]).toEqual([['b', { fromKey: 'Kb', toKey: 'Kc' }], ['a', { fromKey: 'Ka', toKey: 'Kc' }]]);
      // The same posting in another city (an aggregator's row per location) is another group: it keeps its key.
      const places = alignPostingKeys([
        { id: 'board_austin', atsPostingKey: 'x', dedupeKey: 'K_austin', sourcePriority: 5, locationCountry: 'US', locationCity: 'Austin' },
        { id: 'js_austin', atsPostingKey: 'x', dedupeKey: 'K_js_austin', sourcePriority: 30, locationCountry: 'US', locationCity: 'austin' },
        { id: 'js_dallas', atsPostingKey: 'x', dedupeKey: 'K_js_dallas', sourcePriority: 30, locationCountry: 'US', locationCity: 'Dallas' },
        { id: 'feed_dallas', atsPostingKey: 'x', dedupeKey: 'K_feed_dallas', sourcePriority: 10, locationCountry: 'US', locationCity: 'Dallas' },
        { id: 'js_austin_ca', atsPostingKey: 'x', dedupeKey: 'K_js_ca', sourcePriority: 30, locationCountry: 'CA', locationCity: 'Austin' },
        { id: 'js_no_city', atsPostingKey: 'x', dedupeKey: 'K_js_none', sourcePriority: 30, locationCountry: 'US', locationCity: null },
        { id: 'js_no_city_2', atsPostingKey: 'x', dedupeKey: 'K_js_none_2', sourcePriority: 30, locationCountry: 'US' },
      ]);
      expect(Object.fromEntries(places)).toEqual({
        js_austin: { fromKey: 'K_js_austin', toKey: 'K_austin' },
        js_dallas: { fromKey: 'K_js_dallas', toKey: 'K_feed_dallas' },
        js_no_city_2: { fromKey: 'K_js_none_2', toKey: 'K_js_none' },
      });
      // A group of one, a group already aligned, no rows: nothing moves.
      expect(alignPostingKeys([{ id: 'only', atsPostingKey: 'x', dedupeKey: 'K', sourcePriority: 5 }]).size).toBe(0);
      expect(alignPostingKeys([{ id: 'a', atsPostingKey: 'x', dedupeKey: 'K', sourcePriority: 5 }, { id: 'b', atsPostingKey: 'x', dedupeKey: 'K', sourcePriority: 30 }]).size).toBe(0);
      expect(alignPostingKeys([]).size).toBe(0);
    });

    it('alignPostingKeyGroups returns the keys rows left and the keys they joined; an empty page reads nothing', async () => {
      const moved = [{ fromKey: 'K_jsearch', toKey: 'K_board' }, { fromKey: 'K_feed', toKey: 'K_board' }, { fromKey: null, toKey: 'K_x' }];
      const db = createFakePrisma({ sql: { respond: () => moved } });
      expect((await alignPostingKeyGroups(db as unknown as IngestDb, 'intl', ['K_jsearch'])).sort()).toEqual(['K_board', 'K_feed', 'K_jsearch', 'K_x']);
      expect(db.$sql.calls).toHaveLength(1);
      const none = createFakePrisma();
      expect(await alignPostingKeyGroups(none as unknown as IngestDb, 'intl', [])).toEqual([]);
      expect(none.$sql.calls).toHaveLength(0);
      // A driver that answers something else than rows changes nothing.
      const odd = createFakePrisma({ sql: { respond: () => 3 } });
      expect(await alignPostingKeyGroups(odd as unknown as IngestDb, 'intl', null)).toEqual([]);
    });

    it('applyDedupe runs step 1, then ranks the page\'s keys plus every key step 1 changed', async () => {
      const db = createFakePrisma({ sql: { respond: (call) => (call.text.startsWith('WITH touched AS') ? [{ fromKey: 'K_jsearch', toKey: 'K_board' }] : 2) } });
      // The pipeline's call: the dedupe keys of the page, duplicates and all (signature unchanged).
      expect(await applyDedupe(db as unknown as IngestDb, 'intl', ['K_jsearch', 'K_jsearch', 'K_page'])).toBe(2);
      expect(db.$sql.calls.map((c) => [c.method, c.text.slice(0, 15)])).toEqual([['$queryRaw', 'WITH touched AS'], ['$executeRaw', 'WITH ranked AS ']]);
      expect(db.$sql.calls[0]!.values[1]).toEqual(['K_jsearch', 'K_page']);
      expect(db.$sql.calls[1]!.values).toEqual(['intl', ['K_jsearch', 'K_page', 'K_board']]);
      // The maintenance repair (keys null): every recently touched key, plus the groups step 1 changed.
      const repair = createFakePrisma({ sql: { respond: (call) => (call.text.startsWith('WITH touched AS') ? [{ fromKey: 'K_a', toKey: 'K_b' }] : 0) } });
      await applyDedupe(repair as unknown as IngestDb, 'cn', null);
      expect(repair.$sql.calls[1]!.text).toContain(`"updatedAt" > now() - interval '2 days') OR "dedupeKey" = ANY($3::text[]))`);
      expect(repair.$sql.calls[1]!.values).toEqual(['cn', 'cn', ['K_a', 'K_b']]);
      // Nothing moved: the repair statement is the plain one.
      const quiet = createFakePrisma();
      await applyDedupe(quiet as unknown as IngestDb, 'cn', null);
      expect(quiet.$sql.calls[1]!.values).toEqual(['cn', 'cn']);
      expect(quiet.$sql.calls[1]!.text).not.toContain('ANY(');
    });
  });

  describe('MKT-3C: the two steps over a table (the acceptance lines of JI-5)', () => {
    it('ACCEPT: a JSearch row and a board row for the same Greenhouse posting collapse to one canonical board row, though their titles differ', async () => {
      // The two rows as the normalizer writes them: different wording, so different fuzzy keys; one posting key.
      const jsearch = normalizeProviderJob(input({ externalId: 'jsearch:SYNTHETIC', title: 'Backend Engineer, Payments', applyUrl: 'https://boards.greenhouse.io/stripe/jobs/123' }), 'jsearch', { now: NOW });
      const board = normalizeProviderJob(input({ externalId: 'stripe:123', sourceBoard: 'greenhouse', title: 'Software Engineer (Backend), Payments', applyUrl: 'https://stripe.example/jobs/search?gh_jid=123' }), 'ats_public', { now: NOW });
      expect(jsearch.dedupeKey).not.toBe(board.dedupeKey);
      expect([jsearch.atsPostingKey, board.atsPostingKey]).toEqual(['greenhouse:stripe:123', 'greenhouse:stripe:123']);
      const of = (id: string, job: typeof jsearch, over: Partial<TableRow> = {}) =>
        tableRow({ id, dedupeKey: job.dedupeKey, atsPostingKey: job.atsPostingKey, sourcePriority: job.sourcePriority, atsType: job.atsType, postedAt: job.postedAt, locationCity: job.locationCity, locationCountry: job.locationCountry, ...over });
      expect([jsearch.locationCity, jsearch.locationCountry, board.locationCity, board.locationCountry]).toEqual(['Austin', 'US', 'Austin', 'US']);
      // JSearch found the posting first; the board row arrives with this page.
      const t = dedupeTable([of('js', jsearch, { firstSeenAt: new Date('2026-09-20T00:00:00Z') }), of('board', board, { firstSeenAt: new Date('2026-10-09T00:00:00Z') })]);
      expect(await applyDedupe(t.db, 'intl', [board.dedupeKey])).toBe(1);
      expect(t.row('board')).toMatchObject({ isCanonical: true, canonicalJobId: null, dedupeKey: board.dedupeKey });
      expect(t.row('js')).toMatchObject({ isCanonical: false, canonicalJobId: 'board', dedupeKey: board.dedupeKey });
      // The alternate stays live.
      expect(t.row('js')).toMatchObject({ archivedAt: null, closeReason: null });
      // A second run changes nothing.
      expect(await applyDedupe(t.db, 'intl', [board.dedupeKey])).toBe(0);
      // The next JSearch ingest writes its own fuzzy key again (the upsert does); dedupe puts it back in the group.
      t.row('js').dedupeKey = jsearch.dedupeKey;
      expect(await applyDedupe(t.db, 'intl', [jsearch.dedupeKey])).toBe(0);
      expect(t.row('js')).toMatchObject({ isCanonical: false, canonicalJobId: 'board', dedupeKey: board.dedupeKey });
    });

    it('the same posting listed in another city stays findable there: only twins at the same primary place collapse', async () => {
      const key = 'greenhouse:acme:4012345';
      const t = dedupeTable([
        // The employer's board row: one row for the posting, primary location Austin.
        tableRow({ id: 'board', dedupeKey: 'K_board', atsPostingKey: key, sourcePriority: 5, locationCity: 'Austin' }),
        // An aggregator lists the posting once per city.
        tableRow({ id: 'js_austin', dedupeKey: 'K_js_austin', atsPostingKey: key, sourcePriority: 30, locationCity: 'Austin' }),
        tableRow({ id: 'js_dallas', dedupeKey: 'K_js_dallas', atsPostingKey: key, sourcePriority: 30, locationCity: 'Dallas' }),
      ]);
      await applyDedupe(t.db, 'intl', ['K_board', 'K_js_austin', 'K_js_dallas']);
      expect(t.row('js_austin')).toMatchObject({ dedupeKey: 'K_board', isCanonical: false, canonicalJobId: 'board' });
      // The lists show canonical rows and match a row's primary city: the Dallas row must stay one.
      expect(t.row('js_dallas')).toMatchObject({ dedupeKey: 'K_js_dallas', isCanonical: true, canonicalJobId: null });
    });

    it('a row the exact key pulls out of its fuzzy group leaves that group ranked again', async () => {
      // "js" was the canonical row of fuzzy group K_title, with a twin from another aggregator under it.
      const t = dedupeTable([
        tableRow({ id: 'js', dedupeKey: 'K_title', atsPostingKey: 'lever:acme:u1', sourcePriority: 20 }),
        tableRow({ id: 'twin', dedupeKey: 'K_title', sourcePriority: 30, isCanonical: false, canonicalJobId: 'js' }),
        tableRow({ id: 'board', dedupeKey: 'K_board', atsPostingKey: 'lever:acme:u1', sourcePriority: 5 }),
      ]);
      await applyDedupe(t.db, 'intl', ['K_board']);
      expect(t.row('js')).toMatchObject({ dedupeKey: 'K_board', isCanonical: false, canonicalJobId: 'board' });
      // The group it left hands over to its next row.
      expect(t.row('twin')).toMatchObject({ dedupeKey: 'K_title', isCanonical: true, canonicalJobId: null });
    });

    it('ACCEPT: a GoHire bank row beats the same employer\'s board row for the same company, title and city', async () => {
      const posting = { title: '后端工程师', company: '示例科技', location: '上海', locationCountry: 'CN' };
      const bank = normalizeProviderJob(input({ ...posting, externalId: 'gh_1', sourceBoard: 'gohire', applyUrl: 'https://example.test/p/gh_1' }), 'bank_gohire', { now: NOW, market: 'cn' });
      const board = normalizeProviderJob(input({ ...posting, externalId: 'shili:77', sourceBoard: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/shili/jobs/77' }), 'ats_public', { now: NOW });
      const feed = normalizeProviderJob(input({ ...posting, externalId: 'activejobs:9', applyUrl: 'https://www.zhipin.com/job_detail/9.html' }), 'activejobs_feed', { now: NOW, market: 'cn' });
      expect(new Set([bank.dedupeKey, board.dedupeKey, feed.dedupeKey]).size).toBe(1);
      expect([bank.sourcePriority, board.sourcePriority, feed.sourcePriority]).toEqual([3, 5, 10]);
      const of = (id: string, job: typeof bank, postedAt: string) =>
        tableRow({ id, market: 'cn', dedupeKey: job.dedupeKey, atsPostingKey: job.atsPostingKey, sourcePriority: job.sourcePriority, atsType: job.atsType, locationCountry: job.locationCountry, locationCity: job.locationCity, postedAt: new Date(postedAt) });
      // The bank row is the oldest of the three: the mainland order decides, not recency.
      const t = dedupeTable([of('feed', feed, '2026-10-09T00:00:00Z'), of('board', board, '2026-10-05T00:00:00Z'), of('bank', bank, '2026-09-01T00:00:00Z')]);
      await applyDedupe(t.db, 'cn', [bank.dedupeKey]);
      expect(t.row('bank')).toMatchObject({ isCanonical: true, canonicalJobId: null });
      expect(t.row('board')).toMatchObject({ isCanonical: false, canonicalJobId: 'bank', archivedAt: null, closeReason: null });
      expect(t.row('feed')).toMatchObject({ isCanonical: false, canonicalJobId: 'bank', archivedAt: null, closeReason: null });
      // The bank closes its job: the employer's board row takes over at the next repair.
      t.row('bank').archivedAt = NOW;
      await applyDedupe(t.db, 'cn', null);
      expect(t.row('board')).toMatchObject({ isCanonical: true, canonicalJobId: null });
      expect(t.row('feed')).toMatchObject({ isCanonical: false, canonicalJobId: 'board' });
    });

    it('ACCEPT: the same posting key (and the same fuzzy key) in market intl and market cn stays two independent canonical rows', async () => {
      const shared = { dedupeKey: 'K_same', atsPostingKey: 'smartrecruiters:acmegroup:744000012345678' };
      const rows = [
        tableRow({ id: 'intl_board', market: 'intl', ...shared, sourcePriority: 5 }),
        tableRow({ id: 'intl_js', market: 'intl', dedupeKey: 'K_js_intl', atsPostingKey: shared.atsPostingKey, sourcePriority: 30 }),
        tableRow({ id: 'cn_board', market: 'cn', ...shared, sourcePriority: 5 }),
        tableRow({ id: 'cn_bank', market: 'cn', dedupeKey: 'K_same', atsPostingKey: null, sourcePriority: 3 }),
        tableRow({ id: 'cn_feed', market: 'cn', dedupeKey: 'K_feed_cn', atsPostingKey: shared.atsPostingKey, sourcePriority: 10 }),
      ];
      const t = dedupeTable(rows);
      const before = structuredClone(rows.filter((r) => r.market === 'cn'));
      await applyDedupe(t.db, 'intl', ['K_same', 'K_js_intl']);
      // intl is deduped on its own …
      expect(t.row('intl_board')).toMatchObject({ isCanonical: true, canonicalJobId: null });
      expect(t.row('intl_js')).toMatchObject({ dedupeKey: 'K_same', isCanonical: false, canonicalJobId: 'intl_board' });
      // … and no mainland row was read or written: not aligned, not ranked, although keys and posting key are identical.
      expect(rows.filter((r) => r.market === 'cn')).toEqual(before);
      expect(t.row('cn_feed').dedupeKey).toBe('K_feed_cn');
      for (const call of t.sql.calls) expect(call.values.filter((v) => v === 'intl' || v === 'cn')).toEqual(call.values.filter((v) => v === 'intl'));

      await applyDedupe(t.db, 'cn', ['K_same']);
      // The mainland group has its own canonical row (the bank's), and its own alignment.
      expect(t.row('cn_bank')).toMatchObject({ isCanonical: true, canonicalJobId: null });
      expect(t.row('cn_board')).toMatchObject({ isCanonical: false, canonicalJobId: 'cn_bank' });
      expect(t.row('cn_feed')).toMatchObject({ dedupeKey: 'K_same', isCanonical: false, canonicalJobId: 'cn_bank' });
      // The international rows are exactly as the first run left them: two canonical rows, one per market.
      expect(t.row('intl_board')).toMatchObject({ isCanonical: true, canonicalJobId: null });
      expect(t.row('intl_js')).toMatchObject({ canonicalJobId: 'intl_board' });
      expect(rows.filter((r) => r.isCanonical).map((r) => r.id).sort()).toEqual(['cn_bank', 'intl_board']);
    });

    it('ACCEPT: a Taiwan open-data row with pay beats a JSearch twin without pay; private and archived rows are never grouped', async () => {
      const t = dedupeTable([
        tableRow({ id: 'js_104', dedupeKey: 'K_tw', sourcePriority: 30, locationCountry: 'TW', salaryDisclosed: false, postedAt: new Date('2026-10-09T00:00:00Z') }),
        tableRow({ id: 'open_data', dedupeKey: 'K_tw', sourcePriority: 12, locationCountry: 'TW', salaryDisclosed: true, postedAt: new Date('2026-09-01T00:00:00Z') }),
        tableRow({ id: 'mine', dedupeKey: 'K_tw', sourcePriority: 90, visibility: 'private', atsPostingKey: 'lever:acme:u1' }),
        tableRow({ id: 'gone', dedupeKey: 'K_tw', sourcePriority: 3, archivedAt: LONG_AGO, closeReason: 'expired', atsPostingKey: 'lever:acme:u1' }),
        tableRow({ id: 'live_twin', dedupeKey: 'K_other', sourcePriority: 30, atsPostingKey: 'lever:acme:u1' }),
      ]);
      await applyDedupe(t.db, 'intl', ['K_tw', 'K_other']);
      expect(t.row('open_data')).toMatchObject({ isCanonical: true, canonicalJobId: null });
      expect(t.row('js_104')).toMatchObject({ isCanonical: false, canonicalJobId: 'open_data', archivedAt: null, closeReason: null });
      // A user's own import and an archived row keep their key and their flags, whatever key they share.
      expect(t.row('mine')).toMatchObject({ dedupeKey: 'K_tw', isCanonical: true, canonicalJobId: null });
      expect(t.row('gone')).toMatchObject({ dedupeKey: 'K_tw', isCanonical: true, closeReason: 'expired' });
      expect(t.row('live_twin')).toMatchObject({ dedupeKey: 'K_other', isCanonical: true });
    });

    it('the maintenance repair aligns only posting-key groups touched in the last two days', async () => {
      const t = dedupeTable([
        tableRow({ id: 'board', dedupeKey: 'K_board', atsPostingKey: 'ashby:acme:u1', sourcePriority: 5, updatedAt: RECENT }),
        tableRow({ id: 'js', dedupeKey: 'K_js', atsPostingKey: 'ashby:acme:u1', sourcePriority: 30, updatedAt: LONG_AGO }),
        tableRow({ id: 'stale_board', dedupeKey: 'K_sb', atsPostingKey: 'ashby:acme:u2', sourcePriority: 5, updatedAt: LONG_AGO }),
        tableRow({ id: 'stale_js', dedupeKey: 'K_sj', atsPostingKey: 'ashby:acme:u2', sourcePriority: 30, updatedAt: LONG_AGO }),
      ]);
      await applyDedupe(t.db, 'intl', null);
      expect(t.row('js')).toMatchObject({ dedupeKey: 'K_board', isCanonical: false, canonicalJobId: 'board' });
      expect(t.row('stale_js')).toMatchObject({ dedupeKey: 'K_sj', isCanonical: true });
    });
  });
});
