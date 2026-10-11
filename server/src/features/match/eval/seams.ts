// server/src/features/match/eval/seams.ts
//
// How the harness reaches the code under test. The invariants are written
// against the TARGET contract (MARKET_STRATEGY.md 2.2; MARKET_TASK_PLAN.md
// "Cross-bundle contracts"), and part of that contract does not exist when
// they are written. So nothing under test is imported statically: a seam is a
// repository path and an export name, loaded at run time through a variable
// specifier (the compiler does not resolve it, so this file type-checks before
// the module exists).
//
//   loadSeam('server/src/features/match/fit.ts#getFits')
//
// A module or export that is absent throws `SeamMissing` with that same
// string. A missing seam is a FAILING invariant, never a skipped one: the
// report names what has to be built.
//
// The shapes below are the harness's own structural view of the contract. A
// field the contract promises and a module does not return is caught by the
// invariant that reads it, by name.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
/** eval → match → features → src → server → repository root. */
export const REPO_ROOT = path.resolve(EVAL_DIR, '../../../../..');

export class SeamMissing extends Error {
  /** `<repository path>#<export>` */
  readonly seam: string;
  constructor(seam: string, detail?: string) {
    super(`SeamMissing: ${seam}${detail ? ` (${detail})` : ''}`);
    this.name = 'SeamMissing';
    this.seam = seam;
  }
}

export function isSeamMissing(err: unknown): err is SeamMissing {
  return err instanceof SeamMissing || (!!err && typeof err === 'object' && (err as { name?: unknown }).name === 'SeamMissing');
}

/** Every seam the invariants and the shipped suites read, in one place. */
export const SEAMS = {
  // The fit contract (built by MKT-1F).
  getFit: 'server/src/features/match/fit.ts#getFit',
  getFits: 'server/src/features/match/fit.ts#getFits',
  getVariantFit: 'server/src/features/match/fit.ts#getVariantFit',
  createMatchService: 'server/src/features/match/MatchService.ts#createMatchService',
  createScorePrecompute: 'server/src/features/match/cron.ts#createScorePrecompute',
  locationCheck: 'server/src/features/match/preScore.ts#locationCheck',
  buildKeywordRows: 'server/src/features/match/keywordRows.ts#buildKeywordRows',
  // Ranking input on one scale (MKT-1F).
  fitForRank: 'server/src/features/feed/ranking.ts#fitForRank',
  recommendedRank: 'server/src/features/feed/ranking.ts#recommendedRank',
  annualPay: 'server/src/features/feed/ranking.ts#annualPay',
  sortCandidates: 'server/src/features/feed/ranking.ts#sortCandidates',
  isCountryWideLocation: 'server/src/features/feed/sql.ts#isCountryWideLocation',
  predicateFor: 'server/src/features/feed/sql.ts#predicateFor',
  createFeedQueryService: 'server/src/features/feed/FeedQueryService.ts#createFeedQueryService',
  FakeFeedRepo: 'server/src/features/feed/testkit.ts#FakeFeedRepo',
  feedRow: 'server/src/features/feed/testkit.ts#feedRow',
  // Taxonomy (MKT-1E) and data quality.
  matchTitle: 'server/src/features/jobs/taxonomy/index.ts#matchTitle',
  taxonomyAncestors: 'server/src/features/jobs/taxonomy/index.ts#taxonomyAncestors',
  payPlausible: 'server/src/features/jobs/normalize/index.ts#payPlausible',
  foldTwToCn: 'server/src/features/jobs/normalize/index.ts#foldTwToCn',
  // Brand registry (read, never under test).
  getBrand: 'server/src/platform/brand/registry.ts#getBrand',
  // Embeddings client test seam (built by MKT-2H; optional until then).
  setEmbeddingsClientForTests: 'server/src/platform/embeddings/client.ts#setEmbeddingsClientForTests',
} as const;

export type SeamName = keyof typeof SEAMS;

function splitSpec(spec: string): { file: string; name: string } {
  const at = spec.lastIndexOf('#');
  if (at <= 0 || at === spec.length - 1) throw new Error(`seam spec must be "<repository path>#<export>": ${spec}`);
  return { file: spec.slice(0, at), name: spec.slice(at + 1) };
}

const moduleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Import a module by repository path. `SeamMissing` when the file is absent. */
export async function loadModule(file: string, root: string = REPO_ROOT): Promise<Record<string, unknown>> {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  if (!existsSync(abs)) throw new SeamMissing(file);
  let pending = moduleCache.get(abs);
  if (!pending) {
    // A variable specifier: resolved at run time only.
    const specifier = pathToFileURL(abs).href;
    pending = import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
    moduleCache.set(abs, pending);
    pending.catch(() => moduleCache.delete(abs));
  }
  return pending;
}

/** Load one export. `SeamMissing(spec)` when the module or the export is absent. */
export async function loadSeam<T = unknown>(spec: string, root: string = REPO_ROOT): Promise<T> {
  const { file, name } = splitSpec(spec);
  let mod: Record<string, unknown>;
  try {
    mod = await loadModule(file, root);
  } catch (err) {
    if (isSeamMissing(err)) throw new SeamMissing(spec);
    throw err;
  }
  const value = mod[name];
  if (value === undefined) throw new SeamMissing(spec);
  return value as T;
}

/** A seam that may not exist yet: null instead of `SeamMissing`. Other load errors still throw. */
export async function optionalSeam<T = unknown>(spec: string, root: string = REPO_ROOT): Promise<T | null> {
  try {
    return await loadSeam<T>(spec, root);
  } catch (err) {
    if (isSeamMissing(err)) return null;
    throw err;
  }
}

/** Does the seam exist? (No throw.) */
export async function seamExists(spec: string, root: string = REPO_ROOT): Promise<boolean> {
  return (await optionalSeam(spec, root)) !== null;
}

// ── The fit contract, as the harness reads it ─────────────────────────────

export interface FitDimensionLike {
  key: string;
  weight: number;
  score: number | null;
  status: string;
  evidence: Array<{ text: string; source: string; ref?: string }>;
}

/** `Fit` of MARKET_TASK_PLAN.md ("The fit contract"). Fields the harness reads; anything else passes through. */
export interface FitLike {
  jobId: string;
  score: number | null;
  tier: string | null;
  /** 'ai' | 'estimate' ('pre' is the wire spelling of an estimate). */
  kind: string;
  coverage?: number;
  confidence?: string;
  confidenceReason?: string | null;
  dimensions: FitDimensionLike[];
  requirements?: unknown[];
  topOverlap?: string | null;
  topGap?: string | null;
  basis?: Record<string, unknown>;
  version?: Record<string, unknown>;
  scoredAt?: string;
  stale?: boolean;
  [key: string]: unknown;
}

export interface FitApi {
  getFit(userId: string, jobId: string, opts?: Record<string, unknown>): Promise<FitLike>;
  /** Never a model call. Normalised to a map by job id whatever the module returns (Map, array or record). */
  getFits(userId: string, jobIds: string[]): Promise<Map<string, FitLike>>;
  getVariantFit: ((userId: string, jobId: string, variantId: string) => Promise<FitLike>) | null;
  /** How the functions were bound to the fakes (for a failure message). */
  boundBy: string;
  /**
   * The bound functions exactly as the module returns them (no normalising),
   * for wiring into another service: the feed takes `getFits` as a dependency.
   */
  raw: { getFit: (...args: unknown[]) => unknown; getFits: (...args: unknown[]) => unknown };
}

/** 'pre' and 'estimate' are one kind (the wire keeps 'pre' so published clients keep working). */
export function fitKind(kind: unknown): 'ai' | 'estimate' | 'unknown' {
  if (kind === 'ai') return 'ai';
  if (kind === 'estimate' || kind === 'pre') return 'estimate';
  return 'unknown';
}

/** What every surface must agree on (invariant I1). */
export interface SeamFit {
  score: number | null;
  tier: string | null;
  kind: 'ai' | 'estimate' | 'unknown';
}

export function toSeamFit(v: { score?: unknown; tier?: unknown; kind?: unknown } | null | undefined): SeamFit {
  return {
    score: typeof v?.score === 'number' && Number.isFinite(v.score) ? v.score : null,
    tier: typeof v?.tier === 'string' ? v.tier : null,
    kind: fitKind(v?.kind),
  };
}

function fitsToMap(raw: unknown): Map<string, FitLike> {
  const out = new Map<string, FitLike>();
  const put = (f: unknown, key?: string) => {
    if (!f || typeof f !== 'object') return;
    const id = typeof (f as FitLike).jobId === 'string' ? (f as FitLike).jobId : key;
    if (id) out.set(id, f as FitLike);
  };
  if (raw instanceof Map) for (const [k, v] of raw) put(v, String(k));
  else if (Array.isArray(raw)) for (const v of raw) put(v);
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) put(v, k);
  return out;
}

