// server/src/features/match/eval/offline.ts
//
// The offline guard of the evaluation harness. Fixture mode never talks to a
// network: `globalThis.fetch` is replaced by a function that records the
// attempt and throws "network is off in eval". The record is what invariant
// 10 reads ("zero model calls"): a model, embedding or search call that slips
// past an injected fake still ends here, counted.
//
// The state lives on `globalThis` so the run.ts process, a Vitest worker's
// setup file and a spec that imports this module by another path all see one
// guard.

export const OFFLINE_MESSAGE = 'network is off in eval';

/** Placeholder database URLs on a closed port: a stray query fails at once instead of reaching a real pool. */
export const CLOSED_DATABASE_URL = 'postgresql://ci@127.0.0.1:1/ci';

interface OfflineState {
  installed: boolean;
  attempts: string[];
  original: typeof globalThis.fetch | undefined;
}

const KEY = Symbol.for('roboapply.eval.offline');

function state(): OfflineState {
  const g = globalThis as unknown as Record<symbol, OfflineState | undefined>;
  if (!g[KEY]) g[KEY] = { installed: false, attempts: [], original: undefined };
  return g[KEY]!;
}

function describeTarget(input: unknown): string {
  try {
    if (typeof input === 'string') return new URL(input).host;
    if (input instanceof URL) return input.host;
    if (input && typeof input === 'object' && 'url' in input && typeof (input as { url: unknown }).url === 'string') return new URL((input as { url: string }).url).host;
  } catch {
    // Not a URL: fall through.
  }
  return 'unknown host';
}

/** Replace `fetch` by the recording thrower. Safe to call twice. */
export function installOfflineGuard(): void {
  const s = state();
  if (s.installed) return;
  s.original = globalThis.fetch;
  s.installed = true;
  globalThis.fetch = (async (input: unknown) => {
    // Only the host is kept: a URL can carry a key in its query string.
    s.attempts.push(describeTarget(input));
    throw new Error(OFFLINE_MESSAGE);
  }) as typeof globalThis.fetch;
}

/** Put the real `fetch` back (live mode, and tests that installed the guard themselves). */
export function removeOfflineGuard(): void {
  const s = state();
  if (!s.installed) return;
  if (s.original) globalThis.fetch = s.original;
  s.original = undefined;
  s.installed = false;
}

export function offlineGuardInstalled(): boolean {
  return state().installed;
}

/** Network calls attempted since the guard was installed (or since the last reset). */
export function offlineAttempts(): number {
  return state().attempts.length;
}

/** Hosts of the attempted calls, for a failure message. */
export function offlineAttemptHosts(): string[] {
  return [...state().attempts];
}

export function resetOfflineAttempts(): void {
  state().attempts.length = 0;
}

/**
 * Run `fn` with the guard in place and answer how many network calls it
 * attempted. Installs the guard when the caller's process has none (the
 * default `npm test` run) and removes it again afterwards.
 */
export async function countNetworkAttempts<T>(fn: () => Promise<T>): Promise<{ result: T; attempts: number; hosts: string[] }> {
  const s = state();
  const mine = !s.installed;
  if (mine) installOfflineGuard();
  const before = s.attempts.length;
  try {
    const result = await fn();
    return { result, attempts: s.attempts.length - before, hosts: s.attempts.slice(before) };
  } finally {
    if (mine) removeOfflineGuard();
  }
}

/**
 * Environment of an offline run, set before any server module is imported:
 * closed-port database URLs, no local `.env`, no log files.
 */
export function pinOfflineEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.DATABASE_URL = CLOSED_DATABASE_URL;
  env.DIRECT_DATABASE_URL = CLOSED_DATABASE_URL;
  if (env.FILE_LOGGING === undefined) env.FILE_LOGGING = 'false';
  if (env.LOG_LEVEL === undefined) env.LOG_LEVEL = 'ERROR';
  // The flag the server reads as "this is a test process": lib/prisma.ts then
  // loads no local .env (it carries live third-party keys) and content-safety
  // events are not persisted. A fixture run is a test run.
  if (!env.VITEST) env.VITEST = 'eval-offline';
}
