// @vitest-environment node
//
// WP-32 acceptance: SQL snapshot tests for every feed predicate (ruling C15's
// full list) and for the scope every statement carries (market + visibility,
// canonical/live, fraudFlags, hidden-state NOT EXISTS). Pure: no database.

import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeSql } from '../../test/sqlSnapshot.js';
import { FILTER_FIELDS, type FilterField, type FilterSet } from '../search/index.js';
import { AGE_EXPIRY_BOARDS } from '../jobs/normalize/index.js';
import { filterTokens, queryTokens, toTsQuery } from '../retrieval/index.js';
import {
  AGE_FLOOR_BOARDS,
  ageFloorSql,
  annualFloor,
  browseTaxonomySql,
  cardExtrasSql,
  cnDate,
  countSql,
  exploreCountsSql,
  filterPredicates,
  isCountryWideLocation,
  allTokensTsQuery,
  isShortLatinQuery,
  jobIdsSql,
  predicateFor,
  qPredicateSql,
  retrievalSql,
  roleTaxonomyIds,
  rowsByIdSql,
  scopePredicates,
  sourcesSql,
  wideQPredicateSql,
} from './sql.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const intl = { market: 'intl' as const, now: NOW };
const cn = { market: 'cn' as const, now: NOW };

function show(sql: Prisma.Sql | null) {
  if (!sql) return null;
  return { text: normalizeSql(sql.text), values: sql.values.map((v) => (v instanceof Date ? v.toISOString() : v)) };
}

