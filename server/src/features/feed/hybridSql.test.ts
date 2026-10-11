// @vitest-environment node
//
// MKT-4F: the three retrieval legs as SQL builders (MARKET_STRATEGY 2.1 point
// 3). Pure: no database. What is pinned here:
//   - the scope and filter predicates are the same in all three legs;
//   - the legs differ only in their ordering clause, the join of the dense leg
//     and the q rule (legs A and B apply the wide typed-query predicate, leg C
//     does not);
//   - the lexical query and the vector are bound parameters, never spliced text;
//   - legs B and C reach back to the list's age floor, not the 14-day window.

import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeSql } from '../../test/sqlSnapshot.js';
import { toTsQuery, vectorLiteral } from '../retrieval/index.js';
import { FILTER_FIELDS, type FilterSet } from '../search/index.js';
import { FEED_LIMITS } from './contract.js';
import { denseLegSql, legPredicates, lexicalLegSql, recencyLegSql } from './hybridSql.js';
import { ageFloorSql, filterPredicates, qPredicateSql, retrievalSql, scopePredicates, wideQPredicateSql, type SqlScope } from './sql.js';
import { testVector } from './testkit.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const FLOOR = new Date('2026-06-12T12:00:00.000Z');
const WINDOW = new Date('2026-09-26T12:00:00.000Z');
const TAG = 'openai/text-embedding-3-small@1024';
const VECTOR = vectorLiteral(testVector(0.6, 0.8));
const LIMIT = FEED_LIMITS.legLimit;

const intlScope: SqlScope = { market: 'intl', userId: 'u1', now: NOW };
const cnScope: SqlScope = { market: 'cn', userId: 'u2', now: NOW, heldBanks: ['robohire'] };

const FULL_INTL: FilterSet = {
  taxonomyIds: ['backend_engineer'],
  workModels: ['remote'],
  country: 'US',
  seniority: ['mid', 'senior'],
  salaryMin: { amount: 120000, currency: 'USD', period: 'year' },
  needsSponsorship: true,
  excludedCompanies: ['Globex LLC'],
  q: 'terraform',
};
const GOAPPLY: FilterSet = { taxonomyIds: ['backend_engineer'], employmentType: ['campus'], classYear: 2027, degree: ['bachelor'], q: '后端 开发' };

/** A statement with its long column list folded away and vectors shortened, so a snapshot shows what differs between legs. */
function show(sql: Prisma.Sql) {
  const text = normalizeSql(sql.text).replace(/^SELECT j\."id".*? FROM "RAJob" j/, 'SELECT <FEED_COLUMNS> FROM "RAJob" j');
  const values = sql.values.map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v.startsWith('[') && v.length > 200 ? `<vector of ${v.split(',').length}>` : v));
  return { text, values };
}

const texts = (parts: Prisma.Sql[]) => parts.map((p) => normalizeSql(p.text).replace(/\$\d+/g, '$n'));
const plain = (sql: Prisma.Sql) => normalizeSql(sql.text).replace(/\$\d+/g, '$n');

