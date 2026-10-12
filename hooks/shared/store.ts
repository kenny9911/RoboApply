// hooks/shared/store.ts — a tiny external store for cross-tree UI signals
// (the Assistant rail request, the out-of-credits sheet). Consumers subscribe
// with `useSyncExternalStore`, so a producer anywhere in the tree (a job card,
// a Topbar button) reaches a consumer mounted once in the app layout without
// a context provider in a hot file.

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
  /** Tests only: back to the initial value. */
  reset(): void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      value = initial;
      for (const l of [...listeners]) l();
    },
  };
}