/** One sample per FilterSet field (C15) and the market it applies to. */
const SAMPLES: Array<[FilterField, FilterSet, 'intl' | 'cn']> = [
  ['taxonomyIds', { taxonomyIds: ['backend_engineer'] }, 'intl'],
  ['titles', { titles: ['Data Analyst'] }, 'intl'],
  ['excludedTitles', { excludedTitles: ['Sales Manager', '100%_remote'] }, 'intl'],
  ['jobTypes', { jobTypes: ['full_time', 'contract'] }, 'intl'],
  ['workModels', { workModels: ['remote'] }, 'intl'],
  ['country', { country: 'US' }, 'intl'],
  ['locations', { locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US', lat: 30.27, lng: -97.74, radiusKm: 40 }] }, 'intl'],
  ['seniority', { seniority: ['mid', 'senior'] }, 'intl'],
  ['yearsRange', { yearsRange: { min: 2, max: 5 } }, 'intl'],
  ['postedWithinDays', { postedWithinDays: 7 }, 'intl'],
  ['salaryMin', { salaryMin: { amount: 120000, currency: 'USD', period: 'year' } }, 'intl'],
  ['includeUndisclosedPay', { includeUndisclosedPay: false }, 'intl'],
  ['needsSponsorship', { needsSponsorship: true }, 'intl'],
  ['excludeRequirements', { excludeRequirements: ['citizenship', 'clearance'] }, 'intl'],
  ['industries', { industries: ['Fintech'] }, 'intl'],
  ['excludedIndustries', { excludedIndustries: ['Gambling'] }, 'intl'],
  ['skills', { skills: ['Python', 'SQL'] }, 'intl'],
  ['excludedSkills', { excludedSkills: ['Java'] }, 'intl'],
  ['roleType', { roleType: 'manager' }, 'intl'],
  ['companies', { companies: ['Acme Inc.'] }, 'intl'],
  ['excludedCompanies', { excludedCompanies: ['Globex LLC'] }, 'intl'],
  ['companySizes', { companySizes: ['201-1000', '5000+'] }, 'intl'],
  ['excludeAgencies', { excludeAgencies: true }, 'intl'],
  ['recruiterJobsOnly', { recruiterJobsOnly: true }, 'intl'],
  ['q', { q: 'data 50%' }, 'intl'],
  ['employerTags', { employerTags: ['soe', 'foreign'] }, 'cn'],
  ['classYear', { classYear: 2027 }, 'cn'],
  ['degree', { degree: ['dazhuan', 'bachelor'] }, 'cn'],
  ['employmentType', { employmentType: ['campus', 'social', 'internship'] }, 'cn'],
  ['internDays', { internDays: { min: 3, max: 4 } }, 'cn'],
  ['dailyPay', { dailyPay: { min: 200 } }, 'cn'],
  ['salaryMonthsMin', { salaryMonthsMin: 13 }, 'cn'],
  ['hukouTag', { hukouTag: true }, 'cn'],
  ['schoolTiers', { schoolTiers: ['985', '211'] }, 'cn'],
];

describe('predicates (one snapshot per FilterSet field)', () => {
  it('covers every field except the view/boost-only ones', () => {
    const covered = new Set(SAMPLES.map(([f]) => f));
    expect(FILTER_FIELDS.filter((f) => !covered.has(f)).sort()).toEqual(['fitTier', 'preferredCompanies']);
  });

  it.each(SAMPLES)('%s', (field, filters, market) => {
    expect(show(predicateFor(field, filters, market === 'cn' ? cn : intl))).toMatchSnapshot();
  });

  it('the q field is the WIDE predicate: a search document that holds every word of the query, OR the thin searchText (MKT-4F)', () => {
    const viaField = predicateFor('q', { q: '  Data 50%  ' }, intl)!;
    const wide = wideQPredicateSql('Data 50%');
    expect(show(viaField)).toEqual(show(wide));
    // A row with no document yet (`searchTsv` null) is still found through searchText, and the misspelling match stays.
    expect(wide.text).toBe(`(j."searchTsv" @@ to_tsquery('simple', $1) OR (j."searchText" ILIKE $2 OR $3 <% j."searchText"))`);
    expect(wide.values).toEqual(["'data'", '%data 50\\%%', 'data 50%']);
    // The tokens are those of the function that segmented the document: a bound value, never spliced text.
    expect(wide.values[0]).toBe(allTokensTsQuery('Data 50%'));
    expect(show(wideQPredicateSql("'; DROP TABLE x; --"))!.text).toBe(wide.text);
    // The same on both markets, and nothing for an empty query.
    expect(show(predicateFor('q', { q: 'Data 50%' }, cn))).toEqual(show(wide));
    expect(predicateFor('q', { q: '   ' }, intl)).toBeNull();
  });

  it('a typed query is a FILTER: the search document must hold EVERY word, never just any of them', () => {
    // "product manager" must not keep every posting that says "product" or "manager" somewhere.
    expect(show(wideQPredicateSql('product manager'))!.values[0]).toBe("'product' & 'manager'");
    expect(show(wideQPredicateSql('Terraform, Kubernetes'))!.values[0]).toBe("'terraform' & 'kubernetes'");
    expect(show(predicateFor('q', { q: 'senior product manager' }, intl))!.values[0]).toBe("'senior' & 'product' & 'manager'");
    // The tokens are retrieval `filterTokens` (the Traditional form folded), joined by AND. For a query with no
    // stopword that can be part of a job's name they are the lexical leg's tokens, which its ORDER BY joins by OR.
    for (const q of ['product manager', 'jobs for a data engineer in 2026', '資深 前端 工程師', 'C++ and node.js']) {
      const all = allTokensTsQuery(q)!;
      expect(all.split(' & '), q).toEqual(filterTokens(q).map((t) => `'${t}'`));
      expect(all.split(' & '), q).toEqual(queryTokens(q).map((t) => `'${t}'`));
      expect(all.split(' & ').join(' | '), q).toBe(toTsQuery(q));
    }
    // Grammar, search filler ("jobs", "for", "a", "in") and bare numbers are not required of a posting.
    expect(allTokensTsQuery('jobs for a data engineer in 2026')).toBe("'data' & 'engineer'");
    expect(allTokensTsQuery('nurse jobs')).toBe("'nurse'");
  });

  it('the filter keeps the words an OR query drops when they can be part of a job\'s name (M4 cross-review)', () => {
    // Before: "IT support" filtered on 'support' alone, "social work" on 'social', "招聘 专员" on '专员'.
    const cases: Array<[string, string, string]> = [
      ['IT support', "'it' & 'support'", "'support'"],
      ['social work', "'social' & 'work'", "'social'"],
      ['IT manager', "'it' & 'manager'", "'manager'"],
      ['US tax', "'us' & 'tax'", "'tax'"],
      ['work from home', "'work' & 'home'", "'home'"],
      ['job coach', "'job' & 'coach'", "'coach'"],
      ['招聘 专员', "'招聘' & '专员'", "'专员'"],
      ['招聘专员', "'招聘' & '专员'", "'专员'"],
    ];
    for (const [q, filter, legQuery] of cases) {
      expect(allTokensTsQuery(q), q).toBe(filter);
      expect(show(wideQPredicateSql(q))!.values[0], q).toBe(filter);
      // The lexical leg's OR query is unchanged: it still ranks by the words that tell postings apart.
      expect(toTsQuery(q), q).toBe(legQuery);
    }
    // Only such words: they are all that is left, and they are required.
    expect(allTokensTsQuery('work')).toBe("'work'");
    expect(allTokensTsQuery('the jobs')).toBe("'the' & 'jobs'");
    // A query of one word is the same under AND and OR: nothing changes for it.
    expect(allTokensTsQuery('terraform')).toBe(toTsQuery('terraform'));
    expect(allTokensTsQuery('+++')).toBeNull();
    expect(allTokensTsQuery(null)).toBeNull();
    // A quote inside a token cannot end the operand (tokens are letters and digits; the quoting holds anyway).
    expect(allTokensTsQuery("o'neil")).toBe("'o' & 'neil'");
  });

  it('every statement that filters by a typed query asks for every word: list, count, sample, alert candidates and the source header', () => {
    const scope = { market: 'intl' as const, userId: 'u1', now: NOW };
    const filters: FilterSet = { q: 'product manager' };
    for (const sql of [
      retrievalSql({ scope, filters, fields: FILTER_FIELDS, from: null, to: null, limit: 400 }),
      countSql({ scope, filters, fields: FILTER_FIELDS, cap: 5000 }),
      jobIdsSql({ scope, filters, fields: FILTER_FIELDS, from: null, limit: 10, orderBy: 'posted' }),
      jobIdsSql({ scope: { ...scope, publicOnly: true }, filters, fields: FILTER_FIELDS, from: null, firstSeenAfter: NOW, limit: 10, orderBy: 'first_seen' }),
      sourcesSql({ scope, filters, fields: FILTER_FIELDS, from: null }),
    ]) {
      const shown = show(sql)!;
      expect(shown.values).toContain("'product' & 'manager'");
      expect(shown.values).not.toContain("'product' | 'manager'");
    }
  });

  it('qPredicateSql is its narrow half, unchanged: a substring match on searchText, or a trigram word-similarity match', () => {
    const narrow = qPredicateSql('Data 50%');
    expect(narrow.text).toBe('(j."searchText" ILIKE $1 OR $2 <% j."searchText")');
    expect(narrow.values).toEqual(['%data 50\\%%', 'data 50%']);
  });

  it('a query under three Latin characters uses the narrow predicate alone; two Chinese characters are a whole word', () => {
    for (const q of ['go', 'r', 'c#', 'AI', ' qa ']) {
      expect(isShortLatinQuery(q), q).toBe(true);
      expect(show(wideQPredicateSql(q.trim())), q).toEqual(show(qPredicateSql(q.trim())));
      expect(show(predicateFor('q', { q }, intl)), q).toEqual(show(qPredicateSql(q.trim())));
    }
    for (const q of ['sql', 'rust', '前端', '後端', 'デザ', 'UI 设计']) expect(isShortLatinQuery(q), q).toBe(false);
    expect(show(predicateFor('q', { q: '前端' }, cn))).toMatchInlineSnapshot(`
      {
        "text": "(j."searchTsv" @@ to_tsquery('simple', $1) OR (j."searchText" ILIKE $2 OR $3 <% j."searchText"))",
        "values": [
          "'前端'",
          "%前端%",
          "前端",
        ],
      }
    `);
    expect(show(predicateFor('q', { q: 'go' }, intl))).toMatchInlineSnapshot(`
      {
        "text": "(j."searchText" ILIKE $1 OR $2 <% j."searchText")",
        "values": [
          "%go%",
          "go",
        ],
      }
    `);
    // A query with no token at all (only punctuation) has nothing to search the document with.
    expect(show(wideQPredicateSql('+++'))).toEqual(show(qPredicateSql('+++')));
  });

  it('counts, samples and alert candidates carry the same wide predicate as the list (they find a word that is only in the description)', () => {
    const scope = { market: 'intl' as const, userId: 'u1', now: NOW };
    const filters: FilterSet = { q: 'terraform' };
    const wide = show(wideQPredicateSql('terraform'))!.text.replace(/\$\d+/g, '$n');
    for (const sql of [
      retrievalSql({ scope, filters, fields: FILTER_FIELDS, from: null, to: null, limit: 400 }),
      countSql({ scope, filters, fields: FILTER_FIELDS, cap: 5000 }),
      jobIdsSql({ scope, filters, fields: FILTER_FIELDS, from: null, limit: 10, orderBy: 'posted' }),
      jobIdsSql({ scope: { ...scope, publicOnly: true }, filters, fields: FILTER_FIELDS, from: null, firstSeenAfter: NOW, limit: 10, orderBy: 'first_seen' }),
      sourcesSql({ scope, filters, fields: FILTER_FIELDS, from: null }),
    ]) {
      const shown = show(sql)!;
      expect(shown.text.replace(/\$\d+/g, '$n')).toContain(wide);
      expect(shown.values).toContain("'terraform'");
    }
  });

  it('fitTier and preferredCompanies never become SQL (view filter / boost only)', () => {
    expect(predicateFor('fitTier', { fitTier: 'great' }, intl)).toBeNull();
    expect(predicateFor('preferredCompanies', { preferredCompanies: ['Acme'] }, intl)).toBeNull();
  });

  it('absent fields contribute nothing', () => {
    for (const f of FILTER_FIELDS) expect(predicateFor(f, {}, intl)).toBeNull();
  });

  it('market-only fields are ignored on the other market', () => {
    expect(predicateFor('needsSponsorship', { needsSponsorship: true }, cn)).toBeNull();
    expect(predicateFor('excludeRequirements', { excludeRequirements: ['clearance'] }, cn)).toBeNull();
    expect(predicateFor('hukouTag', { hukouTag: true }, intl)).toBeNull();
    expect(predicateFor('classYear', { classYear: 2027 }, intl)).toBeNull();
  });

  it('salary floor with undisclosed pay kept (default) admits undisclosed and other-currency jobs', () => {
    expect(show(predicateFor('salaryMin', { salaryMin: { amount: 40, currency: 'USD', period: 'hour' }, includeUndisclosedPay: true }, intl))).toMatchSnapshot();
    expect(annualFloor({ amount: 40, currency: 'USD', period: 'hour' })).toBe(83200);
    expect(annualFloor({ amount: 15000, currency: 'CNY', period: 'month' })).toBe(180000);
  });

  it('a city with no coordinates and radius 0 matches the city in every script, remote passes', () => {
    expect(show(predicateFor('locations', { locations: [{ label: '上海', city: '上海', radiusKm: 0 }] }, cn))).toMatchSnapshot();
  });

  it('a country with no city is the whole country, whatever its radius (FIX-3: onboarding "Anywhere in United States")', () => {
    // What onboarding stored: the country code as the label, radius 0. It used to compare locationCity to "us".
    const us = { label: 'US', country: 'US', radiusKm: 0 as const };
    const sql = show(predicateFor('locations', { locations: [us] }, intl));
    expect(sql?.text).toBe(`(j."workModel" = 'remote' OR (j."locationCountry" = $1))`);
    expect(sql?.values).toEqual(['US']);
    expect(sql?.text).not.toContain('locationCity');
    for (const loc of [us, { ...us, radiusKm: 40 as const }, { ...us, label: 'United States' }, { ...us, label: 'Anywhere in United States' }]) {
      expect(isCountryWideLocation(loc), JSON.stringify(loc)).toBe(true);
    }
    // A city is still a city: named in `city`, by coordinates, or by a label our city table knows.
    expect(isCountryWideLocation({ label: 'Austin, TX', city: 'Austin', country: 'US', radiusKm: 0 })).toBe(false);
    expect(isCountryWideLocation({ label: 'Somewhere', country: 'US', lat: 30, lng: -97, radiusKm: 40 })).toBe(false);
    expect(isCountryWideLocation({ label: 'Austin', country: 'US', radiusKm: 0 })).toBe(false);
    expect(isCountryWideLocation({ label: 'Berlin', radiusKm: 0 })).toBe(false);
    // Next to a city, either one admits the job.
    const mixed = show(predicateFor('locations', { locations: [us, { label: '上海', city: '上海', radiusKm: 0 }] }, intl));
    expect(mixed?.text).toContain(`(j."locationCountry" = $1) OR (lower(j."locationCity") = ANY(`);
  });

  it('a radius without coordinates is resolved from the city table', () => {
    const sql = show(predicateFor('locations', { locations: [{ label: 'Austin', city: 'Austin', country: 'US', radiusKm: 80 }] }, intl));
    expect(sql?.text).toContain('asin(sqrt(');
  });

  it('taxonomy and titles form one role predicate (overlap OR title text)', () => {
    const both = show(predicateFor('taxonomyIds', { taxonomyIds: ['backend_engineer'], titles: ['Platform Engineer'] }, intl));
    expect(both?.text).toMatch(/\(j\."taxonomyIds" && \$1::text\[\] OR j\."titleNormalized" ILIKE ANY\(\$2::text\[\]\)\)/);
    expect(predicateFor('titles', { taxonomyIds: ['backend_engineer'], titles: ['Platform Engineer'] }, intl)).toBeNull();
    expect(roleTaxonomyIds({ taxonomyIds: ['software_engineering'] }).length).toBeGreaterThan(3);
  });

  it('校招 matches a stated cn_hire:campus tag, or a 届别-tagged non-internship posting with no cn_hire statement', () => {
    const text = show(predicateFor('employmentType', { employmentType: ['campus'] }, cn))!.text;
    const values = show(predicateFor('employmentType', { employmentType: ['campus'] }, cn))!.values;
    expect(values).toContainEqual(['cn_hire:campus']);
    expect(values).toContain('class_year:%');
    expect(values).toContain('cn_hire:%');
    expect(text).toContain(`j."employmentType" IS DISTINCT FROM 'internship' AND NOT EXISTS`);
  });

  it('school tier is a user-side filter only (no ranking column is read)', () => {
    expect(show(predicateFor('schoolTiers', { schoolTiers: ['985'] }, cn))?.text).toContain("LIKE");
  });
});

describe('scope', () => {
  it('feed scope: market, canonical, live, not seed, no fraud flags, public or own, not hidden', () => {
    expect(scopePredicates({ market: 'intl', userId: 'u1', now: NOW }).map(show)).toMatchSnapshot();
  });

  it('counts and the visitor list never include private rows', () => {
    const texts = scopePredicates({ market: 'cn', userId: null, now: NOW, publicOnly: true, publicDisplayOnly: true, ignoreHidden: true }).map((s) => show(s)!.text);
    expect(texts).toContain(`j."visibility" = 'public'`);
    expect(texts).toContain(`j."publicDisplay" = true`);
    expect(texts.join(' ')).not.toContain('RAJobUserState');
  });

  it('the visitor list carries the public-page rules in the statement: not expired, and a recruiter-bank row or a board still allowed', () => {
    const scope = { market: 'intl' as const, userId: null, now: NOW, publicOnly: true, publicDisplayOnly: true, ignoreHidden: true };
    const withBoards = scopePredicates({ ...scope, publicBoards: ['activejobs', 'greenhouse'] }).map((s) => show(s)!);
    expect(withBoards.map((s) => s.text)).toEqual(expect.arrayContaining([
      '(j."expiresAt" IS NULL OR j."expiresAt" > $1::timestamp(3))',
      '(j."fromRecruiterBank" = true OR j."sourceBoard" = ANY($1::text[]))',
    ]));
    expect(withBoards.find((s) => s.text.includes('ANY('))!.values).toEqual([['activejobs', 'greenhouse']]);
    // No board list given: the expiry rule still applies, the board rule is left to the caller's re-check.
    const bare = scopePredicates(scope).map((s) => show(s)!.text).join(' ');
    expect(bare).toContain('j."expiresAt" >');
    expect(bare).not.toContain('fromRecruiterBank');
    // A signed-in feed is unchanged: neither rule.
    expect(scopePredicates({ market: 'intl', userId: 'u1', now: NOW }).map((s) => show(s)!.text).join(' ')).not.toMatch(/expiresAt|fromRecruiterBank/);
  });
});

describe('mainland apply-link rule (a public posting with no usable apply URL is never listed)', () => {
  const GUARD = `(j."visibility" <> 'public' OR j."applyUrl" ~* '^[[:space:]]*https?://')`;
  const texts = (parts: Prisma.Sql[]) => parts.map((s) => show(s)!.text);

  it('every market cn scope carries it: signed-in list, counts, the visitor list', () => {
    expect(texts(scopePredicates({ market: 'cn', userId: 'u1', now: NOW }))).toContain(GUARD);
    expect(texts(scopePredicates({ market: 'cn', userId: 'u1', now: NOW, publicOnly: true }))).toContain(GUARD);
    expect(texts(scopePredicates({ market: 'cn', userId: null, now: NOW, publicOnly: true, publicDisplayOnly: true, ignoreHidden: true }))).toContain(GUARD);
  });

  it('it never hides the user\'s own import (private rows pass), and RoboApply statements do not carry it', () => {
    // The predicate is an OR on visibility: a private row is not tested for a link.
    expect(GUARD.startsWith(`(j."visibility" <> 'public' OR `)).toBe(true);
    expect(texts(scopePredicates({ market: 'intl', userId: 'u1', now: NOW })).join(' ')).not.toContain('applyUrl');
    expect(texts(scopePredicates({ market: 'intl', userId: null, now: NOW, publicOnly: true })).join(' ')).not.toContain('applyUrl');
  });

  it('the list, the id seams (samples, alert candidates), later pages and the counts all go through that scope', () => {
    const scope = { market: 'cn' as const, userId: 'u1', now: NOW };
    for (const sql of [
      retrievalSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null, to: null, limit: 400 }),
      jobIdsSql({ scope: { ...scope, publicOnly: true }, filters: {}, fields: FILTER_FIELDS, from: null, orderBy: 'first_seen', limit: 100 }),
      rowsByIdSql(scope, ['a']),
      countSql({ scope, filters: {}, fields: FILTER_FIELDS, cap: 5000 }),
      exploreCountsSql('cn', ['software_engineering']),
      sourcesSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null }),
    ]) {
      expect(show(sql)!.text).toContain(GUARD);
    }
  });
});

