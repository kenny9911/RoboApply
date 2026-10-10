// @vitest-environment node
//
// INT-12 — WP-93 "no dead ends" (TASK_PLAN.md §9), server side.
//
// FND-5 mounted every feature router with handlers that answered
// `501 not_implemented` until their owner filled them (`markStub`,
// platform/http.ts). The integration wave ships the product, so NO route in
// FEATURE_MOUNTS may still be a stub: a button that reaches one is a dead end.
//
// The walk: every router in FEATURE_MOUNTS (server/src/features/index.ts) is
// built and its Express stack read; a route whose terminal handler is tagged
// `isStubHandler` fails the test unless it is in ALLOWED_STUBS below.
//
// ALLOWED_STUBS is the explicit, reviewed exception list. A row is accepted
// only when the route sits behind a capability flag (`requireFlag(key)`) that
// is OFF BY DEFAULT ON BOTH BRANDS — so the stub answers `404 feature_disabled`
// to everyone and no UI entry exists for it (R-04). A row with a flag that is
// on anywhere, a row for a route that no longer exists, and a row for a route
// that has been filled all fail: the list cannot rot.
//
// It is empty today: every route is filled.
//
// Also checked, because a stub can hide without the tag:
//   • no source under server/src (tests aside) calls `markStub(`,
//     `notImplemented(` or throws `NotImplementedError`, apart from their
//     definitions in platform/http.ts;
//   • `not_implemented` is answered in exactly one known place — the narrow
//     adapter for a schema column (profile/twFieldsStore.ts) — and that
//     column exists, so the branch is unreachable;
//   • no cron task is the `notImplementedCron` placeholder.
// `501 provider_not_configured` is NOT a stub: it is the honest answer of a
// finished route whose provider key is absent on this deployment (push
// without VAPID keys, alerts without an email transport), and the capability
// that depends on it hides the UI entry.
//
// The web half is __tests__/shell/noDeadEnds.test.tsx.

import { describe, expect, it } from 'vitest';
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FEATURE_MOUNTS, type FeatureMount } from './index.js';
import { isStubHandler, markStub, route } from '../platform/http.js';
import { FLAG_KEYS, resolveFlags, type FlagKey } from '../platform/flags.js';
import { BRANDS, BRAND_IDS } from '../platform/brand/registry.js';
import { twFieldsColumnPresent } from './profile/twFieldsStore.js';

// ── The allow-list ───────────────────────────────────────────────────────

export interface AllowedStub {
  /** `FeatureMount.id`. */
  mount: string;
  /** Upper case. */
  method: string;
  /** The route path inside the router, exactly as declared. */
  path: string;
  /** The capability flag that keeps the route dark; off by default on both brands. */
  flag: FlagKey;
  /** Why the route is still a stub and what unblocks it. */
  reason: string;
}

/** Every route that may still answer 501 not_implemented. Empty: none does. */
export const ALLOWED_STUBS: readonly AllowedStub[] = [];

// ── Route discovery ──────────────────────────────────────────────────────

interface DiscoveredRoute {
  method: string;
  path: string;
  /** Names of the handlers in the chain (flag gates are named `flagGate`). */
  handlerNames: string[];
  /** The terminal handler is still an FND stub. */
  stub: boolean;
}

function discover(router: ExpressRouter): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const stack = (
    router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string; handle: unknown }> } }>;
    }
  ).stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    const handlers = layer.route.stack;
    const stub = handlers.some((h) => isStubHandler(h.handle));
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: layer.route.path, handlerNames: handlers.map((h) => h.name), stub });
    }
  }
  return out;
}

const keyOf = (mount: string, method: string, routePath: string) => `${mount} ${method} ${routePath}`;

/** Stub routes of a mount table that the allow-list does not cover. */
function unlistedStubs(mounts: readonly Pick<FeatureMount, 'id' | 'build'>[], allowed: readonly AllowedStub[]): string[] {
  const ok = new Set(allowed.map((a) => keyOf(a.mount, a.method.toUpperCase(), a.path)));
  const out: string[] = [];
  for (const mount of mounts) {
    for (const r of discover(mount.build({}))) {
      if (r.stub && !ok.has(keyOf(mount.id, r.method, r.path))) out.push(keyOf(mount.id, r.method, r.path));
    }
  }
  return out;
}

