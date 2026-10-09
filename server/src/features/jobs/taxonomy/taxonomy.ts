// server/src/features/jobs/taxonomy/taxonomy.ts
//
// Role taxonomy v1 (PRODUCT F-FEED-13 Explore categories, F-FILT-01
// "function"): L1 = Explore category, L2 = role group, L3 = role. Every node
// has an English and a Simplified Chinese label; roles carry English and
// Chinese synonyms used by title matching and the typeahead.
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
// Labels by locale: en → English; zh → Simplified Chinese; every other
// locale (zh-TW included, which must never show Simplified characters)
// falls back to English until INT translates the staging bundle.

import data from './taxonomy.v1.json' with { type: 'json' };

export type TaxonomyLevel = 1 | 2 | 3;

export interface TaxonomyNode {
  id: string;
  level: TaxonomyLevel;
  parent: string | null;
  en: string;
  zh: string;
  synonyms: { en: string[]; zh: string[] };
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

export interface TaxonomyData {
  version: number;
  asOf: string;
  sources: TaxonomySource[];
  nodes: TaxonomyNode[];
}

const TAXONOMY = data as TaxonomyData;

export const TAXONOMY_VERSION = TAXONOMY.version;
export const TAXONOMY_AS_OF = TAXONOMY.asOf;
export const TAXONOMY_SOURCES: readonly TaxonomySource[] = TAXONOMY.sources;
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

/** Display label for a locale (zh → Simplified; everything else → English for now). */
export function taxonomyLabel(id: string, locale: string): string | null {
  const node = byId.get(id);
  if (!node) return null;
  return locale === 'zh' ? node.zh : node.en;
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
