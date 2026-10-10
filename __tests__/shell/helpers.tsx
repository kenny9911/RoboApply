// Shared helpers for the FND-6a shell tests: seed a brand and its resolved
// capability flags exactly the way the app does (BrandProvider +
// initialCapabilities), on top of the suite's renderWithProviders.
// Below that: the route-tree helpers of the INT-12 "no dead ends" audit.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReactElement } from 'react';

import { BrandProvider } from '../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../lib/brand/client';
import type { BrandId } from '../../lib/brand/registry.generated';
import { FLAG_KEYS, type ResolvedFlags } from '../../server/src/platform/flags';
import { renderWithProviders } from '../utils/renderWithProviders';

/** Every flag false (fail closed), then the overrides. */
export function flagsWith(on: Partial<ResolvedFlags> = {}): ResolvedFlags {
  const all = Object.fromEntries(FLAG_KEYS.map((k) => [k, false])) as Record<string, boolean>;
  return { ...all, hiringContacts: 'off', ...on } as ResolvedFlags;
}

export function capsFor(brandId: BrandId, on: Partial<ResolvedFlags> = {}) {
  return { id: brandId, flags: flagsWith(on) };
}

export function renderWithBrand(
  ui: ReactElement,
  { brand = 'roboapply', flags = {} }: { brand?: BrandId; flags?: Partial<ResolvedFlags> | null } = {},
) {
  return renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={flags === null ? null : capsFor(brand, flags)}>
      {ui}
    </BrandProvider>,
  );
}

// ── The route tree (INT-12: the "no dead ends" audit and the entry-point checklist) ──
//
// Pure file-system helpers: which page file serves a URL, and whether a source
// file is still an FND stub. No Next runtime, so the audit sees exactly the
// files that ship.

export const REPO_ROOT = process.cwd();

export const readSource = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
export const sourceExists = (rel: string): boolean => existsSync(join(REPO_ROOT, rel));

export interface AppRoute {
  /** Repo-relative page file, e.g. `app/(auth)/jobs/[id]/page.tsx`. */
  file: string;
  /** URL segments with route groups removed, e.g. `['jobs', '[id]']`. */
  segments: string[];
  /** Under app/(auth) or app/(onboarding): needs a session. */
  signedIn: boolean;
}

const LOCALE_SEGMENT = /^(en|zh|zh-TW|ja|ko|es|fr|pt|de)$/;

let cachedRoutes: AppRoute[] | null = null;

/** Every page under app/. */
export function appRoutes(): AppRoute[] {
  if (cachedRoutes) return cachedRoutes;
  const out: AppRoute[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(REPO_ROOT, 'app', dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(REPO_ROOT, 'app', rel)).isDirectory()) walk(rel);
      else if (name === 'page.tsx') {
        const parts = dir.split('/').filter(Boolean);
        out.push({
          file: `app/${rel}`,
          segments: parts.filter((p) => !/^\(.+\)$/.test(p)),
          signedIn: parts[0] === '(auth)' || parts[0] === '(onboarding)',
        });
      }
    }
  };
  walk('');
  cachedRoutes = out;
  return out;
}

/**
 * The page that serves `href` (query and hash ignored), the way the App
 * Router picks it: a static segment beats a dynamic one, a dynamic one beats a
 * catch-all. Null when no page matches — a dead link.
 */
export function routeFor(href: string): AppRoute | null {
  const path = href.split('#')[0]!.split('?')[0]!;
  const want = path.split('/').filter(Boolean);
  let best: { route: AppRoute; score: number } | null = null;
  for (const route of appRoutes()) {
    let score = 0;
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i]!;
      if (seg.startsWith('[...')) {
        ok = want.length > i;
        score += 1;
        break;
      }
      if (i >= want.length) {
        ok = false;
        break;
      }
      if (seg === '[locale]') {
        // The localized home pages: a locale code only, never "any one-segment path".
        if (!LOCALE_SEGMENT.test(want[i]!)) {
          ok = false;
          break;
        }
        score += 10;
      } else if (seg.startsWith('[')) score += 10;
      else if (seg === want[i]) score += 100;
      else {
        ok = false;
        break;
      }
      if (i === route.segments.length - 1 && want.length !== route.segments.length) ok = false;
    }
    if (route.segments.length === 0 && want.length !== 0) ok = false;
    if (ok && (!best || score > best.score)) best = { route, score };
  }
  return best ? best.route : null;
}