/** Problems with the allow-list itself (stale rows, rows whose flag is not dark). */
function allowListProblems(mounts: readonly Pick<FeatureMount, 'id' | 'build'>[], allowed: readonly AllowedStub[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of allowed) {
    const key = keyOf(row.mount, row.method.toUpperCase(), row.path);
    if (seen.has(key)) problems.push(`${key}: listed twice`);
    seen.add(key);
    if (!row.reason.trim()) problems.push(`${key}: no reason`);
    if (!(FLAG_KEYS as readonly string[]).includes(row.flag)) problems.push(`${key}: unknown flag ${row.flag}`);
    for (const brandId of BRAND_IDS) {
      // No env at all: the registry default and the requirement checks decide.
      if (resolveFlags(BRANDS[brandId], {})[row.flag] === true) problems.push(`${key}: flag ${row.flag} is on by default on ${brandId}`);
    }
    const mount = mounts.find((m) => m.id === row.mount);
    if (!mount) {
      problems.push(`${key}: no such mount`);
      continue;
    }
    const found = discover(mount.build({})).find((r) => r.method === row.method.toUpperCase() && r.path === row.path);
    if (!found) problems.push(`${key}: no such route (remove the row)`);
    else if (!found.stub) problems.push(`${key}: the route is filled (remove the row)`);
    else if (!found.handlerNames.includes('flagGate')) problems.push(`${key}: the route has no requireFlag gate`);
  }
  return problems;
}

