// server/src/features/match/eval/suites/taxonomy.suite.ts
//
// Taxonomy layer (strategy 2.6): category precision of the deterministic title
// match on the labelled titles of each market, gate ≥ 95%. The labelled sets
// (300 titles per market) belong to the taxonomy area
// (server/src/features/jobs/taxonomy/__fixtures__/labelledTitles.<market>.json)
// and are read by path when they exist; until then the row says `no_fixture`.
//
// Precision = titles whose matched category equals the label ÷ titles that got
// a deterministic category. A title labelled "should stay unknown"
// (categoryId null) that was forced into a category counts as wrong. A title
// with no deterministic match is outside the denominator (enrichment decides
// it); the share that did match is printed beside the precision.
//
// The title goes through the same steps as ingest: the match, and for a title
// with Han characters a second try after folding Taiwan vocabulary to mainland
// forms (normalize/zhVariants.ts).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GateLayer } from '../gates.js';
import { SEAMS, loadSeam } from '../seams.js';
import { notBuiltOrThrow, unmeasured, type SuiteContext, type SuiteMeasure } from '../suite.js';

export const name = 'taxonomy';
export const layer: GateLayer = 'taxonomy';

export const LABELLED_TITLES_DIR = 'server/src/features/jobs/taxonomy/__fixtures__';

export interface LabelledTitle {
  title: string;
  categoryId: string | null;
  roleId?: string | null;
  note?: string;
}

/** The rows of a labelled-titles file: a bare array, or an object holding one array of rows. */
export function readLabelledTitles(raw: unknown): LabelledTitle[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>).find((v) => Array.isArray(v)) : null;
  if (!Array.isArray(list)) throw new Error('labelled titles: expected an array of { title, categoryId, roleId } rows');
  return list
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { title?: unknown }).title === 'string')
    .map((r) => ({
      title: r.title as string,
      categoryId: typeof r.categoryId === 'string' ? r.categoryId : null,
      roleId: typeof r.roleId === 'string' ? r.roleId : null,
    }));
}

type MatchTitle = (title: string, options?: { limit?: number }) => Array<{ id: string; score: number }>;
type Ancestors = (id: string) => Array<{ id: string; level: number }>;

export interface PrecisionResult {
  precision: number | null;
  matched: number;
  correct: number;
  total: number;
  misses: Array<{ title: string; expected: string | null; got: string }>;
}

export function categoryPrecision(rows: LabelledTitle[], categoryOf: (title: string) => string | null): PrecisionResult {
  let matched = 0;
  let correct = 0;
  const misses: PrecisionResult['misses'] = [];
  for (const row of rows) {
    const got = categoryOf(row.title);
    if (got === null) continue;
    matched += 1;
    if (got === row.categoryId) correct += 1;
    else misses.push({ title: row.title, expected: row.categoryId, got });
  }
  return { precision: matched ? correct / matched : null, matched, correct, total: rows.length, misses };
}

export async function run(ctx: SuiteContext): Promise<SuiteMeasure[]> {
  const out: SuiteMeasure[] = [];
  for (const market of ctx.markets) {
    const file = path.join(ctx.repoRoot, LABELLED_TITLES_DIR, `labelledTitles.${market}.json`);
    if (!existsSync(file)) {
      out.push(unmeasured('category_precision', 'no_fixture', `${LABELLED_TITLES_DIR}/labelledTitles.${market}.json is not on disk yet`, { market }));
      continue;
    }
    try {
      const rows = readLabelledTitles(JSON.parse(readFileSync(file, 'utf8')));
      const matchTitle = await loadSeam<MatchTitle>(SEAMS.matchTitle);
      const ancestors = await loadSeam<Ancestors>(SEAMS.taxonomyAncestors);
      const fold = await loadSeam<(s: string) => string>(SEAMS.foldTwToCn);
      const categoryOf = (title: string): string | null => {
        const best = matchTitle(title, { limit: 1 })[0] ?? (/[㐀-鿿]/.test(title) ? matchTitle(fold(title), { limit: 1 })[0] : undefined);
        if (!best) return null;
        return ancestors(best.id).find((n) => n.level === 1)?.id ?? null;
      };
      const r = categoryPrecision(rows, categoryOf);
      const worst = r.misses.slice(0, 5).map((m) => `"${m.title}" → ${m.got} (labelled ${m.expected ?? 'unknown'})`);
      out.push({
        metric: 'category_precision',
        market,
        value: r.precision,
        n: r.matched,
        labels: 'human',
        note: `${r.correct} of ${r.matched} matched titles correct; ${r.matched} of ${r.total} titles got a deterministic category${worst.length ? `; misses: ${worst.join('; ')}` : ''}`,
      });
      out.push({ metric: 'deterministic_match_share', market, value: r.total ? r.matched / r.total : null, n: r.total, labels: 'human' });
    } catch (err) {
      out.push(notBuiltOrThrow('category_precision', err, { market }));
    }
  }
  return out;
}
