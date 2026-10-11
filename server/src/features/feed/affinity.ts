// server/src/features/feed/affinity.ts — per-user affinities with lazy decay (WP-32; ARCH §4.9).
//
// Pure functions over `RAUserAffinity.{taxonomy,company,skill,title}Weights`
// (`{ key: -1..1 }`). Weights fade ×0.98 per day, applied lazily: when read
// (ranking) and before every write. Deltas: save +0.1, apply click +0.15,
// applied +0.25, a hide with no reason −0.1. Keys: the job's role (L3
// taxonomy id), its normalized company name and its first three skills: the
// canonical skill ids (RAJob.skillIds) when the job has them, so "Postgres"
// and "PostgreSQL" are one key, else the first three skill strings.
//
// "Not interested: wrong title" (−0.25) is a title-level negative: it lowers
// the role id AND the job's normalized title, and touches neither the company
// nor the skills (the person said the title was wrong, nothing else). The
// title map only ever holds what that event wrote, and a title weight joins
// the score only while it is negative: a title is never boosted by this map.
// Listed as the "affinity" factor and the `wrong_title` rule on /help/ranking.

import { WRONG_TITLE_WEIGHT } from './rankingText.js';

export type AffinityMap = Record<string, number>;

export interface AffinityState {
  taxonomy: AffinityMap;
  company: AffinityMap;
  skill: AffinityMap;
  /** Normalized title → weight, written by "Not interested: wrong title" only. Absent in a state built before the map existed. */
  title?: AffinityMap;
  updatedAt: Date | null;
}

export const AFFINITY_DECAY_PER_DAY = 0.98;
export const AFFINITY_DELTAS = { save: 0.1, apply_click: 0.15, applied: 0.25, hide: -0.1, wrong_title: WRONG_TITLE_WEIGHT } as const;
export type AffinityEvent = keyof typeof AFFINITY_DELTAS;
/** Events that speak about the title only: the role and the title key move, the company and the skills do not. */
const TITLE_ONLY_EVENTS: ReadonlySet<AffinityEvent> = new Set(['wrong_title']);
/** Weights smaller than this are dropped; each map keeps at most this many keys. */
const MIN_WEIGHT = 0.01;
const MAX_KEYS = 200;
const DAY_MS = 86_400_000;

export const EMPTY_AFFINITY: AffinityState = { taxonomy: {}, company: {}, skill: {}, title: {}, updatedAt: null };

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
  return { taxonomy: scaleMap(state.taxonomy, k), company: scaleMap(state.company, k), skill: scaleMap(state.skill, k), title: scaleMap(state.title ?? {}, k), updatedAt: now };
}

export interface AffinityKeys {
  taxonomy: string | null;
  company: string | null;
  skills: string[];
  /** The job's normalized title (the key of the title map); null when the job has none. */
  title?: string | null;
}

/** What `affinityKeys` reads of a job (a feed row, or the row of a hide / save action). */
export interface AffinityJob {
  primaryTaxonomyId: string | null;
  taxonomyIds: string[] | null;
  companyNameNormalized: string | null;
  skills: string[] | null;
  /** RASkill ids of the posting's skills, required ones first (RAJob.skillIds). */
  skillIds?: string[] | null;
  titleNormalized?: string | null;
}

/**
 * Keys a job contributes: role id (L3, else the deepest listed), company key,
 * its first three skills (canonical ids when the job has them, else the first
 * three strings), and its normalized title.
 */
export function affinityKeys(job: AffinityJob): AffinityKeys {
  const tax = job.primaryTaxonomyId ?? (job.taxonomyIds?.length ? job.taxonomyIds[job.taxonomyIds.length - 1] : null) ?? null;
  const ids = (job.skillIds ?? []).filter((id) => typeof id === 'string' && id.trim());
  return {
    taxonomy: tax,
    company: job.companyNameNormalized || null,
    skills: ids.length ? ids.slice(0, 3) : (job.skills ?? []).slice(0, 3).map((s) => s.toLowerCase()),
    title: job.titleNormalized?.trim() || null,
  };
}

/**
 * Decay to `now`, then add `delta` to each key (clamped to −1..1). `event`
 * names what happened when it changes which keys move: "wrong title" moves the
 * role and the title only; every other event moves the role, the company and
 * the skills, and never the title.
 */
export function applyAffinity(state: AffinityState, keys: AffinityKeys, delta: number, now: Date, event?: AffinityEvent): AffinityState {
  const next = decayed(state, now);
  const title = next.title ?? {};
  const bump = (map: AffinityMap, key: string | null | undefined) => {
    if (!key) return;
    map[key] = clamp((map[key] ?? 0) + delta);
  };
  bump(next.taxonomy, keys.taxonomy);
  if (event && TITLE_ONLY_EVENTS.has(event)) {
    // The title map holds negatives only: a delta that is not one writes nothing there.
    if (delta < 0) bump(title, keys.title);
  } else {
    bump(next.company, keys.company);
    for (const s of keys.skills) bump(next.skill, s);
  }
  return { taxonomy: prune(next.taxonomy), company: prune(next.company), skill: prune(next.skill), title: prune(title), updatedAt: now };
}

/**
 * The affinity factor of one job, 0–100 (50 = neutral): the mean of the role
 * weight, the company weight (a preferred company counts at least +0.5) and
 * the mean of its skill weights. A NEGATIVE weight on the job's title joins
 * that mean as a fourth part; a title with no weight, or a positive one,
 * leaves the mean of three as it is (a title is never boosted by this map).
 */
export function affinityScore(state: AffinityState, keys: AffinityKeys, preferredCompanyKeys: ReadonlySet<string> = new Set()): number {
  const role = keys.taxonomy ? (state.taxonomy[keys.taxonomy] ?? 0) : 0;
  let company = keys.company ? (state.company[keys.company] ?? 0) : 0;
  if (keys.company && preferredCompanyKeys.has(keys.company)) company = Math.max(company, 0.5);
  const skillWeights = keys.skills.map((s) => state.skill[s] ?? 0);
  const skill = skillWeights.length ? skillWeights.reduce((a, b) => a + b, 0) / skillWeights.length : 0;
  const title = keys.title ? (state.title?.[keys.title] ?? 0) : 0;
  const ofThree = (role + company + skill) / 3;
  // Never above the mean of three: a title weight smaller than the other parts must not pull a low score up.
  const mean = title < 0 ? Math.min(ofThree, (role + company + skill + title) / 4) : ofThree;
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
