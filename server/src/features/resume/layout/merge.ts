// server/src/features/resume/layout/merge.ts
//
// Merge a PATCH /:id/layout body into the stored `RAResumeVariant.layout`
// (WP-36b behaviour, plus the WP-65 keys `personal`, `photo` and
// `headingLanguage`). Pure.
//
// `sizes`, `spacing` and `personal` merge field by field; any other key
// replaces. `null` removes a key (so `personal: null` clears 籍贯 / 政治面貌).
// Unknown keys are dropped (the contract schema already refuses them).

export const LAYOUT_KEYS = [
  'template',
  'font',
  'sizes',
  'page',
  'spacing',
  'justify',
  'headerAlign',
  'accent',
  'bullet',
  'skillsLayout',
  'eduOrder',
  'dateFormat',
  'hideDivider',
  // WP-65
  'personal',
  'photo',
  'headingLanguage',
] as const;
export type LayoutKey = (typeof LAYOUT_KEYS)[number];

const OBJECT_KEYS = new Set<LayoutKey>(['sizes', 'spacing', 'personal']);

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function mergeLayout(prevRaw: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const prev = isObject(prevRaw) ? prevRaw : {};
  const merged: Record<string, unknown> = {};
  for (const key of LAYOUT_KEYS) {
    const has = Object.prototype.hasOwnProperty.call(patch, key);
    const next = has ? patch[key] : prev[key];
    if (next === undefined || next === null) continue;
    if (OBJECT_KEYS.has(key) && isObject(next)) {
      const stored = isObject(prev[key]) ? (prev[key] as Record<string, unknown>) : {};
      const out: Record<string, unknown> = has ? { ...stored, ...next } : { ...next };
      // Empty strings clear a personal field.
      for (const [k, v] of Object.entries(out)) if (v === undefined || v === null || v === '') delete out[k];
      if (Object.keys(out).length) merged[key] = out;
    } else {
      merged[key] = next;
    }
  }
  return merged;
}