/** True while a file still carries an FND stub header or a route-stub marker. */
export function isStubSource(rel: string): boolean {
  const source = readSource(rel);
  return /\bSTUB(?: SEAM)? \(FND/.test(source) || source.includes('data-route-stub=');
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '/index.ts', '/index.tsx'];

/** Resolve a relative import to a repo-relative source file, or null (a package, a stylesheet). */
export function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromFile), spec);
  for (const ext of SOURCE_EXTENSIONS) if (sourceExists(base + ext) && statSync(join(REPO_ROOT, base + ext)).isFile()) return base + ext;
  return null;
}

/** Named imports of a source file: `{ local name → [imported name, resolved file] }`. */
export function namedImports(rel: string): Map<string, { imported: string; file: string }> {
  const out = new Map<string, { imported: string; file: string }>();
  const source = readSource(rel);
  for (const m of source.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*'([^']+)'/g)) {
    const file = resolveImport(rel, m[3]!);
    if (!file) continue;
    if (m[1]) out.set(m[1], { imported: 'default', file });
    for (const part of (m[2] ?? '').split(',')) {
      const bits = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (!bits[0]) continue;
      out.set((bits[1] ?? bits[0]).trim(), { imported: bits[0].trim(), file });
    }
  }
  return out;
}

/**
 * Follow re-exports from an index file to the file that defines `name`
 * (`export { A } from './A'`, `export { X as A } from './X'`, `export * from`).
 * Returns the starting file when the name is defined there.
 */
export function definingFile(rel: string, name: string, depth = 0): string {
  if (depth > 6) return rel;
  const source = readSource(rel);
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const part of m[1]!.split(',')) {
      const bits = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const exported = (bits[1] ?? bits[0] ?? '').trim();
      if (exported !== name) continue;
      const target = resolveImport(rel, m[2]!);
      if (!target) return rel;
      const original = bits[0]!.trim();
      return original === 'default' ? target : definingFile(target, original, depth + 1);
    }
  }
  if (new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`).test(source)) return rel;
  for (const m of source.matchAll(/export\s+\*\s+from\s*'([^']+)'/g)) {
    const target = resolveImport(rel, m[1]!);
    if (!target) continue;
    const found = definingFile(target, name, depth + 1);
    if (new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`).test(readSource(found))) return found;
  }
  return rel;
}

/** True when `name` in `rel` is a component whose whole body is `return null`. */
export function rendersNullByDesign(rel: string, name: string): boolean {
  const source = readSource(rel);
  const fn = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*return\\s+null;?\\s*\\}`);
  const arrow = new RegExp(`const\\s+${name}\\b[^=]*=\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?=>\\s*(?:null\\b|\\{\\s*return\\s+null;?\\s*\\})`);
  return fn.test(source) || arrow.test(source);
}

export interface PageAudit {
  file: string;
  /** Components the page's JSX renders, with the file that defines each. */
  components: Array<{ name: string; file: string }>;
  /** Why the page is a dead end; empty when it is fine. */
  problems: string[];
}

/** Audit one page file: not a route stub, and no component it renders is an FND stub or null by design. */
export function auditPage(file: string): PageAudit {
  const problems: string[] = [];
  const source = readSource(file);
  if (source.includes('data-route-stub=')) problems.push('route stub marker');
  const components: PageAudit['components'] = [];
  for (const [local, { imported, file: from }] of namedImports(file)) {
    if (!/^[A-Z]/.test(local)) continue;
    if (!new RegExp(`<${local}[\\s/>]`).test(source)) continue;
    if (!from.startsWith('components/')) continue;
    const defined = imported === 'default' ? from : definingFile(from, imported);
    components.push({ name: imported === 'default' ? local : imported, file: defined });
    if (isStubSource(defined)) problems.push(`${local} is an FND stub (${defined})`);
    if (rendersNullByDesign(defined, imported === 'default' ? local : imported)) problems.push(`${local} renders nothing by design (${defined})`);
  }
  return { file, components, problems };
}
