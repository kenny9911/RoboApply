// server/src/interview-engine/prep/cache.ts
//
// A small in-process TTL + LRU cache for the prep agents (the shape of
// features/jobs/detail/newsSearch.ts, made reusable). A company's interview
// style, an industry's roles and a query's reading change slowly; caching
// them per instance keeps repeated setups instant and the model bill flat.
// It is an optimization only: a miss simply recomputes.

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  /** Concurrent callers of one missing key share one computation. */
  getOrCompute(key: string, compute: () => Promise<V>, options?: { cacheIf?: (value: V) => boolean }): Promise<V>;
  clear(): void;
  readonly size: number;
}

export function createTtlCache<V>(options: { ttlMs: number; max: number; now?: () => number }): TtlCache<V> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { at: number; value: V }>();
  const inflight = new Map<string, Promise<V>>();

  function get(key: string): V | undefined {
    const hit = entries.get(key);
    if (!hit) return undefined;
    entries.delete(key);
    if (now() - hit.at >= options.ttlMs) return undefined;
    entries.set(key, hit);
    return hit.value;
  }

  function set(key: string, value: V): void {
    entries.delete(key);
    entries.set(key, { at: now(), value });
    while (entries.size > options.max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function getOrCompute(key: string, compute: () => Promise<V>, opts: { cacheIf?: (value: V) => boolean } = {}): Promise<V> {
    const hit = get(key);
    if (hit !== undefined) return hit;
    const running = inflight.get(key);
    if (running) return running;
    const promise = compute()
      .then((value) => {
        if (!opts.cacheIf || opts.cacheIf(value)) set(key, value);
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return {
    get,
    set,
    getOrCompute,
    clear: () => {
      entries.clear();
      inflight.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** A cache key part: lower-cased, single-spaced, capped. */
export function keyPart(value: string | null | undefined, max = 120): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, max);
}