const AGE_FLOOR = '(j."postedAt" >= $';
const AGE_FREE = 'OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($';
const HELD_BANKS = 'NOT (j."fromRecruiterBank" = true AND j."sourceBoard" = ANY($';

describe('posting age: the floor cuts the rows whose only life is their posting date (M-22: a posting-age cut-off applies to aggregator rows only)', () => {
  const floor = new Date('2026-06-12T12:00:00Z');

  it('the predicate: at or above the floor, or a dated row of a source the floor does not apply to', () => {
    const sql = show(ageFloorSql(floor))!;
    expect(sql.text).toBe('(j."postedAt" >= $1::timestamp(3) OR (j."postedAt" IS NOT NULL AND NOT (j."sourceBoard" = ANY($2::text[]))))');
    expect(sql.values).toEqual(['2026-06-12T12:00:00.000Z', ['activejobs', 'linkedin', 'jsearch', 'user_import', 'tw_open_data']]);
  });

  it('the floor applies to the boards ingest expires by age, to own imports and to 台灣就業通; to no bank, employer board or government board', () => {
    // The aggregators: the very list ingest's own age rule reads, so a new aggregator needs one entry, there.
    for (const board of AGE_EXPIRY_BOARDS) expect(AGE_FLOOR_BOARDS).toContain(board);
    expect([...AGE_FLOOR_BOARDS].sort()).toEqual([...new Set([...AGE_EXPIRY_BOARDS, 'user_import', 'tw_open_data'])].sort());
    // Sources that close their own rows are listed at any age, the ones added after the list was first written included.
    for (const board of ['robohire', 'gohire', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'ats_public', 'tw_gov_jobs', 'usajobs']) {
      expect(AGE_FLOOR_BOARDS, board).not.toContain(board);
    }
  });

  it('a window start stays a hard bound; the age floor is the exempting one, in the list, the id seams, the header and Explore', () => {
    const scope = { market: 'cn' as const, userId: 'u1', now: NOW };
    const hard = show(retrievalSql({ scope, filters: {}, fields: FILTER_FIELDS, from: floor, to: null, limit: 400 }))!;
    expect(hard.text).toContain('j."postedAt" >= $');
    expect(hard.text).not.toContain(AGE_FREE);
    const last = show(retrievalSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null, ageFloor: floor, to: new Date('2026-08-01T00:00:00Z'), toId: 'j9', limit: 400 }))!;
    expect(last.text).toContain(AGE_FREE);
    expect(last.text).toContain('(j."postedAt", j."id") < (');
    expect(show(jobIdsSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null, ageFloor: floor, limit: 10, orderBy: 'posted' }))!.text).toContain(AGE_FREE);
    expect(show(sourcesSql({ scope, filters: {}, fields: FILTER_FIELDS, from: floor }))!.text).toContain(AGE_FREE);
    expect(show(exploreCountsSql('cn', ['software_engineering'], floor))!.text).toContain(AGE_FREE);
    // The user's own "posted within" filter is a plain bound for every row.
    const within = show(predicateFor('postedWithinDays', { postedWithinDays: 7 }, { market: 'cn', now: NOW }))!;
    expect(within.text).toBe('j."postedAt" >= $1::timestamp(3)');
  });
});

