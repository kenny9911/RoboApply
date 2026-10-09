// @vitest-environment node
//
// FND-7 contract seam:
//   1. every lib/api/contracts mirror is type-only and points at a server
//      contract that exists (a contract.ts added by a later WP may have no
//      mirror yet; INT adds it — none of these checks needs a WP to edit this
//      file or lib/api/contracts/);
//   2. every lib/api/<area>.ts wrapper calls the method and path it documents,
//      and that route exists in the server mount table (FEATURE_MOUNTS) —
//      a typo in a wrapper or a renamed route fails here, not in a browser;
//   3. every route that is still a stub is wrapped, except the documented
//      exceptions (filling a stub never fails here: wrappers are matched to
//      routes by method + path, not by stub id);
//   4. the request fixtures in __tests__/fixtures parse (or are rejected)
//      by the zod schema they name;
//   5. the web typecheck ignores extension/ and deploy/.
// Type-level compatibility (wrapper ↔ contract, fixtures `satisfies` views)
// is enforced by `npm run typecheck:web`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import { REQUEST_FIXTURES } from '../fixtures';

const ROOT = process.cwd();
const FEATURES = join(ROOT, 'server/src/features');
const API = join(ROOT, 'lib/api');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const serverContracts = walk(FEATURES)
  .filter((f) => f.endsWith('/contract.ts'))
  .map((f) => relative(FEATURES, f).replace(/\/contract\.ts$/, ''))
  .sort();

const mirrors = walk(join(API, 'contracts'))
  .map((f) => relative(join(API, 'contracts'), f).replace(/\.ts$/, ''))
  .filter((m) => !['wire', 'taxonomy'].includes(m))
  .sort();

describe('lib/api/contracts mirrors the server contracts', () => {
  it('FND-7 mirrored the contracts that existed in Wave 1', () => {
    for (const area of ['auth', 'feed', 'jobs/detail', 'resume', 'tracker', 'credits', 'onboarding']) expect(mirrors).toContain(area);
  });

  it.each(mirrors)('%s is a type-only mirror', (area) => {
    const file = join(API, 'contracts', `${area}.ts`);
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(new RegExp(`export type \\* from '(\\.\\./)+server/src/features/${area.replace(/\//g, '\\/')}/contract';`));
    // Type-only: no runtime import may pull server code into the browser bundle.
    expect(src.replace(/^\/\/.*$/gm, '')).not.toMatch(/^\s*import\s/m);
  });

  it('has no mirror without a server contract', () => {
    expect(mirrors.filter((m) => !serverContracts.includes(m))).toEqual([]);
  });
});

// ── Wrapper ↔ mount table ────────────────────────────────────────────────────

interface Documented {
  file: string;
  fn: string;
  stub: string;
  method: string;
  path: string;
  params: string[];
  kind: 'call' | 'url' | 'sse' | 'multipart';
}

const WRAPPER_FILES = readdirSync(API)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(API, f))
  .filter((f) => readFileSync(f, 'utf8').includes("from './contracts/wire'"));

function documented(): Documented[] {
  const out: Documented[] = [];
  for (const file of WRAPPER_FILES) {
    const src = readFileSync(file, 'utf8');
    const re = /\/\*\* `([\w.]+)` — (GET|POST|PUT|PATCH|DELETE) (\S+)( \(multipart\))?( \(SSE\))? \*\/\nexport function (\w+)\(([^)]*)\): ([^{]+)\{/g;
    for (const m of src.matchAll(re)) {
      const params = m[7]!
        .split(/,(?![^<]*>)/)
        .map((p) => p.trim().split(/[?:=\s]/)[0]!)
        .filter(Boolean);
      const kind = m[5] ? 'sse' : m[4] ? 'multipart' : m[8]!.trim() === 'string' ? 'url' : 'call';
      out.push({ file: relative(ROOT, file), stub: m[1]!, method: m[2]!, path: m[3]!, fn: m[6]!, params, kind });
    }
  }
  return out;
}

const DOCS = documented();

/** Mounted routes deliberately not wrapped in lib/api by FND-7 (owner file in brackets). */
const NOT_WRAPPED: Array<[RegExp, string]> = [
  [/^auth\.|^account\./, 'lib/api/auth.ts (WP-10)'],
  [/^admin\./, 'lib/api/admin.ts (WP-74)'],
  [/^seo\./, 'lib/server/publicApi.ts (WP-56, server-side)'],
  [/^ext\.(redeemPairCode|me|autofillProfile|pageJob|saveJob|createRun|patchRun|answer|resumeForJob|file|siteRequest)$/, 'extension package client (WP-55b, device token)'],
  [/^authCn\.wechat(Mp)?Callback$/, 'OAuth redirect target'],
  [/^notifyCn\.(serverVerify|serverMessage)$|^billingCn\.notify$/, 'server-to-server webhook'],
];

let mountedRoutes: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
  const { FEATURE_MOUNTS } = await import('../../server/src/features/index');
  const noop = (_req: unknown, _res: unknown, next: () => void) => next();
  const deps = { seekerAuth: [noop], adminAuth: [noop], optionalAuth: [noop], extensionAuth: [noop] };
  const routes: typeof mountedRoutes = [];
  for (const mount of FEATURE_MOUNTS) {
    const router = mount.build(deps as never) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        const path = `${mount.path}${layer.route.path === '/' ? '' : layer.route.path}`;
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }
  mountedRoutes = routes;
}, 60_000);

