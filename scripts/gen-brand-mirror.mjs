#!/usr/bin/env node
// scripts/gen-brand-mirror.mjs
//
// Copies the canonical product-brand registry
//   server/src/platform/brand/registry.ts
// byte for byte to the web mirror
//   lib/brand/registry.generated.ts
// with one header line on top (ARCHITECTURE.md §1.2). The server tsconfig's
// rootDir is ./src, so the server cannot import repo-root lib/, and a runtime
// import the other way (server/src → proxy, client bundles) is untested with
// Turbopack. The copy plus __tests__/lib/brandParity.test.ts removes the drift
// risk instead.
//
//   npm run gen:brand            # write the mirror
//   node scripts/gen-brand-mirror.mjs --check   # exit 1 when the mirror is stale
//
// Edit the canonical file, never the mirror.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CANONICAL_PATH = join(ROOT, 'server/src/platform/brand/registry.ts');
export const MIRROR_PATH = join(ROOT, 'lib/brand/registry.generated.ts');
export const MIRROR_HEADER = '// GENERATED from server/src/platform/brand/registry.ts — do not edit';

/** The exact mirror text for a canonical source. */
export function mirrorText(canonical) {
  return `${MIRROR_HEADER}\n${canonical}`;
}

/** The canonical text a mirror claims to copy (header line removed), or null when the header is missing. */
export function stripMirrorHeader(mirror) {
  const prefix = `${MIRROR_HEADER}\n`;
  return mirror.startsWith(prefix) ? mirror.slice(prefix.length) : null;
}

function main(argv) {
  const check = argv.includes('--check');
  const canonical = readFileSync(CANONICAL_PATH, 'utf8');
  const expected = mirrorText(canonical);
  const current = existsSync(MIRROR_PATH) ? readFileSync(MIRROR_PATH, 'utf8') : null;

  if (check) {
    if (current === expected) {
      console.log('gen-brand-mirror: lib/brand/registry.generated.ts is up to date');
      return 0;
    }
    console.error(
      'gen-brand-mirror: lib/brand/registry.generated.ts differs from server/src/platform/brand/registry.ts.\n' +
        'Run `npm run gen:brand` (edit the canonical server file, never the mirror).',
    );
    return 1;
  }

  if (current === expected) {
    console.log('gen-brand-mirror: already up to date');
    return 0;
  }
  mkdirSync(dirname(MIRROR_PATH), { recursive: true });
  writeFileSync(MIRROR_PATH, expected);
  console.log('gen-brand-mirror: wrote lib/brand/registry.generated.ts');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