describe('recruiter-bank rows of a bank with no posting page are held out of every statement', () => {
  it('the scope carries the rule when a bank is held, and nothing when none is', () => {
    const held = scopePredicates({ market: 'cn', userId: 'u1', now: NOW, heldBanks: ['robohire', 'gohire'] }).map((p) => show(p)!);
    const rule = held.find((p) => p.text.startsWith('NOT (j."fromRecruiterBank"'))!;
    expect(rule.text).toBe('NOT (j."fromRecruiterBank" = true AND j."sourceBoard" = ANY($1::text[]))');
    expect(rule.values).toEqual([['robohire', 'gohire']]);
    for (const scope of [{ market: 'intl' as const, userId: 'u1', now: NOW }, { market: 'cn' as const, userId: null, now: NOW, heldBanks: [] }]) {
      expect(scopePredicates(scope).some((p) => p.text.includes('NOT (j."fromRecruiterBank"'))).toBe(false);
    }
  });

  it('list, counts, id seams, later pages, header and the visitor list all go through that scope', () => {
    const scope = { market: 'intl' as const, userId: 'u1', now: NOW, heldBanks: ['robohire'] };
    const statements = [
      retrievalSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null, to: null, limit: 400 }),
      retrievalSql({ scope: { ...scope, userId: null, publicOnly: true, publicDisplayOnly: true, publicBoards: ['activejobs'], ignoreHidden: true }, filters: {}, fields: FILTER_FIELDS, from: null, to: null, limit: 20 }),
      countSql({ scope, filters: {}, fields: FILTER_FIELDS, cap: 5000 }),
      jobIdsSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null, limit: 10, orderBy: 'posted' }),
      rowsByIdSql(scope, ['j1']),
      sourcesSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null }),
    ];
    for (const s of statements) expect(show(s)!.text).toContain(HELD_BANKS);
  });
});