// ── Source scan ──────────────────────────────────────────────────────────

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'generated' || name === 'node_modules' || name === '__tests__') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
        out.push({ rel: path.relative(SRC, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Files that match `pattern` in code (comment-only lines are ignored). */
function filesMatching(pattern: RegExp, files = sources()): string[] {
  return files
    .filter(({ text }) =>
      text.split('\n').some((line) => {
        const code = line.trim();
        return !code.startsWith('//') && !code.startsWith('*') && !code.startsWith('/*') && pattern.test(code);
      }),
    )
    .map((f) => f.rel)
    .sort();
}

// ── The checks ───────────────────────────────────────────────────────────

describe('the guard can see a stub (so the checks below cannot pass vacuously)', () => {
  const passThrough: RequestHandler = (_req, _res, next) => next();
  const flagGate: RequestHandler = (_req, _res, next) => next();
  const fake = (build: () => ExpressRouter) => [{ id: 'fake', build }];

  const withStub = () => {
    const r = Router();
    r.get('/real', passThrough, route(async () => null));
    r.post('/stub', flagGate, markStub(route(async () => null)));
    return r;
  };

  it('reports a stub route that is not allow-listed', () => {
    expect(unlistedStubs(fake(withStub), [])).toEqual(['fake POST /stub']);
  });

  it('accepts it only through an allow-list row whose flag is off by default on both brands', () => {
    // `visitorAssistant` is off by default on RoboApply and GoApply (brand registry).
    const dark: AllowedStub = { mount: 'fake', method: 'POST', path: '/stub', flag: 'visitorAssistant', reason: 'test row' };
    expect(unlistedStubs(fake(withStub), [dark])).toEqual([]);
    expect(allowListProblems(fake(withStub), [dark])).toEqual([]);
  });

  it('rejects a row whose flag is on for a brand, a row with no gate, a stale row and a row for a filled route', () => {
    const lit: AllowedStub = { mount: 'fake', method: 'POST', path: '/stub', flag: 'copilot', reason: 'x' };
    expect(allowListProblems(fake(withStub), [lit]).join('\n')).toMatch(/flag copilot is on by default on (roboapply|goapply)/);

    const ungated = () => {
      const r = Router();
      r.post('/stub', passThrough, markStub(route(async () => null)));
      return r;
    };
    const row: AllowedStub = { mount: 'fake', method: 'POST', path: '/stub', flag: 'visitorAssistant', reason: 'x' };
    expect(allowListProblems(fake(ungated), [row])).toEqual(['fake POST /stub: the route has no requireFlag gate']);

    expect(allowListProblems(fake(withStub), [{ ...row, path: '/gone' }])).toEqual(['fake POST /gone: no such route (remove the row)']);
    expect(allowListProblems(fake(withStub), [{ ...row, method: 'GET', path: '/real' }])).toEqual(['fake GET /real: the route is filled (remove the row)']);
    expect(allowListProblems(fake(withStub), [{ ...row, mount: 'nope' }])).toEqual(['nope POST /stub: no such mount']);
    expect(allowListProblems(fake(withStub), [{ ...row, reason: ' ' }])).toEqual(['fake POST /stub: no reason']);
  });

  it('finds routes in the real mount table', () => {
    const total = FEATURE_MOUNTS.reduce((n, m) => n + discover(m.build({})).length, 0);
    expect(FEATURE_MOUNTS.length).toBeGreaterThan(60);
    expect(total).toBeGreaterThan(300);
  });
});

describe('no route in FEATURE_MOUNTS is a stub', () => {
  it('every stub route is in ALLOWED_STUBS (there are none)', () => {
    expect(unlistedStubs(FEATURE_MOUNTS, ALLOWED_STUBS)).toEqual([]);
  });

  it('ALLOWED_STUBS has no stale, ungated or lit row', () => {
    expect(allowListProblems(FEATURE_MOUNTS, ALLOWED_STUBS)).toEqual([]);
  });

  it.each(FEATURE_MOUNTS.map((m) => [m.id, m] as const))('router %s: no stub route', (_id, mount) => {
    const routes = discover(mount.build({}));
    expect(routes.length).toBeGreaterThan(0);
    const allowed = new Set(ALLOWED_STUBS.filter((a) => a.mount === mount.id).map((a) => `${a.method.toUpperCase()} ${a.path}`));
    expect(routes.filter((r) => r.stub && !allowed.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});

describe('no stub hides in the source', () => {
  const files = sources();

  it('reads the server sources', () => {
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => f.rel === 'platform/http.ts')).toBe(true);
  });

  it('nothing calls markStub(), notImplemented() or throws NotImplementedError (definitions aside)', () => {
    // (The definition is `markStub<T …>(handler)`, which this call pattern does not match.)
    expect(filesMatching(/\bmarkStub\s*\(/, files)).toEqual([]);
    expect(filesMatching(/\bnew NotImplementedError\s*\(/, files)).toEqual([]);
    // `notImplemented(res)` the handler helper; other files may name a local predicate the same way.
    expect(filesMatching(/\bnotImplemented\s*\(\s*res\b/, files)).toEqual(['platform/http.ts']);
  });

  it('`not_implemented` is answered in one place only, and that branch is unreachable', () => {
    expect(filesMatching(/(HttpError|fail)\s*\(\s*(res\s*,\s*)?'not_implemented'/, files)).toEqual(['features/profile/twFieldsStore.ts', 'platform/http.ts']);
    // The adapter refuses writes only while RAProfile.twFields is missing from the generated client. It is there.
    expect(twFieldsColumnPresent()).toBe(true);
  });

  it('no cron task is the notImplementedCron placeholder', () => {
    expect(filesMatching(/\bnotImplementedCron\s*\(/, files).filter((f) => !f.startsWith('platform/queue/'))).toEqual([]);
  });

  it('the one FND stub header left is the extension worker list, which declares no route', () => {
    const withHeader = files.filter((f) => /\bSTUB(?: SEAM)? \(FND/.test(f.text)).map((f) => f.rel);
    expect(withHeader).toEqual(['features/extension/workers.ts']);
    const workers = files.find((f) => f.rel === 'features/extension/workers.ts')!;
    expect(workers.text).toMatch(/export const workers: WorkerDefinition\[\] = \[\];/);
    expect(workers.text).not.toMatch(/Router\(|router\./);
  });
});
