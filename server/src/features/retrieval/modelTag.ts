// server/src/features/retrieval/modelTag.ts
//
// Which embedding model a market's vectors belong to (MKT-2H item 5).
//
// Two tags per market:
//   - the WRITE tag: `<model>@1024` of the brand's embedding settings
//     (`resolveEmbeddingConfig`). New vectors are always written with it.
//   - the QUERY tag: the tag every vector comparison filters on, stored in
//     `AppConfig` key `retrieval.modelTag.<market>`. `currentModelTag` answers it.
//
// They differ only while a market moves to another model. `RAJobEmbedding`
// holds ONE row per job, so every job the sweep re-embeds leaves the previous
// model: during a change the two models share the market's rows between them.
// Queries filter on whichever tag covers more live rows, so the query tag
// moves at the crossover (the new model covers at least as many live rows as
// the previous one). The dense leg is therefore never empty during a change,
// but it thins: it covers the whole market before, about HALF of it at the
// crossover, and the whole market again when the re-embedding is done. A job
// without a vector of the query tag is still found by the lexical leg.
// Keeping both models' vectors side by side would need a key of
// (jobId, model) on the table (a schema change; see the handoff).
// Vectors of two models are never compared.

import { resolveEmbeddingConfig } from '../../platform/embeddings/index.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { defaultRetrievalRepo, type RetrievalRepo } from './repo.js';

/**
 * The share of a market's vectors (live rows that carry the previous or the
 * new tag) the new model must hold before queries switch to it. 0.5 is the
 * crossover: queries always filter on the tag with more rows, so the dense leg
 * never covers less than half of the embedded rows during a change.
 *
 * MARKET_TASK_PLAN names "dense-leg model switch at 90% coverage" as a choice
 * the owner may overrule. With one row per job 0.9 would keep queries on the
 * previous model while it holds only about 10% of the rows, so the default
 * here is the crossover; 0.9 becomes right again when the table keeps both
 * models' vectors (a key of (jobId, model)).
 */
export const MODEL_SWITCH_SHARE = 0.5;
/** How long a read of the stored query tag is reused in this process. */
const QUERY_TAG_TTL_MS = 60_000;

export const modelTagConfigKey = (market: string): string => `retrieval.modelTag.${market}`;

/** The brand whose market this is ('cn' → goapply, else roboapply). */
export function brandOfMarket(market: string): BrandId {
  return market === 'cn' ? 'goapply' : 'roboapply';
}

/** The tag new vectors of the market are written with; null when no embedding key is set. */
export function writeModelTag(market: string, env: EnvSource = process.env): string | null {
  return resolveEmbeddingConfig(brandOfMarket(market), env).modelTag;
}

const cache = new Map<string, { tag: string | null; at: number }>();

/** Tests only. */
export function resetModelTagCacheForTests(): void {
  cache.clear();
}

export interface ModelTagDeps {
  repo?: Pick<RetrievalRepo, 'getConfig'>;
  env?: EnvSource;
  now?: () => number;
}

/**
 * The model tag queries of the market must filter on: the stored query tag,
 * else (nothing stored yet) the write tag. Null when the market has neither,
 * which means it has no vectors to compare.
 */
export async function currentModelTag(market: string, deps: ModelTagDeps = {}): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  const useCache = !deps.repo && !deps.env;
  const hit = useCache ? cache.get(market) : undefined;
  if (hit && now - hit.at < QUERY_TAG_TTL_MS) return hit.tag;
  let stored: string | null = null;
  try {
    stored = (await (deps.repo ?? defaultRetrievalRepo).getConfig(modelTagConfigKey(market)))?.trim() || null;
  } catch {
    stored = null;
  }
  const tag = stored ?? writeModelTag(market, deps.env);
  if (useCache) cache.set(market, { tag, at: now });
  return tag;
}

export interface ModelTagState {
  writeTag: string | null;
  queryTag: string | null;
  /**
   * Share of live public rows whose vector carries the write tag. Measured
   * only while the two tags differ (the switch decision needs it); null otherwise.
   */
  coverage: number | null;
  /** Share of live public rows whose vector still carries the stored (previous) tag; null like `coverage`. */
  previousCoverage: number | null;
  /** True when this call moved the query tag to the write tag. */
  switched: boolean;
}

/**
 * Bring the stored query tag in line (called by the sweep): with nothing
 * stored the write tag becomes the query tag at once (there is no older model
 * to keep serving); otherwise it moves when the write tag holds at least
 * `MODEL_SWITCH_SHARE` of the rows that carry either tag (the crossover; see
 * the header: one row per job).
 */
export async function reconcileModelTag(market: string, deps: { repo: Pick<RetrievalRepo, 'getConfig' | 'setConfig' | 'indexStats'>; env?: EnvSource }): Promise<ModelTagState> {
  const writeTag = writeModelTag(market, deps.env);
  const stored = (await deps.repo.getConfig(modelTagConfigKey(market)))?.trim() || null;
  if (!writeTag) return { writeTag: null, queryTag: stored, coverage: null, previousCoverage: null, switched: false };
  // The usual case, every 15 minutes: nothing to decide and nothing to count.
  if (stored === writeTag) return { writeTag, queryTag: stored, coverage: null, previousCoverage: null, switched: false };
  if (stored === null) {
    await deps.repo.setConfig(modelTagConfigKey(market), writeTag);
    cache.delete(market);
    return { writeTag, queryTag: writeTag, coverage: null, previousCoverage: null, switched: true };
  }
  const next = await deps.repo.indexStats(market, writeTag);
  const previous = await deps.repo.indexStats(market, stored);
  const share = (rows: number): number => (next.live > 0 ? rows / next.live : 0);
  const state = { writeTag, coverage: share(next.withTag), previousCoverage: share(previous.withTag) };
  if (next.withTag >= MODEL_SWITCH_SHARE * (next.withTag + previous.withTag)) {
    await deps.repo.setConfig(modelTagConfigKey(market), writeTag);
    cache.delete(market);
    return { ...state, queryTag: writeTag, switched: true };
  }
  return { ...state, queryTag: stored, switched: false };
}
