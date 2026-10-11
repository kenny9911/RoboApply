// server/src/features/match/calibration.ts — the estimate on the AI scale
// (MARKET_STRATEGY 2.4; SM-3, SM-4).
//
// Two things are learned per market from the (estimate, AI) pairs the scorer
// leaves behind (every AI row of a primary resume stores the v2 estimate it
// was scored next to, `explanation.estimateAtScore`):
//
//   1. A monotone map from the estimate to the AI score: isotonic regression
//      (pool adjacent violators) reduced to at most 21 knots, read as a
//      piecewise-linear function. Used only once the market has
//      MATCH_CALIBRATION_MIN_PAIRS pairs (500); until then the feed ranks on
//      the blend of feed/ranking.ts `fitForRank`. Recomputed weekly.
//   2. Priors: the mean of each AI component over the last 90 days, which
//      replace the starting priors of a not-stated component. Used only from
//      200 scored values of that component (never a prior from a handful of
//      rows). Recomputed monthly.
//
// Storage: one AppConfig row, key `match.calibration.v1`, value
// `{ [market]: { map | null, priors | null, pairs, computedAt, priorsPairs,
// priorsComputedAt } }`, read through the MatchRepo with a 10-minute
// in-process cache. A missing or malformed value means no map and the starting
// priors; nothing here throws into a fit.
//
// Refresh: `refreshCalibrationIfDue` runs as the second step of the existing
// score-precompute cron (cron.ts), for the cron's brand market. No model call,
// no new cron entry.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { CALIBRATION_PRIORS_MIN_PAIRS, calibrationMinPairs } from './config.js';
import { MATCH_DIMENSION_KEYS, type MatchDimensionKey, type MatchPriors } from './contract.js';
import type { CalibrationPair } from './repo.js';

export const CALIBRATION_CONFIG_KEY = 'match.calibration.v1';
/** Knots a stored map keeps at most. */
export const CALIBRATION_MAX_KNOTS = 21;
/** The map is recomputed when it is older than this. */
export const CALIBRATION_MAP_MAX_AGE_DAYS = 7;
/** The priors are recomputed when they are older than this. */
export const CALIBRATION_PRIORS_MAX_AGE_DAYS = 30;
/** Priors are the mean over this many days of AI scores. */
export const CALIBRATION_PRIORS_WINDOW_DAYS = 90;
/** Newest pairs read per refresh. */
export const CALIBRATION_PAIR_LIMIT = 5000;
export const CALIBRATION_CACHE_TTL_MS = 10 * 60_000;

const DAY_MS = 86_400_000;

/** A monotone, piecewise-linear map: knots `[estimate, ai]` with estimate strictly ascending and ai non-decreasing. */
export interface CalibrationMap {
  knots: Array<[number, number]>;
}

/** What is stored for one market. */
export interface MarketCalibration {
  /** Null when the market had fewer pairs than the minimum at the last refresh. */
  map: CalibrationMap | null;
  /** Data-derived priors for the components with enough scored values; null when none had. */
  priors: Partial<MatchPriors> | null;
  /** Pairs the map was computed from (all it had, up to the read limit). */
  pairs: number;
  /** When the map was last computed (ISO). */
  computedAt: string;
  /** Pairs of the last 90 days the priors were computed from. */
  priorsPairs: number;
  /** When the priors were last computed (ISO). */
  priorsComputedAt: string;
}

export type CalibrationDoc = Partial<Record<Market, MarketCalibration>>;

/** What a fit reads: the map when the market may use one, and the priors its data supports. */
export interface ActiveCalibration {
  map: CalibrationMap | null;
  priors: Partial<MatchPriors> | null;
}

export const NO_CALIBRATION: ActiveCalibration = Object.freeze({ map: null, priors: null });

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── Isotonic regression ───────────────────────────────────────────────────

interface Block {
  /** Mean estimate and mean AI of the pooled points, and how many. */
  x: number;
  y: number;
  n: number;
}

/**
 * Pool-adjacent-violators over the pairs sorted by estimate: the monotone
 * (non-decreasing) step function closest to the AI scores in squared error,
 * returned as at most `maxKnots` knots (neighbouring blocks are merged, lightest
 * first, until it fits). An input that is already monotone comes back as it is
 * (one knot per distinct estimate). Null for no usable pair.
 */
