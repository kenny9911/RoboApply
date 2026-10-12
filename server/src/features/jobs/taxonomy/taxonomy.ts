// server/src/features/jobs/taxonomy/taxonomy.ts
//
// Role taxonomy v1 (PRODUCT F-FEED-13 Explore categories, F-FILT-01
// "function"): L1 = Explore category, L2 = role group, L3 = role. Every node
// has an English, a Simplified Chinese and a Traditional Chinese (Taiwan)
// label; roles carry English, Simplified and Taiwan synonyms used by title
// matching and the typeahead.
//
// Built from public sources (D3): O*NET-SOC 2019 codes and titles (USDOL/ETA,
// CC BY 4.0; the SOC structure is a public-domain federal standard) plus
// common job-posting titles. `taxonomy.v1.json` lists the sources; a role's
// `soc` codes say which O*NET-SOC occupations it corresponds to.
//
// Ids are stable snake_case strings, unique across levels, and safe as
// next-intl key segments (`taxonomy.categories.<id>`). A new version gets a
// new file (`taxonomy.v2.json`) and a migration of stored ids; ids are never
// reused for a different role.
//
// Labels by locale: en → English; zh → Simplified Chinese; zh-TW → the
// node's own Traditional Chinese label (`zhHant`; zh-TW must never show
// Simplified characters); every other locale falls back to English until INT
// translates the staging bundle.
//
// The Taiwan labels (JT-4, MKT-3E). `zhHant` and `synonyms.zhHant` are
// translations in Taiwan usage (軟體, 資料, 網路, 程式, 專案, 行銷, 人資, 韌體,
// 演算法), not conversions of the Simplified labels: the vocabulary differs,
// not only the script. They ship as a DRAFT (`zhHantReview.status`): zh-TW
// otherwise shows English role names and a Taiwan search cannot be asked in
// the language its postings are written in. A Taiwan-native reviewer signs
// off later by filling `zhHantReview` in the data file. Adding them changed
// no id, no English or Simplified label and no node (ids are frozen:
// idsFrozen.test.ts). `exportTaxonomyLabels(locale)` hands the labels to the
// web bundle's `taxonomy` namespace, so the zh-TW bundle is filled from this
// file instead of being machine-translated a second time.

import data from './taxonomy.v1.json' with { type: 'json' };

export type TaxonomyLevel = 1 | 2 | 3;

export interface TaxonomyNode {
  id: string;
  level: TaxonomyLevel;
  parent: string | null;
  en: string;
  zh: string;
  /** Traditional Chinese label as used in Taiwan (zh-TW): a translation in Taiwan usage, never a conversion of `zh`. */
  zhHant: string;
  synonyms: { en: string[]; zh: string[]; /** Taiwan titles for the role (Traditional Chinese). */ zhHant?: string[] };
  /** O*NET-SOC 2019 codes this role corresponds to (roles only). */
  soc?: string[];
  /** A catch-all role (e.g. "Software engineer"): loses ties to a specific role in title matching. */
  generic?: boolean;
}

export interface TaxonomySource {
  id: string;
  name: string;
  publisher: string;
  url: string | null;
  license: string;
  usedFor: string;
}

/** Who has read the Taiwan labels. 'draft' = written, not yet signed off by a Taiwan-native reviewer. */
export interface TaxonomyZhHantReview {
  status: 'draft' | 'reviewed';
  reviewedBy: string | null;
  /** 'YYYY-MM-DD'. */
  reviewedOn: string | null;
}

export interface TaxonomyData {
  version: number;
  asOf: string;
  /** State of the `zhHant` labels and synonyms (absent in a hand-built table, e.g. a test's). */
  zhHantReview?: TaxonomyZhHantReview;
  sources: TaxonomySource[];
  nodes: TaxonomyNode[];
}

const TAXONOMY = data as TaxonomyData;

export const TAXONOMY_VERSION = TAXONOMY.version;
export const TAXONOMY_AS_OF = TAXONOMY.asOf;
export const TAXONOMY_SOURCES: readonly TaxonomySource[] = TAXONOMY.sources;
/** Draft until a Taiwan-native reviewer signs the Traditional Chinese labels off (owner item; JT-4). */
export const TAXONOMY_ZH_HANT_REVIEW: Readonly<TaxonomyZhHantReview> = TAXONOMY.zhHantReview ?? { status: 'draft', reviewedBy: null, reviewedOn: null };
export const TAXONOMY_NODES: readonly TaxonomyNode[] = TAXONOMY.nodes;

const byId = new Map<string, TaxonomyNode>(TAXONOMY_NODES.map((n) => [n.id, n]));
const childrenOf = new Map<string, TaxonomyNode[]>();
for (const n of TAXONOMY_NODES) {
  if (!n.parent) continue;
  const list = childrenOf.get(n.parent) ?? [];
  list.push(n);
  childrenOf.set(n.parent, list);
}

export function getTaxonomyNode(id: string): TaxonomyNode | null {
  return byId.get(id) ?? null;
}

export function isTaxonomyId(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id);
}

/** Explore categories (L1), in data order. */
export function taxonomyCategories(): TaxonomyNode[] {
  return TAXONOMY_NODES.filter((n) => n.level === 1);
}

