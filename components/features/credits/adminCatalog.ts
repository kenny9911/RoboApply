// components/features/credits/adminCatalog.ts — pure helpers for the
// /admin/credits caps editor (WP-21b). The override is the AppConfig
// `credits.catalog.v1` document (server CreditCatalogOverrideSchema):
//   { version: 1, brands: { <brand>: { buckets: { <bucket>: { free: {cap, window}, pro: {cap, window}, grantable } }, entitlements } } }
// The editor touches only `cap` values; windows, `grantable`, entitlements
// and the other brand are kept exactly as they were. The server validates
// again on save.

export const MAX_OVERRIDE_CAP = 10_000;

/** Buckets with a window cap (everything but `practice`, which is interview credits). */
export const EDITABLE_BUCKETS = [
  'fit_analysis',
  'tailor',
  'cover_letter',
  'resume_check',
  'rewrite',
  'outreach',
  'assistant',
  'autofill',
  'ai_answer',
  'job_import',
  'ready_kits',
  'competitiveness',
  'contact_lookup',
] as const;

export type CapProfile = 'free' | 'pro';
/** bucket → profile → raw input ('' = use the default). */
export type CapDraft = Record<string, Record<CapProfile, string>>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** The draft for one brand from a stored override (unknown shapes → empty draft). */
export function draftFromOverride(override: unknown, brand: string): CapDraft {
  const draft: CapDraft = {};
  const buckets = isObj(override) && isObj(override.brands) && isObj(override.brands[brand]) && isObj((override.brands[brand] as Obj).buckets)
    ? ((override.brands[brand] as Obj).buckets as Obj)
    : {};
  for (const b of EDITABLE_BUCKETS) {
    const entry = isObj(buckets[b]) ? (buckets[b] as Obj) : {};
    const cap = (p: CapProfile) => {
      const v = isObj(entry[p]) ? (entry[p] as Obj).cap : undefined;
      return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
    };
    draft[b] = { free: cap('free'), pro: cap('pro') };
  }
  return draft;
}

/** Cells that are not empty and not a whole number in 0…10,000. */
export function invalidCells(draft: CapDraft): string[] {
  const bad: string[] = [];
  for (const [bucket, row] of Object.entries(draft)) {
    for (const p of ['free', 'pro'] as const) {
      const raw = row[p].trim();
      if (!raw) continue;
      if (!/^\d+$/.test(raw) || Number(raw) > MAX_OVERRIDE_CAP) bad.push(`${bucket}.${p}`);
    }
  }
  return bad;
}

/**
 * Apply one brand's draft to the stored override and return the new override.
 * Empty cells remove that `cap` (the default applies again); empty objects are
 * pruned so the document stays minimal. Never mutates its input.
 */
export function applyDraft(override: unknown, brand: string, draft: CapDraft): Obj {
  const base: Obj = isObj(override) ? structuredClone(override) : {};
  base.version = 1;
  const brands: Obj = isObj(base.brands) ? (base.brands as Obj) : {};
  const brandPatch: Obj = isObj(brands[brand]) ? (brands[brand] as Obj) : {};
  const buckets: Obj = isObj(brandPatch.buckets) ? (brandPatch.buckets as Obj) : {};

  for (const [bucket, row] of Object.entries(draft)) {
    const entry: Obj = isObj(buckets[bucket]) ? (buckets[bucket] as Obj) : {};
    for (const p of ['free', 'pro'] as const) {
      const cell: Obj = isObj(entry[p]) ? (entry[p] as Obj) : {};
      const raw = row[p].trim();
      if (raw) cell.cap = Number(raw);
      else delete cell.cap;
      if (Object.keys(cell).length) entry[p] = cell;
      else delete entry[p];
    }
    if (Object.keys(entry).length) buckets[bucket] = entry;
    else delete buckets[bucket];
  }

  if (Object.keys(buckets).length) brandPatch.buckets = buckets;
  else delete brandPatch.buckets;
  if (Object.keys(brandPatch).length) brands[brand] = brandPatch;
  else delete brands[brand];
  base.brands = brands;
  return base;
}

/** Parse an override value typed by an admin: true/false, a whole number, or a hiring-contacts mode. */
export function parseOverrideValue(raw: string): number | boolean | 'off' | 'deeplinks_only' | 'on' | null {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'off' || v === 'deeplinks_only' || v === 'on') return v;
  if (/^\d+$/.test(v) && Number(v) <= MAX_OVERRIDE_CAP) return Number(v);
  return null;
}

export const OVERRIDE_KEY_RE = /^(bucket|entitlement|flag):[A-Za-z0-9_.]+$/;

/** Share of the TW VAT registration level reached, 0…100+ (null when unknown). */
export function revenueShare(revenueTwd: number | null | undefined, levelTwd: number): number | null {
  if (revenueTwd === null || revenueTwd === undefined || !Number.isFinite(revenueTwd) || levelTwd <= 0) return null;
  return Math.floor((revenueTwd / levelTwd) * 100);
}