export function fitIsotonic(pairs: ReadonlyArray<{ estimate: number; ai: number }>, maxKnots: number = CALIBRATION_MAX_KNOTS): CalibrationMap | null {
  const points = pairs.filter((p) => finite(p.estimate) && finite(p.ai)).map((p) => ({ x: clamp(p.estimate), y: clamp(p.ai) }));
  if (!points.length) return null;
  points.sort((a, b) => a.x - b.x || a.y - b.y);

  // Equal estimates are one point (their mean AI): a map has one value per estimate.
  const blocks: Block[] = [];
  for (const p of points) {
    const last = blocks[blocks.length - 1];
    if (last && last.x === p.x) {
      last.y = (last.y * last.n + p.y) / (last.n + 1);
      last.n += 1;
    } else {
      blocks.push({ x: p.x, y: p.y, n: 1 });
    }
  }

  // PAV: merge a block into its left neighbour while it sits below it.
  const pooled: Block[] = [];
  for (const b of blocks) {
    pooled.push({ ...b });
    while (pooled.length > 1 && pooled[pooled.length - 2]!.y > pooled[pooled.length - 1]!.y) {
      const right = pooled.pop()!;
      const left = pooled.pop()!;
      pooled.push(merge(left, right));
    }
  }

  // At most `maxKnots`: merge the neighbouring pair with the fewest points (monotonicity is kept: a weighted mean lies between its parts).
  const limit = Math.max(2, Math.floor(maxKnots));
  while (pooled.length > limit) {
    let at = 0;
    let fewest = Infinity;
    for (let i = 0; i < pooled.length - 1; i++) {
      const n = pooled[i]!.n + pooled[i + 1]!.n;
      if (n < fewest) {
        fewest = n;
        at = i;
      }
    }
    pooled.splice(at, 2, merge(pooled[at]!, pooled[at + 1]!));
  }
  return { knots: pooled.map((b) => [round2(b.x), round2(b.y)]) };
}

function merge(a: Block, b: Block): Block {
  const n = a.n + b.n;
  return { x: (a.x * a.n + b.x * b.n) / n, y: (a.y * a.n + b.y * b.n) / n, n };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A stored value read back as a map; null unless it is a well-formed monotone knot list. */
export function parseCalibrationMap(v: unknown): CalibrationMap | null {
  if (!v || typeof v !== 'object' || !Array.isArray((v as { knots?: unknown }).knots)) return null;
  const knots: Array<[number, number]> = [];
  for (const k of (v as { knots: unknown[] }).knots) {
    if (!Array.isArray(k) || k.length !== 2 || !finite(k[0]) || !finite(k[1])) return null;
    if (k[0] < 0 || k[0] > 100 || k[1] < 0 || k[1] > 100) return null;
    const prev = knots[knots.length - 1];
    if (prev && (k[0] <= prev[0] || k[1] < prev[1])) return null;
    knots.push([k[0], k[1]]);
  }
  return knots.length ? { knots } : null;
}

/**
 * The map at `x`: linear between knots, flat beyond the first and the last
 * (never extrapolated). Monotone in `x`, always within 0–100.
 */
export function applyMap(map: CalibrationMap, x: number): number {
  const knots = map.knots;
  if (!knots.length || !Number.isFinite(x)) return clamp(x);
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (x <= first[0]) return clamp(first[1]);
  if (x >= last[0]) return clamp(last[1]);
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!;
    if (x > x1) continue;
    const [x0, y0] = knots[i - 1]!;
    return clamp(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  return clamp(last[1]);
}

// ── Priors from data ──────────────────────────────────────────────────────

/**
 * The components whose prior may come from data: the four the scorer judges.
 * Logistics is not one of them. In an AI row it is not a model judgement but
 * the deterministic 100 × met / stated, and it is mostly 100 because the
 * person's own filters removed the jobs that fail; its mean would hand back
 * the free logistics points the estimate's rule removes (MARKET_STRATEGY 2.4).
 * The logistics prior stays the configured one (`MATCH_PRIORS`).
 */
export const DATA_PRIOR_KEYS: readonly MatchDimensionKey[] = MATCH_DIMENSION_KEYS.filter((k) => k !== 'logistics');

/**
 * The mean of each AI component over `pairs`, for the components the AI
 * scored at least `minValues` times; the others are left out (the starting
 * prior stays). Never logistics (`DATA_PRIOR_KEYS`). Rounded to one decimal.
 */
export function estimatePriors(pairs: ReadonlyArray<Pick<CalibrationPair, 'components'>>, minValues: number = CALIBRATION_PRIORS_MIN_PAIRS): Partial<MatchPriors> {
  const out: Partial<MatchPriors> = {};
  for (const key of DATA_PRIOR_KEYS) {
    let sum = 0;
    let n = 0;
    for (const p of pairs) {
      const v = p.components[key];
      if (!finite(v)) continue;
      sum += clamp(v);
      n += 1;
    }
    if (n >= minValues && n > 0) out[key] = Math.round((sum / n) * 10) / 10;
  }
  return out;
}

function parsePriors(v: unknown): Partial<MatchPriors> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Partial<MatchPriors> = {};
  for (const key of MATCH_DIMENSION_KEYS) {
    const n = (v as Record<string, unknown>)[key];
    if (n === undefined) continue;
    if (!finite(n) || n < 0 || n > 100) return null;
    out[key as MatchDimensionKey] = n;
  }
  return Object.keys(out).length ? out : null;
}

// ── Storage ───────────────────────────────────────────────────────────────

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const count = (v: unknown): number => (finite(v) && v >= 0 ? Math.floor(v) : 0);

function parseMarket(v: unknown): MarketCalibration | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const computedAt = isoOrNull(o.computedAt);
  if (!computedAt) return null;
  return {
    map: parseCalibrationMap(o.map),
    priors: parsePriors(o.priors),
    pairs: count(o.pairs),
    computedAt,
    priorsPairs: count(o.priorsPairs),
    // A document written before the priors had their own date: due at once.
    priorsComputedAt: isoOrNull(o.priorsComputedAt) ?? new Date(0).toISOString(),
  };
}

