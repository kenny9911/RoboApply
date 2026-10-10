// server/src/features/feed/affinity.ts — per-user affinities with lazy decay (WP-32; ARCH §4.9).
//
// Pure functions over `RAUserAffinity.{taxonomy,company,skill}Weights`
// (`{ key: -1..1 }`). Weights fade ×0.98 per day, applied lazily: when read
// (ranking) and before every write. Deltas: save +0.1, apply click +0.15,
// applied +0.25, a hide with no reason −0.1. Keys: the job's role (L3
// taxonomy id), its normalized company name and its first three skills.
// Listed as the "affinity" factor on /help/ranking.

export type AffinityMap = Record<string, number>;

export interface AffinityState {
  taxonomy: AffinityMap;
  company: AffinityMap;
  skill: AffinityMap;
  updatedAt: Date | null;
}

export const AFFINITY_DECAY_PER_DAY = 0.98;
export const AFFINITY_DELTAS = { save: 0.1, apply_click: 0.15, applied: 0.25, hide: -0.1 } as const;
export type AffinityEvent = keyof typeof AFFINITY_DELTAS;
/** Weights smaller than this are dropped; each map keeps at most this many keys. */
const MIN_WEIGHT = 0.01;
const MAX_KEYS = 200;
const DAY_MS = 86_400_000;

export const EMPTY_AFFINITY: AffinityState = { taxonomy: {}, company: {}, skill: {}, updatedAt: null };

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

export function decayFactor(updatedAt: Date | null, now: Date): number {
  if (!updatedAt) return 1;
  const days = Math.max(0, (now.getTime() - updatedAt.getTime()) / DAY_MS);
  return Math.pow(AFFINITY_DECAY_PER_DAY, days);
}

function scaleMap(map: AffinityMap, k: number): AffinityMap {
  const out: AffinityMap = {};
  for (const [key, w] of Object.entries(map)) {
    if (typeof w !== 'number' || !Number.isFinite(w)) continue;
    const v = clamp(w * k);
    if (Math.abs(v) >= MIN_WEIGHT) out[key] = v;
  }
  return out;
}

function prune(map: AffinityMap): AffinityMap {
  const entries = Object.entries(map).filter(([, w]) => Math.abs(w) >= MIN_WEIGHT);
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Object.fromEntries(entries.slice(0, MAX_KEYS));
}

/** The state as of `now` (decay applied). */
export function decayed(state: AffinityState, now: Date): AffinityState {
  const k = decayFactor(state.updatedAt, now);
  return { taxonomy: scaleMap(state.taxonomy, k), company: scaleMap(state.company, k), skill: scaleMap(state.skill, k), updatedAt: now };
}

export interface AffinityKeys {
  taxonomy: string | null;
  company: string | null;
  skills: string[];
}

/** Keys a job contributes: role id (L3, else the deepest listed), company key, first three skills. */
export function affinityKeys(job: { primaryTaxonomyId: string | null; taxonomyIds: string[] | null; companyNameNormalized: string | null; skills: string[] | null }): AffinityKeys {
  const tax = job.primaryTaxonomyId ?? (job.taxonomyIds?.length ? job.taxonomyIds[job.taxonomyIds.length - 1] : null) ?? null;
  return {
    taxonomy: tax,
    company: job.companyNameNormalized || null,
    skills: (job.skills ?? []).slice(0, 3).map((s) => s.toLowerCase()),
  };
}

/** Decay to `now`, then add `delta` to each key (clamped to −1..1). */
export function applyAffinity(state: AffinityState, keys: AffinityKeys, delta: number, now: Date): AffinityState {
  const next = decayed(state, now);
  const bump = (map: AffinityMap, key: string | null) => {
    if (!key) return;
    map[key] = clamp((map[key] ?? 0) + delta);
  };
  bump(next.taxonomy, keys.taxonomy);
  bump(next.company, keys.company);
  for (const s of keys.skills) bump(next.skill, s);
  return { taxonomy: prune(next.taxonomy), company: prune(next.company), skill: prune(next.skill), updatedAt: now };
}

/**
 * The affinity factor of one job, 0–100 (50 = neutral): the mean of the role
 * weight, the company weight (a preferred company counts at least +0.5) and
 * the mean of its skill weights.
 */
export function affinityScore(state: AffinityState, keys: AffinityKeys, preferredCompanyKeys: ReadonlySet<string> = new Set()): number {
  const role = keys.taxonomy ? (state.taxonomy[keys.taxonomy] ?? 0) : 0;
  let company = keys.company ? (state.company[keys.company] ?? 0) : 0;
  if (keys.company && preferredCompanyKeys.has(keys.company)) company = Math.max(company, 0.5);
  const skillWeights = keys.skills.map((s) => state.skill[s] ?? 0);
  const skill = skillWeights.length ? skillWeights.reduce((a, b) => a + b, 0) / skillWeights.length : 0;
  const mean = (role + company + skill) / 3;
  return Math.round((50 + 50 * clamp(mean)) * 100) / 100;
}

/** Parse a stored weights JSON column (anything invalid becomes empty). */
export function readWeights(v: unknown): AffinityMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: AffinityMap = {};
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (typeof w === 'number' && Number.isFinite(w)) out[k] = clamp(w);
  }
  return out;
}
