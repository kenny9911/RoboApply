// @vitest-environment node
//
// ST-0: there is ONE place that builds a Stripe client (stripeClient.ts
// `getStripe`), because that is where the live-key guard lives. A second
// `new Stripe(` anywhere in the server, the Vercel entry or the scripts would
// be a way around the guard. This test reads the source tree; it calls nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const ROOTS = ['server/src', 'api', 'scripts'];
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

const files = ROOTS.flatMap((root) => walk(join(repoRoot, root), []));
const rel = (file: string) => relative(repoRoot, file).split(sep).join('/');

describe('one Stripe client factory', () => {
  it('finds the source tree (a wrong root would pass by scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map(rel)).toContain(THE_FACTORY);
  });

  it('no file under server/src, api/ or scripts/ other than stripeClient.ts contains "new Stripe("', () => {
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
