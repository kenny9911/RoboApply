// app/manifest.webmanifest/icon/mark.ts — the brand mark SVG, read from disk (WP-61).
//
// The PNG icon route rasterises the brand's own mark. It reads the file that
// ships in public/ instead of fetching it over HTTP: no round-trip back to
// this origin (which fails behind Vercel Deployment Protection or a hairpin
// NAT on the self-hosted CN deploy) and no request to a Host-derived URL.
//
// Each brand's path is a literal `path.join(process.cwd(), 'public', …)` so
// output file tracing copies exactly those two files into the function; a
// test checks that they match `brand.assets.mark` in the registry, and the
// resolved path is checked to stay inside public/.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrandId } from '../../../lib/brand/registry.generated';

/** The file behind `brand.assets.mark` (absolute). */
export function brandMarkFile(id: BrandId): string {
  switch (id) {
    case 'roboapply':
      return path.join(process.cwd(), 'public', 'roboapply-mark.svg');
    case 'goapply':
      return path.join(process.cwd(), 'public', 'brands', 'goapply', 'mark.svg');
  }
}

/** Is `file` inside `<cwd>/public/`? (Guards against a path that climbs out.) */
export function isInsidePublic(file: string, cwd: string = process.cwd()): boolean {
  const root = path.resolve(cwd, 'public') + path.sep;
  return path.resolve(file).startsWith(root);
}

export type ReadText = (file: string) => Promise<string>;

/** The brand's mark SVG, or null when the file is missing or outside public/. */
export async function readBrandMark(id: BrandId, read: ReadText = (f) => readFile(f, 'utf8')): Promise<string | null> {
  const file = brandMarkFile(id);
  if (!isInsidePublic(file)) return null;
  try {
    return await read(file);
  } catch {
    return null;
  }
}