describe('lexicalLegSql and denseLegSql', () => {
  it('an empty filter set: scope, the age floor, the match, the order, the limit', () => {
    expect(show(lexicalLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, toTsQuery('backend engineer python')!))).toMatchInlineSnapshot(`
      {
        "text": "SELECT <FEED_COLUMNS> FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId" WHERE j."market" = $1 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL AND j."sourceBoard" <> 'seed' AND (j."fraudFlags" IS NULL OR jsonb_typeof(j."fraudFlags") <> 'array' OR j."fraudFlags" = '[]'::jsonb) AND (j."visibility" = 'public' OR j."ownerUserId" = $2) AND NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId" = $3 AND s."jobId" = j."id" AND s."hiddenAt" IS NOT NULL) AND (j."postedAt" >= $4::timestamp(3) OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($5::text[])))) AND j."searchTsv" @@ to_tsquery('simple', $6) ORDER BY ts_rank_cd(j."searchTsv", to_tsquery('simple', $7)) DESC, j."postedAt" DESC NULLS LAST, j."id" DESC LIMIT $8",
        "values": [
          "intl",
          "u1",
          "u1",
          "2026-06-12T12:00:00.000Z",
          [
            "activejobs",
            "linkedin",
            "jsearch",
            "user_import",
            "tw_open_data",
          ],
          "'backend' | 'engineer' | 'python'",
          "'backend' | 'engineer' | 'python'",
          200,
        ],
      }
    `);
    expect(show(denseLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, VECTOR, TAG))).toMatchInlineSnapshot(`
      {
        "text": "SELECT <FEED_COLUMNS> FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId" JOIN "RAJobEmbedding" e ON e."jobId" = j."id" AND e."model" = $1 AND e."market" = $2 WHERE j."market" = $3 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL AND j."sourceBoard" <> 'seed' AND (j."fraudFlags" IS NULL OR jsonb_typeof(j."fraudFlags") <> 'array' OR j."fraudFlags" = '[]'::jsonb) AND (j."visibility" = 'public' OR j."ownerUserId" = $4) AND NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId" = $5 AND s."jobId" = j."id" AND s."hiddenAt" IS NOT NULL) AND (j."postedAt" >= $6::timestamp(3) OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($7::text[])))) ORDER BY e."embedding" <=> $8::halfvec(1024), j."id" DESC LIMIT $9",
        "values": [
          "openai/text-embedding-3-small@1024",
          "intl",
          "intl",
          "u1",
          "u1",
          "2026-06-12T12:00:00.000Z",
          [
            "activejobs",
            "linkedin",
            "jsearch",
            "user_import",
            "tw_open_data",
          ],
          "<vector of 1024>",
          200,
        ],
      }
    `);
  });

  it('a full RoboApply set with a typed q: the lexical leg applies the wide q predicate, the dense leg does not', () => {
    const tsQuery = toTsQuery(FULL_INTL.q)!;
    expect(show(lexicalLegSql({ scope: intlScope, filters: FULL_INTL, ageFloor: FLOOR, limit: LIMIT }, tsQuery))).toMatchInlineSnapshot(`
      {
        "text": "SELECT <FEED_COLUMNS> FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId" WHERE j."market" = $1 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL AND j."sourceBoard" <> 'seed' AND (j."fraudFlags" IS NULL OR jsonb_typeof(j."fraudFlags") <> 'array' OR j."fraudFlags" = '[]'::jsonb) AND (j."visibility" = 'public' OR j."ownerUserId" = $2) AND NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId" = $3 AND s."jobId" = j."id" AND s."hiddenAt" IS NOT NULL) AND (j."taxonomyIds" && $4::text[]) AND j."workModel" = ANY($5::text[]) AND (j."locationCountry" = $6 OR (j."workModel" = 'remote' AND (j."remoteScope" = $7 OR j."remoteScope" = 'global'))) AND j."seniority" = ANY($8::text[]) AND ((j."salaryDisclosed" = true AND j."salaryCurrency" = $9 AND COALESCE(j."salaryAnnualMax", j."salaryAnnualMin") >= $10) OR j."salaryDisclosed" = false OR COALESCE(j."salaryAnnualMax", j."salaryAnnualMin") IS NULL OR j."salaryCurrency" IS DISTINCT FROM $11) AND NOT (j."sponsorship" = 'not_offered' AND COALESCE(j."sponsorshipEvidence", '') ~* $12) AND j."companyNameNormalized" <> ALL($13::text[]) AND (j."searchTsv" @@ to_tsquery('simple', $14) OR (j."searchText" ILIKE $15 OR $16 <% j."searchText")) AND (j."postedAt" >= $17::timestamp(3) OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($18::text[])))) AND j."searchTsv" @@ to_tsquery('simple', $19) ORDER BY ts_rank_cd(j."searchTsv", to_tsquery('simple', $20)) DESC, j."postedAt" DESC NULLS LAST, j."id" DESC LIMIT $21",
        "values": [
          "intl",
          "u1",
          "u1",
          [
            "backend_engineer",
          ],
          [
            "remote",
          ],
          "US",
          "US",
          [
            "mid",
            "senior",
          ],
          "USD",
          120000,
          "USD",
          "\\m(no|not|unable|cannot|can't|won't|will not|does not|doesn't|without|ineligible)\\M|不|无法|無法|不提供|不支持",
          [
            "globex",
          ],
          "'terraform'",
          "%terraform%",
          "terraform",
          "2026-06-12T12:00:00.000Z",
          [
            "activejobs",
            "linkedin",
            "jsearch",
            "user_import",
            "tw_open_data",
          ],
          "'terraform'",
          "'terraform'",
          200,
        ],
      }
    `);
    const dense = show(denseLegSql({ scope: intlScope, filters: FULL_INTL, ageFloor: FLOOR, limit: LIMIT }, VECTOR, TAG));
    expect(dense.text).not.toContain('searchText');
    expect(dense.text).not.toContain('searchTsv');
    expect(dense.values).not.toContain("'terraform'");
    expect(dense.text).toMatchInlineSnapshot(`"SELECT <FEED_COLUMNS> FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId" JOIN "RAJobEmbedding" e ON e."jobId" = j."id" AND e."model" = $1 AND e."market" = $2 WHERE j."market" = $3 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL AND j."sourceBoard" <> 'seed' AND (j."fraudFlags" IS NULL OR jsonb_typeof(j."fraudFlags") <> 'array' OR j."fraudFlags" = '[]'::jsonb) AND (j."visibility" = 'public' OR j."ownerUserId" = $4) AND NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId" = $5 AND s."jobId" = j."id" AND s."hiddenAt" IS NOT NULL) AND (j."taxonomyIds" && $6::text[]) AND j."workModel" = ANY($7::text[]) AND (j."locationCountry" = $8 OR (j."workModel" = 'remote' AND (j."remoteScope" = $9 OR j."remoteScope" = 'global'))) AND j."seniority" = ANY($10::text[]) AND ((j."salaryDisclosed" = true AND j."salaryCurrency" = $11 AND COALESCE(j."salaryAnnualMax", j."salaryAnnualMin") >= $12) OR j."salaryDisclosed" = false OR COALESCE(j."salaryAnnualMax", j."salaryAnnualMin") IS NULL OR j."salaryCurrency" IS DISTINCT FROM $13) AND NOT (j."sponsorship" = 'not_offered' AND COALESCE(j."sponsorshipEvidence", '') ~* $14) AND j."companyNameNormalized" <> ALL($15::text[]) AND (j."postedAt" >= $16::timestamp(3) OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($17::text[])))) ORDER BY e."embedding" <=> $18::halfvec(1024), j."id" DESC LIMIT $19"`);
  });

  it('a GoApply set: the mainland scope (apply link, held banks) and the GoApply filters, segmented Chinese tokens in the query', () => {
    const tsQuery = toTsQuery('后端开发工程师 Java')!;
    expect(show(lexicalLegSql({ scope: cnScope, filters: GOAPPLY, ageFloor: FLOOR, limit: LIMIT }, tsQuery))).toMatchInlineSnapshot(`
      {
        "text": "SELECT <FEED_COLUMNS> FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId" WHERE j."market" = $1 AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL AND j."sourceBoard" <> 'seed' AND (j."fraudFlags" IS NULL OR jsonb_typeof(j."fraudFlags") <> 'array' OR j."fraudFlags" = '[]'::jsonb) AND (j."visibility" = 'public' OR j."ownerUserId" = $2) AND (j."visibility" <> 'public' OR j."applyUrl" ~* '^[[:space:]]*https?://') AND NOT (j."fromRecruiterBank" = true AND j."sourceBoard" = ANY($3::text[])) AND NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId" = $4 AND s."jobId" = j."id" AND s."hiddenAt" IS NOT NULL) AND (j."taxonomyIds" && $5::text[]) AND (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j."marketTags") = 'array' THEN j."marketTags" ELSE '[]'::jsonb END) AS t(e) WHERE t.e->>'tag' LIKE $6) OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j."marketTags") = 'array' THEN j."marketTags" ELSE '[]'::jsonb END) AS t(e) WHERE t.e->>'tag' = ANY($7::text[]))) AND (j."educationLevel" IS NULL OR j."educationLevel" = 'none' OR j."educationLevel" = ANY($8::text[])) AND ((EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j."marketTags") = 'array' THEN j."marketTags" ELSE '[]'::jsonb END) AS t(e) WHERE t.e->>'tag' = ANY($9::text[])) OR (j."employmentType" IS DISTINCT FROM 'internship' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j."marketTags") = 'array' THEN j."marketTags" ELSE '[]'::jsonb END) AS t(e) WHERE t.e->>'tag' LIKE $10) AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j."marketTags") = 'array' THEN j."marketTags" ELSE '[]'::jsonb END) AS t(e) WHERE t.e->>'tag' LIKE $11)))) AND (j."searchTsv" @@ to_tsquery('simple', $12) OR (j."searchText" ILIKE $13 OR $14 <% j."searchText")) AND (j."postedAt" >= $15::timestamp(3) OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($16::text[])))) AND j."searchTsv" @@ to_tsquery('simple', $17) ORDER BY ts_rank_cd(j."searchTsv", to_tsquery('simple', $18)) DESC, j."postedAt" DESC NULLS LAST, j."id" DESC LIMIT $19",
        "values": [
          "cn",
          "u2",
          [
            "robohire",
          ],
          "u2",
          [
            "backend_engineer",
          ],
          "class_year:%",
          [
            "class_year:2027",
          ],
          [
            "bachelor",
          ],
          [
            "cn_hire:campus",
          ],
          "cn_hire:%",
          "class_year:%",
          "'后端' & '开发'",
          "%后端 开发%",
          "后端 开发",
          "2026-06-12T12:00:00.000Z",
          [
            "activejobs",
            "linkedin",
            "jsearch",
            "user_import",
            "tw_open_data",
          ],
          "'后端' | '开发' | '工程' | '程师' | 'java'",
          "'后端' | '开发' | '工程' | '程师' | 'java'",
          200,
        ],
      }
    `);
    const dense = show(denseLegSql({ scope: cnScope, filters: GOAPPLY, ageFloor: FLOOR, limit: LIMIT }, VECTOR, 'text-embedding-v4@1024'));
    // Vectors never cross markets, and vectors of two models are never compared: the join names both.
    expect(dense.text).toContain('JOIN "RAJobEmbedding" e ON e."jobId" = j."id" AND e."model" = $1 AND e."market" = $2 WHERE j."market" = $3');
    expect(dense.values.slice(0, 3)).toEqual(['text-embedding-v4@1024', 'cn', 'cn']);
    expect(dense.text).toContain(`(j."visibility" <> 'public' OR j."applyUrl" ~* '^[[:space:]]*https?://')`);
  });
});

