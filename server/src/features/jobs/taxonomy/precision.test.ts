// @vitest-environment node
//
// The taxonomy gate (MARKET_STRATEGY 2.6, SM-2): category precision of the
// deterministic title match on 300 labelled titles per market, at least 95%.
//
// The two fixture files are SYNTHETIC: every title was written for this test
// from the role tree and common posting vocabulary. None was copied from a job
// board, a provider response or a database row. A label is the category a
// recruiter would file the title under; `categoryId: null` means the title
// names no category the tree has and must stay unknown. `roleId` is the role
// when the tree has one for it. `note` says what the row is there for
// ("head:<noun>" marks a head-noun case, "zh-TW" a Traditional Chinese title,
// "mixed" a title in two languages, "campus" a 校招 / 实习 title).
//
// Precision = titles filed under the right category ÷ titles the matcher
// filed under any category. A title the matcher leaves unknown is not counted
// (enrichment decides it), so the test also holds the matcher to a minimum
// share of labelled titles it does file.
//
// A title is matched the way ingest, enrichment and the backfill match it:
// as written and, for a Taiwan title, in its mainland reading (the taxonomy's
// Chinese phrases are Simplified; enrich/titleEvidence.ts). The gate also
// holds for the matcher called on the raw title alone, and for ingest's own
// function (normalize `taxonomyIdsForTitle`), which is what the evaluation
// harness of the match area calls.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { titleEvidence } from '../enrich/titleEvidence.js';
import { taxonomyIdsForTitle } from '../normalize/index.js';
import { CJK_HEAD_WORDS, HEAD_NOUNS, bestTaxonomyMatch } from './match.js';
import { getTaxonomyNode, taxonomyAncestors } from './taxonomy.js';