describe('feed header facts (sourcesSql)', () => {
  it('one aggregate over the public rows the query can reach: any GoHire bank row, and distinct employer boards', () => {
    const sql = show(sourcesSql({ scope: { market: 'cn', userId: 'u1', now: NOW }, filters: { workModels: ['onsite'] }, fields: FILTER_FIELDS, from: new Date('2026-06-12T12:00:00Z') }))!;
    expect(sql).toMatchSnapshot();
    // Public rows only, whoever asks: the user's own imports are not a source of the index.
    expect(sql.text).toContain(`j."visibility" = 'public'`);
    expect(sql.text).not.toContain('j."ownerUserId" =');
    // A board is one (ATS, board token); bank rows are never counted as boards.
    expect(sql.text).toContain(`count(DISTINCT (j."sourceBoard" || ':' || CASE WHEN position(':' in j."externalId") > 1 THEN split_part(j."externalId", ':', 1) ELSE j."companyNameNormalized" END))`);
    expect(sql.text).toContain(`FILTER (WHERE j."fromRecruiterBank" = false AND j."sourceBoard" = ANY(`);
    // How many rows that is: the service reads it to know a list is short before paging to its end (`thin`).
    expect(sql.text).toContain('count(*)::int AS "listed"');
    expect(sql.values).toContain('gohire');
    expect(sql.values.find((v) => Array.isArray(v) && v.includes('smartrecruiters'))).toEqual(expect.arrayContaining(['greenhouse', 'lever', 'ashby', 'smartrecruiters']));
    // The query's own filters and the list's age floor apply (the floor cuts aggregator rows only).
    expect(sql.text).toContain('j."workModel" = ANY(');
    expect(sql.text).toContain(AGE_FLOOR);
    expect(sql.text).not.toMatch(/LIMIT/);
  });

  it('a browse passes its category predicate', () => {
    const sql = show(sourcesSql({ scope: { market: 'cn', userId: 'u1', now: NOW, publicOnly: true }, filters: {}, fields: [], extra: [browseTaxonomySql(['software_engineering'])], from: null }))!;
    expect(sql.text).toContain('j."taxonomyIds" && ');
  });
});

