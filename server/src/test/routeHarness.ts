// server/src/test/routeHarness.ts
//
// Route test harness (FND-2a; FND-3 extends it). Builds a small Express app
// with the same front middleware as server/src/app.ts (json, cookieParser,
// request id, brand context) — importing app.ts itself would open a port and
// start node-cron — mounts the routers under test, listens on an ephemeral
// port and exposes a fetch-based `request()`.
//
// No vitest imports here: this file compiles with the server and must not
// pull test-only modules into the build.
//
//   const h = await startRouteHarness({ mounts: [['/api/v1/public/brand', router]] });
//   const res = await h.request('GET', '/api/v1/public/brand', { host: 'goapply.localhost:3621' });
//   await h.close();

import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import cookieParser from 'cookie-parser';
import { createBrandContext } from '../platform/brand/brandContext.js';
import type { EnvSource } from '../platform/brand/brandEnv.js';
import { setCurrentUserId } from '../lib/requestContext.js';

export interface HarnessUser {
  id: string;
  email?: string;
  role?: string;
  brand?: string;
  [key: string]: unknown;
}

export interface RouteHarnessOptions {
  /** [path, router-or-handler] pairs mounted in order. */
  mounts: Array<[string, Router | RequestHandler]>;
  /** Env table for brand resolution (defaults to process.env). */
  env?: EnvSource;
  /** Skip the brand middleware (to test code paths without a context). */
  withoutBrandContext?: boolean;
  /** Middleware run after the brand context, before the mounts (e.g. fakeAuth). */
  before?: RequestHandler[];
}

export interface HarnessRequestInit {
  /** Sent as Host-equivalent `x-forwarded-host` (the server reads it first). */
  host?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: unknown;
}

export interface HarnessResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface RouteHarness {
  app: express.Express;
  baseUrl: string;
  request<T = unknown>(method: string, path: string, init?: HarnessRequestInit): Promise<HarnessResponse<T>>;
  close(): Promise<void>;
}

export function buildHarnessApp(options: RouteHarnessOptions): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as Request & { requestId?: string }).requestId = crypto.randomUUID();
    next();
  });
  if (!options.withoutBrandContext) app.use(createBrandContext({ env: options.env }));
  for (const mw of options.before ?? []) app.use(mw);
  for (const [path, handler] of options.mounts) app.use(path, handler);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    res.status(500).json({ success: false, code: 'internal_error', error: err.message });
  });
  return app;
}

export async function startRouteHarness(options: RouteHarnessOptions): Promise<RouteHarness> {
  const app = buildHarnessApp(options);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function request<T>(method: string, path: string, init: HarnessRequestInit = {}): Promise<HarnessResponse<T>> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.host) headers['x-forwarded-host'] = init.host;
    if (init.cookies) {
      headers.cookie = Object.entries(init.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; ');
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON body; keep the text
    }
    return { status: res.status, headers: res.headers, body: parsed as T, text };
  }

  return {
    app,
    baseUrl,
    request,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/**
 * Stand-in for requireAuth: attaches `user` and threads its id through the
 * request context the way the real middleware does. Pass a function to pick
 * the user per request (return null → 401 AUTH_REQUIRED).
 */
export function fakeAuth(user: HarnessUser | null | ((req: Request) => HarnessUser | null)): RequestHandler {
  return (req, res, next) => {
    const u = typeof user === 'function' ? user(req) : user;
    if (!u) {
      res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Authentication required' });
      return;
    }
    (req as unknown as { user?: HarnessUser }).user = u;
    setCurrentUserId(u.id);
    next();
  };
}