/** The stored document; `{}` for a missing or malformed value (never throws). */
export function parseCalibrationDoc(raw: string | null | undefined): CalibrationDoc {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: CalibrationDoc = {};
  for (const market of ['intl', 'cn'] as const) {
    const entry = parseMarket((parsed as Record<string, unknown>)[market]);
    if (entry) out[market] = entry;
  }
  return out;
}

/**
 * What a fit may use of a market's stored entry: the map only from
 * `minPairs` pairs, the priors as stored (they were written only for
 * components with enough values).
 */
export function activeCalibration(entry: MarketCalibration | null | undefined, minPairs: number): ActiveCalibration {
  if (!entry) return NO_CALIBRATION;
  return { map: entry.map && entry.pairs >= minPairs ? entry.map : null, priors: entry.priors };
}

/**
 * The starting (or configured) priors with the market's data-derived ones
 * over them. The logistics prior is always the configured one: a stored
 * document that carries a logistics value is not read for it.
 */
export function withCalibratedPriors(starting: MatchPriors, calibrated: Partial<MatchPriors> | null | undefined): MatchPriors {
  if (!calibrated) return starting;
  const out = { ...starting };
  for (const key of DATA_PRIOR_KEYS) {
    const value = calibrated[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ── The calibration service ───────────────────────────────────────────────

/** The two reads and the one write calibration needs (the MatchRepo has them). */
export interface CalibrationStore {
  getConfigValue(key: string): Promise<string | null>;
  setConfigValue(key: string, value: string): Promise<void>;
  listCalibrationPairs(input: { market: Market; since: Date; limit: number }): Promise<CalibrationPair[]>;
}

export interface CalibrationDeps {
  store: CalibrationStore;
  env?: EnvSource;
  now?: () => Date;
  cacheTtlMs?: number;
}

export interface CalibrationRefreshResult {
  /** `not_due`: both parts are young enough; nothing was read beyond the stored document. */
  skipped?: 'not_due';
  /** The map was recomputed in this run. */
  map?: 'stored' | 'too_few_pairs';
  /** The priors were recomputed in this run. */
  priors?: 'stored' | 'too_few_pairs';
  pairs?: number;
  priorsPairs?: number;
}

export interface Calibration {
  /** The pairs of a market since `since`, newest first (numbers only). */
  pairsFor(market: Market, since: Date): Promise<CalibrationPair[]>;
  /** What fits of this market use now. Never throws: an unreadable document is "no calibration". */
  forMarket(market: Market): Promise<ActiveCalibration>;
  /** Recompute the map (older than 7 days) and the priors (older than 30 days) of one market; a younger entry is left alone. */
  refreshIfDue(market: Market, now?: Date): Promise<CalibrationRefreshResult>;
  /** Drop the in-process copy (tests; after a refresh it is replaced, not dropped). */
  clearCache(): void;
}

export function createCalibration(deps: CalibrationDeps): Calibration {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.cacheTtlMs ?? CALIBRATION_CACHE_TTL_MS;
  let cache: { at: number; doc: CalibrationDoc } | null = null;

  async function readDoc(fresh = false): Promise<CalibrationDoc> {
    const t = now().getTime();
    if (!fresh && cache && t - cache.at < ttl) return cache.doc;
    const doc = parseCalibrationDoc(await deps.store.getConfigValue(CALIBRATION_CONFIG_KEY));
    cache = { at: t, doc };
    return doc;
  }

  const pairsFor = (market: Market, since: Date) => deps.store.listCalibrationPairs({ market, since, limit: CALIBRATION_PAIR_LIMIT });

  return {
    pairsFor,

    async forMarket(market) {
      try {
        return activeCalibration((await readDoc())[market], calibrationMinPairs(deps.env));
      } catch (err) {
        logger.warn('MATCH_CALIBRATION', 'calibration unavailable; using the starting priors and no map', { error: err instanceof Error ? err.message : String(err) });
        // Do not ask again on every fit while the store is down.
        cache = { at: now().getTime(), doc: {} };
        return NO_CALIBRATION;
      }
    },

    async refreshIfDue(market, at = now()) {
      const stored = (await readDoc(true))[market] ?? null;
      const age = (iso: string | undefined) => (iso ? at.getTime() - Date.parse(iso) : Infinity);
      const mapDue = age(stored?.computedAt) > CALIBRATION_MAP_MAX_AGE_DAYS * DAY_MS;
      const priorsDue = age(stored?.priorsComputedAt) > CALIBRATION_PRIORS_MAX_AGE_DAYS * DAY_MS;
      if (!mapDue && !priorsDue) return { skipped: 'not_due' };

      const result: CalibrationRefreshResult = {};
      const next: MarketCalibration = stored
        ? { ...stored }
        : { map: null, priors: null, pairs: 0, computedAt: at.toISOString(), priorsPairs: 0, priorsComputedAt: at.toISOString() };

      if (mapDue) {
        const pairs = await pairsFor(market, new Date(0));
        const enough = pairs.length >= calibrationMinPairs(deps.env);
        // Under the minimum no map is stored: ranking keeps the blend.
        next.map = enough ? fitIsotonic(pairs) : null;
        next.pairs = pairs.length;
        next.computedAt = at.toISOString();
        result.map = enough && next.map ? 'stored' : 'too_few_pairs';
        result.pairs = pairs.length;
      }
      if (priorsDue) {
        const recent = await pairsFor(market, new Date(at.getTime() - CALIBRATION_PRIORS_WINDOW_DAYS * DAY_MS));
        const priors = estimatePriors(recent);
        next.priors = Object.keys(priors).length ? priors : null;
        next.priorsPairs = recent.length;
        next.priorsComputedAt = at.toISOString();
        result.priors = next.priors ? 'stored' : 'too_few_pairs';
        result.priorsPairs = recent.length;
      }

      // Read again right before the write: the other brand's run may have stored its market meanwhile.
      const doc = parseCalibrationDoc(await deps.store.getConfigValue(CALIBRATION_CONFIG_KEY));
      doc[market] = next;
      await deps.store.setConfigValue(CALIBRATION_CONFIG_KEY, JSON.stringify(doc));
      cache = { at: now().getTime(), doc };
      return result;
    },

    clearCache() {
      cache = null;
    },
  };
}

/** One calibration per store, so every service built on the same repo shares one cached document. */
const byStore = new WeakMap<CalibrationStore, Calibration>();

export function calibrationFor(store: CalibrationStore, opts: { env?: EnvSource; now?: () => Date } = {}): Calibration {
  let c = byStore.get(store);
  if (!c) {
    c = createCalibration({ store, env: opts.env, now: opts.now });
    byStore.set(store, c);
  }
  return c;
}
