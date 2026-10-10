// server/src/features/seo/stats.ts
//
// Page statistics, intros and the indexability rule (ARCH §9.2). Pure.
//
// D3:
//   - the median listed pay needs ≥ MIN_SAMPLE (20) postings that list a
//     yearly pay in ONE currency (the most common one); below that it is not
//     published at all, and it always ships with its sample size;
//   - an intro is a template filled from `stats` only. `introNumbersMatch`
//     rejects an intro text that holds any number the stats do not (an LLM
//     paraphrase, if ever added under SKU `ra_seo_intro`, must pass it too).

import { MIN_SAMPLE, sourced, type Sourced } from '../../platform/http.js';
import { INDEX_FLOORS, type SeoIntro, type SeoPageStats, type SeoPageType, type SeoStatsView } from './contract.js';
import type { BrowseTarget } from './paths.js';

export interface PayRow {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryDisclosed: boolean;
}

/** One posting's yearly pay point (midpoint of a range), or null when it lists none. */
export function yearlyPayPoint(row: PayRow): { currency: string; value: number } | null {
  if (!row.salaryDisclosed || row.salaryPeriod !== 'year' || !row.salaryCurrency) return null;
  const lo = row.salaryMin;
  const hi = row.salaryMax;
  const value = lo != null && hi != null ? (lo + hi) / 2 : (lo ?? hi);
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return { currency: row.salaryCurrency.toUpperCase(), value };
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The median yearly pay in the most common currency, or null below the
 * sample rule. Ties between currencies go to the alphabetically first one.
 */
export function medianPay(rows: readonly PayRow[], min: number = MIN_SAMPLE): { value: number; currency: string; period: 'year'; sampleSize: number } | null {
  const byCurrency = new Map<string, number[]>();
  for (const r of rows) {
    const p = yearlyPayPoint(r);
    if (!p) continue;
    const list = byCurrency.get(p.currency) ?? [];
    list.push(p.value);
    byCurrency.set(p.currency, list);
  }
  const best = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (!best || best[1].length < min) return null;
  const m = median(best[1])!;
  // Rounded to the nearest 1,000 so the figure never claims more precision than the postings.
  return { value: Math.round(m / 1000) * 1000, currency: best[0], period: 'year', sampleSize: best[1].length };
}

export function floorFor(type: SeoPageType): number {
  return INDEX_FLOORS[type];
}

/** Indexable only at or above the floor, and never with a `?country=` filter (canonical has none). */
export function isIndexable(type: SeoPageType, jobCount: number, opts: { filtered?: boolean } = {}): boolean {
  return !opts.filtered && jobCount >= floorFor(type);
}

const INDEX_METHOD = 'Jobs in our index that we may show publicly, counted when the page was built.';

/** A count of public jobs in our index, as of `asOf` (D3: every public number is Sourced). */
export function indexCount(n: number, asOf: Date | string): Sourced<number> {
  return sourced(n, { source: 'index', method: INDEX_METHOD, asOf })!;
}

/** Stored stats → the wire view (every number Sourced, D3). */
export function statsView(stats: SeoPageStats): SeoStatsView {
  const asOf = stats.asOf;
  const count = (n: number): Sourced<number> => indexCount(n, asOf);
  return {
    jobCount: count(stats.jobCount),
    newLast7d: count(stats.newLast7d),
    payListed: { ...count(stats.payListed ?? 0), sampleSize: stats.jobCount },
    medianPay: stats.medianSalary
      ? {
          value: { value: stats.medianSalary.value, currency: stats.medianSalary.currency, period: 'year' },
          source: 'aggregate',
          sampleSize: stats.medianSalary.sampleSize,
          asOf,
          method: 'Median of the yearly pay listed in the postings (midpoint of each range), in the most common currency.',
        }
      : null,
    topCompanies: stats.topCompanies.map((c) => ({ name: c.name, count: count(c.count) })),
    asOf,
  };
}

/** The intro template and its parameters (numbers only from `stats`). */
export function introFor(target: Pick<BrowseTarget, 'type' | 'segment'>, stats: SeoPageStats): SeoIntro {
  const template = stats.jobCount === 0 ? 'empty' : target.type === 'segment' ? `segment_${target.segment === 'internships' ? 'internships' : 'entry'}` : target.type;
  const params: Record<string, string | number> = {
    count: stats.jobCount,
    newLast7d: stats.newLast7d,
    payListed: stats.payListed ?? 0,
  };
  if (stats.medianSalary) {
    params.median = stats.medianSalary.value;
    params.currency = stats.medianSalary.currency;
    params.sampleSize = stats.medianSalary.sampleSize;
  }
  return { template, params };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** English intro text for `RASeoPage.intro` (the web renders the localized template from the same params). */
export function introText(target: Pick<BrowseTarget, 'type' | 'segment' | 'role' | 'city' | 'sponsorCountry'>, stats: SeoPageStats): string {
  const role = target.role?.label ?? 'these';
  const where = target.city ? ` in ${target.city.name}` : target.type === 'remote_role' ? ' that are remote' : '';
  if (stats.jobCount === 0) return `No open ${role} jobs${where} are listed right now.`;
  const noun = target.type === 'segment' ? (target.segment === 'internships' ? 'internships' : 'entry-level jobs') : `${role} jobs${where}`;
  const parts = [`${fmt(stats.jobCount)} open ${noun}${target.type === 'sponsorship_role' ? ' whose posting says the employer sponsors visas' : ''}.`];
  parts.push(`${fmt(stats.newLast7d)} were added in the last 7 days.`);
  parts.push(`${fmt(stats.payListed ?? 0)} list pay.`);
  if (stats.medianSalary) {
    parts.push(`The median yearly pay listed is ${stats.medianSalary.currency} ${fmt(stats.medianSalary.value)}, from ${fmt(stats.medianSalary.sampleSize)} postings.`);
  }
  return parts.join(' ');
}

/** Every number written in `text` must be one the stats hold (also counts written with separators). */
export function introNumbersMatch(text: string, stats: SeoPageStats, labels: readonly string[] = []): boolean {
  let rest = text;
  for (const l of labels) if (l) rest = rest.split(l).join(' ');
  const allowed = new Set<number>([stats.jobCount, stats.newLast7d, stats.payListed ?? 0, 7]);
  if (stats.medianSalary) {
    allowed.add(stats.medianSalary.value);
    allowed.add(stats.medianSalary.sampleSize);
  }
  for (const c of stats.topCompanies) allowed.add(c.count);
  const found = rest.match(/\d[\d,.]*/g) ?? [];
  return found.every((raw) => allowed.has(Number(raw.replace(/[,]/g, '').replace(/\.$/, ''))));
}
