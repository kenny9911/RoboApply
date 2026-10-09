// @vitest-environment node
//
// FND-5 acceptance: no area imports another area's internals.
// Cross-area imports inside server/src/features/** must target the other
// area's `index.ts` (public surface) or `contract.ts` (wire types, also
// re-exported to the web by lib/api/contracts/*). Exceptions, by design:
//   - features/index.ts (the mount point) imports every area's routers;
//   - jobs/marketHooks.ts statically imports the market hook modules
//     (TASK_PLAN.md F18), and those modules import the hook types back;
//   - anything may import features/index.ts types (FeatureRouterDeps).
// Also enforced here: no `prisma as any` in features/** (§2.1 rule 5).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FEATURES = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Area key of a path relative to features/ ('<root>' for files directly in features/). */
function areaOf(rel: string): string {
  const parts = rel.split('/');
  if (parts.length === 1) return '<root>';
  if (rel.startsWith('jobs/sources/atsPublic/')) return 'jobs/sources/atsPublic';
  if (parts[0] === 'jobs' || parts[0] === 'cn') return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
  return parts[0];
}

const SEAM_TARGETS = new Set(['jobs/marketHooks.ts']);
const HOOK_MODULES = new Set(['cn/jobs/hooks.ts', 'jobs/sources/atsPublic/hooks.ts']);

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

describe('feature area boundaries', () => {
  const files = walk(FEATURES);

  it('finds the feature sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('cross-area imports go through index.ts or contract.ts only', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(FEATURES, file).split(path.sep).join('/');
      const from = areaOf(rel);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
        const tRel = path.relative(FEATURES, target).split(path.sep).join('/');
        if (tRel.startsWith('..')) continue; // outside features (platform, lib, …)
        const to = areaOf(tRel);
        if (from === '<root>' || to === '<root>' || from === to) continue;
        const base = path.basename(tRel);
        if (base === 'index.ts' || base === 'contract.ts') continue;
        if (SEAM_TARGETS.has(tRel)) continue;
        if (rel === 'jobs/marketHooks.ts' && HOOK_MODULES.has(tRel)) continue;
        violations.push(`${rel} → ${tRel}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never uses `prisma as any`', () => {
    const offenders = files.filter((f) => /prisma\s+as\s+any/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(FEATURES, f))).toEqual([]);
  });

  it('parses static, side-effect, re-export and dynamic imports', () => {
    const src = [
      "import { a } from '../feed/routes.js';",
      "import type { B } from '../search/contract.js';",
      "export * from './contract.js';",
      "import './side.js';",
      "const m = await import('../copilot/service.js');",
    ].join('\n');
    expect(specifiers(src)).toEqual(['../feed/routes.js', '../search/contract.js', './contract.js', './side.js', '../copilot/service.js']);
  });

  it('classifies areas', () => {
    expect(areaOf('index.ts')).toBe('<root>');
    expect(areaOf('feed/routes.ts')).toBe('feed');
    expect(areaOf('jobs/marketHooks.ts')).toBe('jobs');
    expect(areaOf('jobs/detail/routes.ts')).toBe('jobs/detail');
    expect(areaOf('jobs/sources/atsPublic/hooks.ts')).toBe('jobs/sources/atsPublic');
    expect(areaOf('cn/campus/contract.ts')).toBe('cn/campus');
  });
});
