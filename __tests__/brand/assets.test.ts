// @vitest-environment node
//
// WP-12: brand assets. lib/brand/metadata.ts puts brand.assets.favicon and
// brand.assets.appleTouch into every page's <head>, and the OG image comes
// from brand.assets.og, so every brand.assets.* path must be a real file
// under public/ ("assets selected from brand.assets").
//
// WP-12 ships the GoApply files under public/brands/goapply/. The brand
// registry (server/src/platform/brand/registry.ts, a hot file owned by FND /
// INT, mirrored in lib/brand/registry.generated.ts) still names the planned
// /goapply-*.svg|png paths, which do not exist. Until INT repoints it to
// GOAPPLY_ASSETS below (WP-12 handoff request R1, blocking for the GoApply
// release), the GoApply registry check is an `it.fails`: it turns red the
// moment the registry is fixed, and INT then changes it to `it`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BRANDS, BRAND_IDS, type BrandId } from '../../lib/brand/registry.generated';

const PUBLIC = join(process.cwd(), 'public');

/** The values INT puts in the registry's goapply.assets (request R1). */
const GOAPPLY_ASSETS = {
  mark: '/brands/goapply/mark.svg',
  logo: '/brands/goapply/logo.png',
  og: '/brands/goapply/og.png',
  favicon: '/brands/goapply/favicon.svg',
  appleTouch: '/brands/goapply/apple-touch.png',
} as const;

function missingAssets(id: BrandId): string[] {
  return Object.entries(BRANDS[id].assets)
    .filter(([, path]) => !(path.startsWith('/') && existsSync(join(PUBLIC, path))))
    .map(([key, path]) => `${id}.assets.${key} = ${path}`);
}

/** Width × height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(join(PUBLIC, path));
  expect(buf.subarray(1, 4).toString('latin1'), `${path} is a PNG`).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('brand.assets point at files under public/', () => {
  it('covers both brands', () => {
    expect([...BRAND_IDS].sort()).toEqual(['goapply', 'roboapply']);
  });

  it('roboapply: every brand.assets path exists', () => {
    expect(missingAssets('roboapply')).toEqual([]);
  });

  it.fails('goapply: every brand.assets path exists (blocked on request R1: INT repoints the registry to /brands/goapply/*)', () => {
    expect(missingAssets('goapply')).toEqual([]);
  });
});

describe('the GoApply files WP-12 ships', () => {
  it.each(Object.entries(GOAPPLY_ASSETS))('%s exists at %s', (_key, path) => {
    expect(existsSync(join(PUBLIC, path))).toBe(true);
  });

  it('the OG image is 1200×630 and the apple-touch icon 180×180', () => {
    expect(pngSize(GOAPPLY_ASSETS.og)).toEqual({ width: 1200, height: 630 });
    expect(pngSize(GOAPPLY_ASSETS.appleTouch)).toEqual({ width: 180, height: 180 });
    expect(pngSize(GOAPPLY_ASSETS.logo).width).toBeGreaterThan(0);
  });

  it.each([GOAPPLY_ASSETS.mark, GOAPPLY_ASSETS.favicon])('%s is a self-contained SVG (no external fonts or links)', (path) => {
    const svg = readFileSync(join(PUBLIC, path), 'utf8');
    expect(svg).toMatch(/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org\/)/);
    expect(svg).not.toMatch(/@import|<image|xlink:href=|font-family/i);
  });
});
