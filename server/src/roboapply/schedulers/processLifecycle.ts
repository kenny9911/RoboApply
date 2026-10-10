// server/src/roboapply/schedulers/processLifecycle.ts
//
// Process-level settings of the long-running API host (INT-13; wave5 WP-93
// #34, asked by the mainland deploy kit, WP-76). `server/src/app.ts` is the
// only caller. Two things live here so they can be unit-tested without
// importing app.ts (which opens a port and starts node-cron):
//
//   1. `trustProxySetting(env)` — how many proxy hops Express trusts when it
//      reads `X-Forwarded-For` into `req.ip` (the rate-limit key and the
//      billing/referral signal address).
//   2. `installGracefulShutdown(...)` — on SIGTERM / SIGINT: stop the cron
//      scheduler, stop accepting connections, let running requests finish
//      (up to a deadline), then exit. A rolling update on the mainland stack
//      (or any Node host) no longer cuts a request in half.
//
// Neither runs on Vercel functions: the platform owns the listener there.

import { isIP } from 'node:net';

/** What `app.set('trust proxy', …)` accepts and this module produces. */
export type TrustProxySetting = boolean | number | string;

type EnvLike = Record<string, string | undefined>;

/**
 * The Express `trust proxy` value for this deployment.
 *
 * `TRUST_PROXY` (optional) wins when set:
 *   - `true` / `false`;
 *   - a hop count (`1`, `2`, …): trust that many proxies in front of the API;
 *   - an Express subnet list (`loopback, 100.64.0.0/10`).
 *
 * Unset:
 *   - on Vercel (`VERCEL` set): `true`, the behaviour this API has always had
 *     there. Vercel's edge overwrites `X-Forwarded-For` with the visitor's
 *     address, so one hop would read the same value; that has not been
 *     re-checked on a live deployment, so the default is left as it was.
 *     Set `TRUST_PROXY=1` in the Vercel project once confirmed.
 *   - anywhere else (the mainland gateway, docker, local dev): `1`. Exactly
 *     one proxy sits in front of the API there (nginx on the mainland stack,
 *     which overwrites `X-Forwarded-For` with the address the load balancer
 *     reported; `next dev` locally), so only the entry that proxy wrote is
 *     believed. With `true` a client-supplied left-most entry would win
 *     wherever a hop appended instead of overwriting.
 *
 * An unusable value (negative, not a number, empty) falls back to the default
 * for the host rather than to "trust everything".
 */
export function trustProxySetting(env: EnvLike = process.env): TrustProxySetting {
  const fallback: TrustProxySetting = env.VERCEL ? true : 1;
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(lower)) return Number(lower);
  // A subnet / keyword list as Express documents it (`loopback`, `linklocal`,
  // `uniquelocal`, IPs and CIDR ranges, comma separated).
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length > 0 && parts.every(isTrustEntry)) return parts.join(', ');
  return fallback;
}

const TRUST_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** One entry of an Express trust list: a keyword, an IP address, or a CIDR range. */
function isTrustEntry(entry: string): boolean {
  if (TRUST_KEYWORDS.has(entry.toLowerCase())) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/** Longest request the API serves (vercel.json `maxDuration`, mirrored by the gateway's read timeout). */
const MAX_REQUEST_MS = 300_000;

/**
 * How long a shutdown waits for running requests.
 * `SHUTDOWN_DRAIN_TIMEOUT_MS` when set (0 = do not wait); otherwise the
 * longest request plus a margin in production (the mainland API pod has
 * `terminationGracePeriodSeconds: 330` with a 10 s preStop), and 1 s in
 * development so `tsx watch` restarts stay quick even with a stream open
 * (an idle server exits at once either way).
 */
export function shutdownDrainTimeoutMs(env: EnvLike = process.env): number {
  const raw = env.SHUTDOWN_DRAIN_TIMEOUT_MS?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return env.NODE_ENV === 'production' ? MAX_REQUEST_MS + 5_000 : 1_000;
}

/** The part of `http.Server` the shutdown uses. */
export interface DrainableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface ShutdownLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface GracefulShutdownOptions {
  server: DrainableServer;
  /** Stop background work that would start new jobs (the node-cron mirror). Must not throw; errors are logged. */
  stopBackground?: () => void;
  /** Runs after the last request finished or the deadline passed (e.g. close the database pool). */
  afterDrain?: () => Promise<void> | void;
  drainTimeoutMs?: number;
  log?: ShutdownLog;
  /** Injected in tests. */
  exit?: (code: number) => void;
  signals?: readonly NodeJS.Signals[];
  proc?: Pick<NodeJS.Process, 'on'>;
  /** How often idle keep-alive sockets are dropped while draining. */
  idleSweepMs?: number;
}

export interface GracefulShutdown {
  /** Start (or join) the shutdown. Resolves once `exit` was called. */
  shutdown(signal: string): Promise<void>;
  /** True from the first signal on. */
  isDraining(): boolean;
}

const noopLog: ShutdownLog = { info: () => undefined, warn: () => undefined };

/**
 * Register SIGTERM / SIGINT handlers that drain the HTTP server before exit.
 *
 *   signal → stopBackground() → server.close() (no new connections; idle
 *   keep-alive sockets dropped now and on every sweep) → wait for running
 *   requests, at most `drainTimeoutMs` → afterDrain() → exit(0).
 *
 * When the deadline passes first, the remaining sockets are destroyed and the
 * exit code is 1, so a supervisor can tell a clean stop from a cut one. A
 * second signal during the drain exits at once (code 1).
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const log = options.log ?? noopLog;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const drainTimeoutMs = options.drainTimeoutMs ?? shutdownDrainTimeoutMs();
  const idleSweepMs = options.idleSweepMs ?? 1_000;
  const proc = options.proc ?? process;
  let running: Promise<void> | null = null;

  async function run(signal: string): Promise<void> {
    log.info('shutdown started', { signal, drainTimeoutMs });
    try {
      options.stopBackground?.();
    } catch (err) {
      log.warn('stopping background work failed', { error: err instanceof Error ? err.message : String(err) });
    }

    const drained = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (clean: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(sweep);
        resolve(clean);
      };
      const deadline = setTimeout(() => finish(false), drainTimeoutMs);
      // Keep-alive sockets that finish a request during the drain go idle; drop them as they do.
      const sweep = setInterval(() => options.server.closeIdleConnections?.(), idleSweepMs);
      try {
        options.server.close((err) => {
          // ERR_SERVER_NOT_RUNNING: nothing was listening, which is as drained as it gets.
          if (err) log.warn('server close reported an error', { error: err.message });
          finish(true);
        });
        options.server.closeIdleConnections?.();
      } catch (err) {
        log.warn('server close threw', { error: err instanceof Error ? err.message : String(err) });
        finish(true);
      }
    });

    if (!drained) {
      log.warn('drain deadline passed; closing the remaining connections', { drainTimeoutMs });
      try {
        options.server.closeAllConnections?.();
      } catch {
        /* exiting anyway */
      }
    }
    try {
      await options.afterDrain?.();
    } catch (err) {
      log.warn('after-drain hook failed', { error: err instanceof Error ? err.message : String(err) });
    }
    log.info('shutdown finished', { signal, clean: drained });
    exit(drained ? 0 : 1);
  }

  const shutdown = (signal: string): Promise<void> => {
    if (running) {
      log.warn('second signal during shutdown; exiting now', { signal });
      exit(1);
      return running;
    }
    running = run(signal);
    return running;
  };

  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as const)) {
    proc.on(signal, () => {
      void shutdown(signal);
    });
  }

  return { shutdown, isDraining: () => running !== null };
}