type AnyFn = (...args: unknown[]) => unknown;
const isFn = (v: unknown): v is AnyFn => typeof v === 'function';
const hasFits = (v: unknown): v is { getFit: AnyFn; getFits: AnyFn; getVariantFit?: AnyFn } =>
  !!v && typeof v === 'object' && isFn((v as { getFits?: unknown }).getFits) && isFn((v as { getFit?: unknown }).getFit);

const FIT_MODULE = 'server/src/features/match/fit.ts';

let fitModuleOverride: string | null = null;

/**
 * Test seam of the harness itself: read the fit functions from another module
 * (an absolute path) instead of features/match/fit.ts. Used by the harness's
 * own tests to prove the binding and the suites with a stand-in. `null`
 * restores the real module. run.ts never calls it.
 */
export function setFitModuleForTests(absolutePath: string | null): void {
  fitModuleOverride = absolutePath;
}

/** The module the fit functions are read from right now (the real one unless a test set another). */
export function fitModuleInUse(): string {
  return fitModuleOverride ?? FIT_MODULE;
}

/**
 * `getFit` / `getFits` / `getVariantFit` bound to the given in-memory
 * dependencies (a `MatchServiceDeps`: repo, scorer, aiAllowed, brand, now …).
 *
 * The contract fixes the three function signatures, not how they are wired to
 * a repository, so the harness accepts either of the two usual shapes:
 *   1. a factory exported by fit.ts (`createFitService(deps)`, or any export
 *      named create…Fit… / make…Fit… / build…Fit…) that takes the match
 *      dependencies, a MatchService, or `{ service }`;
 *   2. the three functions as methods of the object `createMatchService(deps)`
 *      returns.
 * With neither, the seam is missing: functions bound only to the production
 * repository cannot be checked without a database.
 */
export async function loadFitApi(deps: Record<string, unknown>): Promise<FitApi> {
  const fitModule = fitModuleOverride ?? FIT_MODULE;
  const mod = await loadModule(fitModule).catch((err) => {
    if (isSeamMissing(err)) throw new SeamMissing(SEAMS.getFits);
    throw err;
  });
  for (const name of ['getFits', 'getFit'] as const) if (!isFn(mod[name])) throw new SeamMissing(`${FIT_MODULE}#${name}`);

  const createMatchService = await loadSeam<(d: Record<string, unknown>) => Record<string, unknown>>(SEAMS.createMatchService);
  const service = createMatchService(deps);
  // One argument that reads as the dependencies, as a MatchService and as `{ service }` (the key sets do not overlap).
  const hybrid: Record<string, unknown> = { ...service, ...deps, service, match: service, matchService: service, deps };

  let bound: { getFit: AnyFn; getFits: AnyFn; getVariantFit?: AnyFn } | null = null;
  let boundBy = '';
  const factories = Object.keys(mod)
    .filter((n) => isFn(mod[n]) && /^(create|make|build)\w*Fit\w*$/.test(n))
    .sort((a, b) => Number(b === 'createFitService') - Number(a === 'createFitService') || a.localeCompare(b));
  for (const name of factories) {
    try {
      const made = await (mod[name] as AnyFn)(hybrid, hybrid);
      if (hasFits(made)) {
        bound = made;
        boundBy = `${FIT_MODULE}#${name}`;
        break;
      }
    } catch {
      // Not a factory of the fit functions: try the next shape.
    }
  }
  if (!bound && hasFits(service)) {
    bound = service;
    boundBy = `${SEAMS.createMatchService}().getFits`;
  }
  if (!bound) {
    throw new SeamMissing(
      `${FIT_MODULE}#createFitService`,
      'getFit and getFits exist but cannot be bound to in-memory fakes: export createFitService(deps: MatchServiceDeps) returning { getFit, getFits, getVariantFit }, or put the three on the object createMatchService(deps) returns',
    );
  }
  const b = bound;
  return {
    boundBy,
    raw: { getFit: (...args) => b.getFit(...args), getFits: (...args) => b.getFits(...args) },
    getFit: async (userId, jobId, opts) => (await b.getFit(userId, jobId, opts)) as FitLike,
    getFits: async (userId, jobIds) => fitsToMap(await b.getFits(userId, jobIds)),
    getVariantFit: isFn(b.getVariantFit) ? async (userId, jobId, variantId) => (await b.getVariantFit!(userId, jobId, variantId)) as FitLike : null,
  };
}