describe('the three legs of one input', () => {
  const cases: Array<[string, SqlScope, FilterSet]> = [
    ['an empty filter set', intlScope, {}],
    ['a full RoboApply set', intlScope, FULL_INTL],
    ['a GoApply set', cnScope, GOAPPLY],
  ];

  it.each(cases)('%s: the same scope and filter predicates in all three legs', (_name, scope, filters) => {
    const tsQuery = toTsQuery(filters.q ?? 'backend engineer')!;
    const shared = [...scopePredicates(scope), ...filterPredicates(filters, scope, FILTER_FIELDS.filter((f) => f !== 'q'))];
    expect(texts(legPredicates({ scope, filters }).shared)).toEqual(texts(shared));
    const block = texts(shared).join(' AND ');
    const legs = [
      plain(recencyLegSql({ scope, filters, from: WINDOW, limit: LIMIT })),
      plain(lexicalLegSql({ scope, filters, ageFloor: FLOOR, limit: LIMIT }, tsQuery)),
      plain(denseLegSql({ scope, filters, ageFloor: FLOOR, limit: LIMIT }, VECTOR, TAG)),
    ];
    for (const leg of legs) expect(leg).toContain(`WHERE ${block}`);
    // The same columns and the same base FROM; only the dense leg joins the embedding table.
    for (const leg of legs) expect(leg.startsWith('SELECT j."id", j."market"')).toBe(true);
    expect(legs.map((l) => l.includes('JOIN "RAJobEmbedding" e'))).toEqual([false, false, true]);
    // What follows the shared block: the q rule (legs A and B), the leg's own bound, its order.
    const tail = (leg: string) => leg.slice(leg.indexOf(block) + block.length);
    const q = filters.q ? ` AND ${plain(wideQPredicateSql(filters.q))}` : '';
    const floor = ` AND ${plain(ageFloorSql(FLOOR))}`;
    expect(tail(legs[0]!)).toBe(`${q} AND j."postedAt" >= $n::timestamp(3) ORDER BY j."postedAt" DESC NULLS LAST, j."id" DESC LIMIT $n`);
    expect(tail(legs[1]!)).toBe(
      `${q}${floor} AND j."searchTsv" @@ to_tsquery('simple', $n) ORDER BY ts_rank_cd(j."searchTsv", to_tsquery('simple', $n)) DESC, j."postedAt" DESC NULLS LAST, j."id" DESC LIMIT $n`,
    );
    expect(tail(legs[2]!)).toBe(`${floor} ORDER BY e."embedding" <=> $n::halfvec(1024), j."id" DESC LIMIT $n`);
  });

  it('leg A is retrievalSql itself: the list statement of a query with no typed q is unchanged', () => {
    const a = recencyLegSql({ scope: intlScope, filters: { taxonomyIds: ['backend_engineer'] }, from: WINDOW, limit: 400 });
    const today = retrievalSql({ scope: intlScope, filters: { taxonomyIds: ['backend_engineer'] }, fields: FILTER_FIELDS, from: WINDOW, to: null, limit: 400 });
    expect(a.text).toBe(today.text);
    expect(a.values).toEqual(today.values);
  });

  it('a `fields` list is honoured by every leg, and q is never applied through it twice', () => {
    const fields = FILTER_FIELDS.filter((f) => f !== 'workModels');
    const sql = plain(lexicalLegSql({ scope: intlScope, filters: FULL_INTL, fields, ageFloor: FLOOR, limit: LIMIT }, "'terraform'"));
    expect(sql).not.toContain('j."workModel" = ANY(');
    expect(sql.split('j."searchText" ILIKE').length - 1).toBe(1);
  });
});