export function taxonomyChildren(id: string): TaxonomyNode[] {
  return [...(childrenOf.get(id) ?? [])];
}

/** The node and its ancestors, nearest first: [role, group, category]. */
export function taxonomyAncestors(id: string): TaxonomyNode[] {
  const out: TaxonomyNode[] = [];
  let cur = byId.get(id);
  while (cur) {
    out.push(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return out;
}

/** All roles (L3) under a node; a role returns itself. */
export function taxonomyRolesUnder(id: string): TaxonomyNode[] {
  const node = byId.get(id);
  if (!node) return [];
  if (node.level === 3) return [node];
  return taxonomyChildren(id).flatMap((c) => taxonomyRolesUnder(c.id));
}

/**
 * Expand a FilterSet's `taxonomyIds` (any level) to the role ids the feed
 * filters on. Unknown ids are ignored. Order: first appearance.
 */
export function expandTaxonomyIds(ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) for (const role of taxonomyRolesUnder(id)) out.add(role.id);
  return [...out];
}

/**
 * A node's display label for a locale: zh → Simplified; zh-TW → the node's
 * Traditional Chinese label, never the Simplified one (a hand-built node
 * without one shows English); everything else → English.
 */
export function taxonomyNodeLabel(node: Pick<TaxonomyNode, 'en' | 'zh'> & { zhHant?: string | null }, locale: string): string {
  if (locale === 'zh') return node.zh;
  if (locale === 'zh-TW') return node.zhHant?.trim() || node.en;
  return node.en;
}

/** Display label of a taxonomy id for a locale (see taxonomyNodeLabel); null for an unknown id. */
export function taxonomyLabel(id: string, locale: string): string | null {
  const node = byId.get(id);
  return node ? taxonomyNodeLabel(node, locale) : null;
}

/** Structural problems in a taxonomy (empty when valid). Used by tests and the version-bump script. */
export function validateTaxonomy(t: TaxonomyData): string[] {
  const errors: string[] = [];
  const ids = new Map<string, TaxonomyNode>();
  for (const n of t.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate id ${n.id}`);
    ids.set(n.id, n);
    if (!/^[a-z][a-z0-9_]*$/.test(n.id)) errors.push(`id ${n.id} is not snake_case`);
    if (!n.en?.trim()) errors.push(`${n.id} has no English label`);
    if (!n.zh?.trim()) errors.push(`${n.id} has no Chinese label`);
    // Every node carries a Taiwan label (JT-4); a missing or blank one would show English, or nothing, in zh-TW.
    if (typeof n.zhHant !== 'string' || !n.zhHant.trim()) errors.push(`${n.id} has no Traditional Chinese label`);
    if (n.synonyms?.zhHant !== undefined && (!Array.isArray(n.synonyms.zhHant) || n.synonyms.zhHant.some((s) => typeof s !== 'string' || !s.trim()))) {
      errors.push(`${n.id} has a blank Traditional Chinese synonym`);
    }
    if (n.level === 3 && !Array.isArray(n.synonyms?.zhHant)) errors.push(`${n.id} has no Traditional Chinese synonym list`);
  }
  for (const n of t.nodes) {
    if (n.level === 1) {
      if (n.parent !== null) errors.push(`${n.id}: a category has no parent`);
      continue;
    }
    const parent = n.parent ? ids.get(n.parent) : undefined;
    if (!parent) errors.push(`${n.id}: missing parent ${n.parent}`);
    else if (parent.level !== n.level - 1) errors.push(`${n.id}: parent ${parent.id} is level ${parent.level}`);
    if (n.level === 3 && n.soc) for (const code of n.soc) if (!/^\d{2}-\d{4}\.\d{2}$/.test(code)) errors.push(`${n.id}: bad SOC code ${code}`);
  }
  for (const n of t.nodes) {
    if (n.level < 3 && !t.nodes.some((c) => c.parent === n.id)) errors.push(`${n.id}: has no children`);
  }
  return errors;
}

/** The web bundle's `taxonomy` namespace: one label per node, by level. */
export interface TaxonomyLabelBundle {
  categories: Record<string, string>;
  groups: Record<string, string>;
  roles: Record<string, string>;
}

/**
 * Every node's label in a locale, in the shape of the web bundle's `taxonomy`
 * namespace (`taxonomy.categories.<id>`, `taxonomy.groups.<id>`,
 * `taxonomy.roles.<id>`), in data order. The locale step fills a bundle from
 * this instead of translating role names a second time:
 * `exportTaxonomyLabels('zh-TW')` is the Taiwan labels of the data file,
 * `'zh'` the Simplified ones, anything else English. One entry per node.
 */
export function exportTaxonomyLabels(locale: string): TaxonomyLabelBundle {
  const out: TaxonomyLabelBundle = { categories: {}, groups: {}, roles: {} };
  for (const node of TAXONOMY_NODES) {
    const target = node.level === 1 ? out.categories : node.level === 2 ? out.groups : out.roles;
    target[node.id] = taxonomyNodeLabel(node, locale);
  }
  return out;
}