interface LabelledTitle {
  title: string;
  categoryId: string | null;
  roleId: string | null;
  note?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKETS = ['intl', 'cn'] as const;
const ROWS_PER_MARKET = 300;
const MIN_PRECISION = 0.95;
/** The matcher must file at least this share of the titles that have a category. */
const MIN_FILED = 0.9;

function load(market: (typeof MARKETS)[number]): LabelledTitle[] {
  return JSON.parse(readFileSync(path.join(here, '__fixtures__', `labelledTitles.${market}.json`), 'utf8')) as LabelledTitle[];
}

function categoryOf(roleId: string): string {
  return taxonomyAncestors(roleId).find((n) => n.level === 1)!.id;
}

type Filed = { roleId: string; categoryId: string; score: number } | null;

/** The role the pipeline files a title under (a Taiwan title is also read in its mainland form). */
function filed(title: string): Filed {
  const m = titleEvidence(title);
  return m ? { roleId: m.id, categoryId: categoryOf(m.id), score: m.score } : null;
}

/** The role the matcher alone files the raw title under. */
function filedRaw(title: string): Filed {
  const m = bestTaxonomyMatch(title);
  return m ? { roleId: m.id, categoryId: categoryOf(m.id), score: m.score } : null;
}

/** Ingest's own reading (normalize `taxonomyIdsForTitle`, which the harness suite calls too): the better of the title as written and its mainland reading. */
function filedAsIngest(title: string): Filed {
  const m = taxonomyIdsForTitle(title);
  return m.primary && m.score !== null ? { roleId: m.primary, categoryId: categoryOf(m.primary), score: m.score } : null;
}

/**
 * Titles the matcher files under the right category but another role than the label. Both are
 * phrases of the neighbouring role: "sales developer" is not a phrase of the SDR role, and
 * 客户端开发工程师 names the mobile role outright.
 */
const KNOWN_ROLE_MISSES: Record<(typeof MARKETS)[number], string[]> = {
  intl: ['Sales Developer Representative → account_executive'],
  cn: ['游戏客户端开发工程师 → mobile_engineer'],
};

const TRADITIONAL = /[師員發軟體資設計經專務業銷會網數質術護藥儲幹優劃頭顧問內]/;
const CHINESE = /[㐀-鿿]/;

describe.each(MARKETS)('labelled titles: %s', (market) => {
  const rows = load(market);

  it('has 300 rows of the documented shape with valid ids', () => {
    expect(rows).toHaveLength(ROWS_PER_MARKET);
    expect(new Set(rows.map((r) => r.title)).size).toBe(ROWS_PER_MARKET);
    for (const r of rows) {
      expect(Object.keys(r).filter((k) => !['title', 'categoryId', 'roleId', 'note'].includes(k)), r.title).toEqual([]);
      expect(r.title.trim(), 'empty title').not.toBe('');
      if (r.categoryId !== null) expect(getTaxonomyNode(r.categoryId)?.level, `${r.title}: category ${r.categoryId}`).toBe(1);
      if (r.roleId !== null) {
        expect(getTaxonomyNode(r.roleId)?.level, `${r.title}: role ${r.roleId}`).toBe(3);
        expect(categoryOf(r.roleId), `${r.title}: role ${r.roleId} is not under ${r.categoryId}`).toBe(r.categoryId);
      }
    }
  });

  it('files at least 95% of the titles it files under the right category', () => {
    const misses: string[] = [];
    let filedCount = 0;
    let correct = 0;
    let labelled = 0;
    let labelledFiled = 0;
    for (const r of rows) {
      const got = filed(r.title);
      if (r.categoryId) labelled++;
      if (!got) continue;
      filedCount++;
      if (r.categoryId) labelledFiled++;
      if (got.categoryId === r.categoryId) correct++;
      else misses.push(`${r.title} → ${got.roleId} (${got.categoryId}, ${got.score}); labelled ${r.categoryId ?? 'unknown'}`);
    }
    const precision = correct / filedCount;
    if (misses.length) console.info(`[taxonomy precision ${market}] ${correct}/${filedCount} = ${precision.toFixed(4)}; misses:\n  ${misses.join('\n  ')}`);
    expect(precision, `misses:\n${misses.join('\n')}`).toBeGreaterThanOrEqual(MIN_PRECISION);
    expect(labelledFiled / labelled, 'share of labelled titles the matcher files').toBeGreaterThanOrEqual(MIN_FILED);
  });

  it.each([
    ['on the raw title alone, without the mainland reading', filedRaw],
    ['by the function ingest and the evaluation harness call (the better of the raw title and its mainland reading)', filedAsIngest],
  ] as const)('holds the same 95%% when the matcher is called %s', (_how, file) => {
    const got = rows.map((r) => ({ r, got: file(r.title) })).filter(({ got }) => got);
    const misses = got.filter(({ r, got }) => got!.categoryId !== r.categoryId).map(({ r, got }) => `${r.title} → ${got!.roleId} (${got!.categoryId}); labelled ${r.categoryId ?? 'unknown'}`);
    expect((got.length - misses.length) / got.length, `misses:\n${misses.join('\n')}`).toBeGreaterThanOrEqual(MIN_PRECISION);
    // No title labelled unknown is forced into a category that way either.
    expect(got.filter(({ r }) => r.categoryId === null).map(({ r }) => r.title)).toEqual([]);
  });

  it('gets every head-noun case right', () => {
    const cases = rows.filter((r) => r.note?.includes('head:'));
    expect(cases.length).toBeGreaterThanOrEqual(100);
    const wrong = cases
      .map((r) => ({ r, got: filed(r.title) }))
      .filter(({ r, got }) => got && got.categoryId !== r.categoryId)
      .map(({ r, got }) => `${r.title} → ${got!.roleId} (${got!.categoryId}); labelled ${r.categoryId ?? 'unknown'}`);
    expect(wrong).toEqual([]);
  });

  it('covers every head noun in at least three categories, and alone', () => {
    const heads = market === 'intl' ? HEAD_NOUNS : CJK_HEAD_WORDS;
    for (const head of heads) {
      const cases = rows.filter((r) => r.note?.includes(`head:${head}`));
      const categories = new Set(cases.map((r) => r.categoryId).filter(Boolean));
      expect(categories.size, `head noun ${head}: categories ${[...categories].join(', ')}`).toBeGreaterThanOrEqual(3);
      expect(cases.some((r) => /whole title|level word only/.test(r.note ?? '')), `head noun ${head}: no whole-title case`).toBe(true);
    }
  });

  it('never forces a title labelled unknown into a category', () => {
    const unknown = rows.filter((r) => r.categoryId === null);
    expect(unknown.length).toBeGreaterThanOrEqual(15);
    const forced = unknown.map((r) => ({ r, got: filed(r.title) })).filter(({ got }) => got).map(({ r, got }) => `${r.title} → ${got!.roleId}`);
    expect(forced).toEqual([]);
  });

  it('names the right role whenever it files a title whose role is labelled', () => {
    // Role precision is not a gate of the strategy, but a wrong role inside the right category is
    // invisible to the category gate ("Software Engineer, Payments" filed as a tech lead). So the
    // titles filed under another role than their label are listed here by name: a new one fails.
    const withRole = rows.filter((r) => r.roleId).map((r) => ({ r, got: filed(r.title) })).filter(({ got }) => got);
    const wrong = withRole.filter(({ r, got }) => got!.roleId !== r.roleId).map(({ r, got }) => `${r.title} → ${got!.roleId}`);
    expect(wrong).toEqual(KNOWN_ROLE_MISSES[market]);
    expect(withRole.length).toBeGreaterThanOrEqual(230);
  });
});

describe('labelled titles: what each market must contain', () => {
  it('intl: at least 40 Traditional Chinese titles and 20 mixed-language titles', () => {
    const rows = load('intl');
    const traditional = rows.filter((r) => r.note?.includes('zh-TW'));
    expect(traditional.length).toBeGreaterThanOrEqual(40);
    for (const r of traditional) expect(CHINESE.test(r.title), r.title).toBe(true);
    expect(traditional.filter((r) => TRADITIONAL.test(r.title)).length).toBeGreaterThanOrEqual(35);
    const mixed = rows.filter((r) => r.note?.includes('mixed'));
    expect(mixed.length).toBeGreaterThanOrEqual(20);
    for (const r of mixed) expect(CHINESE.test(r.title) && /[A-Za-z]/.test(r.title), r.title).toBe(true);
    // Level words, bracketed notes and tech spellings.
    expect(rows.filter((r) => /[([]/.test(r.title)).length).toBeGreaterThanOrEqual(8);
    for (const spelling of ['C++', '.NET', 'Node.js', 'C#']) expect(rows.some((r) => r.title.includes(spelling)), spelling).toBe(true);
    expect(rows.filter((r) => /\b(Senior|Sr\.|Junior|Staff|Principal|Lead|Intern|II|Graduate|Entry Level)\b/.test(r.title)).length).toBeGreaterThanOrEqual(20);
  });

  it('cn: campus, intern and management-trainee titles, in Simplified Chinese', () => {
    const rows = load('cn');
    for (const word of ['校招', '实习', '管培生', '届']) expect(rows.filter((r) => r.title.includes(word)).length, word).toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => CHINESE.test(r.title)).length).toBeGreaterThanOrEqual(280);
    expect(rows.filter((r) => TRADITIONAL.test(r.title)).map((r) => r.title)).toEqual([]);
    for (const spelling of ['C++', '.NET', 'Node.js']) expect(rows.some((r) => r.title.includes(spelling)), spelling).toBe(true);
  });
});
