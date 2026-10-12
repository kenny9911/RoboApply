// hooks/feed/filterOps.ts — turn the feed server's `FilterDiffProposal.ops`
// (Not interested, NL search, ARCHITECTURE.md §4.9) into ONE FilterSetPatch
// the filters area saves with useApplyFilters (WP-20). Pure, for tests.
//
//   add    path=excludedCompanies value="Acme"   → append to the list (no duplicates)
//   remove path=skills            value="Go"     → drop from the list (a scalar field is cleared)
//   set    path=needsSponsorship  value=true     → replace the field (null clears it)
//
// `path` is a top-level FilterSet field, written `field` or `/field`. Ops on
// unknown or nested paths are ignored (the server owns the vocabulary; the
// filters API validates the result).

import type { FilterField, FilterSet, FilterSetPatch } from '../../lib/api/contracts/search';

export interface FilterOp {
  op: 'add' | 'remove' | 'set';
  path: string;
  value: unknown;
}

function fieldOf(path: string): string | null {
  const clean = path.replace(/^\/+/, '');
  if (!clean || clean.includes('/') || clean.includes('.')) return null;
  return clean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function opsToPatch(filters: FilterSet, ops: readonly FilterOp[]): FilterSetPatch {
  const working: Record<string, unknown> = { ...(filters as Record<string, unknown>) };
  const touched = new Set<string>();
  for (const op of ops) {
    const field = fieldOf(op.path);
    if (!field) continue;
    const current = working[field];
    if (op.op === 'set') {
      working[field] = op.value ?? null;
    } else if (op.op === 'add') {
      const list = Array.isArray(current) ? [...current] : [];
      const values = Array.isArray(op.value) ? op.value : [op.value];
      for (const v of values) if (!list.some((x) => same(x, v))) list.push(v);
      working[field] = list;
    } else if (op.op === 'remove') {
      if (Array.isArray(current)) {
        const values = Array.isArray(op.value) ? op.value : [op.value];
        const next = current.filter((x) => !values.some((v) => same(x, v)));
        working[field] = next.length ? next : null;
      } else {
        working[field] = null;
      }
    } else {
      continue;
    }
    touched.add(field);
  }
  const patch: Record<string, unknown> = {};
  for (const field of touched) patch[field] = working[field] === undefined ? null : working[field];
  return patch as FilterSetPatch;
}

/**
 * True when a patch changes nothing: every op was dropped (unknown or nested
 * path) or each field already has that value. Such a proposal is not shown —
 * no "Save this change" over an empty diff. Pure.
 */
export function isNoopPatch(filters: FilterSet, patch: FilterSetPatch): boolean {
  const current = filters as Record<string, unknown>;
  return Object.entries(patch).every(([field, value]) => {
    const before = current[field];
    const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    if (isEmpty(value) && isEmpty(before)) return true;
    return same(before, value);
  });
}

/** The filters after a patch (a value replaces, null clears). Pure. */
export function applyPatchPreview(filters: FilterSet, patch: FilterSetPatch): FilterSet {
  const out: Record<string, unknown> = { ...(filters as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as FilterSet;
}

/** The patch that removes one limiting filter (zero-results "relax"). Pure. */
export function relaxPatch(filters: FilterSet, field: string, value: unknown): FilterSetPatch {
  const current = (filters as Record<string, unknown>)[field];
  if (Array.isArray(current) && value !== undefined && value !== null && !Array.isArray(value)) {
    const next = current.filter((x) => !same(x, value));
    return { [field as FilterField]: next.length ? next : null } as FilterSetPatch;
  }
  return { [field as FilterField]: null } as FilterSetPatch;
}