describe('statements', () => {
  const filters: FilterSet = { taxonomyIds: ['backend_engineer'], workModels: ['remote'], skills: ['python'] };

  it('retrieval: one window, newest first, LIMIT', () => {
    expect(
      show(retrievalSql({ scope: { market: 'intl', userId: 'u1', now: NOW }, filters, fields: FILTER_FIELDS, from: new Date('2026-09-26T12:00:00Z'), to: new Date('2026-10-01T00:00:00Z'), limit: 400 })),
    ).toMatchSnapshot();
  });

  it('retrieval: older refill is a (postedAt, id) keyset after a full window, strict postedAt otherwise', () => {
    const base = { scope: { market: 'intl' as const, userId: 'u1', now: NOW }, filters: {}, fields: FILTER_FIELDS, from: new Date('2026-08-01T00:00:00Z'), limit: 400 };
    const keyset = show(retrievalSql({ ...base, to: new Date('2026-09-01T00:00:00Z'), toId: 'job_400' }));
    expect(keyset?.text).toContain('(j."postedAt", j."id") < ($');
    expect(keyset?.text).not.toContain('j."postedAt" < $');
    expect(keyset?.values).toContain('job_400');
    expect(keyset?.text).toContain('ORDER BY j."postedAt" DESC NULLS LAST, j."id" DESC');
    const strict = show(retrievalSql({ ...base, to: new Date('2026-09-01T00:00:00Z'), toId: null }));
    expect(strict?.text).toContain('j."postedAt" < $');
    expect(strict?.text).not.toContain('(j."postedAt", j."id")');
  });

  it('retrieval: GoApply deadline orders by a stated, quoted close date (China date) and keeps undated jobs after it', () => {
    const sql = show(retrievalSql({ scope: { market: 'cn', userId: 'u1', now: NOW }, filters: {}, fields: FILTER_FIELDS, from: null, to: null, orderBy: 'deadline', limit: 400 }));
    expect(sql).toMatchSnapshot();
    expect(sql?.text).not.toContain('expiresAt" >=');
    expect(sql?.text).not.toContain('ORDER BY j."expiresAt"');
    expect(sql?.text).toContain(`'^apply_closes:[0-9]{4}-[0-9]{2}-[0-9]{2}'`);
    expect(sql?.text).toContain("t.e->>'evidenceQuote'");
    expect(sql?.text).toMatch(/ASC NULLS LAST, j\."postedAt" DESC NULLS LAST, j\."id" DESC/);
    expect(sql?.values).toContain('2026-10-10');
    // 2026-10-10 20:00 UTC is already 10-11 in China.
    expect(cnDate(new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11');
  });

  it('count: new-count adds the firstSeenAt window', () => {
    const sql = show(countSql({ scope: { market: 'cn', userId: 'u1', now: NOW }, filters: {}, fields: FILTER_FIELDS, cap: 5000, firstSeenAfter: new Date('2026-10-09T00:00:00Z') }));
    expect(sql?.text).toContain('j."firstSeenAt" > $');
    expect(sql?.values).toContain('2026-10-09T00:00:00.000Z');
  });

  it('retrieval: new-count window uses firstSeenAt', () => {
    const sql = show(retrievalSql({ scope: { market: 'intl', userId: 'u1', now: NOW }, filters: {}, fields: FILTER_FIELDS, from: null, to: null, firstSeenAfter: new Date('2026-10-09T00:00:00Z'), limit: 400 }));
    expect(sql?.text).toContain('j."firstSeenAt" > $');
    expect(sql?.text).not.toContain('j."postedAt" >=');
  });

  it('count: public rows only, capped inside (LIMIT cap + 1)', () => {
    const sql = show(countSql({ scope: { market: 'intl', userId: 'u1', now: NOW }, filters, fields: FILTER_FIELDS, cap: 5000 }));
    expect(sql).toMatchSnapshot();
    expect(sql?.values.at(-1)).toBe(5001);
    expect(sql?.text).toContain(`j."visibility" = 'public'`);
    expect(sql?.text).not.toContain('"ownerUserId"');
  });

  it('rows by id keep the scope (a job hidden or closed since drops out)', () => {
    const sql = show(rowsByIdSql({ market: 'intl', userId: 'u1', now: NOW }, ['j1', 'j2']));
    expect(sql?.text).toContain('j."id" = ANY(');
    expect(sql?.text).toContain('"hiddenAt" IS NOT NULL');
    expect(sql?.text).toContain('j."closedAt" IS NULL');
  });

  it('explore counts per L1 category over public live rows', () => {
    expect(show(exploreCountsSql('intl', ['software_engineering', 'data_analytics']))).toMatchSnapshot();
  });

  it('explore counts can carry the lists’ age floor (a tile then counts what its browse list reaches)', () => {
    const sql = show(exploreCountsSql('intl', ['software_engineering'], new Date('2026-06-12T12:00:00Z')));
    expect(sql?.text).toContain(AGE_FLOOR);
    expect(sql?.values).toContain('2026-06-12T12:00:00.000Z');
    expect(sql?.text).toContain(`j."visibility" = 'public'`);
    // …and the bank rule, so a tile never counts a held bank row.
    expect(sql?.text).not.toContain(HELD_BANKS);
    expect(show(exploreCountsSql('cn', ['software_engineering'], null, ['gohire']))?.text).toContain(HELD_BANKS);
  });

  it('browse: the category predicate matches the category id itself and every role under it, as a bare AND part', () => {
    const cat = show(browseTaxonomySql(['software_engineering']))!;
    expect(cat.text).toBe('j."taxonomyIds" && $1::text[]');
    const ids = cat.values[0] as string[];
    expect(ids[0]).toBe('software_engineering');
    expect(ids).toContain('backend_engineer');
    const sql = show(
      retrievalSql({
        scope: { market: 'intl', userId: 'u1', now: NOW, publicOnly: true },
        filters: { taxonomyIds: ['software_engineering'] },
        fields: FILTER_FIELDS.filter((f) => f !== 'taxonomyIds' && f !== 'titles'),
        extra: [browseTaxonomySql(['software_engineering'])],
        from: null,
        to: null,
        limit: 400,
      }),
    )!;
    expect(sql.text).toContain('AND j."taxonomyIds" && $');
    expect(sql.text).not.toContain('(j."taxonomyIds" && $');
    expect(sql.text).toContain(`j."visibility" = 'public'`);
    expect(sql.text).not.toContain('j."ownerUserId" = ');
    // The user's own hidden jobs still stay out of a browse.
    expect(sql.text).toContain('"hiddenAt" IS NOT NULL');
  });

  it('job ids (report sample): ids only, the list’s scope and predicates, newest first, LIMIT', () => {
    const sql = show(
      jobIdsSql({ scope: { market: 'intl', userId: 'u1', now: NOW, publicOnly: true }, filters, fields: FILTER_FIELDS, from: new Date('2026-06-12T12:00:00Z'), limit: 400, orderBy: 'posted' }),
    );
    expect(sql).toMatchSnapshot();
    expect(sql?.text).toMatch(/^SELECT j\."id" FROM/);
    expect(sql?.text).not.toContain('j."ownerUserId"');
    expect(sql?.values.at(-1)).toBe(400);
  });

  it('job ids (alert candidates): first seen after `since`, newest in our index first; an undated posting passes the posted floor', () => {
    const sql = show(
      jobIdsSql({
        scope: { market: 'cn', userId: 'u1', now: NOW, publicOnly: true },
        filters: { classYear: 2027 },
        fields: FILTER_FIELDS,
        from: new Date('2026-10-09T12:00:00Z'),
        allowUndated: true,
        firstSeenAfter: new Date('2026-10-10T09:00:00Z'),
        limit: 101,
        orderBy: 'first_seen',
      }),
    )!;
    expect(sql.text).toContain('(j."postedAt" IS NULL OR j."postedAt" >= $');
    expect(sql.text).toContain('j."firstSeenAt" > $');
    expect(sql.text).toContain('ORDER BY j."firstSeenAt" DESC, j."id" DESC');
    expect(sql.values).toContain('class_year:%');
    expect(sql.text).toContain('"hiddenAt" IS NOT NULL');
  });

  it('card extras: by id, the posting text only for rows that carry market tags', () => {
    const sql = show(cardExtrasSql(['j1', 'j2']))!;
    expect(sql).toMatchSnapshot();
    expect(sql.values).toEqual([['j1', 'j2']]);
    expect(sql.text).toContain('jsonb_array_length(j."marketTags") > 0 THEN j."descriptionPlain" END');
  });

  it('all predicates together compose (no field throws)', () => {
    for (const [, f, market] of SAMPLES) {
      expect(() => filterPredicates(f, market === 'cn' ? cn : intl, FILTER_FIELDS)).not.toThrow();
    }
  });
});
