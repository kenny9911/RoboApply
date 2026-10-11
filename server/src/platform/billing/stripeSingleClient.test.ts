// @vitest-environment node
//
// ST-0: there is ONE place that builds a Stripe client (stripeClient.ts
// `getStripe`), because that is where the live-key guard lives. A second
// `new Stripe(` anywhere in the server, the Vercel entry, the scripts, the
// Next.js app (`stripe` is a dependency of the root package, so a route
// handler under app/, a module under lib/ or proxy.ts could import it), the
// interview agent or the extension would be a way around the guard. This test
// reads the source tree; it calls nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const ROOTS = ['server/src', 'api', 'scripts', 'app', 'lib', 'components', 'hooks', 'interview-agent', 'extension/src'];
/** Source files at the repository root (proxy.ts, next.config.mjs, …): read by name pattern, never recursed. */
const ROOT_FILES = readdirSync(repoRoot).filter((name) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && statSync(join(repoRoot, name)).isFile());
const THE_FACTORY = ['server', 'src', 'platform', 'billing', 'stripeClient.ts'].join('/');
const SKIP_DIRS = new Set(['node_modules', 'generated', 'dist', '.next', '.turbo']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|js|mjs)$/;
// `new Stripe(`, `new Stripe.Stripe(`, `new StripeSdk(`-style aliases are caught by the import check below.
const CONSTRUCTS = /\bnew\s+Stripe\s*(?:<[^>]*>)?\s*\(/;

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

const files = [...ROOTS.flatMap((root) => walk(join(repoRoot, root), [])), ...ROOT_FILES.map((name) => join(repoRoot, name))];
const rel = (file: string) => relative(repoRoot, file).split(sep).join('/');

describe('one Stripe client factory', () => {
  it('finds the source tree (a wrong root would pass by scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map(rel)).toContain(THE_FACTORY);
    // Every root is really read: the Next.js server code, the root files, the agent and the extension.
    const scanned = files.map(rel);
    for (const prefix of ['app/', 'lib/', 'components/', 'hooks/', 'api/', 'scripts/', 'interview-agent/src/', 'extension/src/']) {
      expect(scanned.some((f) => f.startsWith(prefix)), prefix).toBe(true);
    }
    expect(scanned).toContain('proxy.ts');
    expect(scanned).toContain('next.config.mjs');
    expect(scanned.some((f) => f.includes('node_modules/') || f.includes('/dist/') || f.includes('/generated/'))).toBe(false);
  });

  it('no file of the server, the Vercel entry, the scripts, the Next.js app, the agent or the extension other than stripeClient.ts contains "new Stripe("', () => {
    const offenders = files.filter((f) => CONSTRUCTS.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([THE_FACTORY]);
  });

  it('no other file imports the Stripe SDK as a value (types only), so none can construct it under another name', () => {
    const valueImport = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+['"]stripe['"]/m;
    const dynamicImport = /\bimport\(\s*['"]stripe['"]\s*\)|\brequire\(\s*['"]stripe['"]\s*\)/;
    const offenders = files
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        return valueImport.test(text) || dynamicImport.test(text);
      })
      .map(rel);
    expect(offenders).toEqual([THE_FACTORY]);
  });
});