describe('lib/api wrappers ↔ the server mount table', () => {
  it('found the wrappers', () => {
    expect(WRAPPER_FILES.length).toBeGreaterThanOrEqual(35);
    expect(DOCS.length).toBeGreaterThanOrEqual(240);
  });

  it('every documented wrapper route exists on the server', () => {
    const missing = DOCS.filter((d) => !mountedRoutes.some((r) => r.method === d.method && r.path === d.path));
    expect(missing.map((d) => `${d.file} ${d.fn}: ${d.method} ${d.path}`)).toEqual([]);
  });

  it('every route that is still a stub is wrapped or listed as an exception', () => {
    const allStubs = new Set<string>();
    for (const file of walk(FEATURES).filter((f) => /outes\.ts$/.test(f) && !f.endsWith('.test.ts'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:stub|NotImplementedError)\(\s*'([\w.]+)'/g)) allStubs.add(m[1]!);
    }
    // A filled stub simply leaves this set; its wrapper keeps passing the
    // method + path check above (no stub-id "ghost" check, no size floor).
    const wrapped = new Set(DOCS.map((d) => d.stub));
    const unwrapped = [...allStubs].filter((s) => !wrapped.has(s) && !NOT_WRAPPED.some(([re]) => re.test(s)));
    expect(unwrapped).toEqual([]);
  });

  it('wrapper function names are unique per file and stubs are unique overall', () => {
    const seen = new Set<string>();
    for (const d of DOCS) {
      const key = `${d.file}:${d.fn}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    const stubs = DOCS.map((d) => d.stub);
    expect(new Set(stubs).size).toBe(stubs.length);
  });
});

describe('each wrapper calls the method and path it documents', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  it.each(DOCS.map((d) => [`${d.file} ${d.fn}`, d] as const))('%s', async (_name, d) => {
    stubFetch();
    const mod = (await import(join(ROOT, d.file))) as Record<string, (...args: unknown[]) => unknown>;
    const fn = mod[d.fn];
    expect(typeof fn).toBe('function');
    const pathParams = [...d.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
    const args = d.params.map((p) => {
      if (pathParams.includes(p)) return `v-${p}`;
      if (p === 'body') return {};
      if (p === 'query') return { probe: 'x y' };
      if (p === 'form') return new FormData();
      if (p === 'opts') return d.kind === 'sse' ? { onEvent: () => {} } : {};
      throw new Error(`unexpected parameter ${p} in ${d.fn}`);
    });
    const expectedPath = d.path.replace(/:(\w+)/g, (_m, p: string) => `v-${p}`);
    const result = await fn(...args);
    if (d.kind === 'url') {
      const u = new URL(String(result), 'http://x');
      expect(u.pathname).toBe(expectedPath);
      if (d.params.includes('query')) expect(u.searchParams.get('probe')).toBe('x y');
      expect(calls).toHaveLength(0);
      return;
    }
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url, 'http://x');
    expect(u.pathname).toBe(expectedPath);
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe(d.method);
    if (d.params.includes('query')) expect(u.searchParams.get('probe')).toBe('x y');
    if (d.kind === 'multipart') expect(calls[0]!.init.body).toBeInstanceOf(FormData);
  });
});

// ── Request fixtures ─────────────────────────────────────────────────────────

describe('request fixtures parse with their schemas', () => {
  it.each(REQUEST_FIXTURES.map((f) => [`${f.contract}.${f.schema} ${f.valid === false ? '(rejects)' : ''}`, f] as const))('%s', async (_n, f) => {
    const mod = (await import(join(FEATURES, f.contract, 'contract.ts'))) as Record<string, ZodType>;
    const schema = mod[f.schema];
    expect(schema, `${f.schema} is exported`).toBeTruthy();
    expect(schema!.safeParse(f.value).success).toBe(f.valid !== false);
  });
});

describe('web typecheck scope', () => {
  it('tsconfig.json excludes extension/ and deploy/ (they have their own toolchains)', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { exclude: string[] };
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(['extension', 'deploy', 'server']));
  });

  it('package.json has typecheck:web and the extended check chain', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['typecheck:web']).toBe('tsc -p tsconfig.json --noEmit');
    for (const s of ['check:api-boundary', 'check:extension', 'check:zh-variants']) expect(pkg.scripts.check).toContain(`npm run ${s}`);
    expect(pkg.scripts['i18n:merge']).toBe('node scripts/i18n-merge-staging.mjs');
  });

  it('vitest skips extension/ (it runs its own tests)', () => {
    expect(readFileSync(join(ROOT, 'vitest.config.mts'), 'utf8')).toContain("'extension/**'");
  });
});
