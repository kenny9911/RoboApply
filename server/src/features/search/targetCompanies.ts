// server/src/features/search/targetCompanies.ts — "Companies you want to work
// at" (target companies; docs/agent-driven/REDESIGN.md §8 scenario 4).
//
// Where they live: the saved search's FilterSet, field `preferredCompanies`
// (FilterSet v1; the legacy preferences called the same list
// `targetCompanies`, legacyBridge.ts). It is an optional JSON list inside
// `RASearchProfile.filters`: no schema change and no new FilterSet version. A
// saved search without it, and a client that never sends it, work as before.
//
// What it means: a SOFT preference, never a filter. "Only these companies"
// (`companies`, include-only) and "Companies to leave out"
// (`excludedCompanies`) keep their meaning; this list never adds a job to a
// list or takes one out. It only orders a job at a listed company ahead of an
// otherwise equal job, by a bounded amount (TARGET_COMPANY_POINTS = 5,
// feed/rankingText.ts):
//   · the Jobs list's Recommended order: the job's rank gets the points
//     (ORDERING_RULES `target_companies`, published on /help/ranking), so it
//     passes a job whose rank was at most 5 points higher and no other;
//   · the agent's suggestions and its weekly list (the Best fit order of
//     `feedService.preview` with `favorTargetCompanies`): the job is ordered
//     as if its fit were 5 points higher. A job with no fit gets no points: it
//     stays after every job that has one, and among jobs without a fit a job
//     at a listed company comes first.
// Ties after the points are broken as before (newest, the retrieval position,
// the id), and the company spread (at most 2 of one company in any 20) still
// runs after the order. The points change an order, never a number on a card:
// a pick still leads with its gap and its score keeps the honesty line (R2,
// C5).
//
// Names are compared as the feed compares companies: by the normalized
// company name (jobs/normalize `normalizeCompanyName`: case, width, legal
// forms such as "Inc" or "有限公司", bracketed notes and branch suffixes do
// not count), the key `RAJob.companyNameNormalized` stores. Pure functions.

import { normalizeCompanyName } from '../jobs/normalize/index.js';

/** A company name as the list compares it ('' when nothing is left of it). */
export function targetCompanyKey(name: string | null | undefined): string {
  return normalizeCompanyName(name);
}

/** The keys of a list's names (empty keys left out). */
export function targetCompanyKeys(list: readonly string[] | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const name of list ?? []) {
    const key = targetCompanyKey(name);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Is the job's company on the list (`keys`, from `targetCompanyKeys`)? The
 * row's stored key first, else its company name put through the same
 * normalization. False for an empty list.
 */
export function isTargetCompany(job: { companyName?: string | null; companyNameNormalized?: string | null }, keys: ReadonlySet<string> | null | undefined): boolean {
  if (!keys?.size) return false;
  const stored = job.companyNameNormalized?.trim();
  if (stored && keys.has(stored)) return true;
  const key = targetCompanyKey(job.companyName);
  return key !== '' && keys.has(key);
}

/** The comparison key of an entry; a name with nothing left after normalization compares as typed (case aside). */
function entryKey(name: string): string {
  return targetCompanyKey(name) || name.trim().toLowerCase();
}

/**
 * The list with `company` on it (`on`) or off it. Adding a company the list
 * already names, in any spelling, changes nothing; taking one off removes
 * every entry that names it. The other entries keep their order and spelling.
 */
export function withTargetCompany(list: readonly string[] | null | undefined, company: string, on: boolean): { list: string[]; changed: boolean } {
  const current = [...(list ?? [])];
  const name = company.trim();
  if (!name) return { list: current, changed: false };
  const key = entryKey(name);
  const names = (entry: string) => entryKey(entry) === key;
  if (on) {
    if (current.some(names)) return { list: current, changed: false };
    return { list: [...current, name], changed: true };
  }
  const kept = current.filter((entry) => !names(entry));
  return { list: kept, changed: kept.length !== current.length };
}