describe('the q rule and bound parameters', () => {
  it('a typed q under three Latin characters is the narrow predicate in legs A and B', () => {
    const filters: FilterSet = { q: 'go' };
    expect(plain(legPredicates({ scope: intlScope, filters }).q!)).toBe(plain(qPredicateSql('go')));
    const b = show(lexicalLegSql({ scope: intlScope, filters, ageFloor: FLOOR, limit: LIMIT }, toTsQuery('go')!));
    expect(b.text).toContain(`AND (j."searchText" ILIKE $4 OR $5 <% j."searchText") AND (j."postedAt" >=`);
    expect(b.text).not.toContain(`(j."searchTsv" @@ to_tsquery('simple', $4) OR`);
    // The leg's own match still uses the exact token.
    expect(b.values).toContain("'go'");
  });

  it('a typed q of two words: the filter of legs A and B needs both words, while leg B matches and orders by any word of its query text', () => {
    const filters: FilterSet = { q: 'product manager' };
    // The leg's query text may be longer than the typed q (the text to rank by joins it): it only orders.
    const legQuery = toTsQuery('product manager fintech')!;
    const a = show(recencyLegSql({ scope: intlScope, filters, from: WINDOW, limit: LIMIT }));
    const b = show(lexicalLegSql({ scope: intlScope, filters, ageFloor: FLOOR, limit: LIMIT }, legQuery));
    const c = show(denseLegSql({ scope: intlScope, filters, ageFloor: FLOOR, limit: LIMIT }, VECTOR, TAG));
    const filter = "'product' & 'manager'";
    expect(a.values.filter((v) => v === filter)).toHaveLength(1);
    expect(a.values).not.toContain("'product' | 'manager'");
    expect(b.values.filter((v) => v === filter)).toHaveLength(1);
    // The leg's own `@@` and its ORDER BY bind the OR of the query text's tokens, twice.
    expect(b.values.filter((v) => v === "'product' | 'manager' | 'fintech'")).toHaveLength(2);
    expect(b.text).toMatch(/\(j\."searchTsv" @@ to_tsquery\('simple', \$\d+\) OR \(j\."searchText" ILIKE \$\d+ OR \$\d+ <% j\."searchText"\)\) AND \(j\."postedAt" >=/);
    // The dense leg carries neither.
    expect(c.values.some((v) => typeof v === 'string' && /product/.test(v))).toBe(false);
  });

  it('no typed q: no q rule in any leg (a relevance text only orders, through the lexical query and the vector)', () => {
    expect(legPredicates({ scope: intlScope, filters: { taxonomyIds: ['backend_engineer'] } }).q).toBeNull();
    const b = plain(lexicalLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, toTsQuery('climate startups Rust')!));
    expect(b).not.toContain('searchText');
  });

  it('the lexical query and the vector are parameters, whatever they hold', () => {
    const hostile = `'x' | '); DROP TABLE "RAJob"; --'`;
    const b = lexicalLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, hostile);
    expect(b.text).not.toContain('DROP TABLE');
    expect(b.values.filter((v) => v === hostile)).toHaveLength(2);
    const c = denseLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, VECTOR, `tag'; DROP TABLE x; --`);
    expect(c.text).not.toContain('DROP TABLE');
    expect(c.text).not.toContain('0.6');
    expect(c.values).toContain(VECTOR);
    expect(c.text).toContain('<=> $');
    expect(c.text).toContain('::halfvec(1024)');
  });

  it('legs B and C reach back to the age floor (120 days or "posted within"), not the first window', () => {
    for (const sql of [lexicalLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, "'x'"), denseLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, VECTOR, TAG)]) {
      expect(sql.values).toContain(FLOOR);
      expect(sql.values).not.toContain(WINDOW);
      expect(sql.values[sql.values.length - 1]).toBe(200);
    }
  });

  it('never selects searchTsv or the embedding (raw SQL on RAJob lists its columns)', () => {
    for (const sql of [lexicalLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, "'x'"), denseLegSql({ scope: intlScope, filters: {}, ageFloor: FLOOR, limit: LIMIT }, VECTOR, TAG)]) {
      const select = sql.text.slice(0, sql.text.indexOf('FROM "RAJob"'));
      expect(select).not.toContain('*');
      expect(select).not.toContain('searchTsv');
      expect(select).not.toContain('embedding');
    }
  });
});
