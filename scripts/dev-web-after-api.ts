import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import dotenv from 'dotenv';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

export type ApiHealthResponse = Pick<Response, 'ok' | 'status'>;
export type ApiHealthFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<ApiHealthResponse>;

export interface WaitForApiOptions {
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: ApiHealthFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the Express health endpoint accepts requests.
 *
 * Next's dev rewrite turns an upstream connection refusal into an HTTP 500.
 * Gating the web process on this probe prevents an already-open login tab
 * from firing /auth/me (or submitting /login) during that startup window.
 */
export async function waitForApi(
  healthUrl: string,
  options: WaitForApiOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 200;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;

  const startedAt = now();
  let lastFailure = 'API has not responded yet';

  while (true) {
    const elapsedMs = now() - startedAt;
    const remainingMs = Math.max(1, timeoutMs - elapsedMs);

    try {
      const response = await fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs)),
      });
      if (response.ok) return;
      lastFailure = `health check returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    if (now() - startedAt >= timeoutMs) {
      throw new Error(
        `API did not become ready at ${healthUrl} within ${timeoutMs}ms (${lastFailure})`,
      );
    }

    await wait(intervalMs);
  }
}

function loadLocalEnv(): void {
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), override: false });
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env.local'), override: false });
}

function resolveHealthUrl(): string {
  const configuredBase = process.env.NEXT_PUBLIC_API_URL?.trim();
  const port = process.env.PORT?.trim() || '4607';
  const apiBase = (configuredBase || `http://localhost:${port}`).replace(/\/+$/, '');
  return `${apiBase}/api/v1/health`;
}

async function main(): Promise<void> {
  loadLocalEnv();

  const healthUrl = resolveHealthUrl();
  const configuredTimeout = Number(process.env.ROBOAPPLY_API_READY_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 60_000;

  console.log(`[dev:web] Waiting for API readiness at ${healthUrl}...`);
  await waitForApi(healthUrl, { timeoutMs });
  console.log('[dev:web] API ready; starting Next.js.');

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCommand, ['run', 'dev:web'], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  let receivedSignal = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      receivedSignal = true;
      if (!child.killed) child.kill(signal);
    });
  }

  child.once('error', (error) => {
    console.error(`[dev:web] Failed to start Next.js: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? (receivedSignal ? 0 : 1);
  });
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (invokedAsScript) {
  void main().catch((error) => {
    console.error(`[dev:web] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
